import XCTest
@testable import SenseHelperCore

// Shared pipe scaffolding: nonblocking read end, deterministic drain/wait.
class PipeCase: XCTestCase {
  var fds: (r: Int32, w: Int32) = (-1, -1)
  let lock = NSLock()
  func makePipe() {
    var f = [Int32](repeating: 0, count: 2)
    XCTAssertEqual(pipe(&f), 0)
    fds = (f[0], f[1])
    _ = fcntl(fds.r, F_SETFL, fcntl(fds.r, F_GETFL) | O_NONBLOCK)
  }
  func closeEnds() {
    if fds.r >= 0 { close(fds.r); fds.r = -1 }
    if fds.w >= 0 { close(fds.w); fds.w = -1 }
  }
  func writeAll(_ s: String) {
    let data = Data(s.utf8)
    _ = data.withUnsafeBytes { Darwin.write(fds.w, $0.baseAddress!, $0.count) }
  }
  func readAvailable() -> Data {
    var out = Data(), buf = [UInt8](repeating: 0, count: 8192)
    while true {
      let n = read(fds.r, &buf, buf.count)
      if n <= 0 { return out }
      out.append(contentsOf: buf[0..<n])
    }
  }
  func fillPipe() {
    let filler = [UInt8](repeating: 0x2e, count: 4096)
    while write(fds.w, filler, filler.count) > 0 {}
  }
  func waitFor(_ timeout: TimeInterval = 5, _ pred: () -> Bool) -> Bool {
    let end = Date().addingTimeInterval(timeout)
    while Date() < end {
      lock.lock(); let ok = pred(); lock.unlock()
      if ok { return true }
      Thread.sleep(forTimeInterval: 0.005)
    }
    return false
  }
  // Drain until `pred` holds (or 5s); every byte read goes to `sink`.
  func drainUntil(_ sink: (Data) -> Void, _ pred: () -> Bool) {
    let end = Date().addingTimeInterval(5)
    while Date() < end && !pred() { sink(readAvailable()); Thread.sleep(forTimeInterval: 0.01) }
    sink(readAvailable())
  }
}

final class OutputWriterTests: PipeCase {
  private var writer: OutputWriter!
  private var recovered: [Int] = [], fatals = 0
  private var recoveredCount: Int { lock.lock(); defer { lock.unlock() }; return recovered.count }
  override func setUp() {
    makePipe()
    recovered = []; fatals = 0
    writer = OutputWriter(fd: fds.w)
    writer.onDropsRecovered = { [self] n in lock.lock(); recovered.append(n); lock.unlock() }
    writer.onFatal = { [self] in lock.lock(); fatals += 1; lock.unlock() }
  }
  override func tearDown() { writer.close(); closeEnds() }
  private func line(_ tag: String, size: Int = 64) -> Data {
    Data((tag + String(repeating: "x", count: max(0, size - tag.count - 1)) + "\n").utf8)
  }
  // A >PIPE_BUF line writes across drain cycles, intact and in order.
  func testPartialWriteKeepsLineOrder() {
    let big = line("BIG:", size: 128 * 1024)
    fillPipe()
    var hole = [UInt8](repeating: 0, count: 4096)
    _ = read(fds.r, &hole, hole.count) // leave ~4KiB of space
    writer.enqueue(big, critical: false)
    XCTAssertTrue(waitFor { writer.headOffsetForTesting > 0 })
    let off = writer.headOffsetForTesting
    XCTAssertGreaterThan(off, 0)
    XCTAssertLessThan(off, big.count, "first write must be a strict partial")
    var got = Data()
    drainUntil({ got.append($0) }, { writer.headOffsetForTesting == -1 })
    XCTAssertEqual(got.suffix(big.count), big, "reassembled line is byte-identical")
  }
  // Exact eviction: 1 crit + 1100 noncritical over the 1024 cap drops 77.
  func testEvictionAndDroppedCountRecovery() {
    fillPipe()
    writer.enqueue(line("CRIT"), critical: true)
    for i in 0..<1100 { writer.enqueue(line("n\(i)"), critical: false) }
    var text = ""
    drainUntil({ text += String(decoding: $0, as: UTF8.self) }, { recoveredCount > 0 })
    lock.lock()
    XCTAssertEqual(recovered, [77], "one output_overflow report, exactly 77 dropped")
    lock.unlock()
    let wire = text.split(separator: "\n").map(String.init)
    XCTAssertEqual(wire.count, 1024, "critical + 1023 noncriticals survived")
    XCTAssertTrue(wire[0].contains("CRIT"), "critical line survives pressure")
    XCTAssertTrue(wire[1].hasPrefix("n77"), "oldest noncritical evicted first")
    XCTAssertTrue(wire.last!.hasPrefix("n1099"), "newest noncritical retained")
  }
  // An all-critical backlog fails fast instead of growing or dropping.
  func testAllCriticalBacklogFailsFast() {
    fillPipe()
    for _ in 0..<20 { writer.enqueue(line("crit", size: 64 * 1024), critical: true) }
    XCTAssertTrue(waitFor { fatals > 0 })
    lock.lock(); XCTAssertTrue(recovered.isEmpty); lock.unlock()
  }
  // An oversize critical line that can never fit fails immediately.
  func testOversizeCriticalFailsImmediately() {
    writer.enqueue(line("huge", size: OutputWriter.maxBytes + 16), critical: true)
    lock.lock(); XCTAssertEqual(fatals, 1); lock.unlock()
  }
  // #9: purge drops unstarted title-bearing lines only; criticals survive.
  func testTitlePurgeKeepsCriticals() {
    fillPipe()
    writer.enqueue(line("t1"), critical: false, hasTitle: true)
    writer.enqueue(line("k1"), critical: true, hasTitle: true)
    writer.enqueue(line("n1"), critical: false)
    writer.purgeUnstartedTitles()
    var text = ""
    drainUntil({ text += String(decoding: $0, as: UTF8.self) }, { text.contains("n1") })
    XCTAssertTrue(text.contains("k1"), "critical line survives the purge")
    XCTAssertFalse(text.contains("t1"))
  }
}

final class InputReaderTests: PipeCase {
  private var reader: InputReader!
  private var lines: [String] = [], dones: [() -> Void] = [], errors: [String] = []
  private var eofHit = false, eofDetected = false, autoRelease = false
  override func setUp() {
    makePipe()
    lines = []; dones = []; errors = []; eofHit = false; eofDetected = false; autoRelease = false
    reader = InputReader(fd: fds.r, queue: DispatchQueue(label: "test.in"))
    reader.onLine = { [self] d, done in
      lock.lock()
      lines.append(String(decoding: d, as: UTF8.self))
      let auto = autoRelease
      if !auto { dones.append(done) }
      lock.unlock()
      if auto { done() }
    }
    reader.onError = { [self] c in lock.lock(); errors.append(c); lock.unlock() }
    reader.onEOFDetected = { [self] in lock.lock(); eofDetected = true; lock.unlock() }
    reader.onEOF = { [self] in lock.lock(); eofHit = true; lock.unlock() }
    reader.start()
  }
  override func tearDown() { reader.stop(); closeEnds() }
  private func releaseAll() {
    while waitFor(1, { !dones.isEmpty || eofHit }) {
      lock.lock()
      let batch = dones; dones = []
      let done = eofHit
      lock.unlock()
      for d in batch { d() }
      if done { return }
    }
  }
  // Commands are consumed strictly one at a time; the rest stays bounded.
  func testSerializedConsumption() {
    writeAll("one\ntwo\nthree\n")
    XCTAssertTrue(waitFor { lines.count == 1 })
    Thread.sleep(forTimeInterval: 0.1)
    lock.lock(); XCTAssertEqual(lines, ["one"], "next line waits for completion"); lock.unlock()
    releaseAll()
    XCTAssertTrue(waitFor { lines.count == 3 })
    lock.lock(); XCTAssertEqual(lines, ["one", "two", "three"]); lock.unlock()
  }
  // F: EOF runs buffered commands + trailing partial; onEOFDetected fires early.
  func testEOFDrainsBufferedCommandsAndArmsDeadlineEarly() {
    writeAll("a\r\nb\nc") // CRLF stripped; "c" is the trailing partial command
    close(fds.w); fds.w = -1
    XCTAssertTrue(waitFor { lines.count >= 1 && eofDetected },
                  "onEOFDetected must fire before the buffered drain finishes")
    lock.lock(); XCTAssertFalse(eofHit, "onEOF waits for buffered commands"); lock.unlock()
    releaseAll()
    XCTAssertTrue(waitFor { eofHit })
    lock.lock()
    XCTAssertEqual(lines, ["a", "b", "c"], "complete buffered lines are processed normally")
    lock.unlock()
  }
  // Overflow discards through newlines, reports once, stays under cap.
  func testOverflowDiscardsAndRecovers() {
    writeAll("held\n")
    XCTAssertTrue(waitFor { lines.count == 1 }) // in-flight, held
    let flood = String(repeating: String(repeating: "x", count: 200) + "\n", count: 2000) // ~400KiB
    writeAll(flood)
    XCTAssertTrue(waitFor { errors.contains("input_overflow") })
    lock.lock(); autoRelease = true; lock.unlock() // drain buffered lines fast
    releaseAll()
    writeAll("tail-marker\n")
    XCTAssertTrue(waitFor { lines.contains("tail-marker") }, "reader recovers after the flood")
    lock.lock()
    let peak = reader.peakPending, episodes = errors.filter { $0 == "input_overflow" }.count
    let delivered = lines.count
    lock.unlock()
    XCTAssertLessThanOrEqual(peak, InputReader.maxPending, "pending incl. in-flight never exceeds 256KiB")
    XCTAssertGreaterThanOrEqual(episodes, 1)
    XCTAssertLessThan(delivered, 2000, "flooded lines are discarded, not queued")
  }
  // A >64KiB line keeps line-too-long; the rest is discarded.
  func testOrdinaryOversizedLineStillLineTooLong() {
    writeAll(String(repeating: "y", count: 70 * 1024))
    XCTAssertTrue(waitFor { errors.contains("line-too-long") })
    writeAll("\nok-line\n")
    XCTAssertTrue(waitFor { lines.contains("ok-line") })
    lock.lock(); XCTAssertFalse(errors.contains("input_overflow")); lock.unlock()
  }
}
