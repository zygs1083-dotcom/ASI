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
