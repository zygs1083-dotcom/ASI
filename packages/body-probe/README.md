# @asi/body-probe

Periodic sampler for the "body vitals" facts in `docs/DESIGN.md` §2.2b, used
by `asi-sense` to fill `self.body`.

```ts
import { BodyProbe } from '@asi/body-probe';

const probe = new BodyProbe();          // optional: (collectors, { now, wall, platform })
const off = probe.onSample((body) => { /* render gauges */ });
probe.start({ intervalMs: 2000 });          // immediate tick, then every 2s
// probe.start({ intervalMs: 2000, cadence: { memoryMs: 10_000 } }); // cadence override
probe.latest();                             // freshest Body | null (stale-marked)
probe.history(120);                         // chronological { at, body }[], <= 300s
await probe.stop();                         // cancels cadence, bounded wait
off();
```

## Facts

Every field is a `Fact<T>` (`value`, `status`, `source`, `observedAt`,
`ttlMs`, optional `unavailableMounts`). `status` is `ok`, `unknown` (first
delta sample / rebase / a reading that cannot be determined), `unavailable`
(command, parser or platform failure), `denied` (EACCES/EPERM) or `stale`
(computed by `latest()`/cached republish from a monotonic deadline fixed at
ingestion — wall-clock moves cannot freeze or revive a fact; stored history
is never re-marked). `cpu`/`harnessProcess`/`thermal` get
`ttlMs = 3 * intervalMs`; `tokens` keeps the injected fact's own ttl; the
slower collectors get `ttlMs = 3 * effective period` (below).

Units: ratios are 0..1 fractions (process CPU is unclamped, may exceed 1),
sizes are bytes, network rates are B/s, `minutesLeft`/`uptimeSec` are minutes
and seconds. `disks.mount` is the queried path (`/` or resolved cwd; statfs
reports no mountpoint name). Each disk volume also carries optional
`status: 'ok' | 'stale'`, `observedAt` and `ttlMs`; volumes that never
succeeded are omitted from `value` (no fabricated numbers) and listed in the
fact's `unavailableMounts`. `thermal` is a placeholder `unavailable` — real
data is owned by the asi-sense helper. `tokens` is `unavailable` without an
injected `TokenSource`.

Formulas: `memory.used = (max(0, anonymous - purgeable) + wired + compressor-occupied) * pageSize`,
`memory.cached = (file-backed + purgeable) * pageSize` (vm_stat fields).

Cadence: `start({ cadence })` accepts a `Partial<SamplingCadence>`
(`memoryMs`, `networkMs`, `disksMs`, `batteryMs`, `pressureMs`, `swapMs`,
`routeMs` — defaults 5s/5s/10s/30s/5s/30s/30s). The effective period is
`max(intervalMs, configured)`; each slow collector runs on the first tick
at/after it (5s first fires on the ~6s tick at the default 2s interval) and
between runs the cached fact is republished as-is — scheduled on when the
collector returned, never on `observedAt`, stale-marked past its ttl. A child
can never poll faster than the parent that publishes it — the effective child
period is `max(configured child, effective parent, intervalMs)` for
pressure/swap (parent memoryMs) and route (parent networkMs). Outer caches
reset on `start()`/`stop()` (the inner swap/pressure/route and disk
generation state resets too) and cadence does not carry over. The
swap/pressure and route caches inside the samplers use the same periods,
clamped to at least `ttlMs / 3` under standalone use
(`sample(ttl, signal, periods)` overrides).

`memory` and `network` facts are composite: a fresh `ok` fact takes the
oldest constituent's `observedAt` and expires at the earliest absolute
constituent deadline — `ttlMs = min(observedAt + 3*periodMs) - observedAt`
(vm read vs cached pressure/swap; rate sample vs needed families' route
observations).

`network.online` runs `/sbin/route -n get -inet default` / `-inet6 default`
only for families with a usable address (non-internal IPv4 or global IPv6 in
2000::/3), and a route pairs only with its own family — v4 route + unrelated
v6 address is offline. A `not in table` diagnostic means known-offline;
success/offline verdicts cache for the route period; anything else is
`unknown` — never cached, retried next sample, and only makes the verdict
`unknown` when no family is proven online. With no usable addresses `online`
is `false` without a route probe. Deltas key on name + `<Link#N>`; a
same-name replacement, counter drop, or rate >10 Gbit/s rebases to
`unknown`. No external probes are ever made.

`disks` never blocks a tick: `DiskSampler.sample()` starts an independent
background job per queried path (`/` and the resolved cwd, deduplicated) and
returns the currently available per-volume state immediately. Each job has
its own ~3s `AbortController` timeout and an I/O lock that releases only
when the filesystem call really settles — never on timeout, abort or
`stop()` — so a wedged volume cannot pile up operations or stall the probe.
The caller's signal is forwarded into each job: timeout, abort, `stop()` or
rejected I/O all mark the volume failed, discard its late result (a late
`stat` never starts a `statfs`), and its last successful numbers show
`status: 'stale'` immediately — long before its own deadline — until the
next success clears the flag. Each reading keeps the `ttlMs`/deadline in
force when it was taken (a wider caller cadence never revives it); volumes
that never succeeded land in `unavailableMounts`. Jobs relaunch when their
per-volume period (`ttlMs/3`) elapses; equal `stat.dev` volumes dedup with
`/` winning. `DiskSampler.stop()` cancels timers/controllers without
releasing locks, and the BodyProbe default calls the sampler every tick
while it enforces `disksMs` internally (an injected `collectors.disks`
keeps the whole-group outer cache instead).
`collectDisks` remains the standalone sequential helper: it checks its
`AbortSignal` before every `stat`/`statfs`.

Cancellation: each tick runs under an `AbortSignal` forwarded to collectors
and commands (commands bounded 1s, SIGKILL, 4 MB, LC_ALL=C, no shell; identical
commands coalesce only within one signal), and checked before invoking each
collector — a synchronous earlier collector stopping the probe can never
start a later one. `stop()` aborts the tick and awaits only that tick's
commands, so a hung collector cannot delay it; aborted ticks never publish
or touch baselines, and `start()` ticks immediately.

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
pnpm smoke   # 60s; total CPU including children must be <= 0.6%
```

The smoke wraps its sampler worker in `/usr/bin/time -l node --import tsx ...`
and reports `totalCpuPct = 100 * (user + sys) / real`, including waited-for
child commands and worker startup/shutdown, not just parent Node CPU.
It also requires >=27 of the expected 30 samples (90%) and at least one `ok`
fact each for cpu/memory/disks/network; missing progress exits 1 even at low CPU.
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
