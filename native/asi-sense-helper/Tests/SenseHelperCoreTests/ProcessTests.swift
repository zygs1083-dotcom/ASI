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

// Drives the synthetic pipe fixture: same CommandChannel+AXSession as the real
// helper, deterministic fake AX, stderr markers for synchronization.
private final class FixtureProcess {
  let process = Process()
  private let stdinPipe = Pipe(), stdoutPipe = Pipe(), stderrPipe = Pipe()
  private var outData = Data(), errData = Data()
  private var partial = Data(), lines: [String] = []
  private let lock = NSLock()

  init(binary: URL, args: [String] = [], prefillStdout: Bool = false,
       drainStdout: Bool = true) throws {
    let wfd = stdoutPipe.fileHandleForWriting.fileDescriptor
    if prefillStdout { // structural saturation: kernel pipe starts full
      _ = fcntl(wfd, F_SETFL, fcntl(wfd, F_GETFL) | O_NONBLOCK)
      var buf = [UInt8](repeating: 0x2e, count: 4096)
      while write(wfd, &buf, buf.count) > 0 {}
      var one: UInt8 = 0x2e // top off the last partial slot
      while write(wfd, &one, 1) > 0 {}
    }
    stderrPipe.fileHandleForReading.readabilityHandler = { [weak self] h in
      self?.appendErr(h.availableData)
    }
    if drainStdout { startDraining() }
    process.executableURL = binary
    process.arguments = args
    process.standardInput = stdinPipe
    process.standardOutput = stdoutPipe
    process.standardError = stderrPipe
    try process.run()
  }
  deinit { cleanup() }
  func cleanup() {
    stdoutPipe.fileHandleForReading.readabilityHandler = nil
    stderrPipe.fileHandleForReading.readabilityHandler = nil
    try? stdinPipe.fileHandleForWriting.close()
    guard process.isRunning else { return }
    process.terminate()
    if waitExit(timeout: 3) == nil { kill(process.processIdentifier, SIGKILL); process.waitUntilExit() }
  }
  func startDraining() {
    stdoutPipe.fileHandleForReading.readabilityHandler = { [weak self] h in
      self?.appendOut(h.availableData)
    }
  }
  // Read exactly n bytes off the undrained pipe (leaves <4096 free).
  func readStdout(bytes n: Int) {
    var buf = [UInt8](repeating: 0, count: n)
    _ = read(stdoutPipe.fileHandleForReading.fileDescriptor, &buf, n)
  }
  func stdoutBuffered() -> Int {
    var n = Int32(0)
    _ = ioctl(stdoutPipe.fileHandleForReading.fileDescriptor, 0x4004_667f, &n)
    return Int(n)
  }
  private func appendErr(_ d: Data) { lock.lock(); errData.append(d); lock.unlock() }
  private func appendOut(_ d: Data) {
    lock.lock(); defer { lock.unlock() }
    outData.append(d)
    partial.append(d)
    while let nl = partial.firstIndex(of: 0x0A) {
      let line = partial.subdata(in: partial.startIndex..<nl)
      partial.removeSubrange(partial.startIndex...nl)
      if let s = String(data: line, encoding: .utf8) { lines.append(s) }
    }
  }
  func send(_ s: String) { stdinPipe.fileHandleForWriting.write(Data(s.utf8)) }
  func writeFlood(_ data: Data, offset: Int = 0, timeout: TimeInterval) -> Int {
    signal(SIGPIPE, SIG_IGN)
    let fd = stdinPipe.fileHandleForWriting.fileDescriptor
    let flags = fcntl(fd, F_GETFL)
    _ = fcntl(fd, F_SETFL, flags | O_NONBLOCK)
    defer { _ = fcntl(fd, F_SETFL, flags) }
    let deadline = ProcessInfo.processInfo.systemUptime + timeout
    var written = offset
    while written < data.count && ProcessInfo.processInfo.systemUptime < deadline {
      let n = data.withUnsafeBytes {
        write(fd, $0.baseAddress!.advanced(by: written), $0.count - written)
      }
      if n > 0 { written += n; continue }
      if n < 0 && errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR { break }
      var p = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
      _ = poll(&p, 1, 10)
    }
    return written
  }
  func discardPrefillAndDrain() {
    var remaining = stdoutBuffered()
    var buf = [UInt8](repeating: 0, count: 4096)
    while remaining > 0 {
      let n = read(stdoutPipe.fileHandleForReading.fileDescriptor, &buf, min(remaining, buf.count))
      if n <= 0 { break }
      remaining -= n
    }
    startDraining()
  }
  func closeStdin() { try? stdinPipe.fileHandleForWriting.close() }
  func snapshotLines() -> [String] { lock.lock(); defer { lock.unlock() }; return lines }
  func rawOutput() -> Data { lock.lock(); defer { lock.unlock() }; return outData }
  func stderrText() -> String { lock.lock(); defer { lock.unlock() }
    return String(decoding: errData, as: UTF8.self) }
  private func waitFor(_ timeout: TimeInterval, _ pred: () -> Bool) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
      if pred() { return true }
      Thread.sleep(forTimeInterval: 0.01)
    }
    return false
  }
  @discardableResult
  func waitStderr(_ marker: String, count: Int = 1, timeout: TimeInterval = 10) -> Bool {
    waitFor(timeout) {
      self.stderrText().components(separatedBy: marker).count - 1 >= count
    }
  }
  @discardableResult
  func waitForLine(containing needle: String, timeout: TimeInterval = 10) -> String? {
    var found: String?
    _ = waitFor(timeout) {
      found = self.snapshotLines().first { $0.contains(needle) }
      return found != nil
    }
    return found
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
  func waitExit(timeout: TimeInterval = 10) -> Int32? {
    waitFor(timeout) { !self.process.isRunning } ? process.terminationStatus : nil
  }
}

final class ProcessTests: XCTestCase {
  private static func binary() throws -> URL {
    try binaryNamed("asi-sense-helper")
  }
  private static func fixtureBinary() throws -> URL {
    try binaryNamed("asi-sense-pipe-fixture")
  }
  private static func binaryNamed(_ name: String) throws -> URL {
    var dir = URL(fileURLWithPath: #filePath)
    for _ in 0..<3 { dir.deleteLastPathComponent() } // package root
    for config in ["debug", "release"] {
      let url = dir.appendingPathComponent(".build/\(config)/\(name)")
      if FileManager.default.isExecutableFile(atPath: url.path) { return url }
    }
    XCTFail("\(name) binary not found; run `swift build` first")
    return dir.appendingPathComponent(".build/debug/\(name)")
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
    // Bounded well under the 1024-line critical cap: snapshots are critical
    // output now, so an unbounded flood would legitimately fail fast.
    let batch = String(repeating: "{\"cmd\":\"snapshot\"}\n", count: 100)
    for _ in 0..<3 { XCTAssertTrue(p.sendFlood(batch, deadline: 2)) }
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

  // MARK: - Synthetic fixture scenarios (same CommandChannel + AXSession)

  private func launchFixture(_ args: [String] = [], prefillStdout: Bool = false,
                             drainStdout: Bool = true) throws -> FixtureProcess {
    let p = try FixtureProcess(binary: Self.fixtureBinary(), args: args,
                               prefillStdout: prefillStdout, drainStdout: drainStdout)
    XCTAssertTrue(p.waitStderr("fixture:ready"), "fixture must start")
    return p
  }
  // A: a titles:false control jumps a >256KiB ordinary backlog AND an
  // AX-blocked snapshot; the ack lands before the gate releases and quit
  // bypasses the whole stuck pipeline.
  func testFixtureAControlBypassesBlockedSnapshotAndOverflow() throws {
    let p = try launchFixture(["--gate-fw-from=2", "--release-delay-ms=2500"])
    XCTAssertNotNil(p.waitForLine(containing: "window.focused"))
    p.send("{\"cmd\":\"titles\",\"enabled\":true,\"id\":\"A-enable\"}\n")
    XCTAssertNotNil(p.waitForLine(containing: "\"id\":\"A-enable\""))
    XCTAssertTrue(p.waitStderr("fixture:title-read"))
    p.send("{\"cmd\":\"snapshot\"}\n")
    XCTAssertTrue(p.waitStderr("fixture:gate-hold"), "first snapshot must reach the gated AX read")
    p.send(String(repeating: "{\"cmd\":\"snapshot\"}\n", count: 15000)) // ~270KiB
    p.send("{\"cmd\":\"titles\",\"enabled\":false,\"id\":\"A1\"}\n")
    guard let ack = p.waitForLine(containing: "\"id\":\"A1\"", timeout: 10) else {
      return XCTFail("ack must arrive while the backlog and AX read are still blocked")
    }
    XCTAssertFalse(p.stderrText().contains("fixture:gate-release"),
                   "ack must precede any AX completion")
    guard let d = (try? JSONSerialization.jsonObject(with: Data(ack.utf8))) as? [String: Any] else {
      return XCTFail("ack must be JSON")
    }
    XCTAssertEqual(d["id"] as? String, "A1")
    XCTAssertEqual(d["enabled"] as? Bool, false)
    XCTAssertNotNil(d["gen"] as? Int)
    guard let overflow = p.waitForLine(containing: "input_overflow", timeout: 5) else {
      return XCTFail("dropped snapshots must be reported")
    }
    let od = (try? JSONSerialization.jsonObject(with: Data(overflow.utf8))) as? [String: Any]
    XCTAssertGreaterThan(
      ((od?["droppedTypes"] as? [String: Any])?["snapshot"] as? Int) ?? 0, 0,
      "snapshot drops counted by type")
    p.send("{\"cmd\":\"quit\"}\n")
    guard let code = p.waitExit(timeout: 3) else {
      return XCTFail("quit must bypass the blocked AX work and the input backlog")
    }
    XCTAssertEqual(code, 0)
  }
  // B: titles:false is applied and acked while the snapshot's AX read is still
  // gated; the gate releases only afterwards (fixture schedules it inside the
  // titles hook), so the completed snapshot must carry no title.
  func testFixtureBAckPrecedesGateReleaseSnapshotHasNoTitle() throws {
    let p = try launchFixture(["--gate-fw-from=2", "--release-delay-ms=750"])
    XCTAssertNotNil(p.waitForLine(containing: "window.focused"))
    p.send("{\"cmd\":\"titles\",\"enabled\":true,\"id\":\"B-enable\"}\n")
    XCTAssertNotNil(p.waitForLine(containing: "\"id\":\"B-enable\""))
    XCTAssertTrue(p.waitStderr("fixture:title-read"))
    p.send("{\"cmd\":\"snapshot\"}\n")
    XCTAssertTrue(p.waitStderr("fixture:gate-hold"))
    p.send("{\"cmd\":\"titles\",\"enabled\":false,\"id\":\"B1\"}\n")
    guard let ack = p.waitForLine(containing: "\"id\":\"B1\"", timeout: 10) else {
      return XCTFail("ack must arrive while AX is still gated")
    }
    XCTAssertFalse(p.stderrText().contains("fixture:gate-release"),
                   "the AX read must still be blocked when the ack lands")
    XCTAssertTrue(ack.contains("\"enabled\":false"))
    guard let snap = p.waitForLine(containing: "\"type\":\"snapshot\"", timeout: 10) else {
      return XCTFail("snapshot must complete once the delayed gate releases")
    }
    XCTAssertFalse(snap.contains("\"title\""), "post-toggle snapshot carries no title")
    XCTAssertTrue(p.stderrText().contains("fixture:gate-release"))
    p.send("{\"cmd\":\"quit\"}\n")
    XCTAssertEqual(p.waitExit(), 0)
  }
  // C: title lines are <=PIPE_BUF and write atomically, so a pipe with less
  // than a whole line free NEVER receives a title byte - the queued entry is
  // removed wholesale by the privacy purge. Only a line that completed
  // entirely before the toggle could already sit in the kernel.
  private func fixturePrivacyPurgeFlow(prefreeBytes: Int) throws {
    let p = try launchFixture(["--title-len=60000"], prefillStdout: true,
                              drainStdout: false)
    XCTAssertGreaterThan(p.stdoutBuffered(), 16 * 1024, "pipe must start full")
    // Titles default off: enable first so the snapshot is actually titled.
    p.send("{\"cmd\":\"titles\",\"enabled\":true,\"id\":\"C0\"}\n")
    XCTAssertTrue(p.waitStderr("fixture:titles-applied"),
                  "privacy enable must apply before the titled snapshot")
    p.send("{\"cmd\":\"snapshot\"}\n")
    XCTAssertTrue(p.waitStderr("fixture:snapshot-done"),
                  "the title-bearing snapshot must be queued in the writer")
    if prefreeBytes > 0 { p.readStdout(bytes: prefreeBytes) } // < title line
    XCTAssertFalse(p.stderrText().contains("FIXTLEAK"), "markers never go to stderr")
    p.send("{\"cmd\":\"titles\",\"enabled\":false,\"id\":\"C1\"}\n")
    // The marker is emitted only after the full control applied: the purge and
    // the ack enqueue are already done when stdout starts draining.
    XCTAssertTrue(p.waitStderr("fixture:titles-applied", count: 2),
                  "privacy applies while stdout is still blocked")
    p.startDraining()
    guard let ack = p.waitForLine(containing: "\"id\":\"C1\"", timeout: 10) else {
      return XCTFail("the ack must still arrive")
    }
    XCTAssertTrue(ack.contains("\"enabled\":false"))
    let raw = String(decoding: p.rawOutput(), as: UTF8.self)
    XCTAssertFalse(raw.contains("FIXTLEAK-BEGIN"),
                   "no synthetic title byte may ever reach the wire")
    XCTAssertFalse(raw.contains("FIXTLEAK-END"),
                   "no synthetic title suffix may ever reach the wire")
    XCTAssertFalse(raw.contains("\"title\""), "no title key post-toggle")
    // Everything after the kernel filler must be whole valid NDJSON records -
    // a truncated title line can never be glued onto a following event.
    let segments = raw.split(separator: "\n").map(String.init)
    let events = segments.filter { $0.hasPrefix("{") }
    XCTAssertFalse(events.isEmpty, "events must follow the filler")
    for line in events {
      XCTAssertNotNil(try? JSONSerialization.jsonObject(with: Data(line.utf8)),
                      "every emitted line is valid JSON: \(line.prefix(60))")
    }
    XCTAssertTrue(events.contains { $0.contains("\"type\":\"snapshot\"") },
                  "the critical snapshot survives, stripped")
    p.send("{\"cmd\":\"quit\"}\n")
    XCTAssertEqual(p.waitExit(), 0)
  }
  func testFixtureC1FullPipeQueuedTitleNeverWrittenAfterToggle() throws {
    try fixturePrivacyPurgeFlow(prefreeBytes: 0)
  }
  // C variant: a hole smaller than one atomic title line still admits zero
  // title bytes - hello/thermal may consume the hole, nothing else fits.
  func testFixtureC2PartialFreeSpaceTitleNeverWritten() throws {
    try fixturePrivacyPurgeFlow(prefreeBytes: 64)
  }
  private func jsonDict(_ line: String) -> [String: Any]? {
    (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any]
  }
  // One write produces three ordered acks in the hello session.
  func testFixtureTitlesControlsAckEachInOrderWithSession() throws {
    let p = try launchFixture()
    guard let hello = p.waitForLine(containing: "\"type\":\"hello\""),
          let session = jsonDict(hello)?["session"] as? String, !session.isEmpty else {
      return XCTFail("hello must carry a nonempty session")
    }
    XCTAssertNotNil(UUID(uuidString: session), "session must be a UUID")
    p.send("{\"cmd\":\"titles\",\"enabled\":true,\"id\":\"A\"}\n" +
           "{\"cmd\":\"titles\",\"enabled\":false,\"id\":\"B\"}\n" +
           "{\"cmd\":\"titles\",\"enabled\":true,\"id\":\"C\"}\n")
    guard let acks = p.waitForLines(containing: "titles.ack", count: 3) else {
      return XCTFail("every titles control gets its own ack")
    }
    var gens: [Int] = []
    for (i, want) in [("A", true), ("B", false), ("C", true)].enumerated() {
      guard let d = jsonDict(acks[i]) else { return XCTFail("ack must be JSON") }
      XCTAssertEqual(d["id"] as? String, want.0)
      XCTAssertEqual(d["enabled"] as? Bool, want.1)
      XCTAssertEqual(d["session"] as? String, session, "ack session must match hello")
      guard let g = d["gen"] as? Int else { return XCTFail("ack must carry gen") }
      gens.append(g)
    }
    XCTAssertEqual(gens, gens.sorted())
    XCTAssertEqual(Set(gens).count, 3, "gens strictly increase per control")
    p.send("{\"cmd\":\"quit\"}\n")
    XCTAssertEqual(p.waitExit(), 0)
  }
  // Default-off focus and a real enabled -> disabled -> enabled interval.
  func testFixtureDefaultOffAndDisabledSnapshotInterval() throws {
    let p = try launchFixture()
    guard let focused = p.waitForLine(containing: "window.focused") else {
      return XCTFail("initial focus must arrive")
    }
    XCTAssertFalse(focused.contains("\"title\""), "default-off focus is title-free")
    XCTAssertFalse(p.stderrText().contains("fixture:title-read"),
                   "no AXTitle read while titles are off")
    p.send("{\"cmd\":\"titles\",\"enabled\":true,\"id\":\"A2\"}\n")
    XCTAssertNotNil(p.waitForLine(containing: "\"id\":\"A2\""))
    XCTAssertTrue(p.waitStderr("fixture:title-read"))
    p.send("{\"cmd\":\"titles\",\"enabled\":false,\"id\":\"B2\"}\n")
    XCTAssertNotNil(p.waitForLine(containing: "\"id\":\"B2\""))
    p.send("{\"cmd\":\"snapshot\"}\n")
    guard let snap = p.waitForLine(containing: "\"type\":\"snapshot\"") else {
      return XCTFail("snapshot must arrive")
    }
    XCTAssertTrue(snap.contains("\"status\":\"ok\""),
                  "attached window reports ok even while titles are off")
    XCTAssertFalse(snap.contains("\"title\""), "no nested title while disabled")
    p.send("{\"cmd\":\"titles\",\"enabled\":true,\"id\":\"C2\"}\n")
    XCTAssertNotNil(p.waitForLine(containing: "\"id\":\"C2\""))
    p.send("{\"cmd\":\"quit\"}\n")
    XCTAssertEqual(p.waitExit(), 0)
  }
  // Quit terminates parsing in the same write.
  func testFixtureQuitTerminatesParsingSameWrite() throws {
    let p = try launchFixture()
    p.send("{\"cmd\":\"quit\"}\n" +
           "{\"cmd\":\"titles\",\"enabled\":true,\"id\":\"after\"}\n" +
           "{\"cmd\":\"quit\"}\n")
    XCTAssertEqual(p.waitExit(), 0)
    XCTAssertFalse(p.snapshotLines().contains { $0.contains("\"id\":\"after\"") },
                   "nothing after quit is parsed or acked")
  }
  func testFixtureSessionsDifferAcrossLaunches() throws {
    let p1 = try launchFixture(), p2 = try launchFixture()
    guard let h1 = p1.waitForLine(containing: "\"type\":\"hello\""),
          let h2 = p2.waitForLine(containing: "\"type\":\"hello\""),
          let s1 = jsonDict(h1)?["session"] as? String,
          let s2 = jsonDict(h2)?["session"] as? String else {
      return XCTFail("both launches must emit a session in hello")
    }
    XCTAssertNotEqual(s1, s2)
    p1.send("{\"cmd\":\"quit\"}\n"); p2.send("{\"cmd\":\"quit\"}\n")
    XCTAssertEqual(p1.waitExit(), 0)
    XCTAssertEqual(p2.waitExit(), 0)
  }
  func testFixtureLargeSourceQuitLatency() throws {
    let p = try launchFixture(["--title-len=52428800"])
    XCTAssertNotNil(p.waitForLine(containing: "window.focused"))
    p.send("{\"cmd\":\"titles\",\"enabled\":true,\"id\":\"large\"}\n")
    XCTAssertNotNil(p.waitForLine(containing: "\"id\":\"large\""))
    XCTAssertNotNil(p.waitForLine(containing: "window.title"))
    p.send("{\"cmd\":\"snapshot\"}\n")
    Thread.sleep(forTimeInterval: 0.05)
    let start = ProcessInfo.processInfo.systemUptime
    p.send("{\"cmd\":\"quit\"}\n")
    XCTAssertEqual(p.waitExit(timeout: 1), 0)
    XCTAssertLessThanOrEqual(ProcessInfo.processInfo.systemUptime - start, 0.2)
  }

  private func congestedControls() -> Data {
    let padding = String(repeating: "x", count: 1200)
    return Data(((0..<1100).map {
      "{\"cmd\":\"titles\",\"enabled\":false,\"id\":\"\($0)-\(padding)\"}\n"
    }.joined() + "{\"cmd\":\"quit\"}\n").utf8)
  }

  func testFixtureBackpressureResumesAllOrderedAcksBeforeQuit() throws {
    let p = try launchFixture(prefillStdout: true, drainStdout: false)
    let data = congestedControls()
    let sent = p.writeFlood(data, timeout: 1)
    XCTAssertLessThan(sent, data.count, "stdout saturation must backpressure the sender")
    XCTAssertTrue(p.process.isRunning, "critical saturation must not terminate the helper")
    guard p.process.isRunning else { return }
    p.discardPrefillAndDrain()
    XCTAssertEqual(p.writeFlood(data, offset: sent, timeout: 10), data.count)
    guard let acks = p.waitForLines(containing: "titles.ack", count: 1100, timeout: 15) else {
      return XCTFail("all 1100 acknowledgements must arrive")
    }
    XCTAssertEqual(acks.count, 1100)
    for (i, line) in acks.enumerated() {
      guard let ack = jsonDict(line) else { return XCTFail("invalid ack JSON") }
      XCTAssertTrue((ack["id"] as? String)?.hasPrefix("\(i)-") == true)
      XCTAssertEqual(ack["gen"] as? Int, i + 1)
    }
    XCTAssertEqual(p.waitExit(timeout: 3), 0)
  }

  private func assertCongestedTermination(signal: Bool) throws {
    let p = try launchFixture(prefillStdout: true, drainStdout: false)
    let data = congestedControls()
    XCTAssertLessThan(p.writeFlood(data, timeout: 1), data.count)
    XCTAssertTrue(p.process.isRunning)
    guard p.process.isRunning else { return }
    let start = ProcessInfo.processInfo.systemUptime
    if signal { p.process.terminate() } else { p.closeStdin() }
    XCTAssertEqual(p.waitExit(timeout: 1), 0)
    XCTAssertLessThan(ProcessInfo.processInfo.systemUptime - start, 0.4)
  }

  func testFixtureCongestedEOFStopsWithinDrainDeadline() throws {
    try assertCongestedTermination(signal: false)
  }

  func testFixtureCongestedSIGTERMStopsWithinDrainDeadline() throws {
    try assertCongestedTermination(signal: true)
  }

  func testFixtureNonAckCriticalBackpressureStillDetectsEOF() throws {
    let p = try launchFixture(prefillStdout: true, drainStdout: false)
    let commands = Data(String(repeating: "{\"cmd\":\"recheck-permissions\"}\n", count: 1100).utf8)
    XCTAssertEqual(p.writeFlood(commands, timeout: 5), commands.count)
    XCTAssertTrue(p.waitStderr("fixture:recheck-done", count: 1020, timeout: 10))
    Thread.sleep(forTimeInterval: 0.2)
    XCTAssertFalse(p.waitStderr("fixture:recheck-done", count: 1100, timeout: 0.1))
    XCTAssertTrue(p.process.isRunning)
    let start = ProcessInfo.processInfo.systemUptime
    p.closeStdin()
    XCTAssertEqual(p.waitExit(timeout: 1), 0)
    XCTAssertLessThan(ProcessInfo.processInfo.systemUptime - start, 0.4)
  }

  func testFixtureQuitWaitsForQueuedAckWhileStdoutIsBlocked() throws {
    let p = try launchFixture(prefillStdout: true, drainStdout: false)
    p.send("{\"cmd\":\"titles\",\"enabled\":false,\"id\":\"quit-fence\"}\n" +
           "{\"cmd\":\"quit\"}\n")
    Thread.sleep(forTimeInterval: 0.45)
    XCTAssertTrue(p.process.isRunning, "in-band quit must not abandon queued acknowledgements")
    guard p.process.isRunning else { return }
    p.discardPrefillAndDrain()
    XCTAssertNotNil(p.waitForLine(containing: "\"id\":\"quit-fence\""))
    XCTAssertEqual(p.waitExit(timeout: 2), 0)
  }

  func testFixtureQuitDrainCanBeInterruptedByEOF() throws {
    let p = try launchFixture(prefillStdout: true, drainStdout: false)
    p.send("{\"cmd\":\"titles\",\"enabled\":false}\n{\"cmd\":\"quit\"}\n")
    Thread.sleep(forTimeInterval: 0.3)
    XCTAssertTrue(p.process.isRunning)
    let start = ProcessInfo.processInfo.systemUptime
    p.closeStdin()
    XCTAssertEqual(p.waitExit(timeout: 1), 0)
    XCTAssertLessThan(ProcessInfo.processInfo.systemUptime - start, 0.4)
  }

  func testFixturePurgedFocusRepostedOnceWithoutTitle() throws {
    let p = try launchFixture(["--defer-activation"], prefillStdout: true, drainStdout: false)
    p.send("{\"cmd\":\"titles\",\"enabled\":true,\"id\":\"enable-focus\"}\n")
    XCTAssertTrue(p.waitStderr("fixture:titles-applied"))
    p.send("{\"cmd\":\"recheck-permissions\"}\n")
    XCTAssertTrue(p.waitStderr("fixture:focus-queued"))
    XCTAssertTrue(p.waitStderr("fixture:title-read"))
    p.send("{\"cmd\":\"titles\",\"enabled\":false,\"id\":\"purge-focus\"}\n")
    XCTAssertTrue(p.waitStderr("fixture:titles-applied", count: 2))
    p.discardPrefillAndDrain()
    XCTAssertNotNil(p.waitForLine(containing: "\"id\":\"purge-focus\""))
    guard let focus = p.waitForLine(containing: "\"type\":\"window.focused\"") else {
      return XCTFail("the purged focus must be reposted")
    }
    XCTAssertNil(jsonDict(focus)?["title"], "reposted focus must be title-free")
    p.send("{\"cmd\":\"titles\",\"enabled\":false,\"id\":\"dedup-focus\"}\n")
    XCTAssertNotNil(p.waitForLine(containing: "\"id\":\"dedup-focus\""))
    Thread.sleep(forTimeInterval: 0.3)
    XCTAssertEqual(p.snapshotLines().filter { eventType($0) == "window.focused" }.count, 1)
    p.send("{\"cmd\":\"quit\"}\n")
    XCTAssertEqual(p.waitExit(), 0)
  }

  func testFixtureEvictedFocusRepostedOnceAfterPrivacySwitch() throws {
    let p = try launchFixture(prefillStdout: true, drainStdout: false)
    XCTAssertTrue(p.waitStderr("fixture:focus-queued"))
    p.send("{\"cmd\":\"snapshot\"}\n")
    XCTAssertTrue(p.waitStderr("fixture:snapshot-done"))
    Thread.sleep(forTimeInterval: 0.2)
    let controls = String(repeating: "{\"cmd\":\"titles\",\"enabled\":false}\n", count: 1021)
    XCTAssertEqual(p.writeFlood(Data(controls.utf8), timeout: 5), controls.utf8.count)
    XCTAssertTrue(p.waitStderr("fixture:titles-applied", count: 1021))
    p.discardPrefillAndDrain()
    XCTAssertNotNil(p.waitForLines(containing: "titles.ack", count: 1021, timeout: 10))
    guard let overflow = p.waitForLine(containing: "output_overflow"),
          let types = jsonDict(overflow)?["droppedTypes"] as? [String: Int] else {
      return XCTFail("output overflow must report the eviction")
    }
    XCTAssertGreaterThan(types["window.focused"] ?? 0, 0)
    Thread.sleep(forTimeInterval: 0.3)
    p.send("{\"cmd\":\"titles\",\"enabled\":false,\"id\":\"retry-focus\"}\n")
    XCTAssertNotNil(p.waitForLine(containing: "\"id\":\"retry-focus\""))
    XCTAssertNotNil(p.waitForLine(containing: "\"type\":\"window.focused\"", timeout: 2))
    Thread.sleep(forTimeInterval: 0.3)
    XCTAssertEqual(p.snapshotLines().filter { eventType($0) == "window.focused" }.count, 1)
    p.send("{\"cmd\":\"quit\"}\n")
    XCTAssertEqual(p.waitExit(), 0)
  }
}
