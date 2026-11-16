# @asi/body-probe

Periodic sampler for the "body vitals" facts in `docs/DESIGN.md` §2.2b, used
by `asi-sense` to fill `self.body`. Fact/disk contract types come from
`@asi/sense-types` (`workspace:*`) and are re-exported from
`src/types.ts` — consumers may import `Fact`, `FactStatus`, `SourceRef`,
`DiskVolume`, `DisksFact` and `Body` from either package; only the UI- or
probe-local extensions (e.g. memory `cached`) are declared here.

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
fact's `unavailableMounts`. The shared optional `status` field accepts any
`FactStatus`, including availability failures from other producers.
`thermal` is a placeholder `unavailable` — real
data is owned by the asi-sense helper. `tokens` is `unavailable` without an
injected `TokenSource`.

Formulas: `memory.used = (max(0, anonymous - purgeable) + wired + compressor-occupied) * pageSize`,
`memory.cached = (file-backed + purgeable) * pageSize` (vm_stat fields).
Simultaneously-due pressure and swap reads share one `sysctl -n <keys>` process,
each keeping its own cache period.

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
`observedAt` of its primary value — the vm read for memory, the rate sample
for network — so trend points and "last updated" reflect when that value was
actually sampled. It still expires at the earliest absolute constituent
deadline (`ttlMs = max(0, min(at + 3*periodMs) - primary.at)`, counting cached
pressure/swap and the needed families' route observations), so a stale cache
shortens freshness rather than backdating the value.

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

The returned `DisksFact` aggregates per-volume state without letting one bad
mount veto the rest: except for parent `denied`/`unsupported`, the parent
`status` is `ok` when at least one volume is fresh, `stale` when none is
fresh but at least one is stale, and `unknown` when neither is present
(including mixed unavailable/unknown records). Parent `observedAt`/`ttlMs`
are computed over **fresh volumes only** (oldest fresh `observedAt`, earliest fresh
absolute expiry — matching the shared `DisksFact` contract in
`@asi/sense-types`); with no fresh volumes they use stale volumes only, and
with neither fresh nor stale volumes they retain the parent metadata.
Per-volume `status`/`observedAt`/`ttlMs` are authoritative for that
mount; volumes that never declared metadata inherit the parent's effective
status. `unavailableMounts` always wins over a same-named record in `value`.
`latest()` re-aggregates the disk parent between publications using the
remaining monotonic deadlines; TTL expires at the deadline itself. After a
wall-clock jump, its returned disk TTLs express those deadlines against the
current wall clock while retaining the original observation timestamps.
`DisksFact` carries `kind: 'disks'`; use `disksStatusAt(disks, now)` for
its aggregate status or `effectiveDisks(disks, now)` for per-volume
freshness. A `null` or empty value is `unknown` for `ok`, `stale`,
`unavailable`, and `unknown`; `denied` and `unsupported` retain their
status so consumers can guide authorization or explain missing support.

```ts
import { disksStatusAt, effectiveDisks } from '@asi/sense-types';
const status = disksStatusAt(body.disks, now);
const volumes = effectiveDisks(body.disks, now).value;
```

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
pnpm install                              # at the workspace root (links @asi/sense-types)
cd packages/body-probe
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

A root `pnpm-workspace.yaml` now exists and this package consumes
`@asi/sense-types` via `workspace:*`. esbuild's install script is approved at
the root (`allowBuilds: esbuild: true`); the child `package.json` still pins
`packageManager: "pnpm@10.24.0"` and `pnpm.onlyBuiltDependencies` from the
standalone era — safe to drop alongside `.npmrc` once the coordinator
confirms nothing else needs the pin.

The local `.npmrc` contains only `manage-package-manager-versions=true` so
the `packageManager` pin is honored even where the machine's global pnpm
config disables package-manager auto-switching (this MacPro does); it is a
transient override to delete alongside the pin.
