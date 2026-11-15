# asi-sense (M1 skeleton)

Pure-TypeScript local core: fact store, attention pipeline, body thresholds,
and deterministic environment-update formatting.

## Layout

- `src/host/state/`: `StateStore`, fed by normalized signals (see its TSDoc).
- `src/host/attention/`: rules, self-cause, merge/budget and `FloorEvaluator`.
- `src/host/delivery/`: `formatEnvUpdate`, including the title privacy switch.
- `@asi/sense-types`: shared contracts, including the pure `BodyEvaluator` seam.

## Host contract

No internal timers: call `flush()` at merge deadlines and `preStep(sessionId)`
before agent steps. Delivery errors propagate; retry `flush`/`preStep` explicitly.

## M1 boundaries

No persistence, watchers, helpers, DSH/Cordis integration or model requests.
Rate/anomaly/burst/tuning contracts are types only; data stays local.

## Requirements

Vitest requires Node 22.12+, 24.x, or >=26 (developed on 26; ES2022 runtime).
`pnpm check`: typecheck + lint + tests; `pnpm test:coverage`: attention lines >=90%.
