# asi-sense P0 spike

Throwaway vertical slice for the `asi-sense` plugin concept against
DeepSeek Harness (DSH). Not production code; nothing here modifies DSH
itself — the spike loads as a normal plugin bundle inside an isolated
profile.

## Layout

- `packages/asi-sense-spike/` — the bundle
  - `src/index.ts` — Host `AsiSenseSpike` TypertRemoteService:
    `watch` (shared 2 s push), `select`, `inject`, `followup`, `snapshot`;
    actions take a plain `sessionId: string` resolved via `ctx.agents.get`
  - `src/client.ts` — sidebar entry + main diagnostic panel
  - `src/types.ts` — wire types (`SessionId` wire string, `SpikeSnapshot`, …)
  - `src/*-shim.ts` — analyzer-only ambient shims (see Limitations)
  - `cordis.patch.yml` — registers the service + `helperPath` config
- `helper/main.swift` — macOS NDJSON sampler (permission, thermal, front
  app, focused-window focus/title-change events; titles redacted in-process)
- `overlay/asi-dev.patch.yml` — profile overlay: helper path, local
  `magpie` provider (`http://127.0.0.1:3425/v1`,
  `apiKeyEnv ASI_MAGPIE_PLACEHOLDER`), model `auto/gpt-6.1-sol`,
  `retryPolicy {mode: normal, maxRetries: 0}`, all auxiliary model calls
  and telemetry/feedback egress disabled. `contextWindow` is deliberately
  unset: the panel observed the 1000000 provider-default fallback, not
  the 256000 the local gateway advertises for this model.
- `scripts/` — `gen-typert.ts`, `build-client.mjs`, `selfcheck.mjs`,
  `run-asi-dev.sh` (detached launcher)
- `bundle` — symlink to `packages/asi-sense-spike`
- `tmp/dsh-home/` — isolated `DSH_HOME` containing only the `asi-dev` profile

## Constraints

- Fixed external DSH checkout: `/Users/wangying/orca/dsh` at
  `39163dd30f703a79079e2d2446545cff3c453738` (`0.2.2-rc.3`), already built
  (`pnpm install && pnpm run build` done once there). DSH tracked files
  are never edited.
- macOS + Swift toolchain required for the helper.
- Port `127.0.0.1:3186` must be free.
- No model is invoked by any of these commands; the `inject`/`followup`
  panel buttons are manual-test-only.

## Setup (once)

```sh
# 0. Link the pinned DSH packages into this spike (link: deps, no scripts needed)
pnpm install --ignore-scripts

# 1. Build host lib, generated Typert artifacts, client bundle, helper
pnpm run build        # tsc host emit + pnpm run gen + esbuild client
pnpm run helper       # mkdir -p .build && swiftc -O … (creates .build)

# 2. Create the isolated profile (web template) — run from the DSH checkout
cd /Users/wangying/orca/dsh
DSH_HOME=<abs spikes/p0>/tmp/dsh-home \
  pnpm dsh --profile asi-dev --from-default-profile web --dump-config >/dev/null
#    (--from-default-profile is a launcher flag; it belongs before any
#     subcommand, not after `plugin`)

# 3. Install the bundle
DSH_HOME=<abs spikes/p0>/tmp/dsh-home \
  pnpm dsh plugin --profile asi-dev add <abs spikes/p0>/bundle
#    plugin add registers asi-sense-spike as a link: dependency, so later
#    `pnpm run build` output reaches the running app without reinstalling

# 4. Apply the route/egress overlay once into the profile
cp <abs spikes/p0>/overlay/asi-dev.patch.yml \
   <abs spikes/p0>/tmp/dsh-home/profiles/asi-dev/cordis.patch.yml
```

## Run

```sh
./scripts/run-asi-dev.sh   # nohup-detached; URL + token in logs/asi-dev-web.log
```

The ready line in the log carries a one-time `?token=…` — open exactly
that URL in a browser. Equivalent supported invocations:

```sh
# direct
DSH_HOME=<abs>/tmp/dsh-home ASI_MAGPIE_PLACEHOLDER=magpie \
  pnpm dsh --profile asi-dev --no-open --host 127.0.0.1 --port 3186

# overlay without editing the profile (--patch alternative)
DSH_HOME=<abs>/tmp/dsh-home ASI_MAGPIE_PLACEHOLDER=magpie \
  pnpm dsh --profile asi-dev --patch <abs>/overlay/asi-dev.patch.yml \
  --no-open --host 127.0.0.1 --port 3186
```

## Check

```sh
pnpm run check   # host tsc --noEmit + client tsc --noEmit + helper NDJSON selfcheck
```

## Honest limitations

- `src/dsh-agent-shim.ts` and `src/typert-protocol-shim.ts` exist only so
  the workspace Typert generator can resolve `Agent`/`SessionId` types
  inside a registered package via `tsconfig.host.json` `paths`. The agent
  shim is deliberately minimal — Remote signatures take plain `string`
  session ids resolved through `ctx.agents.get`; passing `Agent` as a
  Remote parameter requires the real `TypertLookupMap` wire codec, which
  the earlier shim faked and the strict gateway rejected
  (`lookup provider "agent" does not match its strict definition`).
  This is a throwaway workaround for running the generator outside the
  DSH workspace, not a production solution — upstream, the TypeGraph for
  these boundaries comes from the real packages.
- `watch` streams are pushed off one shared 2 s interval; `snapshot()` is
  a unary read of the same sampler.
- Token fields (`pressureTokens`, `contextWindow`, `projectedTokens`,
  `modelContext`, `usage`) are absent until the provider/session reports
  them — the panel never fabricates them.
- `projectedTokens` comes only from the `contextPressure` session
  projection; there is deliberately no fallback to other meter totals.
- AX observations need Accessibility permission for the spawning
  terminal; the helper reports `axTrusted` and per-subscription failures
  (`unsupported` + AXError code) instead of prompting or polling. The
  denied-permission path is untested (`axTrusted` was always true here).
- Window titles never leave the helper — only `[REDACTED]` plus the
  title's character length.
- Only the initial `thermal` event was observed; no real thermal-state
  change occurred during the spike, so the change-notification path is
  untested.
- `MessageSourceMap` is merge-extended with `kind: 'environment'` (the
  supported extension point). Verified at runtime over 2 real model
  requests: the injected marker queued without waking an idle Agent, the
  follow-up turn ran, and the reply `SPIKE_INJECT_VISIBLE` proves the
  `environment` source marker reached model context (see
  `../../docs/spikes/P0.md`).
- The Client cannot declare `remote.asiSenseSpike` in its entry `inject`
  (the namespace is provided by its own `$mount`), so typed remote access
  runs inside a `ctx.inject(['remote.asiSenseSpike', …], …)` scope —
  accessing `ctx.remote.asiSenseSpike` without it throws
  `cannot get property … without inject`.
- Cleanup verified live, twice: SIGTERM to the detached web server exits
  the server and its spawned helper with no orphan (SIGKILL fallback
  never needed); cordis effect disposal unwinds the scoped remote/slot
  registrations on unload.
