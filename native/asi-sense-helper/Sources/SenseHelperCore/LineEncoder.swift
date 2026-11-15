import Foundation
// Single serialization choke point: when titles are disabled every "title" key
// is removed recursively so a stale payload can never leak.
public struct LineEncoder {
  public var titlesEnabled: Bool
  private let encoder = JSONEncoder()

  public init(titlesEnabled: Bool = true) {
    self.titlesEnabled = titlesEnabled
  }
  public func encodeLine<E: Encodable>(_ event: E) throws -> Data {
    var data = try encoder.encode(event)
    if !titlesEnabled {
      let obj = try JSONSerialization.jsonObject(with: data)
      data = try JSONSerialization.data(withJSONObject: Self.stripTitles(obj))
    }
    data.append(0x0A)
    return data
  }
  static func stripTitles(_ value: Any) -> Any {
    if let dict = value as? [String: Any] {
      var out = dict
      out.removeValue(forKey: "title")
      for key in out.keys { out[key] = stripTitles(out[key]!) }
      return out
    }
    if let array = value as? [Any] { return array.map(stripTitles) }
    return value
  }
}
