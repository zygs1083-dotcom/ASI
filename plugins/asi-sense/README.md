# asi-sense (M1 core)

Pure-TypeScript local core: fact store, attention pipeline, body thresholds,
and deterministic environment-update formatting.

## Layout

- `src/host/state/`: `StateStore` (reentrancy-safe fact table) and the shared
  `sourceObservation` health normalization.
- `src/host/attention/`: rules, self-cause, merge buckets/drain and
  `FloorEvaluator`.
- `src/host/delivery/`: `formatEnvUpdate`, including the title privacy switch.
- `@asi/sense-types`: shared contracts, including the pure `BodyEvaluator` seam.

## Host contract

- **Async API**: `accept(signal, session)`, `flush(now?)` and
  `preStep(sessionId, now?)` return promises — always await them.
  `Deliverer.deliver(intent)` also returns a promise that is awaited before
  any bucket is dropped; the wake budget is charged on a fresh monotonic
  sample taken at delivery completion, not at drain start.
- **Durable intake**: `accept` completes all intake (session refresh, clone,
  classify, store apply, dedup/match/enqueue) synchronously before its first
  await, so the signal is already durable in memory even when the returned
  promise rejects on delivery. To retry a failed delivery call `flush`/
  `preStep` again — never re-`accept` the same signal.
- **Independent failures**: every eligible bucket (of every session) is
  attempted; a rejection retains its bucket uncharged and never prevents the
  others from delivering. Errors propagate only after all attempts (single
  error rethrown, several combined as `AggregateError`). Delivery intents are
  deep-cloned before reaching the adapter.
- **Serialization**: drain work inside `accept`/`flush`/`preStep` runs on a
  promise tail, so concurrent calls can never duplicate or lose a delivery.
- **Clocks**: `clock` is injected _monotonic_ time (default
  `performance.now`) used for merge deadlines, the wake sliding window and
  the min wake gap; `wallClock` (default `Date.now`) is used only for rule
  expiry and the `EnvUpdate.at` display timestamp. `Signal.at` and
  `ToolWindow` bounds remain event wall timestamps.
- **Merge windows**: buckets group by session+subject, hold a half-open
  `[start, start+window)` receipt interval fixed by the _first_ signal's kind
  (5s for `file.changed`, else 2s), and keep one merged detail per signal
  kind — one delivery carries every kind's change. At `preStep` the session's
  pending context groups close early and inject; wake groups still wait for
  their own deadline.
- **Self-cause**: a causal-kind signal inside a tool window's inclusive
  bounds is agent-caused when its `pid`, `ppid` or any `ancestors` entry
  equals `window.pid` (the shell pid — children and grandchildren match), or
  when its path lies under `window.cwd`.
- **Rules**: `validateRule(input)` returns violations (`[]` = valid);
  constructor rules and `addRule` throw `TypeError` on invalid input and
  store defensive clones; `addRule` upserts by id; `removeRule(id)` returns
  whether a rule was removed. `matchesRule` fails closed and never throws.

## M1 boundaries

No persistence, watchers, helpers, DSH/Cordis integration or model requests.
Rate/anomaly/burst/tuning contracts are types only; data stays local.

## Requirements

Node `^22.12.0 || ^24.0.0 || >=26.0.0` (declared in every package; developed
on 26; ES2022 runtime). `pnpm check`: typecheck + lint + tests;
`pnpm test:coverage`: attention lines >=90%.

## M1 review findings → regression tests

1. Durable intake before awaited drain; independent cross-session attempts —
   `accept queues new signals before cross-session delivery failures and recovers`
2. Self-cause via shell pid ancestry (pid/ppid/ancestors) and cwd —
   `classifies shell children and grandchildren across concurrent tool windows`
3. Monotonic `clock` vs `wallClock` separation —
   `wall-clock jumps do not change monotonic merge deadlines or wake budget`
4. `validateRule` export, fail-closed `where`, boundary `TypeError`s —
   `invalid where values fail closed and are rejected at rule boundaries`
5. Session+subject buckets, per-kind details, half-open generations —
   `merges different kinds by subject without double charging`;
   `starts a new half-open generation exactly at the deadline, retained failure included`;
   `counts suppressed groups, not wake-budget details, in update.suppressed`
6. Early context close at `preStep`, open wake stays pending —
   `preStep closes context early without injecting an open wake bucket`
7. Independent jobs, exit tombstones, stale/tie ordering —
   `tracks interleaved jobs independently and retains exit tombstones`;
   `seeds tracking from fact.updated replacements and clears on null`
8. Serialized/awaited delivery; budget charged at completion —
   `serializes concurrent flush and preStep drains without duplicate or lost delivery`;
   `awaits rejected wake delivery without charging or losing the bucket`;
   `awaits rejected context delivery and retries only the retained batch`;
   `charges the wake budget at delivery completion, not drain start`
9. Source mark on any nonduplicate signal; recovery before second denied —
   `ordinary successful signals recover source status before a second denied`
10. Context threshold reads `contextUsed` only —
    `uses actual context usage and ignores projected usage for thresholds`
11. Reentrant `apply` queueing, per-listener snapshot clones, error isolation —
    `serializes reentrant subscriber snapshots and isolates listener errors`
12. Exact Node engines in all three manifests —
    `declares supported Node engines in every package`
