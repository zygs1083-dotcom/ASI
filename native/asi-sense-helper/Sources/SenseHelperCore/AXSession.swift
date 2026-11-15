import ApplicationServices
import Foundation

// Deterministic AX lifecycle (semantics: PROTOCOL.md): all AX state/IPC on a
// serial queue. One lock-protected Control record carries the desired target,
// app/window/privacy generations, titles and the published observer; workers
// carry an immutable app generation re-validated around every blocking call
// and deliveries carry all three stamps.
private struct SessionControl<O> {
  var desiredPid: Int32 = 0, desiredBid = ""
  var appGen = 0, winGen = 0, privGen = 0, titles = true
  var pubPid: Int32 = 0, pubObs: O?
}

public final class AXSession<B: AXBackend> {
  public static var focusedNotification: String { kAXFocusedWindowChangedNotification as String }
  public static var mainNotification: String { kAXMainWindowChangedNotification as String }
  public static var titleNotification: String { kAXTitleChangedNotification as String }
  private typealias Stamp = (app: Int, win: Int, priv: Int)

  private let backend: B, axQueue: DispatchQueue
  private let toMain: (@escaping () -> Void) -> Void
  private let emit: (_ event: any Encodable, _ critical: Bool) -> Void
  private let nowMs: () -> Int64, isTrusted: () -> Bool
  private let uptime: () -> TimeInterval
  private let schedule: (TimeInterval, DispatchWorkItem) -> Void

  private var observer: B.Observer?, appEl: B.Element?, windowEl: B.Element? // AX-queue-only state
  private var pid: Int32 = 0, bundleId = "", key = "", attachedGen = -1
  private var titleSubscribed = false
  private var debouncer = TitleDebouncer(), titleFire: DispatchWorkItem?
  private var titleFireStamp: Stamp = (0, 0, 0), scheduledDeadline: TimeInterval?
  private var unsupported = Set<String>()
  private var needsRetry = false, retryableNoted = false
  // Cross-thread shared state
  private let control = Locked(SessionControl<B.Observer>())
  private let attachState = Locked<(queued: Bool, args: (Int32, String)?, appGen: Int)>((false, nil, 0))
  private let refreshState = Locked<(posted: Bool, pending: Bool, gen: Int)>((false, false, 0))
  private let titleState = Locked<(posted: Bool, element: B.Element?, gen: Int)>((false, nil, 0))

  public init(backend: B, isTrusted: @escaping () -> Bool, nowMs: @escaping () -> Int64,
              emit: @escaping (_ event: any Encodable, _ critical: Bool) -> Void,
              queue: DispatchQueue = .init(label: "asi-sense-helper.ax"),
              toMain: @escaping (@escaping () -> Void) -> Void = { DispatchQueue.main.async(execute: $0) },
              uptime: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime },
              scheduler: ((TimeInterval, DispatchWorkItem) -> Void)? = nil) {
    self.backend = backend; self.isTrusted = isTrusted; self.nowMs = nowMs
    self.emit = emit; axQueue = queue; self.toMain = toMain; self.uptime = uptime
    schedule = scheduler ?? { [queue] in queue.asyncAfter(deadline: .now() + $0, execute: $1) }
  }
  public var isAttached: Bool { control.get().pubPid != 0 }
  public var titlesEnabled: Bool { control.get().titles }
  private func stampNow() -> Stamp { let c = control.get(); return (c.appGen, c.winGen, c.privGen) }
  // Deliver only if the producing context (all three generations) is current.
  private func post(_ event: any Encodable, critical: Bool, stamp: Stamp) {
    toMain { [weak self] in
      guard let self else { return }
      let c = self.control.get()
      guard c.appGen == stamp.app, c.winGen == stamp.win, c.privGen == stamp.priv else { return }
      self.emit(event, critical)
    }
  }
  private func postAlways(_ event: any Encodable, critical: Bool) { toMain { self.emit(event, critical) } }

  // MARK: - Public API (main thread): mutate Control atomically, then post work

  private func queueAttach(_ p: Int32, _ b: String, _ g: Int) {
    if attachState.mutate({ st -> Bool in
      st.args = (p, b); st.appGen = g
      defer { st.queued = true }
      return !st.queued
    }) { axQueue.async { self.attachNext() } }
  }
  public func activate(pid p: Int32, bundleId b: String) {
    let g = control.mutate { c -> Int in
      if c.desiredPid != p { c.appGen &+= 1; c.pubPid = 0; c.pubObs = nil }
      c.desiredPid = p; c.desiredBid = b
      return c.appGen
    }
    queueAttach(p, b, g)
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
      let g = control.mutate { c -> Int in
        if c.desiredPid != p { c.appGen &+= 1; c.pubPid = 0; c.pubObs = nil }
        c.desiredPid = p; c.desiredBid = b
        return c.appGen
      }
      queueAttach(p, b, g)
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
  // Ingress captures the published observer AND current app generation.
  public func notify(_ name: String, observer o: B.Observer, element: B.Element) {
    let c = control.get()
    guard let cur = c.pubObs, backend.equalObserver(cur, o) else { return }
    let g = c.appGen
    if name == Self.titleNotification {
      guard c.titles else { return }
      if titleState.mutate({ st -> Bool in
        st.element = element; st.gen = g
        defer { st.posted = true }; return !st.posted
      }) { axQueue.async { self.titleStep() } }
    } else if refreshState.mutate({ st -> Bool in
      st.gen = g
      if st.posted { st.pending = true; return false }
      st.posted = true; return true
    }) { axQueue.async { self.refreshStep() } }
  }
  // Privacy flips NOW so in-flight title reads drop; attach jobs survive
  // a mid-registration toggle and only skip title work.
  public func setTitlesEnabled(_ on: Bool) {
    guard control.mutate({ c -> Bool in
      guard c.titles != on else { return false }
      c.titles = on; c.privGen &+= 1; return true
    }) else { return }
    axQueue.async { self.applyTitles() }
  }
  // Stamps are captured BEFORE the hop; a privacy change skips the title
  // read and yields no title.
  public func snapshot(pid p: Int32, bundleId b: String,
                       completion: @escaping (_ status: String, _ title: String?) -> Void) {
    let snap = stampNow()
    axQueue.async {
      var status = "unknown", title: String? = nil
      let k = b.isEmpty ? "pid:\(p)" : b
      let c = self.control.get()
      if c.appGen == snap.app, c.winGen == snap.win {
        if !self.isTrusted() { status = "denied" }
        else if self.unsupported.contains(k) { status = "unsupported" }
        else {
          let (err, win) = self.backend.focusedWindow(self.backend.application(pid: p))
          let c1 = self.control.get()
          if c1.appGen == snap.app {
            self.classifyRead(err, Self.focusedNotification, key: k, bundleId: b)
            if let win, err == .success {
              status = "ok"
              if c1.titles, c1.privGen == snap.priv {
                let (terr, t) = self.backend.title(win)
                let c2 = self.control.get()
                if c2.titles, c2.privGen == snap.priv, c2.appGen == snap.app {
                  if terr == .success { title = t }
                  else { self.classifyRead(terr, Self.titleNotification, key: k, bundleId: b) }
                }
              }
            }
          }
        }
      }
      self.toMain { [gen = self.control] in
        let c = gen.get()
        let valid = c.appGen == snap.app && c.winGen == snap.win
        completion(valid ? status : "unknown", valid && c.privGen == snap.priv ? title : nil)
      }
    }
  }

  // MARK: - AX queue internals

  private func attachNext() {
    guard let (p, b, g) = attachState.mutate({ st -> (Int32, String, Int)? in
      st.queued = false
      guard let a = st.args else { return nil }
      st.args = nil
      return (a.0, a.1, st.appGen)
    }), control.get().appGen == g else { return } // superseded while queued
    attachNow(pid: p, bundleId: b, appGen: g)
  }
  // `g` is the request's immutable app generation, re-validated after every
  // blocking IPC; the resource publishes atomically or detaches unstarted.
  private func attachNow(pid p: Int32, bundleId b: String, appGen g: Int) {
    if observer != nil, p == pid, attachedGen == g, !needsRetry { return }
    detachNow()
    pid = p; bundleId = b; key = b.isEmpty ? "pid:\(p)" : b; attachedGen = g
    needsRetry = false; retryableNoted = false
    guard isTrusted(), !unsupported.contains(key) else { return }
    func current() -> Bool { let c = control.get(); return c.appGen == g && c.desiredPid == p }
    guard current() else { return }
    let obs: B.Observer
    do { obs = try backend.createObserver(pid: p) } catch {
      guard current() else { return } // superseded: don't poison cache/emit
      classifyRead((error as? AXObserverCreateError)?.axError ?? .failure, Self.focusedNotification)
      return
    }
    guard current() else { backend.detach(obs); return }
    let app = backend.application(pid: p)
    let e1 = backend.add(observer: obs, element: app, notification: Self.focusedNotification)
    guard current() else { backend.detach(obs); return }
    guard e1 == .success || e1 == .notificationAlreadyRegistered else {
      if isPermanent(e1) {
        markUnsupported(key, bundleId: bundleId, notification: Self.focusedNotification, error: e1)
      } else { noteRetryable() }
      backend.detach(obs)
      return
    }
    // Optional subscription: failure never poisons focused monitoring.
    let e2 = backend.add(observer: obs, element: app, notification: Self.mainNotification)
    guard current() else { backend.detach(obs); return }
    if e2 != .success, e2 != .notificationAlreadyRegistered, !isPermanent(e2) { noteRetryable() }
    // Atomic publish: wins only if this is still the desired target's gen.
    guard control.mutate({ c -> Bool in
      guard c.appGen == g, c.desiredPid == p else { return false }
      c.pubPid = p; c.pubObs = obs
      return true
    }) else { backend.detach(obs); return }
    backend.start(obs)
    observer = obs; appEl = app
    refreshNow(gen: g)
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
    titleSubscribed = false
    pid = 0; bundleId = ""; key = ""; attachedGen = -1
  }
  // permanent -> unsupported, other failures -> ax-retryable.
  @discardableResult
  private func classifyRead(_ e: AXError, _ n: String, key k: String? = nil, bundleId b: String? = nil) -> Bool {
    if isPermanent(e) {
      markUnsupported(k ?? key, bundleId: b ?? bundleId, notification: n, error: e)
      return false
    }
    if e != .success && e != .noValue { noteRetryable() }
    return true
  }
  private func isPermanent(_ e: AXError) -> Bool {
    // cannotComplete/apiDisabled/failure/invalidUIElement/noValue: retryable
    [.notificationUnsupported, .attributeUnsupported, .parameterizedAttributeUnsupported,
     .actionUnsupported, .notImplemented].contains(e)
  }
  private func markUnsupported(_ k: String, bundleId b: String, notification: String, error: AXError) {
    if unsupported.insert(k).inserted {
      postAlways(AxUnsupportedEvent(at: nowMs(), bundleId: b, notification: notification,
                                  error: error.rawValue), critical: false)
    }
    // Only the failing target's own session is torn down.
    if k == key { detachNow() }
  }
  // One ax-retryable per context; recheck()/activation consumes needsRetry.
  private func noteRetryable() {
    needsRetry = true
    guard !retryableNoted else { return }
    retryableNoted = true
    postAlways(ErrorEvent(at: nowMs(), code: "ax-retryable",
                          message: "AX operation failed; will retry on next activation or recheck"),
               critical: true)
  }
  private func refreshStep() {
    let g = refreshState.get().gen
    if control.get().appGen == g { refreshNow(gen: g) }
    if refreshState.mutate({ st -> Bool in
      if st.pending { st.pending = false; return true } // stays posted
      st.posted = false; return false
    }) { axQueue.async { self.refreshStep() } }
  }
  private func refreshNow(gen g: Int) {
    guard attachedGen == g, control.get().appGen == g, let obs = observer, let app = appEl else { return }
    func current() -> Bool { control.get().appGen == g }
    let (err, el) = backend.focusedWindow(app)
    guard current() else { return }
    classifyRead(err, Self.focusedNotification)
    guard err == .success || err == .noValue else { return } // stay attached; retry later
    let newWin = err == .success ? el : nil // noValue/success-nil: windowless
    let same = newWin == nil ? windowEl == nil
                             : windowEl != nil && backend.equal(newWin!, windowEl!)
    if same { // identical focus: no reset/focused; feed the title via debounce
      guard control.get().titles, let w = windowEl else { return }
      let stamp = stampNow()
      let (terr, t) = backend.title(w)
      let c = control.get()
      guard current(), c.titles, c.privGen == stamp.priv else { return }
      classifyRead(terr, Self.titleNotification)
      if let t, terr == .success { submitTitle(t, stamp: stamp) }
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
    debouncer.reset()
    cancelTitleFire()
    var title: String? = nil
    if let w = newWin, control.get().titles, isTrusted() {
      let e = backend.add(observer: obs, element: w, notification: Self.titleNotification)
      guard current() else { return }
      if e == .success || e == .notificationAlreadyRegistered { titleSubscribed = true }
      else if isPermanent(e) { markUnsupported(key, bundleId: bundleId, notification: Self.titleNotification, error: e); return }
      else { noteRetryable() }
      let c2 = control.get()
      if c2.titles, c2.privGen == stamp.priv {
        let (terr, t) = backend.title(w)
        let c3 = control.get()
        if c3.titles, c3.privGen == stamp.priv, c3.appGen == g {
          guard classifyRead(terr, Self.titleNotification) else { return }
          if terr == .success { title = t }
        }
      }
    }
    if let t = title { debouncer.markEmitted(t) }
    post(WindowEvent(type: "window.focused", at: nowMs(), pid: pid, bundleId: bundleId, title: title),
         critical: false, stamp: stamp)
  }
  private func titleStep() {
    let (el, g) = titleState.mutate { st -> (B.Element?, Int) in
      let e = st.element; st.element = nil; return (e, st.gen)
    }
    let c = control.get()
    if c.appGen == g, attachedGen == g, c.titles, let w = windowEl, let el, backend.equal(el, w) {
      let (terr, t) = backend.title(w)
      let c2 = control.get()
      if c2.appGen == g, c2.titles, c2.privGen == c.privGen {
        classifyRead(terr, Self.titleNotification)
        if let t, terr == .success { submitTitle(t, stamp: (g, c.winGen, c.privGen)) }
      }
    }
    if titleState.mutate({ st -> Bool in
      if st.element != nil { return true } // stays posted
      st.posted = false; return false
    }) { axQueue.async { self.titleStep() } }
  }
  private func applyTitles() {
    let g = attachedGen // this job manages THIS worker context only
    guard control.get().appGen == g else { return }
    if control.get().titles {
      debouncer.reset()
      guard isTrusted() else { detachNow(); return }
      guard let obs = observer, let w = windowEl else { return }
      let e = backend.add(observer: obs, element: w, notification: Self.titleNotification)
      guard control.get().appGen == g else { return }
      if e == .success || e == .notificationAlreadyRegistered { titleSubscribed = true }
      else if isPermanent(e) { markUnsupported(key, bundleId: bundleId, notification: Self.titleNotification, error: e); return }
      else { noteRetryable() }
      let c = control.get()
      if c.titles {
        let (terr, t) = backend.title(w)
        let c2 = control.get()
        if c2.appGen == g, c2.titles, c2.privGen == c.privGen {
          classifyRead(terr, Self.titleNotification)
          if let t, terr == .success { submitTitle(t, stamp: (g, c.winGen, c.privGen)) }
        }
      }
    } else {
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
           critical: false, stamp: titleFireStamp)
    } else if let deadline = debouncer.pendingDeadline { // fired early: finish the wait
      arm(deadline, stamp: titleFireStamp)
    }
  }
  // Test support (@testable): run when the AX queue has quiesced.
  func drainQueueForTesting() { axQueue.sync {} }
}
