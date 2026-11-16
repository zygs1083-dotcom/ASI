import Foundation
// Controls apply synchronously in arrival order, naturally backpressuring
// stdin while busy; quit stops parsing. Ordinary pending lines remain bounded
// and report drops; physical framing and read chunks have independent caps.
public final class InputReader {
  public static let chunkBytes = 16 * 1024, maxPending = 256 * 1024
  private let fd: Int32
  private let queue: DispatchQueue
  private let source: DispatchSourceRead
  private var scratch = Data(), rejectingLine = false
  private var pending: [Data] = [], pendingHead = 0, queuedBytes = 0, inFlight = 0
  private var consuming = false, pumping = false, eof = false, eofNotified = false
  private var quitParsed = false
  private var stalledCommand: Command?, stalledBytes = Data()
  private var retryTimer: DispatchSourceTimer?
  private let eofTimer: DispatchSourceTimer
  private let eofDetected = Locked(false)
  private var batchDropped = 0, batchTypes: [String: Int] = [:]
  private let lifecycle = Locked((started: false, stopped: false, suspended: false))
  public private(set) var peakPending = 0 // test seam: bounded-pending evidence
  public var onLine: ((Data, @escaping () -> Void) -> Void)?     // ordinary, serialized
  public var onControlLine: ((Command) -> Void)?                 // controls, synchronous
  public var reserveControl: ((Command) -> Bool)?
  public var onError: ((String) -> Void)?                        // "line-too-long"
  public var onOverflow: ((Int, [String: Int]) -> Void)?         // dropped, per-type counts
  public var onEOFDetected: (() -> Void)? // fires at hitEOF, before draining
  public var onEOF: (() -> Void)?         // fires once all input is consumed

  public init(fd: Int32 = STDIN_FILENO, queue: DispatchQueue = .main) {
    self.fd = fd
    self.queue = queue
    _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
    source = DispatchSource.makeReadSource(fileDescriptor: fd, queue: queue)
    eofTimer = DispatchSource.makeTimerSource(queue: .global())
    source.setEventHandler { [weak self] in self?.readable() }
    eofTimer.schedule(deadline: .now(), repeating: .milliseconds(10))
    eofTimer.setEventHandler { [weak self] in
      guard let self else { return }
      var p = pollfd(fd: self.fd, events: Int16(POLLHUP | POLLERR), revents: 0)
      if poll(&p, 1, 0) > 0, p.revents & Int16(POLLHUP | POLLERR) != 0 {
        self.notifyEOFDetected()
      }
    }
  }
  public func start() {
    lifecycle.mutate { s in
      guard !s.stopped, !s.started else { return }
      s.started = true
      source.resume()
      eofTimer.resume()
    }
  }
  public func stop() {
    lifecycle.mutate { s in
      guard !s.stopped else { return }
      if !s.started || s.suspended { source.resume() } // activate a never-started source so cancel is safe
      if !s.started { eofTimer.resume() }
      s.stopped = true
      source.cancel()
      eofTimer.cancel()
    }
    queue.async { [weak self] in
      self?.retryTimer?.cancel()
      self?.retryTimer = nil
    }
  }
  // Per-entry pending cost: the line plus its LF, with a 64B minimum so
  // zero-byte records (e.g. blank lines) still spend real budget.
  private static func charge(_ line: Data) -> Int { max(64, line.count + 1) }
  private var pendingBytes: Int {
    let n = queuedBytes + inFlight
    if n > peakPending { peakPending = n }
    return n
  }
  private var inputEnded: Bool { quitParsed || lifecycle.get().stopped }
  private func readable() {
    batchDropped = 0; batchTypes = [:]
    defer { flushOverflow() }
    var avail = max(1, Int(source.data)) // probe even at 0: a 0-length read means EOF
    while avail > 0, !eof, !inputEnded {
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
      pump()
      if stalledCommand != nil { return }
    }
  }
  // Quit or external stop ends framing mid-chunk.
  private func feed(_ bytes: ArraySlice<UInt8>) {
    var seg = bytes
    while !inputEnded, let nl = seg.firstIndex(of: 0x0A) {
      let rest = seg[seg.index(after: nl)...]
      if rejectingLine { rejectingLine = false; seg = rest; continue } // tail of a rejected line
      var line = scratch
      line.append(contentsOf: seg[seg.startIndex..<nl])
      scratch.removeAll()
      if !autoreleasepool(invoking: { complete(line) }) {
        stalledBytes = Data(rest)
        pauseInput()
        return
      }
      seg = rest
    }
    guard !inputEnded else {
      scratch.removeAll(); rejectingLine = false; return
    }
    guard !rejectingLine else { return } // drop the oversize partial too
    scratch.append(contentsOf: seg)
    if scratch.count > CommandParser.maxLineBytes {
      scratch.removeAll()
      rejectingLine = true
      onError?("line-too-long")
    }
  }
  @discardableResult
  private func complete(_ raw: Data) -> Bool {
    var line = raw
    if line.last == 0x0D { line.removeLast() }
    if line.count > CommandParser.maxLineBytes { onError?("line-too-long"); return true }
    let result = CommandParser.parse(line)
    switch result {
    case .ok(let cmd) where cmd.isControl:
      if let reserveControl, !reserveControl(cmd) {
        stalledCommand = cmd
        return false
      }
      onControlLine?(cmd)
      if cmd == .quit { endInput() }
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
    return true
  }
  private func pauseInput() {
    lifecycle.mutate { s in
      guard !s.stopped, !s.suspended else { return }
      s.suspended = true
      source.suspend()
    }
    guard retryTimer == nil else { return }
    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now(), repeating: .milliseconds(10))
    timer.setEventHandler { [weak self] in self?.retryStalled() }
    retryTimer = timer
    timer.resume()
  }
  private func retryStalled() {
    guard let cmd = stalledCommand, !inputEnded else { return }
    var p = pollfd(fd: fd, events: Int16(POLLHUP | POLLERR), revents: 0)
    if poll(&p, 1, 0) > 0, p.revents & Int16(POLLHUP | POLLERR) != 0 {
      stalledCommand = nil; stalledBytes.removeAll()
      notifyEOFDetected()
      stop()
      onEOF?()
      return
    }
    guard reserveControl?(cmd) ?? true else { return }
    stalledCommand = nil
    onControlLine?(cmd)
    if cmd == .quit { endInput() }
    let bytes = stalledBytes
    stalledBytes.removeAll()
    if !inputEnded { feed(Array(bytes)[...]); flushOverflow(); pump() }
    guard stalledCommand == nil else { return }
    retryTimer?.cancel(); retryTimer = nil
    lifecycle.mutate { s in
      guard !s.stopped, s.suspended else { return }
      s.suspended = false
      source.resume()
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
  // quit is terminal: unread/queued input is discarded and the source is
  // cancelled so pump, completion and EOF can never restart input.
  private func endInput() {
    guard !quitParsed else { return }
    quitParsed = true
    pending.removeAll(); pendingHead = 0; queuedBytes = 0
    scratch.removeAll(); rejectingLine = false
    stop()
  }
  private func flushOverflow() {
    guard batchDropped > 0 else { return }
    let n = batchDropped, types = batchTypes
    batchDropped = 0; batchTypes = [:]
    onOverflow?(n, types)
  }
  // Ordinary consumption stays serialized (<=1 in-flight); nothing new is
  // delivered once input ended.
  private func pump() {
    guard !pumping else { return }
    pumping = true
    defer { pumping = false }
    guard !consuming, !inputEnded else { return }
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
    notifyEOFDetected() // runtime arms its exit deadline here, before the drain
    // The trailing partial line is the final command (unless it continues a
    // rejected oversized line); a parsed quit ends input right here.
    if !quitParsed {
      if rejectingLine {
        rejectingLine = false
        scratch.removeAll()
      } else if !scratch.isEmpty {
        let line = scratch
        scratch.removeAll()
        if line.count > CommandParser.maxLineBytes { onError?("line-too-long") }
        else { complete(line) }
      }
    }
    flushOverflow()
    pump()
  }
  private func notifyEOFDetected() {
    if eofDetected.mutate({ detected -> Bool in
      guard !detected else { return false }
      detected = true
      return true
    }) { onEOFDetected?() }
  }
}
