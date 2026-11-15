import Foundation
// Bounded stdin reader (semantics: PROTOCOL.md): <=16KiB chunks, <=256KiB
// retained (buffer + in-flight), strict one-at-a-time consumption, overflow
// discard once per episode, normal EOF drain after early onEOFDetected.
public final class InputReader {
  public static let chunkBytes = 16 * 1024, maxPending = 256 * 1024
  private let fd: Int32
  private let queue: DispatchQueue
  private let source: DispatchSourceRead
  private var buffer = Data(), discarding = false
  private let lifecycle = Locked((started: false, stopped: false))
  private var consuming = false, inFlight = 0, pumping = false
  private var eof = false, overflowNoted = false
  public private(set) var peakPending = 0 // test seam: bounded-pending evidence
  public var onLine: ((Data, @escaping () -> Void) -> Void)?
  public var onError: ((String) -> Void)? // "input_overflow" | "line-too-long"
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
  private var pendingBytes: Int {
    let n = buffer.count + inFlight
    if n > peakPending { peakPending = n }
    return n
  }
  private func readable() {
    var avail = max(1, Int(source.data)) // probe even at 0: a 0-length read means EOF
    while avail > 0, !eof, !lifecycle.get().stopped {
      let room = Self.maxPending - pendingBytes
      if room <= 0, !discarding {
        if !overflowNoted { overflowNoted = true; onError?("input_overflow") }
        // Drop the buffered trailing partial, keep complete lines.
        if let nl = buffer.lastIndex(of: 0x0A) { buffer.removeSubrange(buffer.index(after: nl)...) }
        else { buffer.removeAll() }
        discarding = true
      }
      let want = min(avail, Self.chunkBytes, discarding ? Self.chunkBytes : max(1, room))
      var chunk = [UInt8](repeating: 0, count: want)
      let n = read(fd, &chunk, want)
      if n < 0 {
        if errno == EINTR { continue }
        if errno != EAGAIN && errno != EWOULDBLOCK { hitEOF() }
        return
      }
      if n == 0 { hitEOF(); return }
      avail -= n
      if discarding {
        var rest = chunk[0..<n]
        while discarding { // drop one physical line at a time
          guard let nl = rest.firstIndex(of: 0x0A) else { break } // still mid-line: drop it all
          rest = rest[rest.index(after: nl)...]
          if rest.count <= Self.maxPending - pendingBytes { // suffix fits: resume retaining
            buffer.append(contentsOf: rest); discarding = false
          }
        }
      } else {
        buffer.append(contentsOf: chunk[0..<n])
      }
      pump()
    }
  }
  // Extraction lives here so consumption stays serialized (<=1 in-flight).
  private func pump() {
    guard !pumping else { return }
    pumping = true
    defer { pumping = false }
    while true {
      if consuming { return }
      if let nl = buffer.firstIndex(of: 0x0A) {
        var line = buffer.subdata(in: buffer.startIndex..<nl)
        buffer.removeSubrange(buffer.startIndex...nl)
        if line.last == 0x0D { line.removeLast() }
        deliver(line)
        continue
      }
      if !eof {
        if buffer.count > CommandParser.maxLineBytes {
          buffer.removeAll()
          onError?("line-too-long")
          discarding = true
          continue
        }
        return
      }
      // EOF: the trailing partial line is the final command.
      if !buffer.isEmpty {
        var line = buffer
        buffer.removeAll()
        if line.count > CommandParser.maxLineBytes { onError?("line-too-long"); continue }
        if line.last == 0x0D { line.removeLast() }
        if !line.isEmpty { deliver(line); continue }
      }
      onEOF?()
      return
    }
  }
  private func deliver(_ line: Data) {
    consuming = true
    inFlight = line.count
    // Re-serialize the consumer completion on this queue.
    onLine?(line) { [weak self, queue] in
      queue.async { [weak self] in
        guard let self else { return }
        self.inFlight = 0
        self.consuming = false
        self.overflowNoted = self.pendingBytes >= Self.maxPending
        self.pump()
      }
    }
  }
  private func hitEOF() {
    guard !eof else { return }
    eof = true
    source.cancel()
    onEOFDetected?() // runtime arms its exit deadline here, before the drain
    pump()
  }
}
