import XCTest
@testable import SenseHelperCore

private func decode(_ data: Data) throws -> [String: Any] {
  try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
}

final class ProtocolTests: XCTestCase {
  private func encode<E: Encodable>(_ event: E, titles: Bool = true) throws -> [String: Any] {
    let enc = LineEncoder(titlesEnabled: titles)
    let data = try enc.encodeLine(event)
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
    let raw = try LineEncoder().encodeLine(WindowEvent(type: "window.title", at: 5, pid: 1, bundleId: "b", title: "a\nb\t\"q\""))
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
}
