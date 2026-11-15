import XCTest
import ApplicationServices
@testable import SenseHelperCore

// Fake backend; entered/release semaphores create exact mid-IPC races.
private final class FakeAX: AXBackend {
  final class El { let id: Int; init(_ id: Int) { self.id = id } }
  final class Obs { let pid: Int32; init(_ pid: Int32) { self.pid = pid } }
  var windows: [Int32: El] = [:], titles: [Int: String] = [:], errors: [String: AXError] = [:]
  var titleOnce: [Int: String] = [:] // consumed on the first read per window
  var adds: [(Int, String)] = [], removes: [(Int, String)] = []
  var detachCount = 0, fwCalls = 0, titleCalls = 0
  var fwApps: [Int] = [] // app element id per focusedWindow call
  var observers: [Obs] = [], started: [Obs] = [], detached: [Obs] = []
  var fwEntered: DispatchSemaphore?, fwRelease: DispatchSemaphore?
  var titleEntered: DispatchSemaphore?, titleRelease: DispatchSemaphore?
  var addEntered: DispatchSemaphore?, addRelease: DispatchSemaphore?
  func createObserver(pid: Int32) throws -> Obs {
    if let e = errors["create:\(pid)"] { throw AXObserverCreateError(axError: e) }
    let o = Obs(pid); observers.append(o); return o
  }
  func start(_ o: Obs) { started.append(o) }
  func application(pid: Int32) -> El { El(-Int(pid)) }
  func add(observer: Obs, element: El, notification: String) -> AXError {
    adds.append((element.id, notification))
    if let g = addEntered { g.signal(); addRelease?.wait(); addEntered = nil; addRelease = nil }
    return errors["add:\(element.id):\(notification)"] ?? .success
  }
  func remove(observer: Obs, element: El, notification: String) {
    removes.append((element.id, notification))
  }
  func focusedWindow(_ app: El) -> (AXError, El?) {
    fwCalls += 1; fwApps.append(app.id)
    if let g = fwEntered { g.signal(); fwRelease?.wait(); fwEntered = nil; fwRelease = nil }
    let pid = Int32(-app.id)
    if let e = errors["fw:\(pid)"] { return (e, nil) }
    return (.success, windows[pid])
  }
  func title(_ window: El) -> (AXError, String?) {
    titleCalls += 1
    if let g = titleEntered { g.signal(); titleRelease?.wait(); titleEntered = nil; titleRelease = nil }
    if let e = errors["title:\(window.id)"] { return (e, nil) }
    if let o = titleOnce.removeValue(forKey: window.id) { return (.success, o) }
    return (.success, titles[window.id])
  }
  func equal(_ a: El, _ b: El) -> Bool { a.id == b.id }
  func equalObserver(_ a: Obs, _ b: Obs) -> Bool { a === b }
  func detach(_ o: Obs) { detachCount += 1; detached.append(o) }
}

final class AXSessionTests: XCTestCase {
  private typealias S = AXSession<FakeAX>
  private var fake: FakeAX!, session: S!, axQ: DispatchQueue!
  private var events: [[String: Any]] = [], scheduled: [(TimeInterval, DispatchWorkItem)] = []
  private var trusted = true, clock: TimeInterval = 0
  private var pending: [() -> Void] = []
  private func makeSession(captureMain: Bool = false) {
    fake = FakeAX(); events = []; scheduled = []; clock = 0; pending = []
    axQ = DispatchQueue(label: "test.ax")
    session = S(backend: fake, isTrusted: { [self] in trusted }, nowMs: { 7 },
                emit: { [self] e, _ in events.append(Self.dict(e)) },
                queue: axQ, toMain: captureMain ? { [self] in pending.append($0) } : { $0() },
                uptime: { [self] in clock },
                scheduler: { [self] d, i in scheduled.append((clock + d, i)) })
  }
  private static func dict(_ e: any Encodable) -> [String: Any] {
    ((try? JSONSerialization.jsonObject(with: (try! JSONEncoder().encode(e)))) as? [String: Any]) ?? [:]
  }
  // sync drains one queue frontier; loop to reach reposted successors.
  private func drain() { for _ in 0..<8 { session.drainQueueForTesting() } }
  private func ofType(_ t: String) -> [[String: Any]] { events.filter { $0["type"] as? String == t } }
  private func attach(_ p: Int32, _ b: String = "b.x", win: Int? = nil, title: String? = nil) {
    if let w = win { fake.windows[p] = .init(w) }
    if let w = win, let t = title { fake.titles[w] = t }
    session.activate(pid: p, bundleId: b); drain()
  }
  private var obs: FakeAX.Obs { fake.observers.last! }
  private func advance(_ dt: TimeInterval) { // fake clock: run due debounce items
    clock += dt
    for (_, item) in scheduled.filter({ $0.0 <= clock }) { axQ.async(execute: item) }
    scheduled.removeAll { $0.0 <= clock }
    drain()
  }
  // Install the gate FIRST, run `start`, assert IPC entry, `body`, release.
  private func race(_ setGate: (DispatchSemaphore, DispatchSemaphore) -> Void,
                    label: String, start: () -> Void, body: () -> Void) {
    let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
    setGate(entered, release)
    start()
    XCTAssertEqual(entered.wait(timeout: .now() + 2), .success, label)
    body()
    release.signal()
    drain()
  }
  private func raceThroughFwRead(start: () -> Void, body: () -> Void) {
    race({ [self] in fake.fwEntered = $0; fake.fwRelease = $1 },
         label: "focused read must reach IPC", start: start, body: body)
  }
  private func raceThroughAdd(start: () -> Void, body: () -> Void) {
    race({ [self] in fake.addEntered = $0; fake.addRelease = $1 },
         label: "registration must reach IPC", start: start, body: body)
  }
  // Hold the AX queue behind a semaphore; the returned closure releases it.
  private func hold() -> () -> Void {
    let s = DispatchSemaphore(value: 0)
    axQ.async { s.wait() }
    return { s.signal() }
  }

  func testOptionalMainUnsupportedStillEmitsFocusedAndTitle() {
    makeSession()
    fake.errors["add:\(-7):\(S.mainNotification)"] = .notificationUnsupported
    attach(7, win: 1, title: "T1")
    XCTAssertTrue(ofType("ax.unsupported").isEmpty)
    XCTAssertTrue(ofType("error").isEmpty)
    XCTAssertEqual(ofType("window.focused").first?["title"] as? String, "T1")
    XCTAssertTrue(fake.adds.contains { $0.0 == 1 && $0.1 == S.titleNotification })
  }
  func testUnsupportedDedupAndPidKeys() {
    makeSession()
    fake.errors["add:\(-7):\(S.focusedNotification)"] = .notificationUnsupported
    attach(7, "b.u"); attach(7, "b.u")
    let u = ofType("ax.unsupported")
    XCTAssertEqual(u.count, 1)
    XCTAssertEqual(u[0]["bundleId"] as? String, "b.u")
    XCTAssertTrue(ofType("window.focused").isEmpty)
    fake.errors["add:\(-4):\(S.focusedNotification)"] = .notificationUnsupported
    attach(4, "")
    XCTAssertEqual(ofType("ax.unsupported").last?["bundleId"] as? String, "")
    attach(6, "", win: 8)
    XCTAssertEqual(ofType("window.focused").count, 1)
  }
  func testRetryableFailuresRecoverOnActivateAndRecheck() {
    makeSession()
    fake.errors["add:\(-9):\(S.focusedNotification)"] = .cannotComplete
    attach(9, "b.r")
    XCTAssertTrue(ofType("ax.unsupported").isEmpty)
    XCTAssertEqual(ofType("error").first?["code"] as? String, "ax-retryable")
    XCTAssertFalse(session.isAttached)
    fake.errors.removeAll()
    attach(9, "b.r", win: 2, title: "W")
    XCTAssertEqual(ofType("window.focused").count, 1)
    fake.errors["add:3:\(S.titleNotification)"] = .cannotComplete
    attach(7, win: 3)
    XCTAssertEqual(ofType("error").last?["code"] as? String, "ax-retryable")
    fake.errors.removeAll()
    session.recheck(pid: 7, bundleId: "b.x"); drain()
    XCTAssertEqual(fake.adds.filter { $0.0 == 3 && $0.1 == S.titleNotification }.count, 2,
                   "recheck must re-register the title observation")
    XCTAssertEqual(ofType("window.focused").count, 3)
  }
  func testPermissionRevokeDetachAndRegrantRetry() {
    trusted = false
    makeSession()
    attach(5, "b.p")
    XCTAssertTrue(fake.adds.isEmpty, "untrusted must not register")
    trusted = true
    attach(5, "b.p", win: 3)
    XCTAssertEqual(ofType("window.focused").count, 1)
    trusted = false
    session.recheck(pid: 5, bundleId: "b.p"); drain()
    XCTAssertFalse(session.isAttached)
    XCTAssertGreaterThanOrEqual(fake.detachCount, 1)
    trusted = true
    attach(5, "b.p", win: 3, title: "again")
    XCTAssertEqual(ofType("window.focused").count, 2)
  }
  func testReadErrorClassificationAndNoValue() {
    makeSession()
    attach(7, win: 1, title: "A")
    fake.errors["fw:7"] = .cannotComplete
    session.notify(S.focusedNotification, observer: obs, element: .init(1)); drain()
    XCTAssertEqual(ofType("error").first?["code"] as? String, "ax-retryable")
    XCTAssertTrue(session.isAttached)
    fake.errors.removeValue(forKey: "fw:7"); fake.errors["title:1"] = .cannotComplete
    session.notify(S.titleNotification, observer: obs, element: .init(1)); drain()
    XCTAssertEqual(ofType("error").count, 1, "ax-retryable emits once per context")
    fake.errors["fw:7"] = .noValue
    session.notify(S.focusedNotification, observer: obs, element: .init(1)); drain()
    XCTAssertTrue(ofType("ax.unsupported").isEmpty)
    XCTAssertEqual(ofType("error").count, 1, "noValue is windowless, not an error")
    fake.errors["fw:7"] = .attributeUnsupported
    session.notify(S.focusedNotification, observer: obs, element: .init(1)); drain()
    XCTAssertEqual(ofType("ax.unsupported").count, 1)
    XCTAssertFalse(session.isAttached)
  }
  // #5: focus A -> B re-subscribes title; same-window keeps the debounce.
  func testWindowIdentityRules() {
    makeSession()
    attach(7, win: 1, title: "A")
    fake.windows[7] = .init(2); fake.titles[2] = "B"
    session.notify(S.focusedNotification, observer: obs, element: .init(2)); drain()
    let fw = ofType("window.focused")
    XCTAssertEqual(fw.count, 2)
    XCTAssertEqual(fw[1]["title"] as? String, "B")
    XCTAssertTrue(fake.removes.contains { $0.0 == 1 && $0.1 == S.titleNotification })
    XCTAssertTrue(fake.adds.contains { $0.0 == 2 && $0.1 == S.titleNotification })
    fake.titles[2] = "B2" // same window: no focused; title feeds the debounce
    session.notify(S.mainNotification, observer: obs, element: .init(2)); drain()
    XCTAssertEqual(ofType("window.focused").count, 2)
    XCTAssertTrue(ofType("window.title").isEmpty, "updated title stays debounced")
    advance(0.3)
    XCTAssertEqual(ofType("window.title").first?["title"] as? String, "B2")
  }
  // #9/A: titles off mid-read flips synchronously; stale reads never deliver.
  func testTitlesOffWhileBlockedReadNeverDelivers() {
    makeSession()
    attach(7, win: 1, title: "A")
    let baseCalls = fake.titleCalls
    fake.titles[1] = "B"
    race({ [self] in fake.titleEntered = $0; fake.titleRelease = $1 },
         label: "title read must reach IPC",
         start: { self.session.notify(S.titleNotification, observer: self.obs, element: .init(1)) },
         body: {
           self.session.setTitlesEnabled(false) // flips NOW, on the caller
           XCTAssertFalse(self.session.titlesEnabled)
         })
    XCTAssertEqual(fake.titleCalls, baseCalls + 1, "no further AXTitle read while off")
    XCTAssertTrue(fake.removes.contains { $0.0 == 1 && $0.1 == S.titleNotification })
    advance(1.0)
    XCTAssertTrue(ofType("window.title").isEmpty, "stale read and pending debounce die")
    // Phase 2 (#9): an actual armed debounce is cancelled by the toggle.
    session.setTitlesEnabled(true); drain()
    fake.titles[1] = "B"
    session.notify(S.titleNotification, observer: obs, element: .init(1)); drain()
    XCTAssertFalse(scheduled.isEmpty, "debounce work must be captured by the scheduler")
    session.setTitlesEnabled(false)
    advance(1.0)
    XCTAssertTrue(ofType("window.title").isEmpty, "armed debounce must not emit while off")
  }
  // A: activation mid-IPC supersedes blocked reads and registrations.
  func testActivationSupersedesBlockedWork() {
    makeSession()
    attach(7, win: 1, title: "A")
    raceThroughFwRead(
      start: { self.session.notify(S.focusedNotification, observer: self.obs, element: .init(1)) },
      body: { self.session.activate(pid: 8, bundleId: "b.2") })
    XCTAssertEqual(ofType("window.focused").count, 1,
                 "the blocked pre-activation refresh must be dropped")
    fake.windows[8] = .init(2); fake.titles[2] = "W2"
    session.notify(S.focusedNotification, observer: obs, element: .init(2)); drain()
    XCTAssertEqual(ofType("window.focused").last?["pid"] as? Int, 8)
    makeSession()
    raceThroughAdd(
      start: { self.session.activate(pid: 7, bundleId: "b.x") },
      body: { self.session.activate(pid: 8, bundleId: "b.2") })
    let stale = fake.observers[0]
    XCTAssertTrue(fake.detached.contains { $0 === stale }, "obsolete observer detached")
    XCTAssertFalse(fake.started.contains { $0 === stale }, "obsolete observer never started")
    XCTAssertEqual(fake.fwApps, [-8], "only the new attach ran a focused read")
    fake.windows[8] = .init(2)
    session.notify(S.focusedNotification, observer: obs, element: .init(2)); drain()
    let fw = ofType("window.focused")
    XCTAssertEqual(fw.count, 1)
    XCTAssertEqual(fw[0]["pid"] as? Int, 8)
    XCTAssertTrue(session.isAttached)
  }
  // A/B: termination mid-IPC detaches NOW (read-blocked and add-blocked).
  func testTerminationMidIPCDetachesImmediately() {
    makeSession()
    attach(7, win: 1, title: "A")
    let detachBefore = fake.detachCount
    raceThroughFwRead(
      start: { self.session.notify(S.focusedNotification, observer: self.obs, element: .init(1)) },
      body: {
        self.session.appTerminated(pid: 7)
        XCTAssertFalse(self.session.isAttached, "logical detach is synchronous")
      })
    XCTAssertGreaterThan(fake.detachCount, detachBefore, "resource detach ran on the queue")
    XCTAssertEqual(ofType("window.focused").count, 1, "stale refresh dropped")
    session.notify(S.focusedNotification, observer: obs, element: .init(1)); drain()
    XCTAssertEqual(ofType("window.focused").count, 1, "post-termination notifies are gated")
    makeSession()
    raceThroughAdd(
      start: { self.session.activate(pid: 7, bundleId: "b.x") },
      body: {
        self.session.appTerminated(pid: 7)
        XCTAssertFalse(self.session.isAttached, "logical detach is synchronous")
      })
    XCTAssertFalse(session.isAttached)
    XCTAssertTrue(fake.detached.contains { $0 === fake.observers[0] })
    XCTAssertFalse(fake.started.contains { $0 === fake.observers[0] })
    XCTAssertTrue(ofType("window.focused").isEmpty)
    XCTAssertEqual(fake.fwCalls, 0)
  }
  // A: a blocked snapshot is superseded by activation or titles-off.
  func testSnapshotBlockedReadSupersededAndPrivacyOff() {
    makeSession(captureMain: true)
    attach(7, win: 1, title: "A")
    pending.removeAll()
    var result: (String, String?)?
    let baseTitles = fake.titleCalls
    raceThroughFwRead(
      start: { self.session.snapshot(pid: 7, bundleId: "b.x") { s, t in result = (s, t) } },
      body: { self.session.activate(pid: 8, bundleId: "b.2") })
    pending.forEach { $0() }
    XCTAssertEqual(result?.0, "unknown")
    XCTAssertNil(result?.1)
    XCTAssertEqual(fake.titleCalls, baseTitles, "superseded snapshot must not read AXTitle")
    makeSession()
    attach(7, win: 1, title: "A")
    result = nil
    let afterAttach = fake.titleCalls
    raceThroughFwRead(
      start: { self.session.snapshot(pid: 7, bundleId: "b.x") { s, t in result = (s, t) } },
      body: { self.session.setTitlesEnabled(false) })
    XCTAssertEqual(result?.0, "ok")
    XCTAssertNil(result?.1)
    XCTAssertEqual(fake.titleCalls, afterAttach, "no AXTitle read after the toggle")
  }
  func testStaleObserverEventsAreIgnored() {
    makeSession()
    attach(7, win: 1)
    let oldObs = obs
    attach(8, "b.2", win: 2)
    let calls = fake.fwCalls
    session.notify(S.focusedNotification, observer: oldObs, element: .init(2)); drain()
    XCTAssertEqual(fake.fwCalls, calls, "stale observer notifications must not schedule work")
    session.notify(S.focusedNotification, observer: obs, element: .init(2)); drain()
    XCTAssertEqual(fake.fwCalls, calls + 1)
  }
  // C: pending deliveries die at revocation and at the detach winGen bump.
  func testInvalidationDropsPendingDeliveries() {
    makeSession(captureMain: true)
    attach(7, win: 1, title: "A")
    XCTAssertEqual(pending.count, 1) // the focused post is held on "main"
    trusted = false
    session.recheck(pid: 7, bundleId: "b.x")
    pending[0]()
    XCTAssertTrue(events.isEmpty, "deliveries die at revocation, not at queued detach")
    drain()
    XCTAssertFalse(session.isAttached)
    pending.removeAll(); events = []
    trusted = true
    attach(9, "b.9", win: 3, title: "OK")
    XCTAssertEqual(pending.count, 1, "focused post is held on main")
    fake.errors["fw:9"] = .attributeUnsupported
    session.notify(S.focusedNotification, observer: obs, element: .init(3)); drain()
    pending.forEach { $0() }
    XCTAssertTrue(ofType("window.focused").isEmpty,
                  "held focused is invalidated by the detach winGen bump")
    XCTAssertEqual(ofType("ax.unsupported").count, 1)
  }
  func testNotificationsCoalesceToOneOutstandingRefresh() {
    makeSession()
    attach(7, win: 1)
    let base = fake.fwCalls
    raceThroughFwRead(
      start: { for _ in 0..<5 { self.session.notify(S.focusedNotification, observer: self.obs, element: .init(1)) } },
      body: {})
    XCTAssertLessThanOrEqual(fake.fwCalls - base, 2)
  }
  // A: a privacy toggle mid-registration keeps the attach but skips all
  // title work; the scripted title error is never consulted.
  func testPrivacyOffDuringRegistrationKeepsAttachNoTitle() {
    makeSession()
    fake.windows[7] = .init(1)
    fake.errors["title:1"] = .attributeUnsupported // must never be consulted
    raceThroughAdd(
      start: { self.session.activate(pid: 7, bundleId: "b.x") },
      body: { self.session.setTitlesEnabled(false) })
    XCTAssertTrue(session.isAttached, "attach survives a privacy toggle")
    let fw = ofType("window.focused")
    XCTAssertEqual(fw.count, 1)
    XCTAssertNil(fw[0]["title"], "focused carries no title while off")
    XCTAssertEqual(fake.titleCalls, 0, "no AXTitle read while off")
    XCTAssertFalse(fake.adds.contains { $0.1 == S.titleNotification })
    XCTAssertTrue(ofType("ax.unsupported").isEmpty, "unread title error must not mark unsupported")
    var result: (String, String?)?
    session.snapshot(pid: 7, bundleId: "b.x") { s, t in result = (s, t) }
    drain()
    XCTAssertEqual(result?.0, "ok")
    XCTAssertNil(result?.1)
    XCTAssertEqual(fake.titleCalls, 0, "snapshot must not read AXTitle while off")
    XCTAssertTrue(ofType("ax.unsupported").isEmpty)
  }
  // A cancelled pending attach frees the queued slot; a stale gated cleanup
  // must not detach a newer attach.
  func testCancelledPendingAttachDoesNotWedgeOrTeardown() {
    makeSession()
    fake.windows[8] = .init(2)
    var release = hold()
    session.activate(pid: 7, bundleId: "b.x")
    session.appTerminated(pid: 7) // cancels args AND queues a gated detach
    release()
    drain()
    XCTAssertFalse(session.isAttached)
    session.activate(pid: 8, bundleId: "b.2"); drain()
    XCTAssertTrue(session.isAttached, "attach after cancelled pending must run")
    session.notify(S.focusedNotification, observer: obs, element: .init(2)); drain()
    XCTAssertEqual(ofType("window.focused").last?["pid"] as? Int, 8)
    release = hold()
    session.activate(pid: 7, bundleId: "b.x")
    session.appTerminated(pid: 7)   // gated cleanup queued behind the attach
    session.activate(pid: 8, bundleId: "b.2")
    release()
    drain()
    XCTAssertTrue(session.isAttached)
    XCTAssertFalse(fake.detached.contains { $0 === obs },
                   "stale cleanup must not detach the newer attach")
  }
  func testPermanentTitleFailureOnFirstFocusEmitsNoFocused() {
    makeSession(captureMain: true)
    fake.windows[7] = .init(1)
    fake.errors["title:1"] = .attributeUnsupported
    attach(7)
    pending.forEach { $0() }
    XCTAssertEqual(ofType("ax.unsupported").count, 1)
    XCTAssertTrue(ofType("window.focused").isEmpty, "no focused, never pid0/empty bundle")
    XCTAssertFalse(session.isAttached)
  }
  // Off->on mid-title-read discards the stale result via privGen.
  func testPrivacyToggleDropsStaleTitleReadNotRetagged() {
    makeSession()
    attach(7, win: 1, title: "A")
    fake.titleOnce[1] = "STALE" // first read returns STALE, later reads FRESH
    fake.titles[1] = "FRESH"
    race({ [self] in fake.titleEntered = $0; fake.titleRelease = $1 },
         label: "title read must reach IPC",
         start: { self.session.notify(S.titleNotification, observer: self.obs, element: .init(1)) },
         body: {
           self.session.setTitlesEnabled(false)
           self.session.setTitlesEnabled(true) // off->on: privGen moved twice
         })
    session.notify(S.titleNotification, observer: obs, element: .init(1)); drain()
    advance(1.0)
    XCTAssertEqual(ofType("window.title").compactMap { $0["title"] as? String },
                 ["FRESH"], "stale pre-toggle title must never emit")
  }
}
