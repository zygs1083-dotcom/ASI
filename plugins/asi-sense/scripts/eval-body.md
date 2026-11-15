# Body Adaptive Evaluation

Task acceptance evidence for DESIGN section 2.2c: three independent alert
layers, learned baselines and guarded feedback-driven tuning.

## Reproduce

From the repository root, use the pinned plugin-local runner:

```sh
pnpm --filter asi-sense exec tsx scripts/eval-body.ts
pnpm check
```

This is a deterministic synthetic simulation, not a host/DSH measurement or
a model evaluation. No model requests, real observation data, filesystem
persistence or running service are involved.

## Method

- Seven days at a 60-second cadence; Monday UTC start.
- xorshift32 seed `0x415349`; daily sinusoid, bounded noise, weekend
  amplitude multiplier `0.65`.
- Five injected disturbances; file deletion events arrive every 500ms.
- Entry alerts from every enabled layer count; recovery and record-only
  self-cause audits do not count as alerts.
- Stable exposure excludes the known injected intervals plus five minutes
  of rate-window washout; rates use the remaining measured exposure.
- The script asserts every injection is detected and each day from day 2
  has fewer than one false entry alert per stable day.

## Captured Results

| Injection | Detected | Delay (s) |
| --- | --- | ---: |
| disk drop | yes | 0 |
| RSS leak | yes | 180 |
| excess deletion | yes | 25 |
| CPU anomaly | yes | 120 |
| context drain | yes | 60 |

| Day | Stable exposure (days) | False alerts | False alerts / stable day |
| ---: | ---: | ---: | ---: |
| 1 | 0.9993 | 0 | 0.0000 |
| 2 | 0.9889 | 0 | 0.0000 |
| 3 | 0.9889 | 0 | 0.0000 |
| 4 | 0.9951 | 0 | 0.0000 |
| 5 | 0.9889 | 0 | 0.0000 |
| 6 | 0.9889 | 0 | 0.0000 |
| 7 | 1.0000 | 0 | 0.0000 |

| Installed hours | Learning progress (%) |
| ---: | ---: |
| 0 | 0.0 |
| 6 | 25.0 |
| 7.2 | 30.0 |
| 12 | 50.0 |
| 18 | 75.0 |
| 24 | 100.0 |
| 48 | 100.0 |
| 168 | 100.0 |

## Repeated Noise Feedback

Nine distinct alert registrations for the same CPU rule receive synthetic
`noise` feedback. Every three consecutive labels request 20% less
sensitivity, implemented as an upper sigma threshold divided by `0.8`.

| Operation | Parameter | From | To | Status | Reason |
| --- | --- | ---: | ---: | --- | --- |
| propose | cpu.sigma | 3 | 3.75 | applied | three consecutive noise labels |
| propose | cpu.sigma | 3.75 | 4.6875 | applied | three consecutive noise labels |
| propose | cpu.sigma | 4.6875 | 5.859375 | rejected | hourly change limit |
| propose | floor.disk | 0.05 | 0.04 | rejected | safety: cannot loosen |
| lock | cpu.sigma | 4.6875 | 4.6875 | applied | locked |
| propose | cpu.sigma | 4.6875 | 5 | rejected | param locked |

Each applied step is +25% (within the 50% guard), only two changes apply in
the rolling hour, and the safety floor remains unchanged.

## Verification And Limits

Baseline `c94b7e4`: `pnpm check` exits 0 with 97 tests. Final gate exits 0
with 147 tests (50 new body tests), clean typecheck and lint; the evaluation
script also passes a separate TypeScript check because scripts are outside
the existing plugin tsconfig include list.

The weekly buckets are UTC, and their constant-step stochastic median/MAD
is an approximation rather than exact rolling MAD; the algorithm and error
caveats are documented in `src/host/body/baseline.ts`. These synthetic
results do not establish a real-world false-positive rate. No DSH tool
registration, UI integration or real filesystem persistence is included.
