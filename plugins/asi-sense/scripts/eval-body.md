# Body Adaptive Repair Evidence

Scope: body detectors, their tests, optional `monotonicAt` type field, evaluation and README only; M1 attention/state is unchanged.
This is implementation verification, not an independent review.

- `pnpm install --frozen-lockfile && pnpm check`: exit 0; body-probe **206**, sense-ui Chromium **192**, asi-sense **232** tests (previously 178), total **630**.
- The full-gate body suite has **104** tests; after adding the forward-jump regression, the complete asi-sense package passes **233** tests.
- Full-check and follow-up scoped lint have no errors and 33 warnings: test non-null assertions and one optional-chain style warning.
- `pnpm --filter asi-sense exec tsx scripts/eval-body.ts`: exit 0; captured stdout is transcribed below, not recalculated for this report.
- Both evaluation TypeScript files also pass a separate strict `tsc` check with Node types.
- Failed-first regressions also establish persisted-zone adoption, bad-clock snapshot rejection, and coalescing of slow in-flight saves.
- No model requests, host observations, watchers or production connections are used; test browsers/processes are closed, existing user Chrome is untouched.

## Review Findings To Regressions

Paths below are under `../test/body/`; long test titles may be given by unique prefix. Evaluation assertions are in `eval-body.ts`.

| # | Finding | Regression Test |
| ---: | --- | --- |
| 1 | Trusted identity, locks and restart | `tuner.test.ts`: `only the trusted user may lock/unlock; agents are audited and rejected`; `monitor-persist.test.ts`: `restores baseline, counters, locks and ID lineage in one snapshot` |
| 2 | Current-value floor tightening and direction specs | `tuner.test.ts`: `binds agent/auto to amplitude, direction, lock and budgets; user bypasses AI guards`; `tuner-contract.test.ts`: `rejects invalid floor specs at construction: %j`; `monitor.test.ts`: `uses effective floors without clamping a trusted user loosening to defaults` |
| 3 | User revert, agent guards and stale-ID conflict | `tuner-contract.test.ts`: `user can revert a tightened floor despite exhausted AI budget and lock`; `tuner.test.ts`: `lets the user revert a large change the agent could not`; `rejects stale reverts` (ABA) |
| 4 | Hourly, daily, global and auto budgets | `tuner-contract.test.ts`: `caps 10 to 11 to 10 loops continuously over 24 hours at six AI changes`; `tuner.test.ts`: `allows 2 changes/param/hour, 6/param/day, 24/day global`; `counts auto feedback changes as AI budget` |
| 5 | Monotonic windows and clock jumps | `rate.test.ts`: `measures windows on monotonic stamps, not chaotic wall times`; `tuner.test.ts`: `freezes AI when the wall clock is behind the saved high-water mark`; `never credits restart downtime: restored windows keep their remaining time`; `tuner-contract.test.ts`: `preserves the daily budget across restart despite a forward wall-clock jump`; `cannot serialize bad clocks into an empty persisted quota window` |
| 6 | Persistence lifecycle and corrupt restore | `monitor-persist.test.ts`: `restores baseline, counters, locks and ID lineage in one snapshot`; `coalesces tuner-only mutations to 10s saves and flushes on exit`; `coalesces slow in-flight saves instead of queueing back-to-back writes`; `tuner-contract.test.ts`: `corrupt restore cannot reset two used changes into a permitted third attempt` |
| 7 | Installation-age and per-bucket gates | `anomaly.test.ts`: `never fires at 8 hours even with an eligible bucket`; `never fires on a bucket with <8 samples`; `never fires on a single-date bucket even with` eight samples |
| 8 | Complete default composition | `default-rules.test.ts`: `cold-start defaults detect RSS 0 to 1GiB in one second`; `defaults detect disk loss, context ETA and external deletion without rule injection`; `rate.test.ts`: `includes the exact ten-minute context ETA boundary` |
| 9 | Caller-owned replay/interleaving/retry | `rate.test.ts`: `produces identical output for identical inputs (no hidden mutation)`; `isolates interleaved streams sharing one caller state`; `anomaly.test.ts`: `is pure`; `monitor-persist.test.ts`: `replays failed evaluator attempts from the same caller state without consuming samples` |
| 10 | Agent add/modify/delete and mixed bursts | `burst.test.ts`: `counts agent add/modify/delete separately; pure agent crossings never wake`; `wakes on mixed bursts using external counts only`; `default-rules.test.ts`: `three self-caused %s events remain record even with an approved wake rule` |
| 11 | Attention rules through actual M1 | `default-rules.test.ts`: `accept only intakes rate/anomaly warnings; preStep injects context`; `external deletion becomes approved wake only after flush` |
| 12 | Local buckets, DST and persisted zone | `baseline.test.ts`: repeated fall-back hour, skipped spring-forward hour and 09:00 tests; `monitor-persist.test.ts`: `adopts the persisted timezone when the restoring host gives no override` |
| 13 | Cross-directory out-of-order delivery | `burst.test.ts`: `counts each directory on its own watermark` (`/a@0 /b@2000 /a@10,20`, 1000ms window) |
| 14 | Undo survives rejected-request floods | `tuner.test.ts`: `keeps a revertable applied entry after a 500-reject flood, across reload` |
| 15 | Independent multi-seed/day/delivery evaluation | `eval-body.ts`: 3 seeds x cold/mature x all 7 days; actual defaultBodyRules + M1 pipeline; five classes and two-hour CPU no-drift assertions |

Additional regressions: `anomaly.test.ts` detects sustained .99 CPU on the third frame with scale .135 and excludes anomalous samples from learning for two hours across bucket boundaries; `baseline.test.ts` calibrates robust scale before judging high-variance buckets.

## Captured Evaluation Output

Offline synthetic fixtures only; no observed host data, filesystem watching, model or network requests.
Fixed xorshift32 seeds; independent workload generator never reads detector parameters.
Cold and mature cohorts each cover seven complete 24h receipt-time days, including cold day one.
Mature baselines come from a separate 14-day, 90s-cadence training capture, reused without retraining.
Weekly-hour buckets need two dates, so disturbance latencies use mature captures, not cold week one.
Both stable cohorts include stationary high-variance CPU/network/RSS, sub-threshold boundary jitter,
49/50 external deletes across watched subdirectories, 120 self-caused adds/modifies, missing facts,
four-minute outages, 35-53s jitter, two restarts, NY spring DST and +3h/rollback wall jumps.
False counts are alert entries (not recoveries/audits); delivered counts sum EnvChange.count,
after actual defaultBodyRules + M1 intake/preStep/flush, not payload delivery-level guesses.

| Seed (hex) | Cohort | Day | Detector False | Delivery False |
| --- | --- | ---: | ---: | ---: |
| 415349 | cold | 1 | 0 | 0 |
| 415349 | cold | 2 | 0 | 0 |
| 415349 | cold | 3 | 0 | 0 |
| 415349 | cold | 4 | 0 | 0 |
| 415349 | cold | 5 | 0 | 0 |
| 415349 | cold | 6 | 0 | 0 |
| 415349 | cold | 7 | 0 | 0 |
| 415349 | mature | 1 | 0 | 0 |
| 415349 | mature | 2 | 0 | 0 |
| 415349 | mature | 3 | 0 | 0 |
| 415349 | mature | 4 | 0 | 0 |
| 415349 | mature | 5 | 0 | 0 |
| 415349 | mature | 6 | 0 | 0 |
| 415349 | mature | 7 | 0 | 0 |
| 12345678 | cold | 1 | 0 | 0 |
| 12345678 | cold | 2 | 0 | 0 |
| 12345678 | cold | 3 | 0 | 0 |
| 12345678 | cold | 4 | 0 | 0 |
| 12345678 | cold | 5 | 0 | 0 |
| 12345678 | cold | 6 | 0 | 0 |
| 12345678 | cold | 7 | 0 | 0 |
| 12345678 | mature | 1 | 0 | 0 |
| 12345678 | mature | 2 | 0 | 0 |
| 12345678 | mature | 3 | 0 | 0 |
| 12345678 | mature | 4 | 0 | 0 |
| 12345678 | mature | 5 | 0 | 0 |
| 12345678 | mature | 6 | 0 | 0 |
| 12345678 | mature | 7 | 0 | 0 |
| 6d2b79f5 | cold | 1 | 0 | 0 |
| 6d2b79f5 | cold | 2 | 0 | 0 |
| 6d2b79f5 | cold | 3 | 0 | 0 |
| 6d2b79f5 | cold | 4 | 0 | 0 |
| 6d2b79f5 | cold | 5 | 0 | 0 |
| 6d2b79f5 | cold | 6 | 0 | 0 |
| 6d2b79f5 | cold | 7 | 0 | 0 |
| 6d2b79f5 | mature | 1 | 0 | 0 |
| 6d2b79f5 | mature | 2 | 0 | 0 |
| 6d2b79f5 | mature | 3 | 0 | 0 |
| 6d2b79f5 | mature | 4 | 0 | 0 |
| 6d2b79f5 | mature | 5 | 0 | 0 |
| 6d2b79f5 | mature | 6 | 0 | 0 |
| 6d2b79f5 | mature | 7 | 0 | 0 |

| Seed (hex) | Disturbance | Detector Delay (s) | Delivery Delay (s) |
| --- | --- | ---: | ---: |
| 415349 | disk drop | 69.590 | 69.590 |
| 415349 | RSS leak | 127.147 | 127.147 |
| 415349 | scattered deletion | 25.441 | 27.942 |
| 415349 | CPU anomaly | 99.218 | 99.218 |
| 415349 | context drain | 94.340 | 94.340 |
| 415349 | CPU sustained (2h) | 110.334 | 110.334 |
| 12345678 | disk drop | 166.491 | 166.491 |
| 12345678 | RSS leak | 195.089 | 195.089 |
| 12345678 | scattered deletion | 17.289 | 19.790 |
| 12345678 | CPU anomaly | 86.016 | 86.016 |
| 12345678 | context drain | 120.032 | 120.032 |
| 12345678 | CPU sustained (2h) | 112.781 | 112.781 |
| 6d2b79f5 | disk drop | 44.615 | 44.615 |
| 6d2b79f5 | RSS leak | 266.004 | 266.004 |
| 6d2b79f5 | scattered deletion | 5.792 | 8.293 |
| 6d2b79f5 | CPU anomaly | 106.761 | 106.761 |
| 6d2b79f5 | context drain | 96.105 | 96.105 |
| 6d2b79f5 | CPU sustained (2h) | 105.027 | 105.027 |

PASS: 3 seeds x 2 cohorts x 7 daily detector/delivery assertions; five classes detected and delivered.
Additional two-hour sustained CPU scenario: >=100 valid samples/seed, every before/after baseline identical.

Limits: bounded synthetic workloads, not arbitrary real workloads; 14-day training is not scored.
Clock fixtures start 2026-03-06T05:00:00.000Z; each measured cohort spans 168h.
Disk writes persist eight minutes, outlasting four-minute outages; an unobserved short drop cannot establish a one-minute rate.
M3 atomic storage/sidebar installation remains host integration, outside this repair's permitted scope.
