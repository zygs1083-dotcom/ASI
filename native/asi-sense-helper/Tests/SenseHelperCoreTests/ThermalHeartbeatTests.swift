import Foundation
import XCTest
@testable import SenseHelperCore

private struct ThermalReading {
  let uptime: TimeInterval
  let at: Int64
}

final class ThermalHeartbeatTests: XCTestCase {
  func testHelperReemitsThermalReadingWithinTTL() throws {
    var root = URL(fileURLWithPath: #filePath)
    for _ in 0..<3 { root.deleteLastPathComponent() }
    let process = Process()
    let input = Pipe(), output = Pipe()
    process.executableURL = root.appendingPathComponent(".build/debug/asi-sense-helper")
    process.standardInput = input
    process.standardOutput = output
    process.standardError = FileHandle.nullDevice
    let received = expectation(description: "two thermal readings")
    let data = Locked(Data())
    let readings = Locked([ThermalReading]())
    output.fileHandleForReading.readabilityHandler = { handle in
      data.mutate { buffer in
        buffer.append(handle.availableData)
        while let nl = buffer.firstIndex(of: 0x0a) {
          let line = buffer.subdata(in: buffer.startIndex..<nl)
          buffer.removeSubrange(buffer.startIndex...nl)
          guard let event = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any],
                event["type"] as? String == "thermal",
                let state = event["state"] as? String,
                ["nominal", "fair", "serious", "critical"].contains(state),
                let at = (event["at"] as? NSNumber)?.int64Value else { continue }
          let due = readings.mutate { values in
            let now = ProcessInfo.processInfo.systemUptime
            let due = values.first.map {
              now - $0.uptime >= 25 && (values.last ?? $0).uptime - $0.uptime < 25
            } ?? false
            values.append(.init(uptime: now, at: at))
            return due
          }
          if due { received.fulfill() }
        }
      }
    }
    try process.run()
    defer {
      output.fileHandleForReading.readabilityHandler = nil
      try? input.fileHandleForWriting.close()
      if process.isRunning { process.terminate() }
      process.waitUntilExit()
    }
    wait(for: [received], timeout: 40)
    let events = readings.get()
    if let first = events.first, let last = events.last, events.count >= 2 {
      XCTAssertGreaterThanOrEqual(last.uptime - first.uptime, 25)
      XCTAssertLessThan(last.uptime - first.uptime, 40)
      XCTAssertGreaterThan(last.at, first.at)
    }
  }
}
