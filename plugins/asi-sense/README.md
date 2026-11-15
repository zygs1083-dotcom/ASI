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
  `preStep(sessionId, now?)` return promises — always await them. `accept`
  is pure intake — it never drains or awaits delivery.
  `Deliverer.deliver(intent)` also returns a promise that is awaited before
  any bucket is dropped; the wake budget is charged on a fresh monotonic
  sample taken at delivery completion, not at drain start. While a `deliver`
  is **in flight**, every `flush`/`preStep` call inside its async
  context rejects immediately with `ReentrantDeliveryError` — awaited or
  not — so return or reject from `deliver` instead. The token is
  per-delivery: work scheduled inside `deliver` (a `setImmediate` callback,
  a detached promise) inherits the context but calls pipeline APIs freely
  after its wrapper continuation: between promise settlement and that
  continuation, microtask `flush`/`preStep` MAY still reject. Use
  `setImmediate`, not `queueMicrotask`, or avoid drains inside `deliver`.
  Concurrent callers _outside_ `deliver` queue normally.
- **Scheduling**: no core timers — the host MUST schedule its flush timer
  from monotonic `nextDeadline()` (earliest pending merge deadline,
  retained failures included) and refresh it after `accept`/drains;
  `undefined` means none — ready context/failed inject need `preStep`, a
  past deadline is host-owned retry/backoff.
- **Durable intake**: `accept` runs all mutable intake (session refresh,
  source marks, dedup/match/enqueue) inside the store's
  apply callback — shared synchronous FIFO, so the signal is durable before
  the promise resolves. Exception: an
  `accept` issued **reentrantly** from a subscriber or apply callback is
  queued until the outer intake finishes. To retry a failed delivery call
  `flush`/`preStep` again — never re-`accept` the same signal.
- **Retry entries**:

  | failed delivery          | retry via                                                             |
  | ------------------------ | --------------------------------------------------------------------- |
  | wake (`send`/`followup`) | `flush()` or any `preStep`                                            |
  | context `inject`         | `preStep` of the **same session** only — `flush` never retries inject |

- **At-least-once + `deliveryId`**: a rejection may already have committed
  externally, so the host dedups deliveries by `deliveryId` — a stable
  SHA-256 over `sessionId` + the sorted original signal ids. A retry always
  carries the same underlying signal set, `deliveryId` and `EnvUpdate.at`
  (frozen at the first attempt), but routing and effective level are
  re-evaluated: busy/user flags may switch `send`/`followup`, and a wake
  that loses its budget check on retry ships as a separate `inject` keeping
  its original `at`/`deliveryId` — across buckets there is **no FIFO** (e.g.
  `followup(new)` then `inject(old)`). Only frozen inject batches retry
  verbatim; fresh context always ships as its own batch.
- **Independent failures**: every eligible bucket (of every session) is
  attempted — detached and sealed before its awaited delivery, so in-flight
  arrivals never join an attempted bucket; a rejection retains it uncharged
  and never prevents the others. Original rejection objects propagate after
  all attempts — a single one (even an empty `AggregateError`) rethrown by
  identity, several combined as `AggregateError` without flattening.
  Delivery intents are deep-cloned before reaching the adapter.
- **Serialization**: drain work inside `flush`/`preStep` runs on a
  promise tail, so concurrent calls can never duplicate or lose a delivery.
- **Clocks**: `clock` is injected _monotonic_ time (default
  `performance.now`) used for merge deadlines, the wake sliding window and
  the min wake gap; `wallClock` (default `Date.now`) is used only for rule
  expiry and the `EnvUpdate.at` display timestamp. `Signal.at` and
  `ToolWindow` bounds remain event wall timestamps. An explicit `flush`/
  `preStep` `now` must be a timestamp of that same monotonic clock — never
  `Date.now` (a future cutoff is clamped, a non-finite one is a
  `TypeError`); omit it normally.
- **Merge windows**: buckets group by session+subject, hold a half-open
  `[start, start+window)` receipt interval fixed by the _first_ signal's kind
  (5s for `file.changed`, else 2s), and keep one merged detail per
  **(kind, effective level)** pair — one delivery carries every pair's
  change, so a context and a wake `job.exited` on the same subject never
  collapse into a single count. At `preStep` the session's context
  ships first: pure context groups close early and inject, context details
  _split out_ of still-open mixed buckets inject too, and the wake remainder
  keeps its deadline — its later update reports `alreadyInjected`
  (`另有 N 条已在上一步注入`) instead of repeating them. An attempted mixed
  bucket is sealed: it retries whole, never split.
- **Job tracking**: `StateStore(wallClock?, defaultTtlMs?, monotonicClock?)` — exit
  tombstones use the injected _monotonic_ clock over the half-open
  `[receivedAt, receivedAt+600s)` window while fact TTL keeps the wall clock.
  `env.activeJobs` reports order on a single `jobsFactAt` watermark — EVERY
  accepted `fact.updated` for the path advances it, `unknown` included —
  and a report older than it is dropped before touching fact, tracking or
  tombstones. Job events are no watermark: a report older than individual
  job events still merges per job id — a newer tombstone or running event
  wins, the value rebuilds from merged tracking, and `null` clears only
  when no newer running job survives. A non-unknown report also advances
  `jobSnapshotAt`, below which `job.started` is ignored. An `unknown`
  report marks **only** the status — value, provenance, freshness, jobs
  and tombstones preserved — yet still moves `jobsFactAt`. A start arriving
  after its tombstone prunes is an ordinary new event — still subject to
  the watermark and signal-id dedup.
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

## M1 re-review findings → regression tests

In `m1-rereview-regressions.test.ts` unless noted:

1. Raw rejection objects (empty `AggregateError` by identity; unflattened combinations) — `rethrows an empty AggregateError by identity instead of swallowing it` / `combines independent raw failures without flattening adapter AggregateErrors`
2. Reentrant `accept` shares the store FIFO — `delivers the first denied before a nested accept marks recovery` / `merges a nested same-subject signal into the outer bucket window` / `queues a pipeline accept triggered from a store.apply subscriber`
3. `env.activeJobs` replacement watermark + retained exit tombstones — `blocks pre-snapshot starts for replaced and unknown ids but accepts independent late jobs`
4. Mixed-bucket context split + `alreadyInjected` — `injects split context at preStep while the wake keeps its deadline and count`
5. Monotonic tombstones, half-open `[receivedAt, +600s)` — `ignores wall-clock jumps and prunes exit tombstones at exactly 600s monotonic`
6. Sealed in-flight buckets; monotonic cutoff clamp — `clamps future cutoffs, rejects non-finite ones and keeps same-subject arrivals in a fresh bucket`
7. `ReentrantDeliveryError` inside `deliver` — `rejects drains awaited inside adapter.deliver while accept stays durable`
8. Stable `deliveryId`/frozen `at`; frozen inject batches; once-per-step, non-FIFO downgrade retries; mutation isolation — `retries a failed wake with the same deliveryId and frozen display time` / `downgrades a failed wake retry to a separate frozen inject once the budget moved` / `injects a same-step budget downgrade once and propagates inject failure` / `isolates adapter mutations of a delivered intent from the retained retry` / `awaits rejected context delivery and retries only the retained batch` (m1-pipeline, updated)
9. Retry entries, at-least-once dedup, downgrade/no-FIFO, adapter reentrancy — **Host contract** above; exercised by the fix-8 tests (the updated pipeline test proves `flush` never retries inject; the downgrade tests prove once-per-step attempts and `followup(new)`-then-`inject(old)` ordering)

## M1 fix-3 regressions → tests

In `m1-fix3-regressions.test.ts`:

1. `env.activeJobs` snapshot ordering independent of `fact.status`; `unknown` reports change status only — `keeps job tombstones when unknown is followed by an older snapshot` / `keeps the newest watermark across three out-of-order snapshots` / `accepts constructor-delayed snapshots but rejects reports older than explicit unknown` (semantics refined by M1 fix-4 below)
2. Bucket details keyed by (kind, effective level) — `injects same-kind context before the wake deadline (success first)` / `injects same-kind context before the wake deadline (failure first)` / `keeps same-kind outcome counts separate without a preStep split`
3. Per-delivery active token for `ReentrantDeliveryError` — `allows inherited setImmediate intake after delivery resolved` / `allows inherited setImmediate intake after delivery rejected` (also queueMicrotask intake)

## M1 fix-4 regressions → tests

1. Blocker: `started@1 → exited@30 → unknown@40 → snapshot@35`, and `snapshot@30 → unknown@40 → snapshot@35` — `keeps job tombstones when unknown is followed by an older snapshot` / `keeps the newest watermark across three out-of-order snapshots` (m1-fix3); `jobsFactAt` orders all explicit statuses while snapshots merge newer per-job events.
2. Blocker: `queueMicrotask(() => accept())` before a resolved/rejected adapter promise's continuation — `allows inherited setImmediate intake after delivery %s` (m1-fix3, also asserts microtask intake for both outcomes); `rejects drains awaited inside adapter.deliver while accept stays durable` (m1-rereview) guards the remaining drain rejection.

## M3 待定契约

1. 去重范围：`send` / `followup` / `inject` 是否共享同一 `deliveryId` 去重记录，跨 session 的边界是什么？
2. 未知提交时的保留期：DSH 可能已提交但确认丢失时，未确认的 `deliveryId` 和待重试消息应保留多久，何时重试或释放？
3. DSH 是否支持原子提交的幂等键？仅靠本地 ID 集合无法同时消除提交前记账导致的丢失和提交后记账导致的重复；当前只能承诺 at-least-once，不能保证 exactly-once。
