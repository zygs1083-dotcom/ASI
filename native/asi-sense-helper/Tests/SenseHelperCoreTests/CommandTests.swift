import XCTest
@testable import SenseHelperCore
private func parse(_ s: String) -> CommandResult {
  CommandParser.parse(Data(s.utf8))
}

final class CommandTests: XCTestCase {
  func testValidCommands() {
    XCTAssertEqual(parse(#"{"cmd":"snapshot"}"#), .ok(.snapshot))
    XCTAssertEqual(parse(#"{"cmd":"titles","enabled":true}"#), .ok(.titles(true)))
    XCTAssertEqual(parse(#"{"cmd":"titles","enabled":false}"#), .ok(.titles(false)))
    XCTAssertEqual(parse(#"{"cmd":"titles","enabled":false,"id":"abc-1"}"#),
                   .ok(.titles(false, id: .string("abc-1"))))
    XCTAssertEqual(parse(#"{"cmd":"titles","enabled":true,"id":42}"#),
                   .ok(.titles(true, id: .int(42))))
    XCTAssertEqual(parse(#"{"cmd":"titles","enabled":true,"id":0}"#),
                   .ok(.titles(true, id: .int(0))))
    XCTAssertEqual(parse(#"{"cmd":"titles","enabled":true,"id":-9007199254740991}"#),
                   .ok(.titles(true, id: .int(-9007199254740991))))
    XCTAssertEqual(parse(#"{"cmd":"titles","enabled":true,"id":9223372036854775807}"#),
                   .ok(.titles(true, id: .int(.max))))
    XCTAssertEqual(parse(#"{"cmd":"titles","enabled":true,"id":-9223372036854775808}"#),
                   .ok(.titles(true, id: .int(.min))))
    XCTAssertEqual(parse(#"{"cmd":"recheck-permissions"}"#), .ok(.recheckPermissions))
    XCTAssertEqual(parse(#"{"cmd":"quit"}"#), .ok(.quit))
    XCTAssertEqual(parse(#"{"v":1,"cmd":"quit","at":123,"type":"x"}"#), .ok(.quit))
  }
  private func assertError(_ s: String, _ expected: String, file: StaticString = #filePath, line: UInt = #line) {
    guard case .error(let code, _) = parse(s) else {
      return XCTFail("expected error for \(s)", file: file, line: line)
    }
    XCTAssertEqual(code, expected, s, file: file, line: line)
  }
  func testMalformedInputs() {
    for s in ["", "not json", "[1]", "42", "\"x\"", "{}", #"{"cmd":1}"#, #"{"foo":1}"#] {
      assertError(s, "malformed")
    }
  }
  func testUnknownCommand() {
    assertError(#"{"cmd":"nope"}"#, "unknown-command")
  }
  func testBadEnabled() {
    for s in [#"{"cmd":"titles"}"#, #"{"cmd":"titles","enabled":0}"#, #"{"cmd":"titles","enabled":1}"#,
              #"{"cmd":"titles","enabled":"true"}"#, #"{"cmd":"titles","enabled":null}"#] {
      assertError(s, "bad-enabled")
    }
  }
  func testBadId() {
    for s in [#"{"cmd":"titles","enabled":true,"id":1.5}"#,
              #"{"cmd":"titles","enabled":true,"id":true}"#,
              // Beyond Int64 range: a Double round-trip must never wrap.
              #"{"cmd":"titles","enabled":true,"id":9223372036854775808}"#,
              #"{"cmd":"titles","enabled":true,"id":-9223372036854775809}"#,
              #"{"cmd":"titles","enabled":true,"id":1e30}"#,
              #"{"cmd":"titles","enabled":true,"id":[1]}"#,
              #"{"cmd":"titles","enabled":true,"id":{"x":1}}"#] {
      assertError(s, "bad-id")
    }
  }
  func testBadVersion() {
    for s in [#"{"v":2,"cmd":"quit"}"#, #"{"v":"1","cmd":"quit"}"#, #"{"v":true,"cmd":"quit"}"#,
              #"{"v":1.5,"cmd":"quit"}"#, #"{"v":1.0001,"cmd":"quit"}"#, #"{"v":-1,"cmd":"quit"}"#,
              #"{"v":1e30,"cmd":"quit"}"#] {
      assertError(s, "bad-version")
    }
  }
  func testErrorsNeverEchoInput() {
    guard case .error(_, let message) = parse("{s3cret-command") else {
      return XCTFail("expected error")
    }
    XCTAssertFalse(message.contains("s3cret-command"))
  }
}
