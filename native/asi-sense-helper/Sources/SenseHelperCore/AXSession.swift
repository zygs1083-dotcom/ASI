import ApplicationServices
import Foundation

// Deterministic AX lifecycle (semantics: PROTOCOL.md): all AX state/IPC on a
// serial queue. One lock-protected Control record carries the desired target,
// app/window/privacy generations, titles and the published observer; workers
// carry an immutable app generation re-validated around every blocking call,
// deliveries carry stamps, and queued notification/privacy work captures the
// privacy generation it was requested under.
private struct SessionControl<O> {
  var desiredPid: Int32 = 0, desiredBid = ""
  var appGen = 0, winGen = 0, privGen = 0, titles = false
  var pubPid: Int32 = 0, pubObs: O?
  // Only delivered focus commits dedup; stale posts remain unreported.
  var deliveredApp = -1, deliveredWin = -1
  var pendingApp = -1, pendingWin = -1, pendingID = 0
  var focusUndelivered = false, focusRetryPosted = false, focusRetryAgain = false
}

public final class AXSession<B: AXBackend> {
  public static var focusedNotification: String { kAXFocusedWindowChangedNotification as String }
  public static var mainNotification: String { kAXMainWindowChangedNotification as String }
  public static var titleNotification: String { kAXTitleChangedNotification as String }
  private typealias Stamp = (app: Int, win: Int, priv: Int)

  private let backend: B, axQueue: DispatchQueue
  private let toMain: (@escaping () -> Void) -> Void
  private let emit: (_ event: any Encodable) -> Void
  private let emitFocus: (WindowEvent, @escaping (Bool) -> Void) -> Void
  private let canRetryFocus: () -> Bool
  private let onFocusUndelivered: (() -> Void)?
  private let nowMs: () -> Int64, isTrusted: () -> Bool
  private let uptime: () -> TimeInterval
  private let schedule: (TimeInterval, DispatchWorkItem) -> Void

  private var observer: B.Observer?, appEl: B.Element?, windowEl: B.Element? // AX-queue-only state
  private var pid: Int32 = 0, bundleId = "", key = "", attachedGen = -1
  // Observed identity drives subscriptions; delivered identity drives dedup.
  private var titleSubscribed = false, hasWindowContext = false
  private var debouncer = TitleDebouncer(), titleFire: DispatchWorkItem?
  private var titleFireStamp: Stamp = (0, 0, 0), scheduledDeadline: TimeInterval?
  private var unsupported = Set<String>()
  private var needsRetry = false, retryableNoted = false
  private var privacyAppliedGen = 0
  // Cross-thread shared state
  private let control = Locked(SessionControl<B.Observer>())
  private let attachState = Locked<(queued: Bool, args: (Int32, String)?, appGen: Int, privGen: Int)>((false, nil, 0, 0))
  private let refreshState = Locked<(posted: Bool, pending: Bool, appGen: Int, privGen: Int)>((false, false, 0, 0))
  private let titleState = Locked<(posted: Bool, element: B.Element?, appGen: Int, privGen: Int)>((false, nil, 0, 0))
  private let privState = Locked<(posted: Bool, pending: Bool, gen: Int)>((false, false, 0))
  #if DEBUG
  private let queuedControlJobs = Locked(0)
  #endif

  public init(backend: B, isTrusted: @escaping () -> Bool, nowMs: @escaping () -> Int64,
              emit: @escaping (_ event: any Encodable) -> Void,
              emitFocus: ((WindowEvent, @escaping (Bool) -> Void) -> Void)? = nil,
              canRetryFocus: @escaping () -> Bool = { true },
              onFocusUndelivered: (() -> Void)? = nil,
              queue: DispatchQueue = .init(label: "asi-sense-helper.ax"),
              toMain: @escaping (@escaping () -> Void) -> Void = { DispatchQueue.main.async(execute: $0) },
              uptime: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
              scheduler: ((TimeInterval, DispatchWorkItem) -> Void)? = nil) {
    self.backend = backend; self.isTrusted = isTrusted; self.nowMs = nowMs
    self.emit = emit; axQueue = queue; self.toMain = toMain; self.uptime = uptime
    self.emitFocus = emitFocus ?? { event, done in emit(event); done(true) }
    self.canRetryFocus = canRetryFocus
    self.onFocusUndelivered = onFocusUndelivered
    schedule = scheduler ?? { [queue] in queue.asyncAfter(deadline: .now() + $0, execute: $1) }
  }
  public var isAttached: Bool { control.get().pubPid != 0 }
  public var titlesEnabled: Bool { control.get().titles }
  private func stampNow() -> Stamp { let c = control.get(); return (c.appGen, c.winGen, c.privGen) }
  // Deliver only if the producing context (all three generations) is current.
  private func post(_ event: any Encodable, stamp: Stamp) {
    toMain { [weak self] in
      guard let self else { return }
      let c = self.control.get()
      guard c.appGen == stamp.app, c.winGen == stamp.win, c.privGen == stamp.priv else { return }
      self.emit(event)
    }
  }
  // Commit focus/title dedup only after a current-stamp delivery.
  private func postFocus(_ event: WindowEvent, stamp: Stamp, emittedTitle: String? = nil) {
    toMain { [weak self] in
      guard let self else { return }
      let pending = self.control.mutate { c -> Int? in
        guard c.appGen == stamp.app, c.winGen == stamp.win, c.privGen == stamp.priv
        else { return nil }
        guard !(c.deliveredApp == stamp.app && c.deliveredWin == stamp.win),
              !(c.pendingApp == stamp.app && c.pendingWin == stamp.win) else { return nil }
        c.pendingID &+= 1
        c.pendingApp = stamp.app; c.pendingWin = stamp.win
        return c.pendingID
      }
      guard let pending else { return }
      self.emitFocus(event) { [weak self] written in
        guard let self else { return }
        let (recorded, dropped) = self.control.mutate { c -> (Bool, Bool) in
          guard c.pendingID == pending else { return (false, false) }
          c.pendingApp = -1; c.pendingWin = -1
          guard c.appGen == stamp.app, c.winGen == stamp.win else { return (false, false) }
          guard written else { c.focusUndelivered = true; return (false, true) }
          c.focusUndelivered = false
          c.deliveredApp = stamp.app; c.deliveredWin = stamp.win
          return (c.privGen == stamp.priv, false)
        }
        if dropped { self.requestFocusCapacity() }
        if recorded, let t = emittedTitle {
          self.axQueue.async { [weak self] in
            guard let self else { return }
            let c = self.control.get()
            guard c.appGen == stamp.app, c.winGen == stamp.win,
                  c.privGen == stamp.priv else { return }
            // A newer notification may already have queued a different title.
            if self.debouncer.pendingTitle == nil || self.debouncer.pendingTitle == t {
              self.debouncer.markEmitted(t)
            }
          }
        }
      }
    }
  }
  // App-scoped records (ax.unsupported, ax-retryable): the producing context's
  // app and privacy generations must still be current at delivery. The window
  // generation is intentionally omitted: our own unsupported teardown bumps it.
  private func postAppScoped(_ event: any Encodable, stamp: Stamp,
                             retry: (Int32, String, String?)? = nil) {
    toMain { [weak self] in
      guard let self else { return }
      let c = self.control.get()
      guard c.appGen == stamp.app else { return }
      if c.privGen != stamp.priv {
        if let (p, b, key) = retry {
          self.axQueue.async {
            let current = self.control.get()
            guard current.appGen == stamp.app, current.desiredPid == p,
                  current.pubPid == 0 else { return }
            if let key { self.unsupported.remove(key) }
            self.queueAttach(p, b, stamp.app, current.privGen)
          }
        }
        return
      }
      self.emit(event)
    }
  }

  // MARK: - Public API (main thread): mutate Control atomically, then post work

  private func queueAttach(_ p: Int32, _ b: String, _ g: Int, _ pr: Int) {
    if attachState.mutate({ st -> Bool in
      st.args = (p, b); st.appGen = g; st.privGen = pr
      defer { st.queued = true }
      return !st.queued
    }) { axQueue.async { self.attachNext() } }
  }
  public func activate(pid p: Int32, bundleId b: String) {
    let (g, pr) = control.mutate { c -> (Int, Int) in
      if c.desiredPid != p { c.appGen &+= 1; c.pubPid = 0; c.pubObs = nil }
      c.desiredPid = p; c.desiredBid = b
      return (c.appGen, c.privGen)
    }
    queueAttach(p, b, g, pr)
  }
  // Logical detach is synchronous; resource teardown stays queued.
  public func appTerminated(pid p: Int32) {
    guard let g = control.mutate({ c -> Int? in
      guard c.desiredPid == p || c.pubPid == p else { return nil }
      c.appGen &+= 1
      c.desiredPid = 0; c.desiredBid = ""; c.pubPid = 0; c.pubObs = nil
      return c.appGen
    }) else { return }
    attachState.mutate { $0.args = nil }
    axQueue.async { if self.control.get().appGen == g { self.detachNow() } }
  }
  // Revocation invalidates now; a changed target behaves like activate().
  public func recheck(pid p: Int32, bundleId b: String) {
    if isTrusted(), p != 0 {
      let (g, pr) = control.mutate { c -> (Int, Int) in
        if c.desiredPid != p { c.appGen &+= 1; c.pubPid = 0; c.pubObs = nil }
        c.desiredPid = p; c.desiredBid = b
        return (c.appGen, c.privGen)
      }
      queueAttach(p, b, g, pr)
    } else {
      let g = control.mutate { c -> Int in
        c.appGen &+= 1; c.desiredPid = 0; c.pubPid = 0; c.pubObs = nil
        return c.appGen
      }
      attachState.mutate { $0.args = nil }
      axQueue.async { if self.control.get().appGen == g { self.detachNow() } }
    }
  }
  public func shutdown() { axQueue.async { self.detachNow() } }
  public func focusCapacityRecovered() {
    if control.mutate({ c -> Bool in
      guard c.focusUndelivered else { return false }
      if c.focusRetryPosted { c.focusRetryAgain = true; return false }
      c.focusRetryPosted = true
      return true
    }) { queueControlJob { self.focusRetryStep() } }
  }
  private func requestFocusCapacity() {
    if let onFocusUndelivered { onFocusUndelivered() }
    else if canRetryFocus() { focusCapacityRecovered() }
  }
  private func queueControlJob(_ work: @escaping () -> Void) {
    #if DEBUG
    queuedControlJobs.mutate { $0 += 1 }
    #endif
    axQueue.async {
      #if DEBUG
      self.queuedControlJobs.mutate { $0 -= 1 }
      #endif
      work()
    }
  }
  private func focusRetryStep() {
    if control.get().focusUndelivered {
      if canRetryFocus() { refreshNow(gen: attachedGen, priv: control.get().privGen) }
      else { requestFocusCapacity() }
    }
    if control.mutate({ c -> Bool in
      if c.focusRetryAgain { c.focusRetryAgain = false; return true }
      c.focusRetryPosted = false
      return false
    }) { queueControlJob { self.focusRetryStep() } }
  }
  // Ingress captures the published observer AND current app+privacy generations.
  public func notify(_ name: String, observer o: B.Observer, element: B.Element) {
    let c = control.get()
    guard let cur = c.pubObs, backend.equalObserver(cur, o) else { return }
    let g = c.appGen, p = c.privGen
    if name == Self.titleNotification {
      guard c.titles else { return }
      if titleState.mutate({ st -> Bool in
        st.element = element; st.appGen = g; st.privGen = p
        defer { st.posted = true }; return !st.posted
      }) { axQueue.async { self.titleStep() } }
    } else if refreshState.mutate({ st -> Bool in
      st.appGen = g; st.privGen = p
      if st.posted { st.pending = true; return false }
      st.posted = true; return true
    }) { axQueue.async { self.refreshStep() } }
  }
  // Int.max signals fatal exhaustion to CommandChannel; never wrap.
  public static func nextPrivacyGeneration(_ current: Int) -> Int {
    current == Int.max ? Int.max : current + 1
  }
  // Privacy flips NOW (privGen bumps synchronously per command, even redundant
  // ones, so every command gets its own ack generation) and kills any pending
  // queued title read; at most one coalesced privacy job stays outstanding.
  // Returns the privacy generation this command produced.
  @discardableResult
  public func setTitlesEnabled(_ on: Bool) -> Int {
    let g = control.mutate { c -> Int in
      c.privGen = Self.nextPrivacyGeneration(c.privGen)
      c.titles = c.privGen == Int.max ? false : on
      if c.deliveredApp != c.appGen || c.deliveredWin != c.winGen {
        c.focusUndelivered = true
      }
      return c.privGen
    }
    titleState.mutate { $0.element = nil }
    if privState.mutate({ st -> Bool in
      st.gen = g
      if st.posted { st.pending = true; return false }
      st.posted = true; return true
    }) { queueControlJob { self.privacyStep() } }
    return g
  }
  // Stamps are captured BEFORE the hop; a privacy change skips the title
  // read and yields no title.
  public func snapshot(pid p: Int32, bundleId b: String,
                       completion: @escaping (_ status: String, _ title: String?) -> Void) {
    snapshotDetail(pid: p, bundleId: b) { status, title, _ in completion(status, title) }
  }
  public func snapshotDetail(pid p: Int32, bundleId b: String,
                             completion: @escaping (_ status: String, _ title: String?, _ count: Int?) -> Void) {
    let snap = stampNow()
    axQueue.async {
      var status = "unknown", title: String? = nil
      var count: Int? = nil
      let k = b.isEmpty ? "pid:\(p)" : b
      let c = self.control.get()
      if c.appGen == snap.app, c.winGen == snap.win {
        if !self.isTrusted() { status = "denied" }
        else if self.unsupported.contains(k) { status = "unsupported" }
        // Trusted but never attached (or attached to another app): report
        // unknown rather than fabricating ok from a direct one-off read.
        else if self.observer == nil || self.pid != p { status = "unknown" }
        else {
          let app = self.backend.application(pid: p)
          let (countErr, observedCount) = self.backend.windowCount(app)
          if countErr == .success, let observedCount, observedCount >= 0,
             self.control.get().appGen == snap.app, self.isTrusted() { count = observedCount }
          guard self.control.get().appGen == snap.app, self.isTrusted() else {
            self.toMain { completion("unknown", nil, nil) }
            return
          }
          let (err, win) = self.backend.focusedWindow(app)
          let c1 = self.control.get()
          if c1.appGen == snap.app {
            self.classifyRead(err, Self.focusedNotification, stamp: snap,
                              key: k, bundleId: b, pid: p)
            if let win, err == .success {
              status = "ok"
              if c1.titles, c1.privGen == snap.priv {
                let (terr, t) = self.backend.boundedTitle(win)
                let c2 = self.control.get()
                if c2.titles, c2.privGen == snap.priv, c2.appGen == snap.app {
                  if terr == .success { title = t }
                  else { self.classifyOptionalTitle(terr, stamp: snap, pid: p, bundleId: b) }
                }
              }
            }
          }
        }
      }
      self.toMain { [gen = self.control] in
        let c = gen.get()
        let valid = c.appGen == snap.app && c.winGen == snap.win
        completion(valid ? status : "unknown", valid && c.privGen == snap.priv ? title : nil,
                   valid && self.isTrusted() ? count : nil)
      }
    }
  }

  // MARK: - AX queue internals

  private func attachNext() {
    guard let (p, b, g, pr) = attachState.mutate({ st -> (Int32, String, Int, Int)? in
      st.queued = false
      guard let a = st.args else { return nil }
      st.args = nil
      return (a.0, a.1, st.appGen, st.privGen)
    }), control.get().appGen == g else { return } // superseded while queued
    attachNow(pid: p, bundleId: b, appGen: g, privGen: pr)
  }
  // `g` is the request's immutable app generation, re-validated after every
  // blocking IPC; the resource publishes atomically or detaches unstarted.
  private func attachNow(pid p: Int32, bundleId b: String, appGen g: Int, privGen pr: Int) {
    if observer != nil, p == pid, attachedGen == g, !needsRetry { return }
    detachNow()
    pid = p; bundleId = b; key = b.isEmpty ? "pid:\(p)" : b; attachedGen = g
    needsRetry = false; retryableNoted = false
    guard isTrusted(), !unsupported.contains(key) else { return }
    func current() -> Bool { let c = control.get(); return c.appGen == g && c.desiredPid == p }
    // Reattempt stale privacy failures under the current epoch, without recursion.
    func requeueIfStaleEpoch() -> Bool {
      let c = control.get()
      guard c.appGen == g, c.desiredPid == p, c.privGen != pr else { return false }
      queueAttach(p, b, g, c.privGen)
      return true
    }
    guard current() else { return }
    let obs: B.Observer
    do { obs = try backend.createObserver(pid: p) } catch {
      guard current() else { return } // superseded: don't poison cache/emit
      guard !requeueIfStaleEpoch() else { return }
      classifyRead((error as? AXObserverCreateError)?.axError ?? .failure,
                   Self.focusedNotification, stamp: (g, 0, pr),
                   key: key, bundleId: b, pid: p)
      _ = requeueIfStaleEpoch()
      return
    }
    guard current() else { backend.detach(obs); return }
    let app = backend.application(pid: p)
    let e1 = backend.add(observer: obs, element: app, notification: Self.focusedNotification)
    guard current() else { backend.detach(obs); return }
    guard e1 == .success || e1 == .notificationAlreadyRegistered else {
      if requeueIfStaleEpoch() { backend.detach(obs); return }
      if isPermanent(e1) {
        markUnsupported(key, bundleId: bundleId, pid: p,
                        notification: Self.focusedNotification, error: e1,
                        stamp: (g, 0, pr))
      } else { noteRetryable(stamp: (g, 0, pr), pid: p, bundleId: b) }
      backend.detach(obs)
      _ = requeueIfStaleEpoch()
      return
    }
    // Optional subscription: failure never poisons focused monitoring.
    let e2 = backend.add(observer: obs, element: app, notification: Self.mainNotification)
    guard current() else { backend.detach(obs); return }
    if e2 != .success, e2 != .notificationAlreadyRegistered, !isPermanent(e2) {
      noteRetryable(stamp: (g, 0, pr), pid: p, bundleId: b)
    }
    // Atomic publish: wins only if this is still the desired target's gen.
    guard control.mutate({ c -> Bool in
      guard c.appGen == g, c.desiredPid == p else { return false }
      c.pubPid = p; c.pubObs = obs
      return true
    }) else { backend.detach(obs); return }
    backend.start(obs)
    observer = obs; appEl = app
    refreshNow(gen: g, priv: pr)
  }
  // The published slot is released only if it still holds THIS observer.
  private func detachNow() {
    cancelTitleFire()
    debouncer.reset()
    if let obs = observer {
      backend.detach(obs)
      control.mutate { c in
        if let cur = c.pubObs, backend.equalObserver(cur, obs) {
          c.pubObs = nil; c.pubPid = 0; c.winGen &+= 1
        }
      }
    }
    observer = nil; appEl = nil; windowEl = nil
    titleSubscribed = false; hasWindowContext = false
    pid = 0; bundleId = ""; key = ""; attachedGen = -1
  }
  // permanent -> unsupported, other failures -> ax-retryable. `s` is the
  // immutable stamp of the request that produced the error: app+privacy gens
  // are checked before error state mutates AND again at delivery, so a stale
  // result can never be relabeled as a newer context's failure.
  @discardableResult
  private func classifyRead(_ e: AXError, _ n: String, stamp s: Stamp,
                            key k: String, bundleId b: String, pid p: Int32) -> Bool {
    if isPermanent(e) {
      markUnsupported(k, bundleId: b, pid: p, notification: n, error: e, stamp: s)
      return false
    }
    if e != .success && e != .noValue { noteRetryable(stamp: s, pid: p, bundleId: b) }
    return true
  }
  // Optional AXTitle reads/subscriptions degrade to "no title" only and never
  // poison the app's focus observation; retryable failures keep needsRetry.
  @discardableResult
  private func classifyOptionalTitle(_ e: AXError, stamp s: Stamp,
                                     pid p: Int32, bundleId b: String) -> Bool {
    if isPermanent(e) { return false }
    if e != .success && e != .noValue { noteRetryable(stamp: s, pid: p, bundleId: b) }
    return true
  }
  private func isPermanent(_ e: AXError) -> Bool {
    // cannotComplete/apiDisabled/failure/invalidUIElement/noValue: retryable
    [.notificationUnsupported, .attributeUnsupported, .parameterizedAttributeUnsupported,
     .actionUnsupported, .notImplemented].contains(e)
  }
  private func markUnsupported(_ k: String, bundleId b: String, pid p: Int32,
                               notification: String, error: AXError, stamp: Stamp) {
    // The producing epoch must still be current before error state mutates;
    // the delivery re-checks the same stamp.
    guard control.get().appGen == stamp.app, control.get().privGen == stamp.priv else { return }
    if unsupported.insert(k).inserted {
      postAppScoped(AxUnsupportedEvent(at: nowMs(), bundleId: b, pid: p,
                                     notification: notification, error: error.rawValue),
                    stamp: stamp, retry: (p, b, k))
    }
    // Only the failing target's own session is torn down.
    if k == key { detachNow() }
  }
  // One ax-retryable per context; recheck()/activation consumes needsRetry.
  private func noteRetryable(stamp: Stamp, pid p: Int32, bundleId b: String) {
    guard control.get().appGen == stamp.app, control.get().privGen == stamp.priv else { return }
    needsRetry = true
    guard !retryableNoted else { return }
    retryableNoted = true
    postAppScoped(ErrorEvent(at: nowMs(), code: "ax-retryable",
                             message: "AX operation failed; will retry on next activation or recheck",
                             pid: p, bundleId: b),
                  stamp: stamp, retry: (p, b, nil))
  }
  private func refreshStep() {
    let st = refreshState.get()
    if control.get().appGen == st.appGen { refreshNow(gen: st.appGen, priv: st.privGen) }
    if refreshState.mutate({ st -> Bool in
      if st.pending { st.pending = false; return true } // stays posted
      st.posted = false; return false
    }) { axQueue.async { self.refreshStep() } }
  }
  private func refreshNow(gen g: Int, priv p: Int) {
    guard attachedGen == g, control.get().appGen == g, let obs = observer, let app = appEl else { return }
    func current() -> Bool { control.get().appGen == g }
    let (err, el) = backend.focusedWindow(app)
    guard current() else { return }
    classifyRead(err, Self.focusedNotification, stamp: (g, 0, p),
                 key: key, bundleId: bundleId, pid: pid)
    guard err == .success || err == .noValue else { return } // stay attached; retry later
    let newWin = err == .success ? el : nil // noValue/success-nil: windowless
    let c0 = control.get()
    let sameObserved = newWin == nil ? (windowEl == nil && hasWindowContext)
                                     : windowEl != nil && backend.equal(newWin!, windowEl!)
    let focusReported = c0.deliveredApp == g && c0.deliveredWin == c0.winGen
    if sameObserved, focusReported {
      // identical delivered focus: no reset/focused; feed the title via debounce
      guard let w = windowEl else { return }
      // The captured privacy epoch is validated BEFORE the read too: a stale
      // queued refresh must never spend an AXTitle call.
      let c1 = control.get()
      guard c1.titles, c1.privGen == p, c1.appGen == g else { return }
      let (terr, t) = backend.boundedTitle(w)
      let c = control.get()
      guard current(), c.titles, c.privGen == p else { return } // stale privacy epoch
      guard classifyOptionalTitle(terr, stamp: (g, 0, p), pid: pid, bundleId: bundleId)
      else { return }
      if let t, terr == .success { submitTitle(t, stamp: (g, c.winGen, c.privGen)) }
      return
    }
    if sameObserved {
      // Recover undelivered focus without resetting subscriptions/debounce.
      var repostTitle: String? = nil
      let producingStamp: Stamp = (g, c0.winGen, p)
      if let w = windowEl, c0.titles, c0.privGen == p, isTrusted() {
        let (terr, t) = backend.boundedTitle(w)
        let c2 = control.get()
        if c2.appGen == g, c2.titles, c2.privGen == p,
           classifyOptionalTitle(terr, stamp: (g, 0, p), pid: pid, bundleId: bundleId),
           terr == .success {
          repostTitle = t
        }
      }
      postFocus(WindowEvent(type: "window.focused", at: nowMs(), pid: pid,
                            bundleId: bundleId, title: repostTitle, windowless: newWin == nil),
                stamp: producingStamp, emittedTitle: repostTitle)
      return
    }
    if titleSubscribed, let old = windowEl {
      backend.remove(observer: obs, element: old, notification: Self.titleNotification)
      guard current() else { return }
    }
    titleSubscribed = false
    // Atomic window commit: only a matching app gen bumps winGen.
    guard let stamp = control.mutate({ c -> Stamp? in
      guard c.appGen == g, c.pubPid == pid else { return nil }
      c.winGen &+= 1
      return (c.appGen, c.winGen, c.privGen)
    }) else { return }
    windowEl = newWin
    hasWindowContext = true
    debouncer.reset()
    cancelTitleFire()
    var title: String? = nil
    // Title work belongs to the privacy epoch this refresh was queued under:
    // a request made before an off->on flip does not run its stale reads.
    if let w = newWin, control.get().titles, control.get().privGen == p, isTrusted() {
      let e = backend.add(observer: obs, element: w, notification: Self.titleNotification)
      guard current() else { return }
      if e == .success || e == .notificationAlreadyRegistered { titleSubscribed = true }
      else if !isPermanent(e) {
        noteRetryable(stamp: (g, 0, p), pid: pid, bundleId: bundleId) // optional
      }
      let c2 = control.get()
      if c2.titles, c2.privGen == p, c2.appGen == g {
        let (terr, t) = backend.boundedTitle(w)
        let c3 = control.get()
        if c3.titles, c3.privGen == p, c3.appGen == g,
           classifyOptionalTitle(terr, stamp: (g, 0, p), pid: pid, bundleId: bundleId),
           terr == .success {
          title = t
        }
      }
    }
    postFocus(WindowEvent(type: "window.focused", at: nowMs(), pid: pid,
                          bundleId: bundleId, title: title, windowless: newWin == nil),
              stamp: stamp, emittedTitle: title)
  }
  private func titleStep() {
    let (el, g, p) = titleState.mutate { st -> (B.Element?, Int, Int) in
      let e = st.element; st.element = nil; return (e, st.appGen, st.privGen)
    }
    let c = control.get()
    if c.appGen == g, c.privGen == p, attachedGen == g, c.titles,
       let w = windowEl, let el, backend.equal(el, w) {
      let (terr, t) = backend.boundedTitle(w)
      let c2 = control.get()
      if c2.appGen == g, c2.titles, c2.privGen == p,
         classifyOptionalTitle(terr, stamp: (g, 0, p), pid: pid, bundleId: bundleId),
         let t, terr == .success {
        submitTitle(t, stamp: (g, c2.winGen, c2.privGen))
      }
    }
    if titleState.mutate({ st -> Bool in
      if st.element != nil { return true } // stays posted
      st.posted = false; return false
    }) { axQueue.async { self.titleStep() } }
  }
  // At most one queued privacy job plus one successor; each applies the exact
  // generation it dequeued and skips work already covered by a newer apply.
  private func privacyStep() {
    let st = privState.get()
    if st.gen != privacyAppliedGen {
      privacyAppliedGen = st.gen
      applyTitles(privGen: st.gen)
    }
    if control.get().focusUndelivered { requestFocusCapacity() }
    if privState.mutate({ s -> Bool in
      if s.pending { s.pending = false; return true } // one successor, latest gen
      s.posted = false; return false
    }) { queueControlJob { self.privacyStep() } }
  }
  private func applyTitles(privGen g: Int) {
    let appG = attachedGen // this job manages THIS worker context only
    var c = control.get()
    guard c.appGen == appG, c.privGen == g else { return }
    if c.titles {
      debouncer.reset()
      guard isTrusted() else { detachNow(); return }
      guard let obs = observer, let w = windowEl else { return }
      let e = backend.add(observer: obs, element: w, notification: Self.titleNotification)
      // Record a successful subscription BEFORE the staleness guard: if a
      // newer privacy job supersedes us it must still remove this
      // registration, which only exists on the AX queue's state.
      if e == .success || e == .notificationAlreadyRegistered { titleSubscribed = true }
      c = control.get()
      guard c.appGen == appG, c.privGen == g else { return }
      if e != .success, e != .notificationAlreadyRegistered, !isPermanent(e) {
        noteRetryable(stamp: (appG, 0, g), pid: pid, bundleId: bundleId)
      }
      let (terr, t) = backend.boundedTitle(w)
      let c2 = control.get()
      guard c2.appGen == appG, c2.titles, c2.privGen == g else { return }
      guard classifyOptionalTitle(terr, stamp: (appG, 0, g), pid: pid, bundleId: bundleId)
      else { return }
      if let t, terr == .success { submitTitle(t, stamp: (appG, c2.winGen, c2.privGen)) }
    } else {
      // Privacy recovery is title-free and uses the current epoch.
      debouncer.cancelPending()
      cancelTitleFire()
      if titleSubscribed, let obs = observer, let w = windowEl {
        backend.remove(observer: obs, element: w, notification: Self.titleNotification)
      }
      titleSubscribed = false
    }
  }
  private func submitTitle(_ t: String, stamp: Stamp) {
    let now = uptime()
    guard let deadline = debouncer.submit(t, now: now) else { cancelTitleFire(); return }
    guard deadline != scheduledDeadline else { return } // identical pending keeps its fire
    titleFire?.cancel()
    arm(deadline, stamp: stamp)
  }
  private func arm(_ deadline: TimeInterval, stamp: Stamp) {
    let item = DispatchWorkItem { [weak self] in self?.fireTitle() }
    titleFire = item; scheduledDeadline = deadline; titleFireStamp = stamp
    schedule(max(0, deadline - uptime()), item)
  }
  private func cancelTitleFire() { titleFire?.cancel(); titleFire = nil; scheduledDeadline = nil }
  private func fireTitle() {
    titleFire = nil; scheduledDeadline = nil
    guard control.get().titles else { return }
    guard isTrusted() else { detachNow(); return }
    if let t = debouncer.fire(now: uptime()) {
      post(WindowEvent(type: "window.title", at: nowMs(), pid: pid, bundleId: bundleId, title: t),
           stamp: titleFireStamp)
    } else if let deadline = debouncer.pendingDeadline { // fired early: finish the wait
      arm(deadline, stamp: titleFireStamp)
    }
  }
  // Test support (@testable): run when the AX queue has quiesced.
  func drainQueueForTesting() { axQueue.sync {} }
  #if DEBUG
  public var pendingFocusAndPrivacyJobsForTesting: Int {
    queuedControlJobs.get()
  }
  #endif
}
