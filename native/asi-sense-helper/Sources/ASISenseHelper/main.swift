import AppKit
import ApplicationServices
import Foundation
import SenseHelperCore

private func nowMs() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }
private func accessibilityTrusted() -> Bool { AXIsProcessTrusted() }
private func permissionState() -> String { accessibilityTrusted() ? "granted" : "denied" }

// Main owns NSWorkspace subscriptions, NDJSON framing, privacy encoding and
// lifecycle; AX IPC lives on the session queue, stdin/stdout are bounded.
final class HelperRuntime {
  private var encoder = LineEncoder()
  private let writer = OutputWriter(fd: STDOUT_FILENO)
  private var reader: InputReader!
  private var session: AXSession<SystemAXBackend>!
  private var workspaceTokens: [NSObjectProtocol] = []
  private var centerTokens: [(NotificationCenter, NSObjectProtocol)] = []
  private var stopping = false, titlesEnabled = true

  func start() {
    let backend = SystemAXBackend()
    let session = AXSession(backend: backend, isTrusted: accessibilityTrusted, nowMs: nowMs) {
      [weak self] event, critical in self?.emit(event, critical: critical)
    }
    self.session = session
    backend.callback = { [weak session] obs, element, name in
      session?.notify(name, observer: obs, element: element)
    }
    writer.onFatal = { exit(1) }
    // Fires on the writer queue; encoder/privacy state is main-owned, so hop.
    writer.onDropsRecovered = { [weak self] n in
      DispatchQueue.main.async { [weak self] in
        self?.emit(ErrorEvent(at: nowMs(), code: "output_overflow",
                              message: "stdout backpressure dropped queued events", dropped: n),
                   critical: true)
      }
    }
    let reader = InputReader(queue: .main)
    self.reader = reader
    reader.onLine = { [weak self] line, done in self?.processLine(line, done: done) }
    reader.onError = { [weak self] code in
      self?.emitError(code, code == "input_overflow" ? "stdin backlog exceeds 256KiB"
                                                   : "command line exceeds 64KiB")
    }
    reader.onEOFDetected = { armExitDeadline() }
    reader.onEOF = { [weak self] in self?.shutdown(exitCode: 0) }
    emitHello()
    emitThermal()
    registerObservers()
    reader.start()
    if let app = NSWorkspace.shared.frontmostApplication {
      session.activate(pid: app.processIdentifier, bundleId: app.bundleIdentifier ?? "")
    }
  }

  private func emit<E: Encodable>(_ event: E, critical: Bool = false) {
    guard !stopping, let line = try? encoder.encodeLine(event) else { return }
    writer.enqueue(line, critical: critical,
                   hasTitle: encoder.titlesEnabled && line.range(of: Data(#""title""#.utf8)) != nil)
  }
  private func emitHello() {
    emit(HelloEvent(at: nowMs(), pid: ProcessInfo.processInfo.processIdentifier,
                    permissions: .init(accessibility: permissionState())), critical: true)
  }
  private func emitApp(_ type: String, _ a: NSRunningApplication) {
    emit(AppEvent(type: type, at: nowMs(), name: a.localizedName ?? "",
                  bundleId: a.bundleIdentifier ?? "", pid: a.processIdentifier))
  }
  private func emitThermal() {
    guard let state = Self.thermalString(ProcessInfo.processInfo.thermalState) else {
      emitError("thermal-state", "unrecognized thermal state")
      return
    }
    emit(ThermalEvent(at: nowMs(), state: state))
  }
  private func emitError(_ code: String, _ message: String) {
    emit(ErrorEvent(at: nowMs(), code: code, message: message), critical: true)
  }
  static func thermalString(_ state: ProcessInfo.ThermalState) -> String? {
    switch state {
    case .nominal: return "nominal"
    case .fair: return "fair"
    case .serious: return "serious"
    case .critical: return "critical"
    default: return nil
    }
  }
  private func registerObservers() {
    let wnc = NSWorkspace.shared.notificationCenter
    func ws(_ name: Notification.Name, _ body: @escaping (Notification) -> Void) {
      workspaceTokens.append(wnc.addObserver(forName: name, object: nil, queue: .main, using: body))
    }
    func app(_ n: Notification) -> NSRunningApplication? {
      n.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
    }
    ws(NSWorkspace.didActivateApplicationNotification) { [weak self] n in
      guard let a = app(n) else { return }
      self?.emitApp("app.activated", a)
      self?.session.activate(pid: a.processIdentifier, bundleId: a.bundleIdentifier ?? "")
    }
    ws(NSWorkspace.didLaunchApplicationNotification) { [weak self] n in
      if let a = app(n) { self?.emitApp("app.launched", a) }
    }
    ws(NSWorkspace.didTerminateApplicationNotification) { [weak self] n in
      guard let a = app(n) else { return }
      self?.emitApp("app.terminated", a)
      self?.session.appTerminated(pid: a.processIdentifier)
    }
    for (name, type) in [(NSWorkspace.willSleepNotification, "power.sleep"),
                         (NSWorkspace.didWakeNotification, "power.wake"),
                         (NSWorkspace.sessionDidBecomeActiveNotification, "session.active"),
                         (NSWorkspace.sessionDidResignActiveNotification, "session.inactive")] {
      ws(name) { [weak self] _ in self?.emit(SimpleEvent(type: type, at: nowMs())) }
    }
    let dnc = DistributedNotificationCenter.default()
    for (name, type) in [("com.apple.screenIsLocked", "screen.locked"),
                         ("com.apple.screenIsUnlocked", "screen.unlocked")] {
      centerTokens.append((dnc, dnc.addObserver(forName: .init(name), object: nil, queue: .main) { [weak self] _ in
        self?.emit(SimpleEvent(type: type, at: nowMs()))
      }))
    }
    centerTokens.append((.default, NotificationCenter.default.addObserver(
      forName: ProcessInfo.thermalStateDidChangeNotification, object: nil, queue: .main
    ) { [weak self] _ in self?.emitThermal() }))
  }

  private func processLine(_ line: Data, done: @escaping () -> Void) {
    if line.count > CommandParser.maxLineBytes {
      emitError("line-too-long", "command line exceeds 64KiB")
      done()
      return
    }
    switch CommandParser.parse(line) {
    case .ok(let command): execute(command, done: done)
    case .error(let code, let message): emitError(code, message); done()
    }
  }
  private func execute(_ command: Command, done: @escaping () -> Void) {
    switch command {
    case .snapshot:
      emitSnapshot(done: done)
    case .titles(let on):
      setTitlesEnabled(on)
      done()
    case .recheckPermissions:
      emitHello()
      let app = NSWorkspace.shared.frontmostApplication
      session.recheck(pid: app?.processIdentifier ?? 0, bundleId: app?.bundleIdentifier ?? "")
      done()
    case .quit:
      done()
      shutdown(exitCode: 0)
    }
  }
  private func emitSnapshot(done: @escaping () -> Void) {
    var frontApp: SnapshotEvent.FrontApp?, pid: Int32 = 0, bid = ""
    if let app = NSWorkspace.shared.frontmostApplication {
      pid = app.processIdentifier; bid = app.bundleIdentifier ?? ""
      frontApp = .init(name: app.localizedName ?? "", bundleId: bid, pid: pid)
    }
    let finish = { (status: String, title: String?) in
      let fw = frontApp.map {
        SnapshotEvent.FocusedWindow(pid: $0.pid, bundleId: $0.bundleId, status: status, title: title)
      }
      let thermal = Self.thermalString(ProcessInfo.processInfo.thermalState) ?? "unknown"
      if thermal == "unknown" { self.emitError("thermal-state", "unrecognized thermal state") }
      self.emit(SnapshotEvent(at: nowMs(), frontApp: frontApp, focusedWindow: fw,
                              thermal: thermal, permissions: .init(accessibility: permissionState())))
      done()
    }
    guard frontApp != nil else { finish("unknown", nil); return }
    session.snapshot(pid: pid, bundleId: bid) { status, title in finish(status, title) }
  }
  private func setTitlesEnabled(_ on: Bool) {
    guard on != titlesEnabled else { return }
    titlesEnabled = on
    encoder.titlesEnabled = on
    if !on { writer.purgeUnstartedTitles() } // queued pre-toggle title lines cannot leak
    session.setTitlesEnabled(on)
  }
  func shutdown(exitCode: Int32) {
    guard !stopping else { return }
    stopping = true
    reader.stop()
    for token in workspaceTokens { NSWorkspace.shared.notificationCenter.removeObserver(token) }
    for (center, token) in centerTokens { center.removeObserver(token) }
    session.shutdown()          // posts local teardown to the AX queue; never blocks on AX IPC
    writer.flush(deadline: 0.2) // deliver only what the pipe accepts within the deadline
    writer.close()
    exit(exitCode)
  }
}

signal(SIGPIPE, SIG_IGN)
signal(SIGTERM, SIG_IGN)

let runtime = HelperRuntime()

// Independent control queue: SIGTERM/EOF deadline exit directly, no locks.
let controlQueue = DispatchQueue(label: "asi-sense-helper.control")
let sigtermSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: controlQueue)
sigtermSource.setEventHandler { exit(0) }
sigtermSource.resume()

// Armed at EOF detection: bounds exit to ~1s even if a command's AX work
// stalls; the normal shutdown path finishes first and is gone anyway.
private var deadlineArmed = false
func armExitDeadline() {
  guard !deadlineArmed else { return }
  deadlineArmed = true
  controlQueue.asyncAfter(deadline: .now() + 0.75) { exit(0) }
}

runtime.start()
RunLoop.main.run()
