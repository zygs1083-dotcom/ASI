import ApplicationServices
import Foundation

// Injectable boundary for every AX interaction; runs on the session queue.
public protocol AXBackend {
  associatedtype Element
  associatedtype Observer
  func createObserver(pid: Int32) throws -> Observer
  func start(_ observer: Observer)
  func application(pid: Int32) -> Element
  func add(observer: Observer, element: Element, notification: String) -> AXError
  func remove(observer: Observer, element: Element, notification: String)
  func focusedWindow(_ app: Element) -> (AXError, Element?)
  func windowCount(_ app: Element) -> (AXError, Int?)
  func title(_ window: Element) -> (AXError, String?)
  func equal(_ lhs: Element, _ rhs: Element) -> Bool
  func equalObserver(_ lhs: Observer, _ rhs: Observer) -> Bool
  func detach(_ observer: Observer)
}

public struct AXObserverCreateError: Error {
  public let axError: AXError
  public init(axError: AXError) { self.axError = axError }
}

public extension AXBackend {
  func windowCount(_ app: Element) -> (AXError, Int?) { (.notImplemented, nil) }
  // AX supplies the source string; bound downstream work on the AX queue
  // before it reaches events, the debouncer or the main-thread encoder.
  static var sourceTitleLimit: Int { 1024 }
  func boundedTitle(_ window: Element) -> (AXError, String?) {
    let (err, t) = title(window)
    guard let t else { return (err, t) }
    // One Character can contain unbounded scalars. Cap those first, then drop
    // the possibly incomplete final grapheme before the Character limit.
    let scalars = t.unicodeScalars.prefix(2048)
    var bounded = String(scalars)
    if scalars.endIndex != t.unicodeScalars.endIndex { bounded = String(bounded.dropLast()) }
    return (err, String(bounded.prefix(Self.sourceTitleLimit)))
  }
}

// Production backend: 0.5s messaging timeout on app and window elements;
// the callback forwards (observer, element, name) to the session.
public final class SystemAXBackend: AXBackend {
  public static let ipcTimeout: Float = 0.5
  public var callback: ((AXObserver, AXUIElement, String) -> Void)?
  public init() {}
  public func createObserver(pid: Int32) throws -> AXObserver {
    var observer: AXObserver?
    let err = AXObserverCreate(pid, systemAXCallback, &observer)
    guard err == .success, let observer else { throw AXObserverCreateError(axError: err) }
    return observer
  }
  public func start(_ observer: AXObserver) {
    let loop = CFRunLoopGetMain()
    CFRunLoopAddSource(loop, AXObserverGetRunLoopSource(observer), .commonModes)
    CFRunLoopWakeUp(loop)
  }
  public func application(pid: Int32) -> AXUIElement {
    let app = AXUIElementCreateApplication(pid)
    AXUIElementSetMessagingTimeout(app, Self.ipcTimeout)
    return app
  }
  public func add(observer: AXObserver, element: AXUIElement, notification: String) -> AXError {
    AXObserverAddNotification(observer, element, notification as CFString,
                              Unmanaged.passUnretained(self).toOpaque())
  }
  public func remove(observer: AXObserver, element: AXUIElement, notification: String) {
    AXObserverRemoveNotification(observer, element, notification as CFString)
  }
  public func focusedWindow(_ app: AXUIElement) -> (AXError, AXUIElement?) {
    var value: CFTypeRef?
    let err = AXUIElementCopyAttributeValue(app, kAXFocusedWindowAttribute as CFString, &value)
    guard err == .success, let value, CFGetTypeID(value) == AXUIElementGetTypeID() else {
      return (err, nil)
    }
    let window = value as! AXUIElement
    AXUIElementSetMessagingTimeout(window, Self.ipcTimeout)
    return (.success, window)
  }
  public func windowCount(_ app: AXUIElement) -> (AXError, Int?) {
    var value: CFTypeRef?
    let err = AXUIElementCopyAttributeValue(app, kAXWindowsAttribute as CFString, &value)
    guard err == .success, let value, CFGetTypeID(value) == CFArrayGetTypeID(),
          let windows = value as? [AXUIElement] else { return (err, nil) }
    return (.success, windows.count)
  }
  public func title(_ window: AXUIElement) -> (AXError, String?) {
    var value: CFTypeRef?
    let err = AXUIElementCopyAttributeValue(window, kAXTitleAttribute as CFString, &value)
    return (err, value as? String)
  }
  public func equal(_ lhs: AXUIElement, _ rhs: AXUIElement) -> Bool { CFEqual(lhs, rhs) }
  public func equalObserver(_ lhs: AXObserver, _ rhs: AXObserver) -> Bool { lhs === rhs }
  public func detach(_ observer: AXObserver) {
    let source = AXObserverGetRunLoopSource(observer)
    CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes)
    CFRunLoopSourceInvalidate(source)
  }
}
private func systemAXCallback(_ observer: AXObserver, _ element: AXUIElement,
                              _ name: CFString, _ refcon: UnsafeMutableRawPointer?) {
  guard let refcon else { return }
  Unmanaged<SystemAXBackend>.fromOpaque(refcon).takeUnretainedValue()
    .callback?(observer, element, name as String)
}
