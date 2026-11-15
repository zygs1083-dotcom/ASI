import Foundation
public struct Permissions: Encodable {
  public var accessibility: String // "granted" | "denied"
  public init(accessibility: String) { self.accessibility = accessibility }
}

public struct HelloEvent: Encodable {
  public var v = 1; public var type = "hello"; public var at: Int64
  public var version = "0.1.0"
  public var pid: Int32
  public var permissions: Permissions
  public init(at: Int64, pid: Int32, permissions: Permissions) {
    self.at = at; self.pid = pid; self.permissions = permissions }
}

public struct AppEvent: Encodable {
  public var v = 1; public var type: String; public var at: Int64
  public var name: String
  public var bundleId: String
  public var pid: Int32
  public init(type: String, at: Int64, name: String, bundleId: String, pid: Int32) {
    self.type = type; self.at = at; self.name = name; self.bundleId = bundleId; self.pid = pid }
}

public struct WindowEvent: Encodable {
  public var v = 1; public var type: String; public var at: Int64
  public var pid: Int32
  public var bundleId: String
  public var title: String?
  public init(type: String, at: Int64, pid: Int32, bundleId: String, title: String? = nil) {
    self.type = type; self.at = at; self.pid = pid; self.bundleId = bundleId; self.title = title }
}

public struct AxUnsupportedEvent: Encodable {
  public var v = 1; public var type = "ax.unsupported"; public var at: Int64
  public var bundleId: String
  public var notification: String
  public var error: Int32 // raw AXError code
  public init(at: Int64, bundleId: String, notification: String, error: Int32) {
    self.at = at; self.bundleId = bundleId; self.notification = notification; self.error = error }
}

public struct ThermalEvent: Encodable {
  public var v = 1; public var type = "thermal"; public var at: Int64
  public var state: String // nominal | fair | serious | critical
  public init(at: Int64, state: String) { self.at = at; self.state = state }
}

public struct SimpleEvent: Encodable {
  public var v = 1; public var type: String; public var at: Int64
  public init(type: String, at: Int64) { self.type = type; self.at = at }
}

public struct ErrorEvent: Encodable {
  public var v = 1; public var type = "error"; public var at: Int64
  public var code: String
  public var message: String
  public init(at: Int64, code: String, message: String) {
    self.at = at; self.code = code; self.message = message }
}

public struct SnapshotEvent: Encodable {
  public struct FrontApp: Encodable {
    public var name: String; public var bundleId: String; public var pid: Int32
    public init(name: String, bundleId: String, pid: Int32) {
      self.name = name; self.bundleId = bundleId; self.pid = pid }
  }
  public struct FocusedWindow: Encodable {
    public var pid: Int32; public var bundleId: String
    public var status: String // ok | denied | unsupported | unknown
    public var title: String?
    public init(pid: Int32, bundleId: String, status: String, title: String? = nil) {
      self.pid = pid; self.bundleId = bundleId; self.status = status; self.title = title }
  }
  public var v = 1; public var type = "snapshot"; public var at: Int64
  public var frontApp: FrontApp?
  public var focusedWindow: FocusedWindow?
  public var thermal: String
  public var permissions: Permissions
  public init(at: Int64, frontApp: FrontApp?, focusedWindow: FocusedWindow?,
              thermal: String, permissions: Permissions) {
    self.at = at; self.frontApp = frontApp; self.focusedWindow = focusedWindow
    self.thermal = thermal; self.permissions = permissions }
}
