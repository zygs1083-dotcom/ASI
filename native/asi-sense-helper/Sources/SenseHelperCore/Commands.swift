import Foundation

public enum Command: Equatable {
  case snapshot
  case titles(Bool)
  case recheckPermissions
  case quit
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
      return .ok(.titles(n.boolValue))
    default: return .error(code: "unknown-command", message: "unknown command")
    }
  }
  static func isBool(_ n: NSNumber) -> Bool { CFGetTypeID(n) == CFBooleanGetTypeID() }
}
