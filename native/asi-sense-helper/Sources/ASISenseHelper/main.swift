import AppKit
import ApplicationServices
import Foundation
import SenseHelperCore

private func nowMs() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }
private func accessibilityTrusted() -> Bool { AXIsProcessTrusted() }
private func permissionState() -> String { accessibilityTrusted() ? "granted" : "denied" }

// Main owns NSWorkspace subscriptions and lifecycle; CommandChannel owns the
// bounded stdin/stdout plumbing, privacy switching and acks; AX IPC lives on
// the session queue.
final class HelperRuntime {
  private let channel = CommandChannel(queue: .main, nowMs: nowMs)
  private var session: AXSession<SystemAXBackend>!
  private var workspaceTokens: [NSObjectProtocol] = []
  private var centerTokens: [(NotificationCenter, NSObjectProtocol)] = []
  private var stopping = false

  func start() {
    let backend = SystemAXBackend()
    let session = AXSession(backend: backend, isTrusted: accessibilityTrusted, nowMs: nowMs,
                            emit: { [weak self] event in self?.emit(event) },
                            emitFocus: { [weak self] event, done in
      guard let self, !self.stopping else { done(false); return }
      self.channel.sendFocus(event, completion: done)
    })
    self.session = session
    backend.callback = { [weak session] obs, element, name in
      session?.notify(name, observer: obs, element: element)
    }
    channel.onTitles = { [weak self] on in self?.session.setTitlesEnabled(on) ?? -1 }
    channel.onTitlesApplied = { [weak self] in self?.session.retryUndeliveredFocus() }
    channel.onCommand = { [weak self] cmd, done in self?.execute(cmd, done: done) }
    channel.onQuit = { [weak self] in self?.shutdown(exitCode: 0, drainAll: true) }
    channel.onEOF = { [weak self] in self?.shutdown(exitCode: 0) }
    channel.onEOFDetected = { armExitDeadline() }
    channel.onFatal = { exit(1) }
    emitHello()
    emitThermal()
    registerObservers()
    channel.start()
    if let app = NSWorkspace.shared.frontmostApplication {
      session.activate(pid: app.processIdentifier, bundleId: app.bundleIdentifier ?? "")
    }
  }

  private func emit<E: Encodable>(_ event: E) {
    guard !stopping else { return }
    channel.send(event)
  }
  private func emitHello() {
    emit(HelloEvent(at: nowMs(), pid: ProcessInfo.processInfo.processIdentifier,
                    session: channel.session,
                    permissions: .init(accessibility: permissionState())))
  }
  private func emitApp(_ type: String, _ a: NSRunningApplication) {
    emit(AppEvent(type: type, at: nowMs(), name: a.localizedName ?? "",
                  bundleId: a.bundleIdentifier ?? "", pid: a.processIdentifier))
  }
  private func emitThermal() {
    guard let state = Self.thermalString(ProcessInfo.processInfo.thermalState) else {
      channel.emitError("thermal-state", "unrecognized thermal state")
      return
    }
    emit(ThermalEvent(at: nowMs(), state: state))
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

  private func execute(_ command: Command, done: @escaping () -> Void) {
    switch command {
    case .snapshot:
      emitSnapshot(done: done)
    case .recheckPermissions:
      emitHello()
      let app = NSWorkspace.shared.frontmostApplication
      session.recheck(pid: app?.processIdentifier ?? 0, bundleId: app?.bundleIdentifier ?? "")
      done()
    case .titles, .quit: // controls never reach the ordinary path
      done()
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
      if thermal == "unknown" { self.channel.emitError("thermal-state", "unrecognized thermal state") }
      self.emit(SnapshotEvent(at: nowMs(), frontApp: frontApp, focusedWindow: fw,
                              thermal: thermal, permissions: .init(accessibility: permissionState())))
      done()
    }
    guard frontApp != nil else { finish("unknown", nil); return }
    session.snapshot(pid: pid, bundleId: bid) { status, title in finish(status, title) }
  }
  func shutdown(exitCode: Int32, drainAll: Bool = false) {
    guard !stopping else { return }
    stopping = true
    channel.stopInput()
    for token in workspaceTokens { NSWorkspace.shared.notificationCenter.removeObserver(token) }
    for (center, token) in centerTokens { center.removeObserver(token) }
    session.shutdown()              // posts local teardown to the AX queue; never blocks on AX IPC
    channel.flushOutput(deadline: drainAll ? .infinity : 0.2) // quit drains; EOF has a deadline
    channel.closeOutput()
    exit(exitCode)
  }
  func terminateFromControlQueue() {
    channel.stopInput()
    channel.flushOutput(deadline: 0.2)
    exit(0)
  }
}

signal(SIGPIPE, SIG_IGN)
signal(SIGTERM, SIG_IGN)

let runtime = HelperRuntime()

// Independent control queue handles SIGTERM without waiting for main or AX.
let controlQueue = DispatchQueue(label: "asi-sense-helper.control")
let sigtermSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: controlQueue)
sigtermSource.setEventHandler {
  DispatchQueue.global().asyncAfter(deadline: .now() + 0.25) { exit(0) }
  runtime.terminateFromControlQueue()
}
sigtermSource.resume()

// Armed at EOF detection: bounds exit to ~200ms even if a command's AX work
// stalls; the normal shutdown path finishes first and is gone anyway.
private var deadlineArmed = false
func armExitDeadline() {
  guard !deadlineArmed else { return }
  deadlineArmed = true
  DispatchQueue.global().asyncAfter(deadline: .now() + 0.2) { exit(0) }
}

runtime.start()
RunLoop.main.run()
