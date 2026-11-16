import Foundation
// Bounded nonblocking NDJSON writer (semantics: PROTOCOL.md): <=1024 lines,
// <=1MiB, O_NONBLOCK + DispatchSourceWrite. Title-bearing records are capped
// at PIPE_BUF (512 on Darwin) and write ATOMICALLY: the whole line crosses in
// one write() or the entry waits at offset 0; a short positive write is
// impossible per POSIX and marks the writer failed rather than ever resuming
// a title line. purgeUnstartedTitles therefore only ever removes whole
// unstarted entries (critical titled ones are re-encoded stripped), and no
// truncated title line can ever sit at the wire head.
// Oldest unstarted noncritical eviction is reported by ONE coalesced critical
// `output_overflow` record emitted as the next whole line; criticals are
// never dropped: a critical producer waits for capacity.
public final class OutputWriter {
  public static let maxLines = 1024, maxBytes = 1 << 20
  public static let atomicLineBytes = LineEncoder.maxTitleLineBytes // PIPE_BUF
  private struct Entry {
    var data: Data, offset = 0
    var critical = false, hasTitle = false, overflow = false
    var type = "unknown"
    var completion: ((Bool) -> Void)?
  }
  private var entries: [Entry] = [], head = 0, queuedBytes = 0
  private var reservedBytes = 0, reservedLines = 0
  private var callbacks: [() -> Void] = []
  private var dropTotal = 0, dropTypes: [String: Int] = [:]
  private var failed = false, closed = false, suspended = true
  private let lock = NSLock(), fd: Int32
  private let source: DispatchSourceWrite
  public var onFatal: (() -> Void)?
  public var onCapacityWait: (() -> Bool)?
  // Encodes the output_overflow record (dropped total + per-type counts).
  // Called from the enqueueing thread while the writer lock is held.
  public var makeOverflowLine: ((_ dropped: Int, _ types: [String: Int]) -> Data)?
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
  public func reserveAck(bytes: Int) -> Bool {
    lock.lock()
    var reserved = false
    if !closed && !failed && bytes <= Self.maxBytes {
      while !fits(bytes), let i = eldestEvictableLocked() { evictLocked(i) }
      if fits(bytes) {
        reservedLines += 1
        reservedBytes += bytes
        reserved = true
      }
      syncOverflowLocked()
      updateSourceLocked()
    }
    let done = takeCallbacksLocked()
    lock.unlock()
    done.forEach { $0() }
    return reserved
  }
  public func releaseAck() {
    lock.lock()
    reservedLines = 0; reservedBytes = 0
    lock.unlock()
  }
  public func enqueue(_ data: Data, critical: Bool, hasTitle: Bool = false,
                      type: String = "unknown", reserved: Bool = false,
                      completion: ((Bool) -> Void)? = nil) {
    var fatal = false
    lock.lock()
    if reserved { reservedLines = 0; reservedBytes = 0 }
    if !closed && !failed {
      let t = EventKinds.normalize(type)
      if (hasTitle && data.count > Self.atomicLineBytes) || (critical && data.count > Self.maxBytes) {
        failed = true // encoder contract broken or critical line exceeds the byte bound
      } else {
        var accepted = true
        while !fits(data.count) {
          if let i = eldestEvictableLocked() {
            evictLocked(i)
            continue
          }
          if !critical {
            recordDropLocked(t)
            accepted = false
            break
          }
          let done = takeCallbacksLocked()
          lock.unlock()
          done.forEach { $0() }
          if onCapacityWait?() == true { return }
          var p = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
          _ = poll(&p, 1, 10)
          lock.lock()
          drainLocked()
          if closed || failed { accepted = false; break }
        }
        if accepted {
          entries.append(Entry(data: data, critical: critical,
                               hasTitle: hasTitle, type: t, completion: completion))
          queuedBytes += data.count
        } else if let completion {
          callbacks.append { completion(false) }
        }
        syncOverflowLocked()
        drainLocked()
      }
      fatal = failed
      updateSourceLocked()
    } else if let completion {
      callbacks.append { completion(false) }
    }
    let done = takeCallbacksLocked()
    lock.unlock()
    done.forEach { $0() }
    if fatal { onFatal?() }
  }
  private func fits(_ bytes: Int) -> Bool {
    entries.count - head + reservedLines + 1 <= Self.maxLines
      && queuedBytes + reservedBytes + bytes <= Self.maxBytes
  }
  private func eldestEvictableLocked() -> Int? {
    (head..<entries.count).first { entries[$0].offset == 0 && !entries[$0].critical }
  }
  private func recordDropLocked(_ type: String) {
    dropTotal += 1
    dropTypes[EventKinds.normalize(type), default: 0] += 1
  }
  private func evictLocked(_ i: Int) {
    recordDropLocked(entries[i].type)
    queuedBytes -= entries[i].data.count - entries[i].offset
    if let completion = entries[i].completion { callbacks.append { completion(false) } }
    entries.remove(at: i)
  }
  private func takeCallbacksLocked() -> [() -> Void] {
    let result = callbacks
    callbacks.removeAll()
    return result
  }
  // Counters hold drops not yet STARTED reporting. An unstarted pending
  // report's drops are still in them, so it is removed and rebuilt merged;
  // a started report is frozen (its counters reset at first write) and a new
  // pending report rides right behind it - at most 1 started + 1 pending.
  private func syncOverflowLocked() {
    guard dropTotal > 0, let make = makeOverflowLine else { return }
    if let i = (head..<entries.count).first(where: {
      entries[$0].overflow && entries[$0].offset == 0
    }) {
      queuedBytes -= entries[i].data.count
      entries.remove(at: i)
    }
    var data = make(dropTotal, dropTypes)
    guard !data.isEmpty else { return }
    while !fits(data.count) {
      guard let i = eldestEvictableLocked() else { return }
      evictLocked(i)
      data = make(dropTotal, dropTypes) // counts moved: re-encode once more
    }
    var at = head
    if at < entries.count, entries[at].offset > 0 { at += 1 }
    entries.insert(Entry(data: data, critical: true, overflow: true,
                         type: "error"), at: at)
    queuedBytes += data.count
  }
  // Privacy: no unwritten title byte may go out once titles are off. Title
  // entries are atomic so only whole UNSTARTED entries ever exist here:
  // an unstarted CRITICAL titled record (e.g. a snapshot) is re-encoded
  // stripped; every other unstarted title entry is dropped wholesale.
  public func purgeUnstartedTitles(stripCritical: (Data) -> Data?) {
    lock.lock()
    var i = entries.count - 1
    while i >= head {
      defer { i -= 1 }
      guard entries[i].hasTitle, entries[i].offset == 0 else { continue }
      if entries[i].critical, let stripped = stripCritical(entries[i].data) {
        queuedBytes += stripped.count - entries[i].data.count
        entries[i].data = stripped
        entries[i].hasTitle = false
      } else {
        queuedBytes -= entries[i].data.count
        if let completion = entries[i].completion { callbacks.append { completion(false) } }
        entries.remove(at: i)
      }
    }
    updateSourceLocked()
    let done = takeCallbacksLocked()
    lock.unlock()
    done.forEach { $0() }
  }
  // A finite deadline bounds shutdown; infinity waits for the FIFO quit drain.
  public func flush(deadline: TimeInterval = 0.2) {
    let end = ProcessInfo.processInfo.systemUptime + deadline
    while true {
      lock.lock(); drainLocked(); updateSourceLocked()
      let done = head >= entries.count || failed
      let completions = takeCallbacksLocked()
      lock.unlock()
      completions.forEach { $0() }
      if done { return }
      let remain = end - ProcessInfo.processInfo.systemUptime
      if remain <= 0 { return }
      if !deadline.isFinite, onCapacityWait?() == true { return }
      var p = pollfd(fd: fd, events: Int16(POLLOUT), revents: 0)
      poll(&p, 1, deadline.isFinite ? Int32(remain * 1000) : 10)
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
    var fatal = false
    lock.lock()
    drainLocked()
    fatal = failed
    updateSourceLocked()
    let done = takeCallbacksLocked()
    lock.unlock()
    done.forEach { $0() }
    if fatal { onFatal?() }
  }
  // Strict line order: one write() attempt per entry. Title lines are <=
  // PIPE_BUF so they must complete in a single write; a short positive write
  // is impossible per POSIX and fails the writer rather than resuming - a
  // purged title entry can therefore never leave a truncated prefix on the
  // wire. A started overflow report freezes the drop counters at first write.
  private func drainLocked() {
    while head < entries.count, !closed {
      let entry = entries[head]
      let n = entry.data.withUnsafeBytes { buf -> Int in
        guard let base = buf.baseAddress else { return -1 }
        return write(fd, base.advanced(by: entry.offset), buf.count - entry.offset)
      }
      if n <= 0 {
        if n < 0, errno == EINTR { continue }
        if n < 0 && errno != EAGAIN && errno != EWOULDBLOCK { failed = true }
        break // EAGAIN: wait for the write source; real error: fail fast
      }
      if entry.overflow, entry.offset == 0 {
        dropTotal = 0; dropTypes = [:] // report frozen: later drops report anew
      }
      if entry.hasTitle, n < entry.data.count {
        failed = true; break // impossible short title write: never resume
      }
      queuedBytes -= n
      entries[head].offset += n
      if entries[head].offset < entries[head].data.count { break } // keep line order
      if let completion = entries[head].completion { callbacks.append { completion(true) } }
      head += 1
    }
    // Compact consumed prefixes so storage stays bounded by live backlog.
    if head >= entries.count { entries.removeAll(); head = 0 }
    else if head >= 64 && head * 2 >= entries.count { entries.removeFirst(head); head = 0 }
    syncOverflowLocked()
  }
  private func updateSourceLocked() {
    let needs = head < entries.count && !closed && !failed
    if needs && suspended { suspended = false; source.resume() }
    if !needs && !suspended { suspended = true; source.suspend() }
  }
}
