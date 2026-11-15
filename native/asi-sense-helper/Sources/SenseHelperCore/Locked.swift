import Foundation
// Tiny lock-protected box for state shared between main and the AX queue.
public final class Locked<T> {
  private var value: T
  private let lock = NSLock()
  public init(_ value: T) { self.value = value }
  public func get() -> T { lock.lock(); defer { lock.unlock() }; return value }
  public func set(_ v: T) { lock.lock(); value = v; lock.unlock() }
  @discardableResult
  public func mutate<R>(_ body: (inout T) -> R) -> R {
    lock.lock(); defer { lock.unlock() }; return body(&value)
  }
}
