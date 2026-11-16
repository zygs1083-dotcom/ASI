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
    // Top off the last partial slot so "full" means exactly zero free space.
    var one: UInt8 = 0x2e
    while write(fds.w, &one, 1) > 0 {}
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
  private var fatals = 0
  override func setUp() {
    makePipe()
    fatals = 0
    writer = OutputWriter(fd: fds.w)
    writer.makeOverflowLine = { dropped, types in
      let obj: [String: Any] = ["type": "error", "code": "output_overflow",
                                "dropped": dropped, "droppedTypes": types]
      var d = try! JSONSerialization.data(withJSONObject: obj)
      d.append(0x0A)
      return d
    }
    writer.onFatal = { [self] in lock.lock(); fatals += 1; lock.unlock() }
  }
  override func tearDown() { writer.close(); closeEnds() }
  private func line(_ tag: String, size: Int = 64) -> Data {
    Data((tag + String(repeating: "x", count: max(0, size - tag.count - 1)) + "\n").utf8)
  }
  private func titledLine(_ tag: String, _ title: String) -> Data {
    let obj: [String: Any] = ["type": "window.title", "tag": tag, "title": title]
    var d = try! JSONSerialization.data(withJSONObject: obj)
    d.append(0x0A)
    return d
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
  // Eviction reports ONE coalesced output_overflow line with dropped counts.
  func testEvictionReportsOverflowImmediatelyWithTypes() {
    fillPipe()
    writer.enqueue(line("CRIT"), critical: true, type: "hello")
    for i in 0..<1100 { writer.enqueue(line("n\(i)"), critical: false, type: "window.title") }
    var text = ""
    drainUntil({ text += String(decoding: $0, as: UTF8.self) }, { text.contains("n1099") })
    let wire = text.split(separator: "\n").map(String.init)
    guard let overflow = wire.first(where: { $0.contains("output_overflow") }),
          let brace = overflow.firstIndex(of: "{"),
          let obj = try? JSONSerialization.jsonObject(
            with: Data(overflow[brace...].utf8)) as? [String: Any]
    else { return XCTFail("the overflow report must be a whole record on the wire") }
    // CRIT + report + 1022 noncrits fill the 1024-line cap: 78 evicted.
    XCTAssertEqual(obj["dropped"] as? Int, 78, "report coalesces every evicted line")
    XCTAssertEqual((obj["droppedTypes"] as? [String: Any])?["window.title"] as? Int, 78)
    XCTAssertTrue(wire.contains { $0.hasPrefix("CRIT") }, "critical line survives pressure")
    XCTAssertTrue(wire.contains { $0.hasPrefix("n78") }, "oldest noncriticals evicted first")
    XCTAssertFalse(wire.contains { $0.hasPrefix("n0") }, "the very first line was evicted")
    XCTAssertTrue(wire.contains { $0.hasPrefix("n1099") }, "newest noncritical retained")
    XCTAssertEqual(wire.filter { $0.contains("output_overflow") }.count, 1, "one coalesced report")
  }
  // An all-critical backlog fails fast instead of growing or dropping.
  func testAllCriticalBacklogFailsFast() {
    fillPipe()
    for _ in 0..<20 { writer.enqueue(line("crit", size: 64 * 1024), critical: true) }
    XCTAssertTrue(waitFor { fatals > 0 })
  }
  // An oversize critical line that can never fit fails immediately.
  func testOversizeCriticalFailsImmediately() {
    writer.enqueue(line("huge", size: OutputWriter.maxBytes + 16), critical: true)
    lock.lock(); XCTAssertEqual(fatals, 1); lock.unlock()
  }
  // Privacy purge: noncritical title lines drop; a critical titled snapshot is
  // re-encoded stripped, not purged. No sensitive byte reaches the wire.
  func testTitlePurgeDropsNoncriticalStripsCritical() {
    fillPipe()
    writer.enqueue(titledLine("t1", "SECRET"), critical: false, hasTitle: true,
                   type: "window.title")
    let snap = try! JSONSerialization.data(withJSONObject: [
      "type": "snapshot", "tag": "k1",
      "focusedWindow": ["pid": 1, "title": "SECRET-DEEP"],
    ]) + Data("\n".utf8)
    writer.enqueue(snap, critical: true, hasTitle: true, type: "snapshot")
    writer.enqueue(line("n1"), critical: false)
    writer.purgeUnstartedTitles(stripCritical: LineEncoder.stripTitles(fromLine:))
    var text = ""
    drainUntil({ text += String(decoding: $0, as: UTF8.self) }, { text.contains("n1") })
    XCTAssertFalse(text.contains("SECRET"), "no title bytes, not even a suffix")
    XCTAssertTrue(text.contains("k1"), "critical snapshot survives, stripped")
    XCTAssertTrue(text.contains("snapshot"))
  }
  // Title lines are <=PIPE_BUF so they write atomically: a hole smaller than
  // the line leaves the entry at offset 0 and the purge removes it whole.
  // No title byte can ever leak, and the wire stays valid JSON throughout.
  func testTitleLineAtomicAndPurgeKeepsValidJSON() {
    fillPipe()
    var hole = [UInt8](repeating: 0, count: 64)
    _ = read(fds.r, &hole, hole.count) // 64 free < encoded title line
    let titled = titledLine("tl", "FIXTLEAK-BEGIN-" + String(repeating: "s", count: 300))
    XCTAssertLessThanOrEqual(titled.count, LineEncoder.maxTitleLineBytes)
    XCTAssertGreaterThan(titled.count, 64, "fixture: line bigger than the hole")
    let snap = try! JSONSerialization.data(withJSONObject: [
      "type": "snapshot", "focusedWindow": ["pid": 1, "title": "SECRET-DEEP"],
    ]) + Data("\n".utf8)
    writer.enqueue(titled, critical: false, hasTitle: true, type: "window.title")
    writer.enqueue(snap, critical: true, hasTitle: true, type: "snapshot")
    Thread.sleep(forTimeInterval: 0.1)
    XCTAssertEqual(writer.headOffsetForTesting, 0,
                   "a title line is atomic: it must not partially start")
    writer.purgeUnstartedTitles(stripCritical: LineEncoder.stripTitles(fromLine:))
    writer.enqueue(line("TAIL"), critical: false)
    var got = Data()
    drainUntil({ got.append($0) }, { String(decoding: got, as: UTF8.self).contains("TAIL") })
    let wire = String(decoding: got, as: UTF8.self)
    XCTAssertFalse(wire.contains("FIXTLEAK"), "no title byte may reach the wire")
    XCTAssertFalse(wire.contains("SECRET"), "no title byte may reach the wire")
    for segment in wire.split(separator: "\n").map(String.init)
      where segment.hasPrefix("{") {
      XCTAssertNotNil(try? JSONSerialization.jsonObject(with: Data(segment.utf8)),
                      "every emitted line is valid JSON")
    }
    XCTAssertTrue(wire.contains("\"type\":\"snapshot\""),
                  "critical snapshot survives, title-stripped")
  }
  // A >PIPE_BUF overflow report may legitimately write partially; its drop
  // counters freeze at first write, later drops build a new pending report,
  // and the reports' `dropped` sums must equal total evictions exactly.
  func testOverflowReportPartialWriteKeepsAccurateCounts() {
    writer.makeOverflowLine = { dropped, types in
      var d = try! JSONSerialization.data(withJSONObject: [
        "type": "error", "code": "output_overflow", "dropped": dropped,
        "droppedTypes": types, "pad": String(repeating: "p", count: 600)])
      d.append(0x0A)
      return d
    }
    fillPipe()
    // ~1.4MiB of noncritical lines: evictions hit the byte bound too.
    for i in 0..<1200 { writer.enqueue(line("n\(i)", size: 1200), critical: false,
                                       type: "window.title") }
    // A hole smaller than the ~720B report but >= PIPE_BUF: the report starts
    // and stays partially written (sub-PIPE_BUF free space yields no write).
    var hole = [UInt8](repeating: 0, count: 600)
    _ = read(fds.r, &hole, hole.count)
    XCTAssertTrue(waitFor { writer.headOffsetForTesting > 0 },
                  "the oversized report must partially write through the hole")
    for i in 1200..<1400 { writer.enqueue(line("n\(i)", size: 1200), critical: false,
                                          type: "window.title") }
    var text = ""
    drainUntil({ text += String(decoding: $0, as: UTF8.self) },
               { text.split(separator: "\n").contains { $0.hasPrefix("n1399") } })
    let segments = text.split(separator: "\n").map(String.init)
    var reported = 0, reports = 0
    for s in segments where s.contains("output_overflow") {
      guard let b = s.firstIndex(of: "{"),
            let o = try? JSONSerialization.jsonObject(
              with: Data(s[b...].utf8)) as? [String: Any],
            let d = o["dropped"] as? Int else { continue }
      reported += d; reports += 1
    }
    let kept = segments.filter { $0.hasPrefix("n") }.count
    XCTAssertGreaterThanOrEqual(reports, 2,
                              "frozen started report + coalesced pending report")
    XCTAssertEqual(reported + kept, 1400,
                   "every evicted line is reported exactly once, none lost")
  }
}

final class CommandChannelTests: PipeCase {
  // Every critical kind sent through the real channel+encoder+writer survives
  // a saturated pipe while noncriticals around them are evicted.
  func testChannelCriticalKindsSurviveEviction() {
    makePipe(); defer { closeEnds() }
    _ = fcntl(fds.w, F_SETFL, fcntl(fds.w, F_GETFL) | O_NONBLOCK)
    fillPipe()
    let devNull = open("/dev/null", O_RDONLY)
    defer { close(devNull) }
    let channel = CommandChannel(inputFD: devNull, outputFD: fds.w,
                                 queue: DispatchQueue(label: "test.ch"), nowMs: { 0 })
    defer { channel.stopInput() } // a suspended read source must be cancelled
    for _ in 0..<2000 {
      channel.send(WindowEvent(type: "window.title", at: 0, pid: 1,
                               bundleId: "b", title: "x"))
    }
    channel.send(AppEvent(type: "app.terminated", at: 0, name: "A", bundleId: "b", pid: 1))
    channel.send(AxUnsupportedEvent(at: 0, bundleId: "b", pid: 1,
                                    notification: "AXFocusedWindowChanged", error: -25211))
    channel.send(SnapshotEvent(at: 0, frontApp: nil, focusedWindow: nil,
                               thermal: "nominal",
                               permissions: .init(accessibility: "denied")))
    channel.send(TitlesAckEvent(at: 0, session: "sess-1", id: .string("k"), enabled: false, gen: 3))
    var text = ""
    drainUntil({ text += String(decoding: $0, as: UTF8.self) },
               { text.contains("\"type\":\"titles.ack\"") })
    channel.closeOutput()
    for type in ["app.terminated", "ax.unsupported", "snapshot", "titles.ack"] {
      XCTAssertTrue(text.contains("\"type\":\"\(type)\""), "\(type) is critical and survives")
    }
    XCTAssertTrue(text.contains("output_overflow"), "evicted noncriticals are reported")
    XCTAssertLessThan(text.components(separatedBy: "\"type\":\"window.title\"").count - 1,
                      2000, "noncriticals are evicted under pressure")
  }
  // A saturated privacy generation is fatal: the encoder goes off, title
  // records are purged, one fixed error is emitted, input stops and onFatal
  // fires - an ack carrying the max/wrapped generation is never emitted.
  func testPrivacyGenerationExhaustedGoesFatal() {
    var inf = [Int32](repeating: 0, count: 2)
    XCTAssertEqual(pipe(&inf), 0)
    defer { close(inf[0]); close(inf[1]) }
    makePipe(); defer { closeEnds() }
    var fatal = 0
    let channel = CommandChannel(inputFD: inf[0], outputFD: fds.w,
                                 queue: DispatchQueue(label: "test.ch3"), nowMs: { 0 })
    channel.onTitles = { _ in Int.max }
    channel.onFatal = { [self] in lock.lock(); fatal += 1; lock.unlock() }
    channel.start()
    defer { channel.stopInput() }
    let cmd = #"{"cmd":"titles","enabled":true,"id":"x"}"# + "\n"
    let bytes = Array(cmd.utf8)
    XCTAssertEqual(Darwin.write(inf[1], bytes, bytes.count), bytes.count)
    XCTAssertTrue(waitFor { fatal == 1 }, "exhaustion must invoke onFatal")
    var text = ""
    drainUntil({ text += String(decoding: $0, as: UTF8.self) },
               { text.contains("privacy-generation-exhausted") })
    XCTAssertFalse(text.contains("titles.ack"), "no ack may carry the max/wrapped gen")
    XCTAssertTrue(text.contains("\"code\":\"privacy-generation-exhausted\""))
    channel.closeOutput()
  }
  // Titles default off: events sent before any enable are stripped even
  // when the session has not yet been touched.
  func testChannelTitlesDefaultOff() {
    makePipe(); defer { closeEnds() }
    let devNull = open("/dev/null", O_RDONLY); defer { close(devNull) }
    let channel = CommandChannel(inputFD: devNull, outputFD: fds.w,
                                 queue: DispatchQueue(label: "test.ch4"), nowMs: { 0 })
    defer { channel.stopInput() }
    channel.send(WindowEvent(type: "window.focused", at: 0, pid: 1,
                             bundleId: "b", title: "SECRET"))
    var text = ""
    drainUntil({ text += String(decoding: $0, as: UTF8.self) }, { !text.isEmpty })
    XCTAssertFalse(text.contains("SECRET"), "default-off: title stripped before encode")
    channel.closeOutput()
  }
}

final class InputReaderTests: PipeCase {
  private var reader: InputReader!
  private var lines: [String] = [], dones: [() -> Void] = [], errors: [String] = []
  private var controls: [Command] = []
  private var overflows: [(Int, [String: Int])] = []
  private var eofHit = false, eofDetected = false, autoRelease = false
  override func setUp() {
    makePipe()
    lines = []; dones = []; errors = []; controls = []; overflows = []
    eofHit = false; eofDetected = false; autoRelease = false
    reader = InputReader(fd: fds.r, queue: DispatchQueue(label: "test.in"))
    reader.onLine = { [self] d, done in
      lock.lock()
      lines.append(String(decoding: d, as: UTF8.self))
      let auto = autoRelease
      if !auto { dones.append(done) }
      lock.unlock()
      if auto { done() }
    }
    reader.onControlLine = { [self] c in lock.lock(); controls.append(c); lock.unlock() }
    reader.onError = { [self] c in lock.lock(); errors.append(c); lock.unlock() }
    reader.onOverflow = { [self] n, t in lock.lock(); overflows.append((n, t)); lock.unlock() }
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
  private func snapshotCmd(_ n: Int = 0) -> String {
    "{\"cmd\":\"snapshot\",\"n\":\"" + String(repeating: "s", count: n) + "\"}\n"
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
  // Overflow drops ordinary commands, counts drops per bounded type key.
  func testOverflowDropsOrdinaryAndReportsTypeCounts() {
    writeAll("held\n")
    XCTAssertTrue(waitFor { lines.count == 1 }) // in-flight, held
    let flood = String(repeating: snapshotCmd(200), count: 3000) // ~600KiB of snapshots
    writeAll(flood)
    XCTAssertTrue(waitFor { !overflows.isEmpty }, "input_overflow reports promptly")
    Thread.sleep(forTimeInterval: 0.3) // let the flood finish draining
    lock.lock()
    let total = overflows.reduce(0) { $0 + $1.0 }
    let snaps = overflows.reduce(0) { $0 + ($1.1["snapshot"] ?? 0) }
    lock.unlock()
    XCTAssertGreaterThan(snaps, 0, "snapshot drops are counted by type")
    XCTAssertEqual(total, snaps, "all drops were snapshots")
    lock.lock(); autoRelease = true; lock.unlock()
    releaseAll()
    writeAll("tail-marker\n")
    XCTAssertTrue(waitFor { lines.contains("tail-marker") }, "reader recovers after the flood")
    lock.lock()
    let peak = reader.peakPending
    let delivered = lines.count
    lock.unlock()
    XCTAssertLessThanOrEqual(peak, InputReader.maxPending, "pending incl. in-flight never exceeds 256KiB")
    XCTAssertLessThan(delivered, 3000, "flooded lines are discarded, not queued")
  }
  // Every pending entry costs >=64B, so a flood of zero-byte blank lines
  // (malformed commands) cannot queue unbounded records behind a blocked one.
  func testBlankLineFloodStaysBoundedAndCountsMalformed() {
    writeAll("held\n")
    XCTAssertTrue(waitFor { lines.count == 1 }) // in-flight, held
    writeAll(String(repeating: "\n", count: 30000)) // 30KiB raw, 30000 records
    XCTAssertTrue(waitFor { !overflows.isEmpty })
    Thread.sleep(forTimeInterval: 0.3)
    lock.lock()
    let malformed = overflows.reduce(0) { $0 + ($1.1["malformed"] ?? 0) }
    let peak = reader.peakPending
    lock.unlock()
    XCTAssertGreaterThan(malformed, 0, "blank-line drops counted as malformed")
    XCTAssertLessThanOrEqual(peak, InputReader.maxPending,
                             "per-entry charge keeps pending <= 256KiB")
    XCTAssertGreaterThan(peak, 200 * 1024, "the cap was actually exercised")
  }
  // A >64KiB line keeps line-too-long; the rest is discarded.
  func testOrdinaryOversizedLineStillLineTooLong() {
    writeAll(String(repeating: "y", count: 70 * 1024))
    XCTAssertTrue(waitFor { errors.contains("line-too-long") })
    writeAll("\nok-line\n")
    XCTAssertTrue(waitFor { lines.contains("ok-line") })
    lock.lock(); XCTAssertTrue(overflows.isEmpty); lock.unlock()
  }
  // Valid titles/quit commands bypass an in-flight ordinary command and the
  // pending backlog entirely.
  func testControlsJumpInFlightAndBacklog() {
    writeAll("held\n")
    XCTAssertTrue(waitFor { lines.count == 1 }) // ordinary in-flight, held
    writeAll(#"{"cmd":"titles","enabled":false,"id":9}"# + "\n")
    writeAll(#"{"cmd":"quit"}"# + "\n")
    XCTAssertTrue(waitFor { controls.count == 2 },
                  "controls deliver while an ordinary command is in flight")
    lock.lock()
    XCTAssertEqual(controls[0], .titles(false, id: .int(9)))
    XCTAssertEqual(controls[1], .quit)
    lock.unlock()
    XCTAssertEqual(dones.count, 1, "the ordinary command is still serialized")
  }
  // Every control is delivered synchronously in arrival order - no
  // newest-wins supersession: all three titles commands must be seen.
  func testEveryControlDeliversInArrivalOrder() {
    writeAll(#"{"cmd":"titles","enabled":false}"# + "\n" +
             #"{"cmd":"titles","enabled":true,"id":"x"}"# + "\n" +
             #"{"cmd":"titles","enabled":false,"id":"y"}"# + "\n")
    XCTAssertTrue(waitFor { controls.count == 3 })
    lock.lock()
    XCTAssertEqual(controls, [.titles(false), .titles(true, id: .string("x")),
                              .titles(false, id: .string("y"))])
    lock.unlock()
  }
  // A parsed quit terminates input immediately: nothing after it - in the
  // same chunk or later - is parsed, delivered or queued.
  func testQuitStopsParsingWithinAndAfterChunk() {
    writeAll(#"{"cmd":"quit"}"# + "\n" +
             #"{"cmd":"titles","enabled":true,"id":"after"}"# + "\n" +
             #"{"cmd":"quit"}"# + "\n")
    XCTAssertTrue(waitFor { !controls.isEmpty })
    Thread.sleep(forTimeInterval: 0.1)
    lock.lock()
    XCTAssertEqual(controls, [.quit], "no control after quit may be parsed")
    lock.unlock()
    writeAll("more\n")
    Thread.sleep(forTimeInterval: 0.1)
    lock.lock()
    XCTAssertTrue(lines.isEmpty, "input stays dead after quit")
    XCTAssertEqual(controls, [.quit])
    lock.unlock()
  }
  // A control callback that blocks stops all further stdin consumption
  // (bounded to the <=16KiB already-read chunk by natural backpressure);
  // later controls wait - none is overwritten or coalesced.
  func testBlockedControlCallbackStopsStdinConsumption() {
    let blocked = DispatchSemaphore(value: 0), entered = DispatchSemaphore(value: 0)
    reader.onControlLine = { [weak self] c in
      guard let self else { return }
      self.lock.lock()
      self.controls.append(c)
      let first = self.controls.count == 1
      self.lock.unlock()
      if first { entered.signal(); blocked.wait() }
    }
    writeAll(#"{"cmd":"titles","enabled":true,"id":"first"}"# + "\n" +
             #"{"cmd":"titles","enabled":false,"id":"second"}"# + "\n")
    XCTAssertEqual(entered.wait(timeout: .now() + 5), .success)
    Thread.sleep(forTimeInterval: 0.1)
    lock.lock()
    XCTAssertEqual(controls.count, 1, "no next control is delivered while blocked")
    lock.unlock()
    blocked.signal()
    XCTAssertTrue(waitFor { controls.count == 2 })
    lock.lock()
    XCTAssertEqual(controls, [.titles(true, id: .string("first")),
                              .titles(false, id: .string("second"))])
    lock.unlock()
  }
  // Controls are never charged to (or dropped by) the ordinary pending cap.
  func testControlsSurviveInputOverflow() {
    writeAll("held\n")
    XCTAssertTrue(waitFor { lines.count == 1 })
    writeAll(String(repeating: snapshotCmd(400), count: 1000)) // way over 256KiB
    writeAll(#"{"cmd":"titles","enabled":false,"id":"flood"}"# + "\n")
    XCTAssertTrue(waitFor {
      controls.contains { $0 == .titles(false, id: .string("flood")) }
    }, "a control line lands even when the ordinary cap is exhausted")
    XCTAssertTrue(waitFor { !overflows.isEmpty })
  }
}
