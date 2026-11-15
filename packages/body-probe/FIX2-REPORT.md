# Body Probe Review Fix Round 2

- Baseline `e326c5d`; changes confined to `packages/body-probe/**`.
- 1 CPU/cadence: `probe.test.ts` / `samples %s on the first tick at/after its %ims period`; CPU/process/chart ticks stay 2s, memory/network/pressure 5s, disks 10s, swap/route/battery 30s (slow polls round up to a tick).
- 2 TTL: `memory.test.ts` / `composes observedAt/ttlMs from the oldest constituent, ties take the smallest period`; `network.test.ts` / `composes observedAt/ttlMs from the oldest constituent (rate vs route)`; `probe.test.ts` / `marks real composite facts stale after stop; stored history stays ok` and cached-republish regression.
- 3 IPv6: `network.test.ts` / `queries only the -inet6 route for IPv6-only interfaces` and `pairs route verdicts with their own family %#` (both mismatched directions and dual-stack partial failure).
- 4 Route errors: `network.test.ts` / `maps the route probe to online/status %#` and `caches a %s route verdict 30s but never unknown`; only recognizable no-route diagnostics mean offline.
- 5 Smoke progress: `smoke.test.ts` / `requires at least 90% of expected samples` and `rejects a run without an ok %s fact` (each required collector); worker exits 1 for failed progress independently of CPU.
- 6 Cancellation/disks: `probe.test.ts` / `does not invoke later collectors once an earlier one stops the tick` and `a never-settling disk %s survives 8 stop/starts; new generations publish stale` (stat/statfs); `disks.test.ts` also covers late completion and stale last-success reuse.
- `pnpm install --ignore-workspace` exited 0; `pnpm check` (= `pnpm typecheck && pnpm test`) exited 0: 10 files, 192/192 tests passed (baseline 162).
- Smoke 1: real 60.08s, user 0.23s + sys 0.13s => 0.599201% CPU; 30/30 samples; exit 0.
- Smoke 2: real 60.11s, user 0.21s + sys 0.12s => 0.548994% CPU; 30/30 samples; exit 0.
- Smoke 3: real 60.11s, user 0.21s + sys 0.11s => 0.532357% CPU; 30/30 samples; exit 0.
- All three runs include startup/shutdown and waited-for child CPU, have cpu/memory/disks/network `ok`, and pass <=0.6%; run 1 remains close to the tightened limit.
- Child-accounting positive control: child busy-loop, parent CPU 0.977ms vs `/usr/bin/time` 0.34s user + 0.02s sys (0.37s real).
- Evidence: `/tmp/bpfix2/final-check.log`, `/tmp/body-probe-fix2-smoke-{1,2,3}.log`, `/tmp/body-probe-fix2-metrics.json`, `/tmp/body-probe-fix2-time-control.log`; RED logs retained under `/tmp/bpfix2/` and `/tmp/body-probe-fix2-smoke-red.log`.
- Limitations: diff is 841 additions + 110 deletions = 951 lines, exceeding the <=500-line target to retain the regression matrix; disks conservatively mark the aggregate stale while a scan remains in flight (stricter than a per-mount bound).
- No model/balance requests, secrets/prod access, browsers, or task-owned background processes remain.
