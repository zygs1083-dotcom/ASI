import XCTest
@testable import SenseHelperCore
final class TitleDebouncerTests: XCTestCase {
  func testTrailingEdgeTiming() {
    var d = TitleDebouncer()
    XCTAssertEqual(d.submit("A", now: 0), 0.25)
    XCTAssertNil(d.fire(now: 0.249), "249ms must not emit")
    XCTAssertEqual(d.fire(now: 0.250), "A")
    XCTAssertEqual(d.lastEmitted, "A")
  }
  func testRepeatedPendingKeepsOriginalDeadline() {
    var d = TitleDebouncer()
    XCTAssertEqual(d.submit("A", now: 0), 0.25)
    XCTAssertEqual(d.submit("A", now: 0.20), 0.25, "identical pending must not postpone")
    XCTAssertNil(d.fire(now: 0.24))
    XCTAssertEqual(d.fire(now: 0.25), "A")
  }
  func testBurstLatestWins() {
    var d = TitleDebouncer()
    d.submit("A", now: 0)
    d.submit("B", now: 0.1)
    d.submit("C", now: 0.2)
    XCTAssertNil(d.fire(now: 0.34))
    XCTAssertEqual(d.fire(now: 0.45), "C")
  }
  func testSameEmittedNotRepeated() {
    var d = TitleDebouncer()
    d.submit("A", now: 0)
    XCTAssertEqual(d.fire(now: 0.25), "A")
    XCTAssertNil(d.submit("A", now: 0.5), "same as emitted must not reschedule")
    XCTAssertNil(d.fire(now: 1.0))
  }
  func testRevertToEmittedCancelsPending() {
    var d = TitleDebouncer()
    d.submit("B", now: 0)
    XCTAssertEqual(d.fire(now: 0.25), "B")
    d.submit("A", now: 1.0)
    XCTAssertNotNil(d.pendingTitle)
    XCTAssertNil(d.submit("B", now: 1.1), "returning to emitted B cancels stale pending A")
    XCTAssertNil(d.pendingTitle)
    XCTAssertNil(d.fire(now: 2.0))
  }
  func testContextResetPermitsSameString() {
    var d = TitleDebouncer()
    d.submit("T", now: 0)
    XCTAssertEqual(d.fire(now: 0.25), "T")
    d.reset()
    d.submit("T", now: 1.0)
    XCTAssertEqual(d.fire(now: 1.25), "T")
  }
  func testCancelPendingAndMarkEmitted() {
    var d = TitleDebouncer()
    d.markEmitted("W")
    XCTAssertNil(d.submit("W", now: 0), "markEmitted records dedup memory")
    d.submit("U", now: 1.0)
    d.cancelPending()
    XCTAssertNil(d.fire(now: 2.0), "cancelPending drops pending, keeps dedup")
  }
}
