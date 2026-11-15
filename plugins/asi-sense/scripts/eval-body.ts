import assert from 'node:assert/strict';
import type { Body, BodyThresholdSample, BodyThresholdState, Fact, Signal } from '@asi/sense-types';
import { AnomalyEvaluator, Baseline, BodyMonitor, FileBurstDetector, Tuner } from '../src/host/body/index.ts';

// Entirely synthetic: Monday UTC start, one-minute samples, xorshift32 seed.
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const GIB = 1024 ** 3;
const START = Date.UTC(2026, 10, 2);
const source = { id: 'synthetic', api: 'eval', host: 'fixture' };
let now = START;
let seed = 0x415349;
function noise() {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return ((seed >>> 0) / 2 ** 32 - 0.5) * 2;
}
const injections = [
  { name: 'disk drop', metric: 'disk:/', kind: 'body.rate', start: DAY + 2 * HOUR + 15 * MIN, duration: 10 * MIN },
  { name: 'RSS leak', metric: 'rss', kind: 'body.rate', start: 2 * DAY + 4 * HOUR + 15 * MIN, duration: 10 * MIN },
  { name: 'excess deletion', metric: '/fixture/work', kind: 'file.burst', start: 3 * DAY + HOUR, duration: MIN },
  {
    name: 'CPU anomaly',
    metric: 'cpu',
    kind: 'body.anomaly',
    start: 4 * DAY + 12 * HOUR + 15 * MIN,
    duration: 10 * MIN,
  },
  {
    name: 'context drain',
    metric: 'context',
    kind: 'body.rate',
    start: 5 * DAY + 8 * HOUR + 15 * MIN,
    duration: 10 * MIN,
  },
];
function elapsed(name: string, t: number) {
  const injection = injections.find((i) => i.name === name);
  assert(injection);
  const delta = t - injection.start;
  return delta >= 0 && delta < injection.duration ? delta / 1000 : undefined;
}
function sample(t: number): BodyThresholdSample {
  const at = START + t;
  const fact = <T>(value: T): Fact<T> => ({ value, observedAt: at, ttlMs: 2 * MIN, status: 'ok', source });
  const hour = (t % DAY) / HOUR;
  const weekend = new Date(at).getUTCDay() % 6 === 0 ? 0.65 : 1;
  const cycle = (1 + Math.sin(((hour - 6) / 24) * 2 * Math.PI)) / 2;
  const cpu = elapsed('CPU anomaly', t) === undefined ? (0.15 + 0.16 * cycle + 0.008 * noise()) * weekend : 0.95;
  const rss = GIB + 16 * 1024 ** 2 * cycle + 1024 ** 2 * noise() + (elapsed('RSS leak', t) ?? 0) * 4 * 1024 ** 2;
  const free = 60 * GIB + 16 * 1024 ** 2 * noise() - (elapsed('disk drop', t) === undefined ? 0 : 4 * GIB);
  const used = 20_000 + 100 * cycle + 20 * noise() + (elapsed('context drain', t) ?? 0) * 300;
  const body: Body = {
    cpu: fact({ usage: cpu, perCore: [cpu], load1: cpu, load5: cpu, load15: cpu }),
    memory: fact({ total: 16 * GIB, used: 5 * GIB, pressure: 'normal', swapUsed: 0 }),
    disks: fact([{ mount: '/', total: 100 * GIB, free }]),
    battery: fact(null),
    thermal: fact('nominal'),
    network: fact({ online: true, rxBps: 5000 + 1000 * cycle * weekend, txBps: 1000 }),
    harnessProcess: fact({ rss, cpu, uptimeSec: t / 1000 }),
    tokens: fact({
      contextWindow: 120_000,
      contextUsed: used,
      sessionUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }),
  };
  return { at, body, source };
}
const baseline = new Baseline({ clock: () => now, installedAt: START });
const monitor = new BodyMonitor({
  rateRules: [
    { id: 'disk-loss', metric: 'disk:/', direction: 'down', windowMs: MIN, maxDelta: 2 * GIB },
    { id: 'rss-leak', metric: 'rss', direction: 'up', windowMs: 5 * MIN, maxSlope: 2 * 1024 ** 2 },
    { id: 'context-loss', metric: 'context', direction: 'down', windowMs: MIN, maxSlope: 100 },
  ],
  anomaly: new AnomalyEvaluator(baseline, [{ id: 'cpu-anomaly', metric: 'cpu', sigma: 3 }]),
});
const burst = new FileBurstDetector();
const alerts: Signal[] = [];
const stableSamples = Array<number>(7).fill(0);
const falsePositives = Array<number>(7).fill(0);
let state: BodyThresholdState = {};
let prev = sample(0);
function stable(t: number) {
  // An injected disturbance is not stationary; include the longest rate window
  // after it ends. Count every other entry alert, including floor alerts.
  return !injections.some((i) => t >= i.start && t <= i.start + i.duration + 5 * MIN);
}
function record(signal: Signal) {
  if (signal.data.severity === 'normal' || signal.data.level === 'record') return;
  alerts.push(signal);
  const t = signal.at - START;
  if (stable(t)) falsePositives[Math.floor(t / DAY)]++;
}
for (let t = MIN; t <= 7 * DAY; t += MIN) {
  now = START + t;
  const next = sample(t);
  const result = monitor.evaluate(prev, next, state);
  state = result.state;
  for (const signal of result.signals) record(signal);
  if (t < 7 * DAY && stable(t)) stableSamples[Math.floor(t / DAY)]++;
  if (t === injections[2].start) {
    for (let j = 0; j < 60; j++) {
      for (const signal of burst.accept({
        id: `delete-${j}`,
        kind: 'file.changed',
        at: now + j * 500,
        source,
        subject: `/fixture/work/file-${j}.txt`,
        data: { change: 'delete' },
        cause: 'user',
      }))
        record(signal);
    }
  }
  prev = next;
}
console.log('# Body Adaptive Evaluation\n');
console.log('Synthetic only; xorshift32 seed 0x415349; 7 days, 60s cadence, UTC hourly-week buckets.');
console.log(
  'Calm data includes a daily cycle, bounded noise and weekend amplitude 0.65; no model or host observations.\n',
);
console.log('| Injection | Detected | Delay (s) |');
console.log('| --- | --- | ---: |');
for (const injection of injections) {
  const found = alerts.find(
    (signal) =>
      signal.kind === injection.kind &&
      (signal.data.metric === injection.metric || signal.subject === injection.metric) &&
      signal.at >= START + injection.start &&
      signal.at < START + injection.start + injection.duration,
  );
  console.log(
    `| ${injection.name} | ${found ? 'yes' : 'NO'} | ${found ? (found.at - START - injection.start) / 1000 : '-'} |`,
  );
  assert(found, `Missed injection: ${injection.name}`);
}
console.log('\n| Day | Stable exposure (days) | False alerts | False alerts / stable day |');
console.log('| ---: | ---: | ---: | ---: |');
for (let day = 0; day < 7; day++) {
  const exposure = (stableSamples[day] * MIN) / DAY;
  const rate = falsePositives[day] / exposure;
  console.log(`| ${day + 1} | ${exposure.toFixed(4)} | ${falsePositives[day]} | ${rate.toFixed(4)} |`);
  if (day >= 1) assert(rate < 1, `Day ${day + 1} false-positive rate >= 1`);
}
console.log(
  '\nStable exposure excludes only injected intervals plus 5min of rate-window washout; recovery signals are not alerts.',
);
console.log('\n| Installed hours | Learning progress (%) |');
console.log('| ---: | ---: |');
for (const hour of [0, 6, 7.2, 12, 18, 24, 48, 168]) {
  now = START + hour * HOUR;
  console.log(`| ${hour} | ${baseline.learningProgress.toFixed(1)} |`);
}

// Replay distinct alert feedback for ONE rule. Every 3 consecutive noise labels
// requests 20% less sensitivity: an upper sigma threshold is divided by 0.8.
now = START + 7 * DAY;
const tuner = new Tuner(
  {
    'cpu.sigma': { value: 3, min: 1, max: 12, noiseDirection: 'up' },
    'floor.disk': { value: 0.05, min: 0.02, max: 0.5, tighten: 'up' },
  },
  () => now,
);
for (let i = 0; i < 9; i++) {
  tuner.registerAlert(`cpu-${i}`, 'cpu-anomaly', 'cpu.sigma');
  tuner.feedback(`cpu-${i}`, 'noise');
}
tuner.propose({ param: 'floor.disk', to: 0.04, reason: 'must reject loosening a safety floor' }, 'agent');
tuner.lock('cpu.sigma');
tuner.propose({ param: 'cpu.sigma', to: 5, reason: 'must reject a locked parameter' }, 'agent');
console.log('\n## Repeated Noise Feedback\n');
console.log('| Operation | Parameter | From | To | Status | Reason |');
console.log('| --- | --- | ---: | ---: | --- | --- |');
for (const log of tuner.logs.filter((log) => log.operation !== 'feedback')) {
  console.log(
    `| ${log.operation} | ${log.param} | ${log.from} | ${log.to} | ${log.status} | ${log.rejectionReason ?? log.reason} |`,
  );
}
const applied = tuner.logs.filter((log) => log.operation === 'propose' && log.status === 'applied');
assert.equal(applied.length, 2);
assert.equal(tuner.get('cpu.sigma'), 4.6875);
assert.equal(tuner.get('floor.disk'), 0.05);
for (const log of applied) {
  assert.equal(typeof log.from, 'number');
  assert.equal(typeof log.to, 'number');
  assert(Math.abs(Number(log.to) - Number(log.from)) <= Math.abs(Number(log.from)) * 0.5);
}
assert(tuner.logs.some((log) => log.status === 'rejected' && log.by === 'auto'));
console.log(
  '\nPASS: five injections detected; days 2-7 <1 false alert/stable day; only two guarded auto changes, floor unchanged.',
);
