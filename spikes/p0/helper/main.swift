// asi-sense spike environment helper. Emits NDJSON on stdout:
//   {"type":"permission","axTrusted":bool}
//   {"type":"thermal","state":0..3}                  initial + on change
//   {"type":"app","bundleId":"…","name":"…"}        frontmost app changes
//   {"type":"window","change":"focus|title","title":"[REDACTED]","length":n}
//   {"type":"window","status":"unsupported","detail":"…","error":n}
// Window titles are redacted in this process before anything reaches stdout;
// only the title's character length is ever reported. No prompts:
// AXIsProcessTrusted() only reports; no recording permissions used.

import AppKit
import ApplicationServices
import Foundation

private let stdout = FileHandle.standardOutput

func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: []),
          let line = String(data: data, encoding: .utf8),
          let bytes = (line + "\n").data(using: .utf8) else { return }
    stdout.write(bytes)
}

func thermalValue() -> Int { ProcessInfo.processInfo.thermalState.rawValue }

func emitThermal() {
    emit(["type": "thermal", "state": thermalValue()])
}

func emitUnsupported(_ detail: String, _ error: AXError? = nil) {
    var event: [String: Any] = ["type": "window", "status": "unsupported", "detail": detail]
    if let error { event["error"] = Int(error.rawValue) }
    emit(event)
}

var currentObserver: AXObserver?
var currentObservedPid: pid_t = 0
var currentTitleWindow: AXUIElement?

// The title read exists only to report the title's length; the value itself is
// dropped in this process and never reaches stdout.
func titleLength(of element: AXUIElement) -> (length: Int?, error: AXError) {
    var value: CFTypeRef?
    let error = AXUIElementCopyAttributeValue(element, kAXTitleAttribute as CFString, &value)
    guard error == .success, let title = value as? String else { return (nil, error) }
    return (title.count, error)
}

func emitTitleEvent(_ window: AXUIElement, change: String) {
    let result = titleLength(of: window)
    var event: [String: Any] = ["type": "window", "change": change, "title": "[REDACTED]"]
    if let length = result.length { event["length"] = length }
    if result.error != .success { event["titleError"] = Int(result.error.rawValue) }
    emit(event)
}

func unsubscribeTitle() {
    if let observer = currentObserver, let window = currentTitleWindow {
        AXObserverRemoveNotification(observer, window, kAXTitleChangedNotification as CFString)
    }
    currentTitleWindow = nil
}

func focusedWindow(of element: AXUIElement) -> AXUIElement? {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXFocusedWindowAttribute as CFString, &value) == .success,
          let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}

func subscribeTitle(on window: AXUIElement) {
    guard let observer = currentObserver else { return }
    unsubscribeTitle()
    let added = AXObserverAddNotification(observer, window, kAXTitleChangedNotification as CFString, nil)
    guard added == .success else {
        emitUnsupported("title-subscribe", added)
        return
    }
    currentTitleWindow = window
    emitTitleEvent(window, change: "title")
}

func onFocusChanged() {
    emit(["type": "window", "change": "focus"])
    let application = AXUIElementCreateApplication(currentObservedPid)
    guard let window = focusedWindow(of: application) else {
        unsubscribeTitle()
        emitUnsupported("focused-window-unavailable")
        return
    }
    subscribeTitle(on: window)
}

let axCallback: AXObserverCallback = { _, element, notification, _ in
    switch notification as String {
    case kAXFocusedWindowChangedNotification:
        onFocusChanged()
    case kAXTitleChangedNotification:
        emitTitleEvent(element, change: "title")
    default:
        break
    }
}

func stopObserving() {
    unsubscribeTitle()
    if let observer = currentObserver {
        CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .defaultMode)
        currentObserver = nil
        currentObservedPid = 0
    }
}

func observeFront(_ app: NSRunningApplication) {
    let pid = app.processIdentifier
    if pid == currentObservedPid { return }
    stopObserving()
    var observer: AXObserver?
    let created = AXObserverCreate(pid, axCallback, &observer)
    guard created == .success, let observer else {
        emitUnsupported("observer-create", created)
        return
    }
    let element = AXUIElementCreateApplication(pid)
    let focusAdded = AXObserverAddNotification(observer, element, kAXFocusedWindowChangedNotification as CFString, nil)
    guard focusAdded == .success else {
        emitUnsupported("focus-subscribe", focusAdded)
        return
    }
    CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(observer), .defaultMode)
    currentObserver = observer
    currentObservedPid = pid
    onFocusChanged()
}

func describe(_ app: NSRunningApplication) {
    var event: [String: Any] = ["type": "app"]
    if let bundleId = app.bundleIdentifier { event["bundleId"] = bundleId }
    if let name = app.localizedName { event["name"] = name }
    emit(event)
    if AXIsProcessTrusted() { observeFront(app) }
}

emit(["type": "permission", "axTrusted": AXIsProcessTrusted()])
emitThermal()

NotificationCenter.default.addObserver(
    forName: ProcessInfo.thermalStateDidChangeNotification,
    object: nil,
    queue: nil
) { _ in emitThermal() }

NSWorkspace.shared.notificationCenter.addObserver(
    forName: NSWorkspace.didActivateApplicationNotification,
    object: nil,
    queue: nil
) { note in
    guard let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication else { return }
    describe(app)
}

if let front = NSWorkspace.shared.frontmostApplication { describe(front) }

CFRunLoopRun()
