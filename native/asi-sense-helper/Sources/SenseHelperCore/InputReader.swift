import Foundation
// Bounded stdin reader (semantics: PROTOCOL.md): <=16KiB chunks; physical
// lines are framed in a separate <=64KiB scratch INDEPENDENTLY of serialized
// consumption. Each completed line is classified by CommandParser: valid
// `titles`/`quit` commands are controls kept in dedicated newest-of-class
// slots (never charged to the pending cap, flushed after every read chunk,
// delivered ahead of any queued ordinary line even while one is in flight).
// Ordinary lines queue in a bounded pending list (queued + in-flight
// <=256KiB, each entry charged max(64, bytes+1) to cover framing overhead so
// a flood of empty lines cannot queue unbounded records); beyond the cap they
// are dropped and counted per command type, reported coalesced per readiness
// batch. Oversize physical lines keep line-too-long and are rejected through
// their next LF.
public final class InputReader {
  public static let chunkBytes = 16 * 1024, maxPending = 256 * 1024
  private let fd: Int32
  private let queue: DispatchQueue
  private let source: DispatchSourceRead
  private var scratch = Data(), rejectingLine = false
  private var pending: [Data] = [], pendingHead = 0, queuedBytes = 0, inFlight = 0
  private var consuming = false, pumping = false, eof = false, eofNotified = false
  private var seq = 0
  private var titlesSlot: (seq: Int, cmd: Command)?, quitSlot: (seq: Int, cmd: Command)?
  private var batchDropped = 0, batchTypes: [String: Int] = [:]
  private let lifecycle = Locked((started: false, stopped: false))
  public private(set) var peakPending = 0 // test seam: bounded-pending evidence
  public var onLine: ((Data, @escaping () -> Void) -> Void)?     // ordinary, serialized
  public var onControlLine: ((Command) -> Void)?                 // controls, immediate
  public var onError: ((String) -> Void)?                        // "line-too-long"
  public var onOverflow: ((Int, [String: Int]) -> Void)?         // dropped, per-type counts
  public var onEOFDetected: (() -> Void)? // fires at hitEOF, before draining
  public var onEOF: (() -> Void)?         // fires once all input is consumed

  public init(fd: Int32 = STDIN_FILENO, queue: DispatchQueue = .main) {
    self.fd = fd
    self.queue = queue
    _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
    source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
    source.setEventHandler { [weak self] in self?.readable() }
  }
  public func start() {
    lifecycle.mutate { $0.started = true }
    source.resume()
  }
  public func stop() {
    let wasStarted = lifecycle.mutate { s -> Bool in
      defer { s.stopped = true }
      return s.started
    }
    if !wasStarted { source.resume() } // activate a never-started source so cancel is safe
    source.cancel()
  }
  // Per-entry pending cost: the line plus its LF, with a 64B minimum so
  // zero-byte records (e.g. blank lines) still spend real budget.
  private static func charge(_ line: Data) -> Int { max(64, line.count + 1) }
  private var pendingBytes: Int {
    let n = queuedBytes + inFlight
    if n > peakPending { peakPending = n }
    return n
  }
  private func readable() {
    batchDropped = 0; batchTypes = [:]
    defer { flushOverflow() }
    var avail = max(1, Int(source.data)) // probe even at 0: a 0-length read means EOF
    while avail > 0, !eof, !lifecycle.get().stopped {
      let want = min(avail, Self.chunkBytes)
      var chunk = [UInt8](repeating: 0, count: want)
      let n = read(fd, &chunk, want)
      if n < 0 {
        if errno == EINTR { continue }
        if errno != EAGAIN && errno != EWOULDBLOCK { hitEOF() }
        return
      }
      if n == 0 { hitEOF(); return }
      avail -= n
      feed(chunk[0..<n])
      flushControls()
      pump()
    }
  }
  // Frame complete physical lines out of the chunk; classify each one.
  private func feed(_ bytes: ArraySlice<UInt8>) {
    var seg = bytes
    while let nl = seg.firstIndex(of: 0x0A) {
      defer { seg = seg[seg.index(after: nl)...] }
      if rejectingLine { rejectingLine = false; continue } // tail of a rejected line
      var line = scratch
      line.append(contentsOf: seg[seg.startIndex..<nl])
      scratch.removeAll()
      complete(line)
    }
    guard !rejectingLine else { return } // drop the oversize partial too
    scratch.append(contentsOf: seg)
    if scratch.count > CommandParser.maxLineBytes {
      scratch.removeAll()
      rejectingLine = true
      onError?("line-too-long")
    }
  }
  private func complete(_ raw: Data) {
    var line = raw
    if line.last == 0x0D { line.removeLast() }
    if line.count > CommandParser.maxLineBytes { onError?("line-too-long"); return }
    seq += 1
    let result = CommandParser.parse(line)
    switch result {
    case .ok(let cmd) where cmd.isControl:
      switch cmd {
      case .titles: titlesSlot = (seq, cmd)
      case .quit: quitSlot = (seq, cmd)
      default: break
      }
    case .ok, .error:
      if pendingBytes + Self.charge(line) > Self.maxPending {
        batchDropped += 1
        batchTypes[dropKey(result), default: 0] += 1
      } else {
        pending.append(line)
        queuedBytes += Self.charge(line)
        _ = pendingBytes // refreshes peakPending
      }
    }
  }
  // Fixed, bounded drop-type keys; arbitrary commands never echo.
  private func dropKey(_ result: CommandResult) -> String {
    switch result {
    case .ok(.snapshot): return "snapshot"
    case .ok(.recheckPermissions): return "recheck-permissions"
    case .ok: return "unknown"
    case .error(let code, _): return code == "unknown-command" ? "unknown" : "malformed"
    }
  }
  // Controls jump the ordinary backlog; newest of each class wins and the two
  // classes keep arrival order between them.
  private func flushControls() {
    while titlesSlot != nil || quitSlot != nil {
      if let q = quitSlot, titlesSlot == nil || q.seq < titlesSlot!.seq {
        quitSlot = nil
        onControlLine?(q.cmd)
      } else if let t = titlesSlot {
        titlesSlot = nil
        onControlLine?(t.cmd)
      }
    }
  }
  private func flushOverflow() {
    guard batchDropped > 0 else { return }
    let n = batchDropped, types = batchTypes
    batchDropped = 0; batchTypes = [:]
    onOverflow?(n, types)
  }
  // Ordinary consumption stays serialized (<=1 in-flight).
  private func pump() {
    guard !pumping else { return }
    pumping = true
    defer { pumping = false }
    guard !consuming else { return }
    if pendingHead < pending.count {
      let line = pending[pendingHead]
      pendingHead += 1
      queuedBytes -= Self.charge(line)
      if pendingHead >= pending.count { pending.removeAll(); pendingHead = 0 }
      else if pendingHead >= 64 && pendingHead * 2 >= pending.count {
        pending.removeFirst(pendingHead); pendingHead = 0
      }
      deliver(line)
      return
    }
    if eof, !eofNotified { eofNotified = true; onEOF?() }
  }
  private func deliver(_ line: Data) {
    consuming = true
    inFlight = Self.charge(line)
    _ = pendingBytes
    // Re-serialize the consumer completion on this queue.
    onLine?(line) { [weak self, queue] in
      queue.async { [weak self] in
        guard let self else { return }
        self.inFlight = 0
        self.consuming = false
        self.pump()
      }
    }
  }
  private func hitEOF() {
    guard !eof else { return }
    eof = true
    source.cancel()
    onEOFDetected?() // runtime arms its exit deadline here, before the drain
    // The trailing partial line is the final command (unless it continues a
    // rejected oversized line).
    if rejectingLine {
      rejectingLine = false
      scratch.removeAll()
    } else if !scratch.isEmpty {
      let line = scratch
      scratch.removeAll()
      if line.count > CommandParser.maxLineBytes { onError?("line-too-long") }
      else { complete(line) }
    }
    flushControls()
    flushOverflow()
    pump()
  }
}
