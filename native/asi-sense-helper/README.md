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
