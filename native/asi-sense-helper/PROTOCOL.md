# asi-sense-helper protocol v1

NDJSON over stdin (commands) / stdout (events). One JSON object per line, UTF-8.
No other output is ever written (stdout write failure -> exit 1).

## Event envelope

Every event has `v` (always `1`), `type` (string), `at` (Int64 epoch ms).
Payload fields are flattened into the event object (no `data` wrapper).

Startup order:

1. `hello` - `{version:"0.1.0", pid, session, permissions:{accessibility:"granted"|"denied"}}`
2. `thermal` - `{state:"nominal"|"fair"|"serious"|"critical"}`
3. initial `window.focused` for the current front app, only if Accessibility is
   granted. `app.activated` is **never** fabricated - only real `NSWorkspace`
   activations appear.

| type | extra fields | source |
|---|---|---|
| `hello` | `version`,`pid`,`session`,`permissions` | startup + `recheck-permissions`; random UUID `session` is fixed for this process |
| `app.activated` / `app.launched` / `app.terminated` | `name`,`bundleId`,`pid` (missing strings -> `""`) | NSWorkspace |
| `window.focused` | `pid`,`bundleId`,`title?`,`window` | AX focused/main window change; `title` absent if unreadable, no focused window, or titles disabled; `window` is explicitly `null` when the focused app currently has no window (windowless focus, deduplicated while focus stays windowless) |
| `window.title` | `pid`,`bundleId`,`title?` | AX title change, debounced 250ms trailing, latest wins, same-as-emitted suppressed per focused-window context |
| `titles.ack` | `session`,`id?`,`enabled`,`gen` | confirms each `titles` command: same session as hello, echoed state/id, strictly increasing process-local privacy generation |
| `ax.unsupported` | `bundleId`,`pid`,`notification`,`error` (raw AXError code) | a required AX registration failed with a *permanent* unsupported error; at most once per app key per run (see AX semantics) |
| `thermal` | `state` | ProcessInfo |
| `power.sleep`/`power.wake`, `screen.locked`/`screen.unlocked`, `session.active`/`session.inactive` | - | NSWorkspace + DNC |
| `snapshot` | see below | `{"cmd":"snapshot"}` |
| `error` | `code`,`message`,`dropped?`,`droppedTypes?`,`pid?`,`bundleId?` | rejected input, flow-control notices or unrecognized OS state; fixed strings, never echoes input |

If a future unrecognized `ProcessInfo.ThermalState` appears, a fixed `error`
event (`code:"thermal-state"`) is emitted instead of an invented state.

### `snapshot` response

`{frontApp:{name,bundleId,pid}, focusedWindow:{pid,bundleId,status,title?}, thermal, permissions}`

- `frontApp`/`focusedWindow`: omitted when no front app exists.
- `focusedWindow.status`: `ok` (attached observer and a focused window was read), `denied` (no
  Accessibility trust), `unsupported` (the app rejected AX observation),
  `unknown` (trusted but no attached observer or focused window;
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
| `{"cmd":"titles","enabled":true|false,"id"?}` | privacy switch (see below); optional `id` is a string or exact Int64 correlation tag echoed by `titles.ack` (non-integral or out-of-range values -> `bad-id`) |
| `{"cmd":"recheck-permissions"}` | fresh `hello`; reconciles AX state: attaches when trusted and not yet observing, detaches the live observer when trust was revoked; never prompts |
| `{"cmd":"quit"}` | clean shutdown, exit 0 |

**Controls.** Every `titles`/`quit` is applied synchronously in arrival order,
at its complete physical line, before parsing the next line. Controls bypass
queued ordinary commands and an in-flight snapshot. No controls are coalesced
or silently discarded: each `titles`, including redundant ones, increments
the privacy generation, flips the encoder, purges queued titles when disabling,
and enqueues its own critical `titles.ack`. Only actual AX title work coalesces.
`quit` increments the privacy generation, disables titles and purges queued
titles before bounded shutdown. Parsing stops at the first `quit`: no later
commands, controls or errors are processed, even in the same write/read chunk.

Errors (`error` event, process keeps running unless noted):

| code | cause |
|---|---|
| `malformed` | not a JSON object, or `cmd` not a string |
| `unknown-command` | unrecognized `cmd` |
| `bad-enabled` | `titles.enabled` missing or not a JSON boolean (0/1 rejected) |
| `bad-id` | `titles.id` present but not a string or integer |
| `bad-version` | `v` present but not numerically `1` |
| `line-too-long` | command line exceeds 64KiB; the rest of that physical line is discarded |
| `input_overflow` | ordinary pending input exceeded 256KiB; `dropped`/`droppedTypes` count the dropped commands per bounded type key (`snapshot`,`recheck-permissions`,`unknown`,`malformed`); coalesced per readiness batch |
| `output_overflow` | queued output hit the bounds below and noncritical events were evicted; `dropped`/`droppedTypes` count evictions per event type. Emitted as the next whole record, not at queue-empty |
| `ax-retryable` | an AX operation failed with a retryable error (`cannotComplete`, `apiDisabled`, `failure`, `invalidUIElement`, ...); carries `pid`/`bundleId` of the affected app; the app is *not* marked unsupported and the next activation/`recheck-permissions` retries |
| `thermal-state` | OS reported an unrecognized thermal state |
| `privacy-generation-exhausted` | privacy generation saturated at `Int.max`; titles forced off, fixed error emitted, exit 1 (bounded drain); host must rebuild helper, never reuse the exhausted generation |

## Input bounds

- Reads are nonblocking, <=16KiB chunks, on a serial reader context (the main
  run loop in the shipped helper); each readiness event handles finite bytes.
- Physical lines are framed in a dedicated <=64KiB scratch **independently** of
  serialized command consumption; an oversized line is rejected through its
  next LF with `line-too-long`.
- Ordinary pending input (queued + in-flight command) is capped at 256KiB,
  each entry charged `max(64, bytes+1)` to cover framing overhead so empty
  lines cannot queue unbounded records; anything beyond the cap is dropped
  and counted in a coalesced `input_overflow` per readiness batch.
- Control capacity is one in service, **zero pending**: the synchronous
  callback must finish before framing another line or reading stdin again.
  A busy control consumer naturally backpressures the pipe; only the current
  <=16KiB read chunk and <=64KiB line scratch are retained. No overwrite/drop.
- Ordinary commands run one at a time (next delivered only after the previous
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
- On saturation the **oldest unstarted noncritical** events are evicted; one
  coalesced critical `output_overflow` record (`dropped`, `droppedTypes`)
  rides as the next whole line right behind any partially-written head.
- **Critical** - never evicted, never purged-without-transform:
  `hello`, `error`, `app.terminated`, `ax.unsupported`, `snapshot`,
  `titles.ack`. If nothing removable remains (or a critical event exceeds
  the byte bound) the helper fails fast with exit 1 rather than discard
  critical data or grow memory.
- Title-bearing lines are capped at **PIPE_BUF bytes** including the LF -
  `min(4096, PIPE_BUF)` = 512 on Darwin (a platform-safety tightening of the
  requested <=4096); the encoder truncates or strips title strings to fit
  the final JSONSerialization encoding. Such a line is written atomically:
  the whole line crosses in one `write()` or the entry waits at offset 0 -
  a partial title line never exists, so it can never be resumed, purged
  mid-wire, or glued onto a following record.
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
  `kAXMainWindowChangedNotification` and all `AXTitle` reads/subscriptions are
  optional - their failures (even permanent unsupported ones) never mark an
  app unsupported and never detach it; a focused app simply reports no title.
- Permanent unsupported errors (`notificationUnsupported`,
  `attributeUnsupported`, `parameterizedAttributeUnsupported`,
  `actionUnsupported`, `notImplemented`) emit `ax.unsupported` once per app key
  per run. Every other failure emits `ax-retryable` once per context and is
  retried on the next activation or `recheck-permissions`. `noValue` means
  windowless/unknown: it emits `window.focused` with `window:null` (once per
  windowless context; repeated windowless notifications are deduplicated, and
  switching to a windowless app reports it again).
- App-scoped error events (`ax.unsupported`, `ax-retryable`) capture the
  producing app+privacy generations and the target's identity before any
  teardown; at delivery a stale generation drops the event entirely - errors
  are never relabeled with a newer context.
  A required registration failure under a changed privacy epoch retries
  once under the current epoch while the app is still desired; a repeated
  failure then reports current `ax.unsupported` or `ax-retryable` normally.
- The internal dedup key is the bundle id, or `pid:<n>` when the app has none -
  two bundle-less apps never share unsupported state; on the wire `bundleId`
  serializes as `""` for missing identifiers.
- On a focused-window refresh the window identity is compared first (`CFEqual`
  in production): the same window keeps the pending title debounce and emits
  no extra `window.focused` only after successful stamped delivery; a focus
  discarded on a privacy transition is reposted (title-free when disabled).
  A different window unsubscribes the old title
  observation, resets the debounce, subscribes the new one (only when titles
  are on) and emits one `window.focused`.
- When the observed app terminates, the session detaches logically at once
  (resource teardown stays queued).
- AX notification jobs coalesce: at most one outstanding refresh and one title
  read per context; a re-run enqueues one successor at the queue tail so
  activation/privacy/termination work is never starved. Notifications from a
  replaced observer are ignored.
- Privacy changes also coalesce: each `titles` command bumps the generation
  synchronously and returns it for the ack, but at most one queued AX apply
  job (plus one successor carrying the latest generation) ever exists - a
  storm of toggles runs a bounded amount of AX work, and queued notification
  reads carry the privacy generation they were requested under so stale
  pre-toggle reads never run.

## Privacy

Titles default **off (fail-closed)** in every new helper process. The host
starts with recursive title stripping enabled, learns `session` from hello,
sends its current intent with a unique `id`, and waits for a matching ack.
An ack is accepted only for the **current session and latest intent**:
`session`, `id` and `enabled` must match, and `gen` increases within that
session only. Never compare generations across helper restarts. An old enable
ack cannot clear a newer pending disable. Missing ack, EOF, stream failure or
generation exhaustion keeps titles closed and requires rebuilding the helper
and repeating this handshake; never infer that a missing ack means success.

```text
host:  id = unique(); discardTitles = true        // strip recursively NOW
       send {"cmd":"titles","enabled":false,"id":id}
host:  strip title keys from every subsequent event until the matching ack
host:  on titles.ack where ack.session == currentSession &&
           ack.id == latestIntent.id && ack.enabled == false &&
           latestIntent.enabled == false:
           barrier closed - no title may arrive until an explicit true;
           record ack.gen (privacy gens are monotonically increasing)
host:  titles:true takes helper-side effect at once, but the host must not
       render titles until the matching enabled:true ack is received
```

On the helper side, a delivered `titles` command:

1. synchronously bumps the privacy generation and flips `titlesEnabled` in the
   session (so in-flight AX title reads are invalidated),
2. flips the central encoder: every nested `title` key is removed recursively
   from all later events,
3. purges queued output: title entries are atomic, so only whole unstarted
   records can exist - noncritical title lines are dropped entirely and an
   unstarted critical title-bearing record such as `snapshot` is re-encoded
   with every `title` key stripped rather than dropped,
4. enqueues the critical `titles.ack`.

Every parsed `titles` before quit gets its own ack and generation, including
redundant ones and consecutive controls in a single write; none is superseded.

Residual risk, explicitly: a COMPLETE title line already accepted into the
kernel buffer before the toggle cannot be recalled. That is the only possible
residual: because title lines write atomically there is never a partial line
to complete, so no truncated title or title suffix can ever follow the ack.

- `titles:true` resets title dedup and re-reads through the normal 250ms
  debounce. While titles are off the helper does not read `AXTitle`.
- After each AXTitle result, the AX queue bounds the source to 2048 Unicode
  scalars, discards a possibly partial final grapheme, then limits to 1024
  Characters before events/encoding; even one giant grapheme stays bounded.
  AX may itself allocate the source.
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
