import Foundation
// Event types whose queued lines are critical (never evicted or purged) and
// the full vocabulary used to type output_overflow drop counts.
public enum EventKinds {
  public static let critical: Set<String> = [
    "hello", "error", "app.terminated", "ax.unsupported", "snapshot", "titles.ack",
  ]
  public static let known: Set<String> = critical.union([
    "app.activated", "app.launched", "window.focused", "window.title", "thermal",
    "power.sleep", "power.wake", "screen.locked", "screen.unlocked",
    "session.active", "session.inactive",
  ])
  // Drop-type keys are bounded: anything unrecognised collapses to "unknown".
  public static func normalize(_ type: String) -> String { known.contains(type) ? type : "unknown" }
}

public struct Permissions: Encodable {
  public var accessibility: String // "granted" | "denied"
  public init(accessibility: String) { self.accessibility = accessibility }
}

public struct HelloEvent: Encodable {
  public var v = 1; public var type = "hello"; public var at: Int64
  public var version = "0.1.0"
  public var pid: Int32
  // Random per-process stream id: the host learns it here and requires the
  // same value on every titles.ack before trusting that ack.
  public var session: String
  public var permissions: Permissions
  public init(at: Int64, pid: Int32, session: String, permissions: Permissions) {
    self.at = at; self.pid = pid; self.session = session; self.permissions = permissions }
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
  public var windowless: Bool // emits "window":null when the app has no window
  private enum CodingKeys: String, CodingKey { case v, type, at, pid, bundleId, title, window }
  public init(type: String, at: Int64, pid: Int32, bundleId: String, title: String? = nil,
              windowless: Bool = false) {
    self.type = type; self.at = at; self.pid = pid; self.bundleId = bundleId
    self.title = title; self.windowless = windowless }
  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(v, forKey: .v); try c.encode(type, forKey: .type); try c.encode(at, forKey: .at)
    try c.encode(pid, forKey: .pid); try c.encode(bundleId, forKey: .bundleId)
    try c.encodeIfPresent(title, forKey: .title)
    if windowless { try c.encodeNil(forKey: .window) }
  }
}

public struct AxUnsupportedEvent: Encodable {
  public var v = 1; public var type = "ax.unsupported"; public var at: Int64
  public var bundleId: String
  public var pid: Int32
  public var notification: String
  public var error: Int32 // raw AXError code
  public init(at: Int64, bundleId: String, pid: Int32, notification: String, error: Int32) {
    self.at = at; self.bundleId = bundleId; self.pid = pid
    self.notification = notification; self.error = error }
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
  public var dropped: Int?                    // *_overflow: total evicted records
  public var droppedTypes: [String: Int]?     // *_overflow: drops by event/command type
  public var pid: Int32?, bundleId: String?   // ax-retryable: the affected app
  public init(at: Int64, code: String, message: String, dropped: Int? = nil,
              droppedTypes: [String: Int]? = nil, pid: Int32? = nil, bundleId: String? = nil) {
    self.at = at; self.code = code; self.message = message; self.dropped = dropped
    self.droppedTypes = droppedTypes; self.pid = pid; self.bundleId = bundleId }
}

// Confirms a `titles` command was applied; `gen` is the privacy generation the
// ack belongs to. `id` echoes the command's correlation id when supplied and
// `session` echoes the value hello advertised, so the host can reject acks
// from a stale helper stream.
public struct TitlesAckEvent: Encodable {
  public var v = 1; public var type = "titles.ack"; public var at: Int64
  public var session: String
  public var id: CommandID?
  public var enabled: Bool
  public var gen: Int
  public init(at: Int64, session: String, id: CommandID? = nil, enabled: Bool, gen: Int) {
    self.at = at; self.session = session; self.id = id
    self.enabled = enabled; self.gen = gen }
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
