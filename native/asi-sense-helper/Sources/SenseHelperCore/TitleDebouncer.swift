import Foundation
// Trailing-edge debounce: latest title wins; a title equal to the last emitted
// one is suppressed within the focused-window context; returning to an
// already-emitted title cancels a stale pending title.
public struct TitleDebouncer {
  public let delay: TimeInterval
  public private(set) var pendingTitle: String?
  public private(set) var pendingDeadline: TimeInterval?
  public private(set) var lastEmitted: String?

  public init(delay: TimeInterval = 0.25) {
    self.delay = delay
  }
  // Returns the deadline to (re)schedule a fire for, or nil when the new title
  // equals the already-emitted one (which also cancels any stale pending title).
  public mutating func submit(_ title: String, now: TimeInterval) -> TimeInterval? {
    if title == lastEmitted {
      pendingTitle = nil
      pendingDeadline = nil
      return nil
    }
    if title == pendingTitle { return pendingDeadline } // same pending title keeps its deadline
    pendingTitle = title
    let deadline = now + delay
    pendingDeadline = deadline
    return deadline
  }
  // Returns the title to emit once its deadline has passed.
  public mutating func fire(now: TimeInterval) -> String? {
    guard let title = pendingTitle, let deadline = pendingDeadline, now >= deadline else {
      return nil
    }
    pendingTitle = nil
    pendingDeadline = nil
    lastEmitted = title
    return title
  }
  // Records an externally emitted title (e.g. window.focused) for dedup.
  public mutating func markEmitted(_ title: String) {
    pendingTitle = nil
    pendingDeadline = nil
    lastEmitted = title
  }

  public mutating func cancelPending() {
    pendingTitle = nil
    pendingDeadline = nil
  }
  // New focused-window/app context: the same string may be emitted again.
  public mutating func reset() {
    pendingTitle = nil
    pendingDeadline = nil
    lastEmitted = nil
  }
}
