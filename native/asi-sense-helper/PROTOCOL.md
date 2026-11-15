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
| `ax.unsupported` | `bundleId`,`notification`,`error` (raw AXError code) | a required AX registration failed with a *permanent* unsupported error; at most once per app key per run (see AX semantics) |
| `thermal` | `state` | ProcessInfo |
| `power.sleep`/`power.wake`, `screen.locked`/`screen.unlocked`, `session.active`/`session.inactive` | - | NSWorkspace + DNC |
| `snapshot` | see below | `{"cmd":"snapshot"}` |
| `error` | `code`,`message`,`dropped?` | rejected input, flow-control notices or unrecognized OS state; fixed strings, never echoes input |

If a future unrecognized `ProcessInfo.ThermalState` appears, a fixed `error`
event (`code:"thermal-state"`) is emitted instead of an invented state.

### `snapshot` response

`{frontApp:{name,bundleId,pid}, focusedWindow:{pid,bundleId,status,title?}, thermal, permissions}`

- `frontApp`/`focusedWindow`: omitted when no front app exists.
- `focusedWindow.status`: `ok` (a focused window was read), `denied` (no
  Accessibility trust), `unsupported` (the app rejected AX observation),
  `unknown` (trusted but no focused window - e.g. a windowless foreground app;
  `noValue` maps here, never to `unsupported`).
- `focusedWindow.title`: present only when readable and titles are on.
- `thermal`: `nominal`/`fair`/`serious`/`critical`; on an unrecognized state it
  is `"unknown"` and a `thermal-state` error event is emitted first.
- Snapshot AX reads run on the same serial AX queue as notifications and are
  generation-checked: a result read under a since-changed app/window context
  is discarded and reported as `unknown`, and a privacy change yields no title.

## Commands (stdin)

One per line, <=64KiB; partial lines and CRLF handled. Optional `v` must equal
`1` when present; other metadata fields are ignored.

| command | effect |
|---|---|
| `{"cmd":"snapshot"}` | one `snapshot` event |
| `{"cmd":"titles","enabled":true|false}` | privacy switch (see below) |
| `{"cmd":"recheck-permissions"}` | fresh `hello`; reconciles AX state: attaches when trusted and not yet observing, detaches the live observer when trust was revoked; never prompts |
| `{"cmd":"quit"}` | clean shutdown, exit 0 |

Errors (`error` event, process keeps running unless noted):

| code | cause |
|---|---|
| `malformed` | not a JSON object, or `cmd` not a string |
| `unknown-command` | unrecognized `cmd` |
| `bad-enabled` | `titles.enabled` missing or not a JSON boolean (0/1 rejected) |
| `bad-version` | `v` present but not numerically `1` |
| `line-too-long` | command line exceeds 64KiB; the rest of that physical line is discarded |
| `input_overflow` | aggregate pending input exceeded 256KiB; the current physical line is discarded through its next LF (one event per saturation episode) |
| `output_overflow` | queued output hit the bounds below and noncritical events were evicted; `dropped:N` reports the total evicted count. Emitted once the queue drains |
| `ax-retryable` | an AX operation failed with a retryable error (`cannotComplete`, `apiDisabled`, `failure`, `invalidUIElement`, ...); the app is *not* marked unsupported and the next activation/`recheck-permissions` retries |
| `thermal-state` | OS reported an unrecognized thermal state |

## Input bounds

- Reads are nonblocking, <=16KiB chunks, on a serial reader context (the main
  run loop in the shipped helper); each readiness event handles finite bytes.
- Total pending input (buffered + in-flight command) is capped at 256KiB. On
  saturation `input_overflow` fires once per episode and physical lines are
  discarded through their LFs without retaining oversize suffixes; ordinary
  oversized lines keep `line-too-long`.
- Commands run strictly one at a time (next delivered only after the previous
  completion, including the async `snapshot` read); a flood cannot queue
  unbounded work.
- EOF: buffered complete commands run normally and a trailing partial line
  parses as the final command. An independent ~750ms control-queue deadline
  arms at EOF detection, so a stalled command is abandoned only if it fires.

## Output bounds

- All stdout writes are nonblocking (`O_NONBLOCK`) through a bounded queue -
  at most **1024 queued lines** and **1MiB queued bytes** - drained by a
  `DispatchSourceWrite`. Enqueue never blocks, spins on EAGAIN, or interleaves
  lines; a partially written line resumes at its byte offset when space frees.
- On saturation the **oldest unstarted noncritical** events are evicted; the
  count accumulates and one `output_overflow` (`dropped:N`) error is emitted
  once the queue drains.
- `hello` and `error` are **critical**: never evicted or purged. If nothing
  removable remains (or a critical event exceeds the byte bound) the helper
  fails fast with exit 1 rather than discard critical data or grow memory.
- Normal shutdown drains only ready output under a strict 200ms deadline;
  it does not guarantee delivery of everything queued. Filled stdout can
  never block EOF or SIGTERM handling.

## AX semantics

- All AX IPC runs on a serial AX queue with `AXUIElementSetMessagingTimeout`
  0.5s on the application and window elements before every read. Main-thread
  work only posts bounded, coalesced jobs to that queue.
- Lifecycle state lives in one lock-protected record: the desired app target,
  app/window/privacy generations and the published observer. Public
  entrypoints mutate it atomically (activation/termination/revocation bump
  the app generation, window commits bump the window generation, privacy
  toggles bump the privacy generation), workers re-validate their request's
  app generation before and after every blocking call, and main-bound
  deliveries are dropped on any stamp mismatch.
- `kAXFocusedWindowChangedNotification` is **required**;
  `kAXMainWindowChangedNotification` is optional - its failure never marks an
  app unsupported and focused monitoring continues.
- Permanent unsupported errors (`notificationUnsupported`,
  `attributeUnsupported`, `parameterizedAttributeUnsupported`,
  `actionUnsupported`, `notImplemented`) emit `ax.unsupported` once per app key
  per run. Every other failure emits `ax-retryable` once per context and is
  retried on the next activation or `recheck-permissions`. `noValue` means
  windowless/unknown.
- The internal dedup key is the bundle id, or `pid:<n>` when the app has none -
  two bundle-less apps never share unsupported state; on the wire `bundleId`
  serializes as `""` for missing identifiers.
- On a focused-window refresh the window identity is compared first (`CFEqual`
  in production): the same window keeps the pending title debounce and emits
  no extra `window.focused`; a different window unsubscribes the old title
  observation, resets the debounce, subscribes the new one (only when titles
  are on) and emits one `window.focused`.
- When the observed app terminates, the session detaches logically at once
  (resource teardown stays queued).
- AX notification jobs coalesce: at most one outstanding refresh and one title
  read per context; a re-run enqueues one successor at the queue tail so
  activation/privacy/termination work is never starved. Notifications from a
  replaced observer are ignored.

## Privacy

- Titles default **on**. `titles:false` cancels pending debounced titles,
  unregisters the title observer, purges unstarted title-bearing noncritical
  queued output, and centrally strips every `title` key from all subsequent
  events in the encoder so a stale payload cannot leak.
- A line already partially written to stdout cannot be recalled; the purge
  covers only queued-but-unwritten data. This is the sole residual leak and is
  at most the unwritten remainder of one line.
- `titles:true` resets title dedup and re-reads through the normal 250ms
  debounce. While titles are off the helper does not read `AXTitle`.
- Only two AX attributes are ever read: `AXFocusedWindow` and `AXTitle`.
  `AXIsProcessTrusted` only - never prompts.

## Exit

- stdin EOF: buffered complete commands run normally, the trailing partial
  line is parsed as a final command (or discarded if it continues a rejected
  oversized line), and the process exits 0 within ~1s even when stdout is
  full; only the ~750ms control-queue deadline may abandon remaining work.
- `{"cmd":"quit"}` / SIGTERM: exit 0. SIGTERM is handled on an independent
  control queue that exits directly without waiting on main/AX/output locks;
  process exit releases kernel AX resources. The normal path performs local
  teardown without blocking on AX IPC and drains output for at most 200ms.
- stdout write failure: exit 1 (SIGPIPE is ignored). The helper writes no files.
