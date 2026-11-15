# @asi/body-probe

Periodic sampler for the "body vitals" facts in `docs/DESIGN.md` §2.2b, used
by `asi-sense` to fill `self.body`.

```ts
import { BodyProbe } from '@asi/body-probe';

const probe = new BodyProbe();
const off = probe.onSample((body) => { /* render gauges */ });
probe.start({ intervalMs: 2000 });          // immediate tick, then every 2s
probe.latest();                             // freshest Body | null (stale-marked)
probe.history(120);                         // chronological { at, body }[], <= 300s
await probe.stop();                         // cancels cadence, bounded wait
off();
```

## Facts

Every field is a `Fact<T>` (`value`, `status`, `source`, `observedAt`,
`ttlMs`). `status` is `ok`, `unknown` (first delta sample / rebase / a
reading that cannot be determined), `unavailable` (command, parser or
platform failure), `denied` (EACCES/EPERM) or `stale` (computed by `latest()`
once `age > ttlMs`; stored history is never re-marked). Sampled facts get
`ttlMs = 3 * intervalMs` unless noted below.

Units: ratios are 0..1 fractions (process CPU is unclamped, may exceed 1),
sizes are bytes, network rates are B/s, `minutesLeft`/`uptimeSec` are minutes
and seconds. `disks.mount` is the queried path (`/` or resolved cwd; statfs
reports no mountpoint name). `thermal` is a placeholder `unavailable` — real
data is owned by the asi-sense helper. `tokens` is `unavailable` without an
injected `TokenSource`.

Formulas: `memory.used = (max(0, anonymous - purgeable) + wired + compressor-occupied) * pageSize`,
`memory.cached = (file-backed + purgeable) * pageSize` (vm_stat fields).

Cadence: `memory.swapUsed` re-runs `sysctl vm.swapusage` at most every 30s and
`pressure` at most every 5s, so those values may lag; `used`/`cached` refresh
every tick. `battery` samples `pmset` at most
every 30s with `ttlMs = max(90s, 3*intervalMs)` and republishes the cached
fact's original `observedAt` (cache resets on `start()`); `network.online`
caches its `/sbin/route -n get default` verdict — including `unknown` — for
30s. Network deltas key on interface name + `<Link#N>` identity; a same-name
replacement, counter drop, or rate >10 Gbit/s rebases to `unknown`. No
external probes are ever made.

Cancellation: each tick runs under an `AbortSignal` forwarded to collectors
and commands (commands bounded 1s, SIGKILL, 4 MB, LC_ALL=C, no shell; identical
commands coalesce only within one signal). `stop()` aborts the tick and awaits
only that tick's commands, so a hung collector cannot delay it; aborted ticks
never publish or touch baselines, and `start()` ticks immediately.

Platforms: cpu/disks/harnessProcess are Node-based and may report `ok` on any
platform; memory/network/battery are macOS-only; external pids use `/bin/ps`
where available; `tokens` is caller-supplied.

`deepseekBalance(fetchFn, baseUrl)` reads `GET <baseUrl>/user/balance` through
a caller-supplied authenticated fetch wrapper (this package never touches
credentials), bounded at 1s, TTL 10min, first `balance_infos` entry.

## Commands

```sh
pnpm install --ignore-workspace
pnpm typecheck && pnpm test && pnpm check
pnpm smoke   # 60s run; exits nonzero if total CPU (including children) >= 1%
```

The smoke wraps its sampler worker in `/usr/bin/time -l node --import tsx ...`
and reports `totalCpuPct = 100 * (user + sys) / real`, including waited-for
child commands and worker startup/shutdown, not just parent Node CPU.
Memory output uses GiB (2^30 bytes); Activity Monitor labels these units GB.

## Packaging (transitional)

Until a root `pnpm-workspace.yaml` exists, the package pins
`packageManager: "pnpm@10.24.0"` (auto-downloaded into the pnpm cache, not a
global install) and approves esbuild's install script via
`pnpm.onlyBuiltDependencies` in `package.json`. On merge the coordinator
removes the child `packageManager` pin and moves build approval to the root
workspace file.

The local `.npmrc` contains only `manage-package-manager-versions=true` so
the `packageManager` pin is honored even where the machine's global pnpm
config disables package-manager auto-switching (this MacPro does); it is a
transient override to delete alongside the pin.
