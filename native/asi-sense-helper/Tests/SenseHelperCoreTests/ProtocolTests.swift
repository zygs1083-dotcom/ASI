import XCTest
@testable import SenseHelperCore

private func decode(_ data: Data) throws -> [String: Any] {
  try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
}

final class ProtocolTests: XCTestCase {
  private func encode<E: Encodable>(_ event: E, titles: Bool = true) throws -> [String: Any] {
    let enc = LineEncoder(titlesEnabled: titles)
    let data = try enc.encodeLine(event).line
    XCTAssertTrue(data.last == 0x0A, "event line must end with newline")
    XCTAssertFalse(data.dropLast().contains(0x0A), "event must be a single NDJSON line")
    return try decode(data)
  }
  func testEnvelopeAndHelloFields() throws {
    let d = try encode(HelloEvent(at: 123, pid: 42, permissions: Permissions(accessibility: "granted")))
    XCTAssertEqual(d["v"] as? Int, 1)
    XCTAssertEqual(d["type"] as? String, "hello")
    XCTAssertEqual(d["at"] as? Int, 123)
    XCTAssertEqual(d["version"] as? String, "0.1.0")
    XCTAssertEqual(d["pid"] as? Int, 42)
    XCTAssertEqual((d["permissions"] as? [String: Any])?["accessibility"] as? String, "granted")
  }
  func testAppAndThermalFields() throws {
    let app = try encode(AppEvent(type: "app.activated", at: 2, name: "TextEdit", bundleId: "com.apple.TextEdit", pid: 7))
    XCTAssertEqual(app["type"] as? String, "app.activated")
    XCTAssertEqual(app["name"] as? String, "TextEdit")
    XCTAssertEqual(app["bundleId"] as? String, "com.apple.TextEdit")
    XCTAssertEqual(app["pid"] as? Int, 7)

    let t = try encode(ThermalEvent(at: 3, state: "fair"))
    XCTAssertEqual(t["type"] as? String, "thermal")
    XCTAssertEqual(t["state"] as? String, "fair")

    let envelopeOnly = try encode(SimpleEvent(type: "screen.locked", at: 4))
    XCTAssertEqual(Set(envelopeOnly.keys), ["v", "type", "at"])
  }
  func testTitleNewlineEscapedOnSingleLine() throws {
    let raw = try LineEncoder().encodeLine(
      WindowEvent(type: "window.title", at: 5, pid: 1, bundleId: "b", title: "a\nb\t\"q\"")).line
    XCTAssertEqual(raw.filter { $0 == 0x0A }.count, 1)
    let d = try decode(raw)
    XCTAssertEqual(d["title"] as? String, "a\nb\t\"q\"")
  }
  func testTitlesDisabledStripsEveryTitleKey() throws {
    for type in ["window.focused", "window.title"] {
      let d = try encode(WindowEvent(type: type, at: 1, pid: 1, bundleId: "b", title: "x"), titles: false)
      XCTAssertNil(d["title"], type)
    }
    let snap = try encode(
      SnapshotEvent(at: 1, frontApp: .init(name: "n", bundleId: "b", pid: 1),
                    focusedWindow: .init(pid: 1, bundleId: "b", status: "ok", title: "x"),
                    thermal: "nominal", permissions: Permissions(accessibility: "granted")),
      titles: false)
    XCTAssertNil((snap["focusedWindow"] as? [String: Any])?["title"])
    XCTAssertNil(snap["title"])
  }
  // titles.ack echoes the command's correlation id (string or integer) and
  // the privacy generation it was applied under.
  func testTitlesAckRoundTripsIds() throws {
    let s = try encode(TitlesAckEvent(at: 9, id: .string("abc-1"), enabled: false, gen: 3))
    XCTAssertEqual(s["type"] as? String, "titles.ack")
    XCTAssertEqual(s["id"] as? String, "abc-1")
    XCTAssertEqual(s["enabled"] as? Bool, false)
    XCTAssertEqual(s["gen"] as? Int, 3)
    let i = try encode(TitlesAckEvent(at: 9, id: .int(42), enabled: true, gen: 4))
    XCTAssertEqual(i["id"] as? Int, 42)
    let none = try encode(TitlesAckEvent(at: 9, enabled: true, gen: 5))
    XCTAssertNil(none["id"], "no id key when the command carried none")
    XCTAssertEqual(none["enabled"] as? Bool, true)
  }
  // Windowless focus emits an explicit "window":null; windowed focus has no key.
  func testWindowlessEncodesWindowNull() throws {
    let wless = try encode(WindowEvent(type: "window.focused", at: 1, pid: 7,
                                       bundleId: "b", windowless: true))
    XCTAssertTrue(wless["window"] is NSNull)
    let wed = try encode(WindowEvent(type: "window.focused", at: 1, pid: 7,
                                     bundleId: "b", title: "T"))
    XCTAssertNil(wed["window"])
  }
  // Escape-heavy and multi-byte titles truncate at valid boundaries; the whole
  // line (with LF) stays <=PIPE_BUF (512 on Darwin) so the writer can write it
  // atomically.
  func testTitleLineTruncatesToAtomicBound() throws {
    let esc = String(repeating: "\\\"\n\t", count: 500)
    let uni = String(repeating: "漢字🐱", count: 2000)
    for title in [esc, uni, String(repeating: "x", count: 20000)] {
      let enc = LineEncoder(titlesEnabled: true)
      let r = try enc.encodeLine(WindowEvent(type: "window.focused", at: 1,
                                             pid: 7, bundleId: "b", title: title))
      XCTAssertTrue(r.hasTitle, "a truncated title still counts as title-bearing")
      XCTAssertLessThanOrEqual(r.line.count, LineEncoder.maxTitleLineBytes)
      let d = try decode(r.line) // still valid JSON on scalar boundaries
      XCTAssertEqual((d["title"] as? String)?.isEmpty, false)
    }
  }
  // If even the non-title metadata cannot fit, titles are stripped rather than
  // truncated mid-metadata.
  func testOversizeMetadataStripsTitleInstead() throws {
    let huge = SimpleHugeMeta(type: "window.focused", pid: 1, bundleId: "b",
                              title: "SECRET", blob: String(repeating: "m", count: 9000))
    let enc = LineEncoder(titlesEnabled: true)
    let r = try enc.encodeLine(huge)
    XCTAssertFalse(r.hasTitle, "unfittable metadata drops the title entirely")
    let d = try decode(r.line)
    XCTAssertNil(d["title"])
    XCTAssertEqual(d["pid"] as? Int, 1)
  }
}

private struct SimpleHugeMeta: Encodable {
  var v = 1; var type: String; var at: Int64 = 1
  var pid: Int32; var bundleId: String; var title: String; var blob: String
}
