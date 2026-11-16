import Foundation

// Command correlation id: hosts may tag a `titles` command with a string or
// integer id which `titles.ack` echoes back. Other JSON types are rejected.
public enum CommandID: Equatable, Codable {
  case string(String)
  case int(Int64)
  public init(from decoder: Decoder) throws {
    let c = try decoder.singleValueContainer()
    if let s = try? c.decode(String.self) { self = .string(s); return }
    self = .int(try c.decode(Int64.self))
  }
  public func encode(to encoder: Encoder) throws {
    var c = encoder.singleValueContainer()
    switch self {
    case .string(let s): try c.encode(s)
    case .int(let i): try c.encode(i)
    }
  }
}

public enum Command: Equatable {
  case snapshot
  case titles(Bool, id: CommandID? = nil)
  case recheckPermissions
  case quit
  var isControl: Bool {
    if case .titles = self { return true }
    return self == .quit
  }
}

public enum CommandResult: Equatable {
  case ok(Command)
  case error(code: String, message: String)
}
// Parses one NDJSON command line; errors use fixed strings, never echo input.
public enum CommandParser {
  public static let maxLineBytes = 64 * 1024

  public static func parse(_ data: Data) -> CommandResult {
    guard let dict = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
      return .error(code: "malformed", message: "command is not a JSON object")
    }
    if let v = dict["v"] {
      guard let n = v as? NSNumber, !isBool(n), n.doubleValue == 1 else {
        return .error(code: "bad-version", message: "unsupported protocol version")
      }
    }
    guard let cmd = dict["cmd"] as? String else {
      return .error(code: "malformed", message: "command has no string cmd field")
    }
    switch cmd {
    case "snapshot": return .ok(.snapshot)
    case "recheck-permissions": return .ok(.recheckPermissions)
    case "quit": return .ok(.quit)
    case "titles":
      guard let raw = dict["enabled"], let n = raw as? NSNumber, isBool(n) else {
        return .error(code: "bad-enabled", message: "titles.enabled must be a boolean")
      }
      if let rawId = dict["id"] {
        guard let id = parseID(rawId) else {
          return .error(code: "bad-id", message: "titles.id must be a string or integer")
        }
        return .ok(.titles(n.boolValue, id: id))
      }
      return .ok(.titles(n.boolValue))
    default: return .error(code: "unknown-command", message: "unknown command")
    }
  }
  private static func parseID(_ raw: Any) -> CommandID? {
    if let s = raw as? String { return .string(s) }
    guard let n = raw as? NSNumber, !isBool(n) else { return nil }
    // Exact integers only: stringify and reparse so a Double like 9.22e18
    // (whose int64Value wraps to Int64.min) is rejected instead of silently
    // producing a different id.
    guard let i = Int64(n.stringValue) else { return nil }
    return .int(i)
  }
  static func isBool(_ n: NSNumber) -> Bool { CFGetTypeID(n) == CFBooleanGetTypeID() }
}
