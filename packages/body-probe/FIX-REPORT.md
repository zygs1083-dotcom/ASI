# Body Probe Review Fix Round 1

- Baseline: `5635ae3`; changes confined to `packages/body-probe/**`.
- Fixed interface identity/reset/rate cap: `reports unknown on a corrupt delta (link %s, rx %i) and recovers`; counters already exceed the old same-name interface.
- Memory formula/cached implemented as adjudicated; `computes used/cached from vm_stat at page size %i` (4K/16K), plus purgeable clamp; Activity Monitor alignment remains partial (measurements below).
- Fixed failed-command sibling cleanup: `waits for slow siblings before mapping a fast failure`.
- Fixed abort/exit/hung/restart: `stop() aborts a real child command and returns only after it exits`, `stop() resolves despite a hung collector and tokenSource, leaving no timers`, `restarts immediately without waiting for a still-pending previous sample`.
- Fixed listener generation: `cuts off stale dispatch when a listener %ss mid-tick` (stop/restart).
- Fixed online: address predicate IPv4/global IPv6 cases, `maps the route probe to online/status %#`, and 30s success/unknown route-cache tests; no external probe.
- Fixed sampling cost: battery/swap 30s, pressure cache 5s after the first all-process smoke exceeded 1%; cache boundary/TTL/observedAt tests cover these.
- Validation: `pnpm install --ignore-workspace` and final `pnpm typecheck` exit 0; final `pnpm test`: 9 files, 162 tests pass (baseline 127); `pnpm check` also passed before the final narrowly tested changes.
- RED evidence: original regressions failed (32 failures); queued-abort regression separately timed out on old code before its fix.
- First 60s smoke (pressure every tick): 60.10s real, 0.39s user + 0.29s sys = 1.131% total CPU, exit 1.
- Final 60s smoke (pressure cache 5s): 60.09s real, 0.33s user + 0.26s sys = 0.982% total CPU, 30 samples, exit 0; includes waited-for child commands and worker startup/shutdown.
- End-of-smoke memory: probe used/cached 52.73/9.13 GiB; adjacent Activity Monitor used/cached 53.27/9.14 GB (UI units); `top` reports 61G used, 1744M unused.
- Three concurrent sampler/UI comparisons then found used deltas of +0.922/+0.902/+0.975 GiB (UI minus probe); cached agrees to UI precision. The UI refreshes independently, but the residual cause is not established; exact Activity Monitor equivalence is NOT claimed.
- `top` includes cached/kernel accounting and coarse rounding, so its PhysMem used is not the chosen App+wired+compressed metric; no formula was changed beyond the coordinator's decision.
- Package TS exports, different-argument concurrency, cross-platform Node metrics and lockfile policy intentionally unchanged; no model/balance requests or permanent processes started.
- Size is 982 added/deleted lines, exceeding the 600-line target: lifecycle/command ownership plus the required regression matrix were retained rather than dropping coverage.
