import Foundation
// Bounded nonblocking NDJSON writer (semantics: PROTOCOL.md): <=1024 lines,
// <=1MiB, O_NONBLOCK + DispatchSourceWrite, partial writes resume at their
// offset, oldest-unstarted-noncritical eviction with recovery reporting.
// Criticals are never dropped: nothing removable -> onFatal (exit 1).
public final class OutputWriter {
  public static let maxLines = 1024, maxBytes = 1 << 20
  private struct Entry {
    var data: Data, offset = 0, critical = false, hasTitle = false
  }
  private var entries: [Entry] = [], head = 0, queuedBytes = 0, dropped = 0
  private var failed = false, closed = false, suspended = true
  private let lock = NSLock(), fd: Int32
  private let source: DispatchSourceWrite
  public var onDropsRecovered: ((Int) -> Void)?
  public var onFatal: (() -> Void)?
  // Test seam: bytes of the head entry already on the wire (partial writes).
  var headOffsetForTesting: Int {
    lock.lock(); defer { lock.unlock() }
    return head < entries.count ? entries[head].offset : -1
  }

  public init(fd: Int32, queue: DispatchQueue = .init(label: "asi-sense-helper.out")) {
    self.fd = fd
    _ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
    source = DispatchSource.makeWriteSource(fileDescriptor: fd, queue: queue)
    source.setEventHandler { [weak self] in self?.drainFromSource() }
    // Sources start suspended and park while empty; `suspended` mirrors the
    // dispatch object's real state for balanced resume/suspend and cancel.
  }
  public func enqueue(_ data: Data, critical: Bool, hasTitle: Bool = false) {
    var recovered = 0, fatal = false
    lock.lock()
    if !closed && !failed {
      // Make room before appending so the backlog never exceeds its bounds.
      var accepted = true
      while entries.count - head >= Self.maxLines || queuedBytes + data.count > Self.maxBytes {
        guard let i = (head..<entries.count).first(where: { entries[$0].offset == 0 && !entries[$0].critical }) else {
          if critical { failed = true } else { dropped += 1 }
          accepted = false
          break
        }
        queuedBytes -= entries[i].data.count
        entries.remove(at: i)
        dropped += 1
      }
      if accepted {
        entries.append(Entry(data: data, critical: critical, hasTitle: hasTitle))
        queuedBytes += data.count
      }
      drainLocked()
      recovered = collectRecoveredLocked()
      fatal = failed
      updateSourceLocked()
    }
    lock.unlock()
    if recovered > 0 { onDropsRecovered?(recovered) }
    if fatal { onFatal?() }
  }
  // Privacy: drop unstarted noncritical title lines when titles are off; an
  // already-started line leaks at most its unwritten remainder; criticals are
  // never touched.
  public func purgeUnstartedTitles() {
    lock.lock()
    var i = entries.count - 1
    while i >= head {
      if entries[i].offset == 0 && entries[i].hasTitle && !entries[i].critical {
        queuedBytes -= entries[i].data.count
        entries.remove(at: i)
      }
      i -= 1
    }
    updateSourceLocked()
    lock.unlock()
  }
  // Best-effort bounded drain for normal shutdown; never waits past `deadline`.
  public func flush(deadline: TimeInterval = 0.2) {
    let end = ProcessInfo.processInfo.systemUptime + deadline
    while true {
      lock.lock(); drainLocked(); updateSourceLocked()
      let done = head >= entries.count || failed
      lock.unlock()
      if done { return }
      let remain = end - ProcessInfo.processInfo.systemUptime
      if remain <= 0 { return }
      var p = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
      poll(&p, 1, Int32(remain * 1000))
    }
  }
  public func close() {
    var needResume = false
    lock.lock()
    closed = true
    if suspended { suspended = false; needResume = true }
    lock.unlock()
    source.setEventHandler {}
    if needResume { source.resume() } // a suspended source must resume before cancel
    source.cancel()
  }
  private func drainFromSource() {
    var recovered = 0, fatal = false
    lock.lock()
    drainLocked()
    recovered = collectRecoveredLocked()
    fatal = failed
    updateSourceLocked()
    lock.unlock()
    if recovered > 0 { onDropsRecovered?(recovered) }
    if fatal { onFatal?() }
  }
  private func collectRecoveredLocked() -> Int {
    guard head >= entries.count, dropped > 0 else { return 0 }
    defer { dropped = 0 }
    return dropped
  }
  private func drainLocked() {
    while head < entries.count, !closed {
      let n = entries[head].data.withUnsafeBytes { buf -> Int in
        guard let base = buf.baseAddress else { return -1 }
        return write(fd, base.advanced(by: entries[head].offset), buf.count - entries[head].offset)
      }
      if n <= 0 {
        if n < 0, errno == EINTR { continue }
        if n < 0 && errno != EAGAIN && errno != EWOULDBLOCK { failed = true }
        break // EAGAIN: wait for the write source; real error: fail fast
      }
      queuedBytes -= n
      entries[head].offset += n
      if entries[head].offset < entries[head].data.count { break } // partial write: keep line order
      head += 1
    }
    // Compact consumed prefixes so storage stays bounded by live backlog.
    if head >= entries.count { entries.removeAll(); head = 0 }
    else if head >= 64 && head * 2 >= entries.count { entries.removeFirst(head); head = 0 }
  }
  private func updateSourceLocked() {
    let needs = head < entries.count && !closed && !failed
    if needs && suspended { suspended = false; source.resume() }
    if !needs && !suspended { suspended = true; source.suspend() }
  }
}
