import XCTest
@testable import SenseHelperCore

// Drives the real helper binary over pipes. Prefers the freshly built debug
// binary; falls back to release only when debug is absent.
private final class HelperProcess {
  let process = Process()
  private let stdinPipe = Pipe()
  private var lines: [String] = []
  private var partial = Data()
  private let lock = NSLock()
  private var stdoutPipe: Pipe?

  init(binary: URL, closeStdoutReadEnd: Bool = false) throws {
    let pipe = Pipe()
    if closeStdoutReadEnd {
      pipe.fileHandleForReading.closeFile()
    } else {
      stdoutPipe = pipe
      pipe.fileHandleForReading.readabilityHandler = { [weak self] h in
        self?.append(h.availableData)
      }
    }
    process.executableURL = binary
    process.standardInput = stdinPipe
    process.standardOutput = pipe
    process.standardError = FileHandle.nullDevice
    try process.run()
  }
  deinit { cleanup() }

  func cleanup() {
    stdoutPipe?.fileHandleForReading.readabilityHandler = nil
    try? stdinPipe.fileHandleForWriting.close()
    guard process.isRunning else { return }
    process.terminate()
    if waitExit(timeout: 3) == nil { process.interrupt(); _ = waitExit(timeout: 2) }
    if process.isRunning { kill(process.processIdentifier, SIGKILL); process.waitUntilExit() }
  }
  private func append(_ data: Data) {
    lock.lock(); defer { lock.unlock() }
    partial.append(data)
    while let nl = partial.firstIndex(of: 0x0A) {
      let line = partial.subdata(in: partial.startIndex..<nl)
      partial.removeSubrange(partial.startIndex...nl)
      if let s = String(data: line, encoding: .utf8) { lines.append(s) }
    }
  }
  func send(_ s: String) { stdinPipe.fileHandleForWriting.write(Data(s.utf8)) }
  func closeStdin() { try? stdinPipe.fileHandleForWriting.close() }
  func snapshotLines() -> [String] { lock.lock(); defer { lock.unlock() }; return lines }

  private func waitFor(_ timeout: TimeInterval, _ pred: () -> Bool) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      if pred() { return true }
      Thread.sleep(forTimeInterval: 0.02)
    }
    return false
  }
  func waitForLines(containing needle: String, count: Int = 1, timeout: TimeInterval = 10) -> [String]? {
    var found: [String]?
    _ = waitFor(timeout) {
      let m = self.snapshotLines().filter { $0.contains(needle) }
      if m.count >= count { found = m; return true }
      return false
    }
    return found
  }
  @discardableResult
  func waitForLine(containing needle: String, timeout: TimeInterval = 10) -> String? {
    waitForLines(containing: needle)?.first
  }
  @discardableResult
  func waitExit(timeout: TimeInterval = 10) -> Int32? {
    waitFor(timeout) { !self.process.isRunning } ? process.terminationStatus : nil
  }
}

final class ProcessTests: XCTestCase {
  private static func binary() throws -> URL {
    var dir = URL(fileURLWithPath: #filePath)
    for _ in 0..<3 { dir.deleteLastPathComponent() } // package root
    for config in ["debug", "release"] {
      let url = dir.appendingPathComponent(".build/\(config)/asi-sense-helper")
      if FileManager.default.isExecutableFile(atPath: url.path) { return url }
    }
    XCTFail("helper binary not found; run `swift build` first")
    return dir.appendingPathComponent(".build/debug/asi-sense-helper")
  }
  private func sendQuitAndExpectCleanExit(_ p: HelperProcess, file: StaticString = #filePath, line: UInt = #line) {
    p.send("{\"cmd\":\"quit\"}\n")
    XCTAssertEqual(p.waitExit(), 0, file: file, line: line)
  }
  private func launch() throws -> HelperProcess {
    let p = try HelperProcess(binary: Self.binary())
    XCTAssertNotNil(p.waitForLine(containing: "\"type\":\"hello\""), "hello must arrive at startup")
    return p
  }
  private func eventType(_ line: String) -> String? {
    ((try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any])?["type"] as? String
  }
  func testHelloThenThermalThenEOFExitsClean() throws {
    let p = try launch()
    XCTAssertNotNil(p.waitForLine(containing: "\"type\":\"thermal\""), "thermal must follow hello")
    let lines = p.snapshotLines()
    XCTAssertEqual(eventType(lines[0]), "hello")
    XCTAssertEqual(eventType(lines[1]), "thermal")
    p.closeStdin()
    XCTAssertEqual(p.waitExit(), 0, "EOF must exit cleanly")
  }
  func testQuitCommandExitsClean() throws {
    let p = try launch()
    sendQuitAndExpectCleanExit(p)
  }
  func testSigtermExitsClean() throws {
    let p = try launch()
    p.process.terminate() // SIGTERM
    XCTAssertEqual(p.waitExit(), 0, "SIGTERM must be handled as a clean stop")
  }
  func testClosedStdoutExitsNonZero() throws {
    let p = try HelperProcess(binary: Self.binary(), closeStdoutReadEnd: true)
    guard let code = p.waitExit() else {
      return XCTFail("helper did not exit after stdout write failure")
    }
    XCTAssertNotEqual(code, 0)
  }
  func testChunkedCommandAndErrorRecovery() throws {
    let p = try launch()
    p.send("garbage\n")
    XCTAssertNotNil(p.waitForLine(containing: "\"type\":\"error\""), "bad input must produce error event")
    p.send("{\"cmd\":\"sna")
    Thread.sleep(forTimeInterval: 0.1)
    p.send("pshot\"}\r\n")
    XCTAssertNotNil(p.waitForLine(containing: "\"type\":\"snapshot\""), "chunked CRLF command must parse")
    p.send("{\"cmd\":\"recheck-permissions\"}\n")
    guard let hellos = p.waitForLines(containing: "\"type\":\"hello\"", count: 2),
          let d = (try? JSONSerialization.jsonObject(with: Data(hellos[1].utf8))) as? [String: Any] else {
      return XCTFail("recheck-permissions must emit a fresh hello")
    }
    let perm = (d["permissions"] as? [String: Any])?["accessibility"] as? String
    XCTAssertTrue(perm == "granted" || perm == "denied", "hello must carry permissions")
    sendQuitAndExpectCleanExit(p)
  }
  func testTrailingCommandWithoutNewlineRunsOnEOF() throws {
    let p = try launch()
    p.send("{\"cmd\":\"snapshot\"}") // no newline
    p.closeStdin()
    XCTAssertNotNil(p.waitForLine(containing: "\"type\":\"snapshot\""), "EOF must drain trailing command")
    XCTAssertEqual(p.waitExit(), 0)
  }
  func testPrivacySnapshotOmitsTitleKeys() throws {
    let p = try launch()
    p.send("{\"cmd\":\"titles\",\"enabled\":false}\n{\"cmd\":\"snapshot\"}\n")
    guard let snap = p.waitForLine(containing: "\"type\":\"snapshot\"") else {
      return XCTFail("no snapshot")
    }
    XCTAssertFalse(snap.contains("\"title\""), "snapshot must not contain title keys when titles disabled")
    sendQuitAndExpectCleanExit(p)
  }
  func testOversizedLineDiscardsThroughNewlineThenRecovers() throws {
    let p = try launch()
    // Oversized physical line with no LF: everything up to the next LF is
    // discarded, including a valid JSON suffix on the same line.
    p.send(String(repeating: "x", count: 70 * 1024))
    XCTAssertNotNil(p.waitForLine(containing: "line-too-long"), "oversized line must be rejected")
    p.send("{\"cmd\":\"snapshot\"}\n{\"cmd\":\"snapshot\"}\n")
    Thread.sleep(forTimeInterval: 0.3)
    let snaps = p.snapshotLines().filter { $0.contains("\"type\":\"snapshot\"") }
    XCTAssertEqual(snaps.count, 1, "JSON suffix on the rejected line must be discarded; second line runs")
    XCTAssertEqual(p.snapshotLines().filter { $0.contains("line-too-long") }.count, 1)
    // A complete oversized line (with LF) still produces exactly one error.
    p.send(String(repeating: "y", count: 70 * 1024) + "\n")
    XCTAssertNotNil(p.waitForLines(containing: "line-too-long", count: 2))
    sendQuitAndExpectCleanExit(p)
  }
}
