import Foundation
// Single serialization choke point: detects the event type and every nested
// "title" key. Titles off strips them recursively so a stale payload can never
// leak; titles on caps any title-bearing line at maxTitleLineBytes INCLUDING
// the LF so the writer puts it on the wire in one atomic write.
public struct LineEncoder {
  // PIPE_BUF is 512 on Darwin (not 4096): a title line at/below the real pipe
  // atomic bound is guaranteed to write whole or not at all.
  public static let maxTitleLineBytes = min(4096, Int(PIPE_BUF))
  public var titlesEnabled: Bool
  private let encoder = JSONEncoder()

  public init(titlesEnabled: Bool = true) {
    self.titlesEnabled = titlesEnabled
  }
  public func encodeLine<E: Encodable>(_ event: E) throws
    -> (line: Data, hasTitle: Bool, type: String) {
    var data = try encoder.encode(event)
    var hasTitle = false
    var type = "unknown"
    if let obj = try? JSONSerialization.jsonObject(with: data) {
      if let d = obj as? [String: Any], let t = d["type"] as? String { type = t }
      hasTitle = Self.containsTitle(obj)
      if hasTitle {
        if !titlesEnabled {
          data = try JSONSerialization.data(withJSONObject: Self.stripTitles(obj))
          hasTitle = false
        } else {
          let fitted = Self.fitTitles(obj)
          data = try JSONSerialization.data(withJSONObject: fitted.0)
          hasTitle = fitted.1
        }
      }
    }
    data.append(0x0A)
    return (data, hasTitle, type)
  }
  // Bound a title-bearing payload so its FINAL JSONSerialization UTF-8 line
  // (with LF) fits the atomic budget - the wire bytes come from this encoder,
  // never from the caller's earlier JSONEncoder pass. All title strings share
  // one Character-prefix bound found by binary search over full re-encodings
  // (escaping is accounted for). If even the non-title metadata cannot fit,
  // titles are stripped entirely and the rest of the event is preserved.
  static func fitTitles(_ obj: Any) -> (Any, Bool) {
    if let d = try? JSONSerialization.data(withJSONObject: obj),
       d.count + 1 <= maxTitleLineBytes { return (obj, true) }
    var lo = 0, hi = min(Self.maxTitleLength(obj), maxTitleLineBytes), best = -1
    while lo <= hi {
      let mid = (lo + hi) / 2
      let size = (try? JSONSerialization.data(
        withJSONObject: truncateTitles(obj, mid)).count) ?? .max
      if size + 1 <= maxTitleLineBytes { best = mid; lo = mid + 1 } else { hi = mid - 1 }
    }
    guard best > 0 else { return (stripTitles(obj), false) }
    return (truncateTitles(obj, best), true)
  }
  static func maxTitleLength(_ value: Any) -> Int {
    if let dict = value as? [String: Any] {
      return dict.reduce(0) { m, kv in
        max(m, kv.key == "title" ? (kv.value as? String)?.count ?? 0
                                 : maxTitleLength(kv.value))
      }
    }
    if let array = value as? [Any] { return array.reduce(0) { max($0, maxTitleLength($1)) } }
    return 0
  }
  static func truncateTitles(_ value: Any, _ bound: Int) -> Any {
    if let dict = value as? [String: Any] {
      var out = dict
      for key in out.keys {
        if key == "title", let s = out[key] as? String { out[key] = String(s.prefix(bound)) }
        else { out[key] = truncateTitles(out[key]!, bound) }
      }
      return out
    }
    if let array = value as? [Any] { return array.map { truncateTitles($0, bound) } }
    return value
  }
  static func containsTitle(_ value: Any) -> Bool {
    if let dict = value as? [String: Any] {
      return dict.contains { $0.key == "title" || containsTitle($0.value) }
    }
    if let array = value as? [Any] { return array.contains(where: containsTitle) }
    return false
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
  // Privacy purge transform for already-encoded lines; nil means the line
  // could not be verified title-free and must be dropped instead.
  public static func stripTitles(fromLine line: Data) -> Data? {
    var data = line
    if data.last == 0x0A { data.removeLast() }
    guard let obj = try? JSONSerialization.jsonObject(with: data),
          let stripped = try? JSONSerialization.data(withJSONObject: stripTitles(obj)) else {
      return nil
    }
    var out = stripped
    out.append(0x0A)
    return out
  }
}
