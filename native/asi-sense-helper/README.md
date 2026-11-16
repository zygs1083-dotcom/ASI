# asi-sense-helper (native)

Native macOS helper for the `asi-sense` DSH plugin (see `docs/DESIGN.md`). A
small CLI process that watches the environment and speaks NDJSON on
stdin/stdout; the host plugin spawns it and owns its lifecycle. It observes:

- app activate / launch / terminate - `NSWorkspace`
- focused window + title changes - `AXObserver` (needs Accessibility)
- sleep / wake / session / screen lock - `NSWorkspace` + `DistributedNotificationCenter`
- thermal state - `ProcessInfo.thermalState`

It never screenshots or reads window contents - at most the focused window and
its `AXTitle` - and writes no files; titles can be disabled at runtime.

## Build / test / smoke

```sh
swift build -c release            # binary at .build/release/asi-sense-helper
swift test                        # unit + process-level tests (needs a prior build)
scripts/smoke.sh                  # real-machine smoke: opens TextEdit/Finder, ~20s
```

## Protocol

NDJSON on stdin (commands) / stdout (events). See [PROTOCOL.md](PROTOCOL.md)
for every field, ordering, error codes, privacy rules and exit statuses.

## Runtime architecture

All I/O is bounded so a slow or dead peer can never hang or exhaust the
helper (bounds and semantics: PROTOCOL.md):

- **stdin**: nonblocking reader, 16KiB chunks, <=64KiB physical-line framing,
  <=256KiB ordinary pending, serialized commands. Valid `titles`/`quit`
  commands apply individually in order, bypassing a snapshot in flight;
  each titles ack reserves output capacity before application. A full critical
  queue pauses stdin, retaining only the current chunk and waiting control.
  Parsing stops at quit; ordinary drops report `input_overflow` with
  per-type counts.
- **stdout**: nonblocking bounded writer (1024 lines / 1MiB); oldest
  noncritical evictions report one coalesced `output_overflow`
  (`dropped`/`droppedTypes`) as the next whole line; criticals
  (`hello`,`error`,`app.terminated`,`ax.unsupported`,`snapshot`,`titles.ack`)
  never drop; critical producers wait for space rather than exiting on a full
  queue.
- **privacy**: titles start off; hello/acks share a random per-process session.
  The host waits for its latest intent's matching ack. `titles` applies synchronously (saturating generation bump),
  flips the central encoder (recursive `title`-key stripping), purges queued
  title lines and emits a critical `titles.ack` - the host's privacy fence.
  Title lines are <=PIPE_BUF (512B on Darwin) and write atomically - either
  whole or not at all - so a purged title line can never leave a truncated
  prefix on the wire.
- **AX**: all IPC on a serial queue with a 0.5s timeout; app/window/privacy
  generation checks drop stale results; one coalesced privacy job applies the
  latest generation regardless of toggle storms. AX returns the complete title
  before the AX queue truncates it to 1024 Characters for encoding; AX and
  conversion may allocate or copy the full source. The title-budget script's
  `processing_peak_increment` starts after synthetic source allocation and is
  not an upper bound on total memory.
- `CommandChannel` owns the stdin/privacy/stdout plumbing shared by the real
  runtime and the `Tests/PipeFixture` synthetic process used by pipe-level
  regression tests.
- **shutdown**: in-band `quit` drains queued output in order. EOF or SIGTERM
  stops input and attempts a <=200ms drain; if stdout is not being read, close
  stdin or send SIGTERM (SIGKILL is the host's last resort).

## Accessibility permission

Title/focused-window monitoring needs the Accessibility permission. The helper
**never prompts** (`AXIsProcessTrusted` only - no
`AXIsProcessTrustedWithOptions`). If it starts denied it still emits hello /
app / power / thermal events; window events and snapshot window status degrade
to `denied`.

To grant: System Settings -> Privacy & Security -> Accessibility -> add the
terminal (or parent process) that launches the helper, then send
`{"cmd":"recheck-permissions"}` - no restart needed. No Screen Recording
permission is required or requested.

## References

- AXUIElement / AXObserver:
  <https://developer.apple.com/documentation/applicationservices/axuielement_h>
- NSWorkspace notifications:
  <https://developer.apple.com/documentation/appkit/nsworkspace>
- ProcessInfo.thermalState:
  <https://developer.apple.com/documentation/foundation/processinfo/thermalstate>
