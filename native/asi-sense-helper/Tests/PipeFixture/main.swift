import ApplicationServices
import Foundation
import SenseHelperCore

// Test-only synthetic helper: the SAME CommandChannel + AXSession wiring as the
// real helper, driven by a deterministic fake AX backend. argv flags configure
// a semaphore gate on focusedWindow calls and a synthetic title; fixed
// non-sensitive markers go to stderr for parent-side synchronization.
private func nowMs() -> Int64 { Int64(Date().timeIntervalSince1970 * 1000) }
private func note(_ s: String) { FileHandle.standardError.write(Data((s + "\n").utf8)) }

final class SyntheticAX: AXBackend {
  final class El { let id: Int; init(_ id: Int) { self.id = id } }
  final class Obs { let pid: Int32; init(_ pid: Int32) { self.pid = pid } }
  var window: El? = El(1), title = ""
  var fwCalls = 0, gateFrom = 0, gate: DispatchSemaphore?
  func createObserver(pid: Int32) throws -> Obs { Obs(pid) }
  func start(_ o: Obs) {}
  func application(pid: Int32) -> El { El(-Int(pid)) }
  func add(observer: Obs, element: El, notification: String) -> AXError { .success }
  func remove(observer: Obs, element: El, notification: String) {}
  func focusedWindow(_ app: El) -> (AXError, El?) {
    fwCalls += 1
    if let g = gate, fwCalls >= gateFrom {
      note("fixture:gate-hold")
      g.wait()
      note("fixture:gate-release")
    }
    return (.success, window)
  }
  func title(_ window: El) -> (AXError, String?) { (.success, title) }
  func equal(_ a: El, _ b: El) -> Bool { a.id == b.id }
  func equalObserver(_ a: Obs, _ b: Obs) -> Bool { a === b }
  func detach(_ o: Obs) {}
}

let frontPid: Int32 = 4242, frontBid = "fixture.app"
var titleLen = 64, gateFrom = 0, releaseMs = 750
for arg in CommandLine.arguments.dropFirst() {
  if arg.hasPrefix("--title-len="), let v = Int(arg.dropFirst(12)) { titleLen = v }
  if arg.hasPrefix("--gate-fw-from="), let v = Int(arg.dropFirst(15)) { gateFrom = v }
  if arg.hasPrefix("--release-delay-ms="), let v = Int(arg.dropFirst(19)) { releaseMs = v }
}

let synthetic = SyntheticAX()
synthetic.title = "FIXTLEAK-BEGIN-" + String(repeating: "x", count: titleLen) + "-FIXTLEAK-END"
if gateFrom > 0 { synthetic.gateFrom = gateFrom; synthetic.gate = DispatchSemaphore(value: 0) }

let channel = CommandChannel(queue: .main, nowMs: nowMs)
var session: AXSession<SyntheticAX>!
session = AXSession(backend: synthetic, isTrusted: { true }, nowMs: nowMs,
                    emit: { e in channel.send(e) })
channel.onTitles = { on in
  let gen = session.setTitlesEnabled(on)
  // Posted on .main so it runs only after the whole titles control returns:
  // the channel-side purge and the ack enqueue have both completed by then.
  DispatchQueue.main.async { note("fixture:titles-applied") }
  // The gate releases on an independent delay AFTER the toggle (and after the
  // ack is enqueued), never before it.
  if let g = synthetic.gate {
    DispatchQueue.global().asyncAfter(deadline: .now() + .milliseconds(releaseMs)) { g.signal() }
  }
  return gen
}
channel.onCommand = { cmd, done in
  switch cmd {
  case .snapshot:
    let fa = SnapshotEvent.FrontApp(name: "FixtureApp", bundleId: frontBid, pid: frontPid)
    session.snapshot(pid: frontPid, bundleId: frontBid) { status, title in
      channel.send(SnapshotEvent(at: nowMs(), frontApp: fa,
        focusedWindow: .init(pid: frontPid, bundleId: frontBid, status: status, title: title),
        thermal: "nominal", permissions: .init(accessibility: "granted")))
      note("fixture:snapshot-done")
      done()
    }
  case .recheckPermissions:
    channel.send(HelloEvent(at: nowMs(), pid: ProcessInfo.processInfo.processIdentifier,
                            permissions: .init(accessibility: "granted")))
    done()
  default: done()
  }
}
func shutdown() {
  channel.stopInput()
  session.shutdown()
  channel.flushOutput(deadline: 0.2)
  channel.closeOutput()
  exit(0)
}
channel.onQuit = { shutdown() }
channel.onEOF = { shutdown() }
let controlQueue = DispatchQueue(label: "asi-sense-pipe-fixture.control")
channel.onEOFDetected = { controlQueue.asyncAfter(deadline: .now() + 0.75) { exit(0) } }
channel.onFatal = { exit(1) }

channel.send(HelloEvent(at: nowMs(), pid: ProcessInfo.processInfo.processIdentifier,
                        permissions: .init(accessibility: "granted")))
channel.send(ThermalEvent(at: nowMs(), state: "nominal"))
channel.start()
session.activate(pid: frontPid, bundleId: frontBid)
note("fixture:ready")
RunLoop.main.run()
