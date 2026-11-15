import Foundation
// Shared stdin/privacy/stdout wiring for the real helper and the synthetic
// pipe fixture: owns the bounded InputReader, the LineEncoder and the
// OutputWriter. Controls (`titles`, `quit`) are delivered by the reader ahead
// of ordinary commands even while one is in flight; `titles` applies the
// privacy switch synchronously through `onTitles` (which returns the session
// privacy generation), purges queued title lines and emits a critical
// `titles.ack` - for EVERY titles command, including redundant ones.
public final class CommandChannel {
  public var onCommand: ((Command, @escaping () -> Void) -> Void)? // ordinary work
  public var onTitles: ((Bool) -> Int)?    // synchronous mutation -> privacy gen
  public var onQuit: (() -> Void)?
  public var onEOF: (() -> Void)?
  public var onEOFDetected: (() -> Void)?
  public var onFatal: (() -> Void)?        // unrecoverable output failure -> exit 1

  private let nowMs: () -> Int64
  private var encoder: LineEncoder
  private var titlesEnabled: Bool
  public let reader: InputReader
  public let writer: OutputWriter

  public init(inputFD: Int32 = STDIN_FILENO, outputFD: Int32 = STDOUT_FILENO,
              queue: DispatchQueue = .main,
              nowMs: @escaping () -> Int64 = { Int64(Date().timeIntervalSince1970 * 1000) },
              titlesEnabled: Bool = true) {
    self.nowMs = nowMs
    self.titlesEnabled = titlesEnabled
    encoder = LineEncoder(titlesEnabled: titlesEnabled)
    reader = InputReader(fd: inputFD, queue: queue)
    writer = OutputWriter(fd: outputFD)
    writer.makeOverflowLine = { [encoder, nowMs] dropped, types in
      (try? encoder.encodeLine(ErrorEvent(
        at: nowMs(), code: "output_overflow",
        message: "stdout backpressure dropped queued events",
        dropped: dropped, droppedTypes: types)).line) ?? Data()
    }
    writer.onFatal = { [weak self] in self?.onFatal?() }
    reader.onLine = { [weak self] line, done in self?.ordinary(line, done: done) }
    reader.onControlLine = { [weak self] cmd in self?.control(cmd) }
    reader.onError = { [weak self] _ in
      self?.emitError("line-too-long", "command line exceeds 64KiB")
    }
    reader.onOverflow = { [weak self] n, types in
      self?.emitOverflow("input_overflow", "stdin backlog exceeds 256KiB",
                         dropped: n, types: types)
    }
    reader.onEOFDetected = { [weak self] in self?.onEOFDetected?() }
    reader.onEOF = { [weak self] in self?.onEOF?() }
  }

  public func start() { reader.start() }
  public func stopInput() { reader.stop() }
  public func flushOutput(deadline: TimeInterval = 0.2) { writer.flush(deadline: deadline) }
  public func closeOutput() { writer.close() }

  // Every event goes through the encoder (privacy stripping/bounding) and the
  // bounded writer; criticality is derived centrally from the event type.
  public func send<E: Encodable>(_ event: E) {
    guard let line = try? encoder.encodeLine(event) else { return }
    writer.enqueue(line.line, critical: EventKinds.critical.contains(line.type),
                   hasTitle: line.hasTitle, type: line.type)
  }
  public func emitError(_ code: String, _ message: String) {
    send(ErrorEvent(at: nowMs(), code: code, message: message))
  }
  private func emitOverflow(_ code: String, _ message: String,
                            dropped: Int, types: [String: Int]) {
    send(ErrorEvent(at: nowMs(), code: code, message: message,
                    dropped: dropped, droppedTypes: types))
  }
  private func ordinary(_ line: Data, done: @escaping () -> Void) {
    switch CommandParser.parse(line) {
    case .ok(let cmd):
      if cmd.isControl { control(cmd); done(); return } // defensive: controls never queue
      guard let onCommand else { done(); return }
      onCommand(cmd, done)
    case .error(let code, let message):
      emitError(code, message)
      done()
    }
  }
  private func control(_ cmd: Command) {
    switch cmd {
    case .titles(let on, let id):
      let gen = onTitles?(on) ?? -1 // session generation, bumped synchronously
      titlesEnabled = on
      encoder.titlesEnabled = on
      if !on { writer.purgeUnstartedTitles(stripCritical: LineEncoder.stripTitles(fromLine:)) }
      send(TitlesAckEvent(at: nowMs(), id: id, enabled: on, gen: gen))
    case .quit:
      // Invalidates the privacy generation so in-flight title work dies, and
      // purges queued titles before the bounded shutdown drain.
      _ = onTitles?(false)
      titlesEnabled = false
      encoder.titlesEnabled = false
      writer.purgeUnstartedTitles(stripCritical: LineEncoder.stripTitles(fromLine:))
      onQuit?()
    default: break
    }
  }
}
