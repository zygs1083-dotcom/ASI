import AppKit
import ApplicationServices
import Foundation
import SenseHelperCore

private func nowMs() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }
private func accessibilityTrusted() -> Bool { AXIsProcessTrusted() }
private func permissionState() -> String { accessibilityTrusted() ? "granted" : "denied" }

private func axObserverCallback(_ observer: AXObserver, _ element: AXUIElement,
                                _ name: CFString, _ refcon: UnsafeMutableRawPointer?) {
  guard let refcon else { return }
  let runtime = Unmanaged<HelperRuntime>.fromOpaque(refcon).takeUnretainedValue()
  DispatchQueue.main.async {
    runtime.handleAXNotification(observer: observer, element: element, name: name as String)
  }
}

final class HelperRuntime {
  private var encoder = LineEncoder()
  private let stdout = FileHandle.standardOutput
  private var stdinBuffer = Data(), workspaceTokens: [NSObjectProtocol] = []
  private var centerTokens: [(NotificationCenter, NSObjectProtocol)] = []
  private var stopping = false, titlesEnabled = true, discardingOversizedLine = false

  private var axObserver: AXObserver?, axAppElement: AXUIElement?, axWindowElement: AXUIElement?
  private var axPid: pid_t = 0, axBundleId = ""
  private var unsupportedApps = Set<String>()
  private var debouncer = TitleDebouncer(), titleWorkItem: DispatchWorkItem?
  private var scheduledDeadline: TimeInterval?

  func start() {
    emitHello()
    emitThermal()
    registerObservers()
    startStdinReader()
    if let app = NSWorkspace.shared.frontmostApplication { attachAX(to: app) }
  }

  private func emit<E: Encodable>(_ event: E) {
    guard !stopping, let line = try? encoder.encodeLine(event) else { return }
    do { try stdout.write(contentsOf: line) } catch { shutdown(exitCode: 1) }
  }
  private func emitHello() {
    emit(HelloEvent(at: nowMs(), pid: ProcessInfo.processInfo.processIdentifier,
                    permissions: .init(accessibility: permissionState())))
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
      self?.attachAX(to: a)
    }
    ws(NSWorkspace.didLaunchApplicationNotification) { [weak self] n in
      if let a = app(n) { self?.emitApp("app.launched", a) }
    }
    ws(NSWorkspace.didTerminateApplicationNotification) { [weak self] n in
      if let a = app(n) { self?.emitApp("app.terminated", a) }
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
  private func startStdinReader() {
    FileHandle.standardInput.readabilityHandler = { [weak self] handle in
      let chunk = handle.availableData
      DispatchQueue.main.async { self?.consumeStdin(chunk) }
    }
  }
  private func consumeStdin(_ chunk: Data) {
    guard !stopping else { return }
    if chunk.isEmpty { // EOF: trailing bytes are processed as a final command line
      if !discardingOversizedLine, !stdinBuffer.isEmpty { processLine(stdinBuffer) }
      shutdown(exitCode: 0)
      return
    }
    stdinBuffer.append(chunk)
    if discardingOversizedLine {
      guard let nl = stdinBuffer.firstIndex(of: 0x0A) else {
        stdinBuffer.removeAll()
        return
      }
      stdinBuffer.removeSubrange(stdinBuffer.startIndex...nl)
      discardingOversizedLine = false
    }
    while let nl = stdinBuffer.firstIndex(of: 0x0A) {
      var line = stdinBuffer.subdata(in: stdinBuffer.startIndex..<nl)
      stdinBuffer.removeSubrange(stdinBuffer.startIndex...nl)
      if line.last == 0x0D { line.removeLast() }
      processLine(line)
      guard !stopping else { return }
    }
    if stdinBuffer.count > CommandParser.maxLineBytes {
      stdinBuffer.removeAll()
      emitError("line-too-long", "command line exceeds 64KiB")
      discardingOversizedLine = true
    }
  }

  private func processLine(_ line: Data) {
    if line.count > CommandParser.maxLineBytes {
      emitError("line-too-long", "command line exceeds 64KiB")
      return
    }
    switch CommandParser.parse(line) {
    case .ok(let command): execute(command)
    case .error(let code, let message): emitError(code, message)
    }
  }
  private func emitError(_ code: String, _ message: String) {
    emit(ErrorEvent(at: nowMs(), code: code, message: message))
  }
  private func execute(_ command: Command) {
    switch command {
    case .snapshot:
      emitSnapshot()
    case .titles(let on):
      setTitlesEnabled(on)
    case .recheckPermissions:
      emitHello()
      if accessibilityTrusted() {
        if axObserver == nil, let app = NSWorkspace.shared.frontmostApplication {
          attachAX(to: app)
        }
      } else {
        detachAX() // trust revoked since attach: drop the stale observer
      }
    case .quit:
      shutdown(exitCode: 0)
    }
  }
  private func emitSnapshot() {
    var frontApp: SnapshotEvent.FrontApp?
    var focusedWindow: SnapshotEvent.FocusedWindow?
    if let app = NSWorkspace.shared.frontmostApplication {
      let bundleId = app.bundleIdentifier ?? ""
      frontApp = .init(name: app.localizedName ?? "", bundleId: bundleId, pid: app.processIdentifier)
      var status = "unknown", title: String?, value: CFTypeRef?
      if !accessibilityTrusted() {
        status = "denied"
      } else if unsupportedApps.contains(bundleId) {
        status = "unsupported"
      } else if AXUIElementCopyAttributeValue(AXUIElementCreateApplication(app.processIdentifier),
                                             kAXFocusedWindowAttribute as CFString, &value) == .success,
                let value, CFGetTypeID(value) == AXUIElementGetTypeID() {
        status = "ok"
        if titlesEnabled { title = readWindowTitle(value as! AXUIElement) }
      }
      focusedWindow = .init(pid: app.processIdentifier, bundleId: bundleId, status: status, title: title)
    }
    let thermal = Self.thermalString(ProcessInfo.processInfo.thermalState) ?? "unknown"
    if thermal == "unknown" { emitError("thermal-state", "unrecognized thermal state") }
    emit(SnapshotEvent(at: nowMs(), frontApp: frontApp, focusedWindow: focusedWindow,
                       thermal: thermal, permissions: .init(accessibility: permissionState())))
  }
  private func setTitlesEnabled(_ on: Bool) {
    guard on != titlesEnabled else { return }
    titlesEnabled = on
    encoder.titlesEnabled = on
    if on {
      debouncer.reset()
      guard accessibilityTrusted() else { detachAX(); return }
      if let observer = axObserver, let window = axWindowElement {
        let err = AXObserverAddNotification(observer, window, kAXTitleChangedNotification as CFString, axRefcon())
        guard err == .success || err == .notificationAlreadyRegistered else {
          markUnsupported(axBundleId, notification: kAXTitleChangedNotification as String, error: err.rawValue)
          return
        }
        if let title = readWindowTitle(window) { submitTitle(title) }
      }
    } else {
      debouncer.cancelPending()
      cancelTitleWork()
      if let observer = axObserver, let window = axWindowElement {
        AXObserverRemoveNotification(observer, window, kAXTitleChangedNotification as CFString)
      }
    }
  }

  private func axRefcon() -> UnsafeMutableRawPointer {
    Unmanaged.passUnretained(self).toOpaque()
  }
  private func attachAX(to app: NSRunningApplication) {
    detachAX()
    debouncer.reset()
    let pid = app.processIdentifier
    let bundleId = app.bundleIdentifier ?? ""
    guard accessibilityTrusted(), !unsupportedApps.contains(bundleId) else { return }
    var observer: AXObserver?
    let createErr = AXObserverCreate(pid, axObserverCallback, &observer)
    guard createErr == .success, let observer else {
      markUnsupported(bundleId, notification: "AXObserverCreate", error: createErr.rawValue)
      return
    }
    let appElement = AXUIElementCreateApplication(pid)
    for name in [kAXFocusedWindowChangedNotification, kAXMainWindowChangedNotification] {
      let err = AXObserverAddNotification(observer, appElement, name as CFString, axRefcon())
      if err != .success {
        markUnsupported(bundleId, notification: name as String, error: err.rawValue)
        return
      }
    }
    CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .commonModes)
    axObserver = observer
    axAppElement = appElement
    axPid = pid
    axBundleId = bundleId
    refreshFocusedWindow()
  }

  private func detachAX() {
    cancelTitleWork()
    if let observer = axObserver {
      CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .commonModes)
      CFRunLoopSourceInvalidate(AXObserverGetRunLoopSource(observer))
    }
    axObserver = nil; axAppElement = nil; axWindowElement = nil
    axPid = 0; axBundleId = ""
  }
  private func markUnsupported(_ bundleId: String, notification: String, error: AXError.RawValue) {
    guard unsupportedApps.insert(bundleId).inserted else { return }
    emit(AxUnsupportedEvent(at: nowMs(), bundleId: bundleId, notification: notification, error: error))
    detachAX()
  }
  private func refreshFocusedWindow() {
    guard let observer = axObserver, let appElement = axAppElement else { return }
    if let old = axWindowElement {
      AXObserverRemoveNotification(observer, old, kAXTitleChangedNotification as CFString)
      axWindowElement = nil
    }
    var title: String?, value: CFTypeRef?
    if AXUIElementCopyAttributeValue(appElement, kAXFocusedWindowAttribute as CFString, &value) == .success,
       let value, CFGetTypeID(value) == AXUIElementGetTypeID() {
      let window = value as! AXUIElement
      axWindowElement = window
      if titlesEnabled {
        let err = AXObserverAddNotification(observer, window, kAXTitleChangedNotification as CFString, axRefcon())
        if err != .success && err != .notificationAlreadyRegistered {
          markUnsupported(axBundleId, notification: kAXTitleChangedNotification as String, error: err.rawValue)
          return
        }
        title = readWindowTitle(window)
      }
    }
    debouncer.reset()
    cancelTitleWork()
    if let title { debouncer.markEmitted(title) }
    emit(WindowEvent(type: "window.focused", at: nowMs(), pid: axPid, bundleId: axBundleId, title: title))
  }

  private func readWindowTitle(_ window: AXUIElement) -> String? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(window, kAXTitleAttribute as CFString, &value) == .success,
          let s = value as? String else { return nil }
    return s
  }
  func handleAXNotification(observer: AXObserver, element: AXUIElement, name: String) {
    guard !stopping, let current = axObserver, observer === current else { return }
    guard accessibilityTrusted() else { detachAX(); return }
    var pid: pid_t = 0
    AXUIElementGetPid(element, &pid)
    guard pid == axPid else { return } // stale callback from a previous app context
    if name == kAXFocusedWindowChangedNotification || name == kAXMainWindowChangedNotification {
      refreshFocusedWindow()
    } else if name == kAXTitleChangedNotification,
              titlesEnabled, let window = axWindowElement, CFEqual(element, window),
              let title = readWindowTitle(window) {
      submitTitle(title)
    }
  }

  private func cancelTitleWork() {
    titleWorkItem?.cancel(); titleWorkItem = nil; scheduledDeadline = nil
  }
  private func submitTitle(_ title: String) {
    let now = ProcessInfo.processInfo.systemUptime
    guard let deadline = debouncer.submit(title, now: now) else { cancelTitleWork(); return }
    guard deadline != scheduledDeadline else { return } // identical pending keeps its fire
    titleWorkItem?.cancel()
    let item = DispatchWorkItem { [weak self] in self?.fireTitle() }
    titleWorkItem = item
    scheduledDeadline = deadline
    DispatchQueue.main.asyncAfter(deadline: .now() + max(0, deadline - now), execute: item)
  }
  private func fireTitle() {
    guard accessibilityTrusted() else { detachAX(); return }
    let now = ProcessInfo.processInfo.systemUptime
    titleWorkItem = nil; scheduledDeadline = nil
    if let title = debouncer.fire(now: now) {
      emit(WindowEvent(type: "window.title", at: nowMs(), pid: axPid, bundleId: axBundleId, title: title))
    } else if let deadline = debouncer.pendingDeadline { // fired early: finish the wait
      let item = DispatchWorkItem { [weak self] in self?.fireTitle() }
      titleWorkItem = item; scheduledDeadline = deadline
      DispatchQueue.main.asyncAfter(deadline: .now() + max(0, deadline - now), execute: item)
    }
  }
  func shutdown(exitCode: Int32) {
    guard !stopping else { return }
    stopping = true
    FileHandle.standardInput.readabilityHandler = nil
    titleWorkItem?.cancel()
    for token in workspaceTokens { NSWorkspace.shared.notificationCenter.removeObserver(token) }
    for (center, token) in centerTokens { center.removeObserver(token) }
    detachAX()
    exit(exitCode)
  }
}

signal(SIGPIPE, SIG_IGN)
signal(SIGTERM, SIG_IGN)

let runtime = HelperRuntime()

// global: kept alive for the whole process lifetime
let sigtermSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
sigtermSource.setEventHandler { runtime.shutdown(exitCode: 0) }
sigtermSource.resume()

runtime.start()
RunLoop.main.run()
