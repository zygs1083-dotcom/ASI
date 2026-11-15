import XCTest
@testable import SenseHelperCore

// Drives the real helper binary over pipes (debug build, release fallback).
private final class HelperProcess {
  enum StdoutMode {
    case drain    // collect lines for assertions
    case discard  // keep draining so the child never blocks, drop contents
    case unread   // read end stays open but is never drained (saturation tests)
    case closed   // read end closed immediately (write-failure test)
  }
  let process = Process()
  private let stdinPipe = Pipe()
  private var lines: [String] = []
  private var partial = Data()
  private let lock = NSLock()
  private var stdoutPipe: Pipe?

  init(binary: URL, stdout: StdoutMode = .drain, prefillStdout: Bool = false) throws {
    let pipe = Pipe()
    stdoutPipe = pipe
    if prefillStdout {
      // Pre-fill the kernel pipe so saturation is structural.
      let wfd = pipe.fileHandleForWriting.fileDescriptor
      _ = fcntl(wfd, F_SETFL, fcntl(wfd, F_GETFL) | O_NONBLOCK)
      var buf = [UInt8](repeating: 0x2e, count: 4096)
      while write(wfd, &buf, buf.count) > 0 {}
    }
    switch stdout {
    case .closed:
      pipe.fileHandleForReading.closeFile()
    case .unread:
      break // keep both ends open; parent simply never reads
    case .drain:
      pipe.fileHandleForReading.readabilityHandler = { [weak self] h in
        self?.append(h.availableData)
      }
    case .discard:
      pipe.fileHandleForReading.readabilityHandler = { h in _ = h.availableData }
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
  // Kernel-buffered stdout bytes (.unread mode). 0x4004667f is FIONREAD's
  // stable macOS ABI value (_IOR('f', 127, int)).
  func stdoutBuffered() -> Int {
    guard let fd = stdoutPipe?.fileHandleForReading.fileDescriptor else { return 0 }
    var n = Int32(0)
    _ = ioctl(fd, 0x4004_667f, &n)
    return Int(n)
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
  // Nonblocking bounded flood: never hangs the suite on a regression.
  func sendFlood(_ s: String, deadline: TimeInterval = 2) -> Bool {
    let data = Data(s.utf8), end = Date().addingTimeInterval(deadline)
    let fd = stdinPipe.fileHandleForWriting.fileDescriptor, old = fcntl(fd, F_GETFL)
    _ = fcntl(fd, F_SETFL, old | O_NONBLOCK)
    defer { _ = fcntl(fd, F_SETFL, old) }
    var off = 0, p = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
    while off < data.count {
      let n = data.withUnsafeBytes { write(fd, $0.baseAddress!.advanced(by: off), $0.count - off) }
      if n > 0 { off += n; continue }
      if n < 0 && errno != EAGAIN && errno != EWOULDBLOCK { return false }
      if Date() >= end { return false }
      _ = poll(&p, 1, 50)
    }
    return true
  }
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
    waitForLines(containing: needle, timeout: timeout)?.first
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
    let p = try HelperProcess(binary: Self.binary(), stdout: .closed)
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
    // Oversized line with no LF: everything to the next LF is discarded.
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
  // #1: pre-filled kernel pipe + bounded flood prove EOF/SIGTERM stay prompt.
  private func saturateOutput(_ p: HelperProcess, file: StaticString = #filePath, line: UInt = #line) {
    XCTAssertGreaterThan(p.stdoutBuffered(), 16 * 1024,
                         "kernel pipe must start structurally full", file: file, line: line)
    p.send("{\"cmd\":\"titles\",\"enabled\":false}\n")
    let batch = String(repeating: "{\"cmd\":\"snapshot\"}\n", count: 100)
    let end = Date().addingTimeInterval(3)
    while Date() < end, p.sendFlood(batch, deadline: 0.5) {}
    Thread.sleep(forTimeInterval: 0.3) // let queued snapshots exercise the writer
    XCTAssertGreaterThanOrEqual(p.stdoutBuffered(), 16 * 1024,
                                "kernel pipe must still be full", file: file, line: line)
  }
  func testFilledStdoutEOFExitsWithinOneSecond() throws {
    let p = try HelperProcess(binary: Self.binary(), stdout: .unread, prefillStdout: true)
    saturateOutput(p)
    XCTAssertTrue(p.process.isRunning, "helper must not die under backpressure")
    p.closeStdin()
    guard let code = p.waitExit(timeout: 1) else {
      return XCTFail("EOF under filled stdout must exit within 1s")
    }
    XCTAssertEqual(code, 0)
  }
  func testFilledStdoutSigtermExitsWithinOneSecond() throws {
    let p = try HelperProcess(binary: Self.binary(), stdout: .unread, prefillStdout: true)
    saturateOutput(p)
    XCTAssertTrue(p.process.isRunning)
    p.process.terminate()
    guard let code = p.waitExit(timeout: 1) else {
      return XCTFail("SIGTERM under filled stdout must exit within 1s")
    }
    XCTAssertEqual(code, 0)
  }
  // F/#8: EOF runs complete commands buffered behind the in-flight one.
  func testEOFDeliversBufferedCommands() throws {
    let p = try launch()
    p.send("{\"cmd\":\"titles\",\"enabled\":false}\n{\"cmd\":\"snapshot\"}\n")
    p.closeStdin()
    XCTAssertNotNil(p.waitForLine(containing: "\"type\":\"snapshot\"", timeout: 2),
                    "buffered snapshot must run before EOF shutdown")
    XCTAssertEqual(p.waitExit(timeout: 1), 0)
  }
  // #8: sustained oversized input must never grow helper memory; bounded
  // reader discards and parent drains output.
  func testSustainedInputRSSStaysUnder50MiB() throws {
    let p = try HelperProcess(binary: Self.binary(), stdout: .drain)
    // Titles off so snapshots carry none; captured output is bounded, held in
    // memory only and never written to logs.
    p.send("{\"cmd\":\"titles\",\"enabled\":false}\n")
    let junk = String(repeating: "x", count: 80 * 1024) + "\n" // >64KiB: discard path
    var rssDuring = UInt64(0)
    for i in 0..<250 { // ~20MiB of oversized lines, paced so the fence survives
      XCTAssertTrue(p.sendFlood(junk, deadline: 3))
      if i == 125 { rssDuring = Self.rssBytes(of: p.process.processIdentifier) }
    }
    // Fence proves the flood was consumed; retry past an overflow episode.
    var snap: String?
    for _ in 0..<5 where snap == nil {
      p.send("{\"cmd\":\"snapshot\"}\n")
      snap = p.waitForLine(containing: "\"type\":\"snapshot\"", timeout: 3)
    }
    XCTAssertNotNil(snap)
    let rssEnd = Self.rssBytes(of: p.process.processIdentifier)
    for (tag, rss) in [("during", rssDuring), ("end", rssEnd)] {
      XCTAssertTrue(rss > 0, "must be able to read RSS \(tag)")
      XCTAssertLessThan(rss, 50 * 1024 * 1024, "RSS \(tag) must stay under 50MiB")
    }
    sendQuitAndExpectCleanExit(p)
  }
  private static func rssBytes(of pid: Int32) -> UInt64 {
    var info = rusage_info_v4()
    let rc = withUnsafeMutablePointer(to: &info) { ptr in
      ptr.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) {
        proc_pid_rusage(pid, RUSAGE_INFO_V4, $0)
      }
    }
    return rc == 0 ? info.ri_resident_size : 0
  }
}
