# asi-sense-helper protocol v1

NDJSON over stdin (commands) / stdout (events). One JSON object per line, UTF-8.
No other output is ever written (stdout write failure -> exit 1).

## Event envelope

Every event has `v` (always `1`), `type` (string), `at` (Int64 epoch ms).
Payload fields are flattened into the event object (no `data` wrapper).

Startup order:

1. `hello` - `{version:"0.1.0", pid, permissions:{accessibility:"granted"|"denied"}}`
2. `thermal` - `{state:"nominal"|"fair"|"serious"|"critical"}`
3. initial `window.focused` for the current front app, only if Accessibility is
   granted. `app.activated` is **never** fabricated - only real `NSWorkspace`
   activations appear.

| type | extra fields | source |
|---|---|---|
| `hello` | `version`,`pid`,`permissions` | startup + `recheck-permissions` |
| `app.activated` / `app.launched` / `app.terminated` | `name`,`bundleId`,`pid` (missing strings -> `""`) | NSWorkspace |
| `window.focused` | `pid`,`bundleId`,`title?` | AX focused/main window change; `title` absent if unreadable, no focused window, or titles disabled |
| `window.title` | `pid`,`bundleId`,`title?` | AX title change, debounced 250ms trailing, latest wins, same-as-emitted suppressed per focused-window context |
| `ax.unsupported` | `bundleId`,`notification`,`error` (raw AXError code) | AX observer/notification registration failed; at most once per bundleId per run; that app then produces no window events |
| `thermal` | `state` | ProcessInfo |
| `power.sleep`/`power.wake`, `screen.locked`/`screen.unlocked`, `session.active`/`session.inactive` | - | NSWorkspace + DNC |
| `snapshot` | see below | `{"cmd":"snapshot"}` |
| `error` | `code`,`message` | rejected input or unrecognized OS state; fixed strings, never echoes input |

If a future unrecognized `ProcessInfo.ThermalState` appears, a fixed `error`
event (`code:"thermal-state"`) is emitted instead of an invented state.

### `snapshot` response

```json
{"v":1,"type":"snapshot","at":1794759404956,"frontApp":{"name":"TextEdit","bundleId":"com.apple.TextEdit","pid":1234},"focusedWindow":{"pid":1234,"bundleId":"com.apple.TextEdit","status":"ok","title":"Untitled"},"thermal":"nominal","permissions":{"accessibility":"granted"}}
```

- `frontApp`/`focusedWindow`: omitted when no front app exists.
- `focusedWindow.status`: `ok` (a focused window was read), `denied` (no
  Accessibility trust), `unsupported` (the app rejected AX observation),
  `unknown` (trusted but no focused window - e.g. a windowless foreground app).
- `focusedWindow.title`: present only when readable and titles are on.
- `thermal`: `nominal`/`fair`/`serious`/`critical`; on an unrecognized state it
  is `"unknown"` and a `thermal-state` error event is emitted first.

## Commands (stdin)

One per line, <=64KiB; partial lines and CRLF handled. Optional `v` must equal
`1` when present; other metadata fields are ignored.

| command | effect |
|---|---|
| `{"cmd":"snapshot"}` | one `snapshot` event |
| `{"cmd":"titles","enabled":true|false}` | privacy switch (see below) |
| `{"cmd":"recheck-permissions"}` | fresh `hello`; reconciles AX state: attaches when trusted and not yet observing, detaches the live observer when trust was revoked; never prompts |
| `{"cmd":"quit"}` | clean shutdown, exit 0 |

Errors (`error` event, process keeps running):

| code | cause |
|---|---|
| `malformed` | not a JSON object, or `cmd` not a string |
| `unknown-command` | unrecognized `cmd` |
| `bad-enabled` | `titles.enabled` missing or not a JSON boolean (0/1 rejected) |
| `bad-version` | `v` present but not numerically `1` |
| `line-too-long` | command line exceeds 64KiB; the rest of that physical line is discarded |
| `thermal-state` | OS reported an unrecognized thermal state |

## Privacy

- Titles default **on**. `titles:false` cancels pending debounced titles,
  unregisters the title observer, and centrally strips every `title` key from
  all subsequent events (`window.focused`, `window.title`, `snapshot`) - the
  suppression is in the encoder so a stale payload cannot leak.
- `titles:true` resets title dedup and re-reads the current title through the
  normal 250ms debounce. While titles are off the helper does not read `AXTitle`.
- Only two AX attributes are ever read: `AXFocusedWindow` and `AXTitle`.
  `AXIsProcessTrusted` only - never prompts.

## Exit

- stdin EOF: buffered trailing bytes are parsed as a final command line (or
  discarded if they continue a rejected oversized line), then exit 0.
- `{"cmd":"quit"}` / SIGTERM: clean teardown, exit 0. All observers, timers, the
  stdin reader and the AX run-loop source are torn down.
- stdout write failure: exit 1 (SIGPIPE is ignored). The helper writes no files.
