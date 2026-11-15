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
`ttlMs`). `status` is `ok`, `unknown` (first delta sample / rebase),
`unavailable` (command, parser or platform failure), `denied` (EACCES/EPERM)
or `stale` (computed by `latest()` once `age > ttlMs`; stored history is
never re-marked). Sampled facts get `ttlMs = 3 * intervalMs`.

Units: ratios are 0..1 fractions (process CPU is unclamped, may exceed 1),
sizes are bytes, network rates are B/s, `minutesLeft`/`uptimeSec` are minutes
and seconds. `disks.mount` is the queried path (`/` or resolved cwd; statfs
reports no mountpoint name). `thermal` is a placeholder `unavailable` — real
data is owned by the asi-sense helper. `tokens` is `unavailable` without an
injected `TokenSource`. macOS collectors run no commands on other platforms.
Commands are coalesced and bounded (1s, SIGKILL, 4 MB, LC_ALL=C).

`deepseekBalance(fetchFn, baseUrl)` reads `GET <baseUrl>/user/balance` through
a caller-supplied authenticated fetch wrapper (this package never touches
credentials), bounded at 1s, TTL 10min, first `balance_infos` entry.

## Commands

```sh
pnpm install --ignore-workspace
pnpm typecheck && pnpm test && pnpm check
pnpm smoke   # 60s real-machine run; exits nonzero if probe >= 1% own CPU
```

The smoke CPU figure covers the probe's own Node process only; CPU spent in
spawned child commands (`vm_stat`, `sysctl`, `pmset`, `netstat`) is excluded.

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
