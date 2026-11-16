import assert from 'node:assert/strict';
import type { BodyThresholdSample, BodyThresholdState, Signal } from '@asi/sense-types';
import { AttentionPipeline, type DeliveryIntent } from '../src/host/attention/pipeline.ts';
import { DEFAULT_RULES } from '../src/host/attention/rules.ts';
import { BodyMonitor, defaultBodyRules } from '../src/host/body/index.ts';
import { StateStore } from '../src/host/state/store.ts';
import { regressionCases } from './eval-body.cases.ts';
import { DAY, disturbances, type Frame, HOUR, ROOT, SEEDS, START, trace } from './eval-body.data.ts';

type Counts = { detector: number[]; delivery: number[] };
type Delays = Map<string, { detector: number; delivery?: number }>;
const freshCounts = (): Counts => ({ detector: Array(7).fill(0), delivery: Array(7).fill(0) });
const alert = (s: Signal) => s.data.severity !== 'normal' && s.data.level !== 'record';
const session = { id: 'synthetic-session', busy: false, userInitiated: false };

class Replay {
  private mono: number;
  private wall: number;
  private snapshot?: string;
  private monitor: BodyMonitor;
  private state: BodyThresholdState = {};
  private prev?: BodyThresholdSample;
  private coldStart = false;
  private readonly pipeline: AttentionPipeline;
  private readonly provenance = new Map<string, number>();
  readonly counts = freshCounts();
  readonly delays: Delays = new Map();
  readonly restarts: number[] = [];
  readonly cpuEvidence: unknown[] = [];
  readonly falseEvidence: unknown[] = [];
  sustainedSamples = 0;

  constructor(
    private readonly injections: boolean,
    start = START,
  ) {
    this.wall = start;
    this.mono = start - START;
    this.monitor = this.createMonitor();
    this.pipeline = new AttentionPipeline({
      store: new StateStore(
        () => this.wall,
        undefined,
        () => this.mono,
      ),
      clock: () => this.mono,
      wallClock: () => this.wall,
      rules: [...DEFAULT_RULES, ...defaultBodyRules()],
      deliverer: { deliver: async (intent) => this.delivered(intent) },
    });
  }

  private createMonitor(): BodyMonitor {
    return new BodyMonitor({
      clock: () => this.mono,
      wallClock: () => this.wall,
      timeZone: 'America/New_York',
      fileBurst: { roots: [ROOT] },
      persistence: {
        load: async () => this.snapshot,
        save: async (data) => {
          this.snapshot = data;
        },
      },
    });
  }

  async restore(snapshot?: string): Promise<void> {
    this.snapshot = snapshot;
    this.coldStart = snapshot === undefined && this.wall === START;
    await this.monitor.restore();
    this.state = this.monitor.restoredState ?? {};
  }

  async capture(): Promise<string> {
    await this.monitor.persist();
    assert(this.snapshot, 'persist must produce a snapshot');
    return this.snapshot;
  }

  async restart(): Promise<void> {
    const snapshot = await this.capture();
    await this.monitor.close();
    this.monitor = this.createMonitor();
    await this.restore(snapshot);
    this.prev = undefined;
    this.restarts.push(this.mono);
  }

  private disturbance(s: Signal, elapsed: number) {
    return disturbances.find(
      (d) =>
        s.kind === d.kind &&
        (s.data.metric === d.metric || s.subject === d.metric) &&
        elapsed >= d.start &&
        elapsed < d.start + d.duration,
    );
  }

  private delivered(intent: DeliveryIntent): void {
    for (const change of intent.update.changes) {
      const elapsed = this.provenance.get(change.signal.id);
      assert(elapsed !== undefined, 'delivered signals must have recorded detector provenance');
      if (!this.injections) this.counts.delivery[Math.floor(elapsed / DAY)] += change.count;
      const disturbance = this.disturbance(change.signal, elapsed);
      if (this.injections && disturbance) {
        const delay = this.delays.get(disturbance.name);
        assert(delay, 'delivery cannot precede detection');
        delay.delivery ??= this.mono - disturbance.start;
        assert.equal(change.level, disturbance.kind === 'file.burst' ? 'wake' : 'context');
      }
    }
  }

  async step(frame: Frame, measured: boolean): Promise<void> {
    this.mono = frame.elapsed;
    this.wall = frame.wall;
    const sustained = disturbances.find((d) => d.name === 'CPU sustained (2h)');
    const checkDrift =
      this.injections &&
      sustained !== undefined &&
      frame.elapsed >= sustained.start &&
      frame.elapsed < sustained.start + sustained.duration;
    const before = checkDrift ? this.monitor.baseline.read('cpu', frame.wall) : undefined;
    const result = this.monitor.evaluate(this.prev ?? frame.sample, frame.sample, this.state);
    this.state = result.state;
    this.prev = frame.sample;
    if (checkDrift) {
      assert(before && before.count >= 8 && before.dates >= 2, 'sustained scenario needs mature hourly buckets');
      assert.deepEqual(this.monitor.baseline.read('cpu', frame.wall), before, 'abnormal CPU must not train baseline');
      if (frame.sample.body.cpu.value) this.sustainedSamples++;
    }
    const signals = [...result.signals, ...frame.files.flatMap((s) => this.monitor.accept(s, frame.elapsed))];
    if (!measured) return;
    const cpu = disturbances.find((d) => d.name === 'CPU anomaly');
    if (this.injections && cpu && frame.elapsed >= cpu.start && frame.elapsed < cpu.start + cpu.duration) {
      this.cpuEvidence.push({
        elapsed: frame.elapsed,
        value: frame.sample.body.cpu.value?.usage,
        installedAt: this.monitor.baseline.installedAt,
        stat: this.monitor.baseline.read('cpu', frame.wall),
      });
    }
    for (const signal of signals) {
      this.provenance.set(signal.id, frame.elapsed);
      if (!this.injections && alert(signal)) {
        this.counts.detector[Math.floor(frame.elapsed / DAY)]++;
        if (this.falseEvidence.length < 20) this.falseEvidence.push({ elapsed: frame.elapsed, signal });
        if (this.coldStart && frame.elapsed < DAY) {
          assert.notEqual(signal.kind, 'body.anomaly', 'cold first day must remain learning');
        }
      }
      const disturbance = this.disturbance(signal, frame.elapsed);
      if (this.injections && alert(signal) && disturbance && !this.delays.has(disturbance.name)) {
        this.delays.set(disturbance.name, { detector: frame.elapsed - disturbance.start });
      }
      await this.pipeline.accept(signal, session);
    }
    await this.pipeline.preStep(session.id);
    this.mono += 2501;
    await this.pipeline.flush();
  }

  async close(): Promise<void> {
    await this.monitor.close();
  }
}

async function warmup(seed: number): Promise<string> {
  const replay = new Replay(false, START - 14 * DAY);
  try {
    await replay.restore();
    for (const frame of trace(seed, { warmup: true })) await replay.step(frame, false);
    return await replay.capture();
  } finally {
    await replay.close();
  }
}

async function stable(seed: number, cohort: string, snapshot?: string): Promise<void> {
  const replay = new Replay(false);
  let restart = 0;
  try {
    await replay.restore(snapshot);
    for (const frame of trace(seed)) {
      if (restart < 2 && frame.elapsed >= (2.5 + restart * 3) * DAY) {
        await replay.restart();
        restart++;
      }
      await replay.step(frame, true);
    }
    assert.equal(replay.restarts.length, 2);
    for (let day = 0; day < 7; day++) {
      const detector = replay.counts.detector[day];
      const delivery = replay.counts.delivery[day];
      console.log(`| ${seed.toString(16)} | ${cohort} | ${day + 1} | ${detector} | ${delivery} |`);
      assert(detector < 1, `${seed}/${cohort}/day${day + 1}: ${JSON.stringify(replay.falseEvidence)}`);
      assert(delivery < 1, `${seed}/${cohort}/day${day + 1}: delivery false alerts >=1`);
    }
  } finally {
    await replay.close();
  }
}

async function latency(seed: number, snapshot: string): Promise<Delays> {
  const replay = new Replay(true);
  try {
    await replay.restore(snapshot);
    for (const frame of trace(seed, { inject: true })) await replay.step(frame, true);
    assert(replay.sustainedSamples >= 100, 'two-hour drift check must cover >=100 valid CPU samples');
    for (const d of disturbances) {
      const delay = replay.delays.get(d.name);
      assert(delay, `${seed}: missed ${d.name}; CPU evidence ${JSON.stringify(replay.cpuEvidence.slice(0, 6))}`);
      assert(delay.delivery !== undefined, `${seed}: no pipeline delivery for ${d.name}`);
      assert(delay.detector <= 5 * 60_000, `${seed}: ${d.name} detection exceeded 5min`);
      assert(delay.delivery <= delay.detector + 2501, `${seed}: delayed pipeline delivery for ${d.name}`);
    }
    return replay.delays;
  } finally {
    await replay.close();
  }
}

console.log('# Body Adaptive Evaluation\n');
console.log('Offline synthetic fixtures only; no observed host data, filesystem watching, model or network requests.');
console.log('Fixed xorshift32 seeds; independent workload generator never reads detector parameters.');
console.log('Cold and mature cohorts each cover seven complete 24h receipt-time days, including cold day one.');
console.log('Mature baselines come from a separate 14-day, 90s-cadence training capture, reused without retraining.');
console.log('Weekly-hour buckets need two dates, so disturbance latencies use mature captures, not cold week one.');
console.log('Both stable cohorts include stationary high-variance CPU/network/RSS, sub-threshold boundary jitter,');
console.log('49/50 external deletes across watched subdirectories, 120 self-caused adds/modifies, missing facts,');
console.log('four-minute outages, 35-53s jitter, two restarts, NY spring DST and +3h/rollback wall jumps.');
console.log('False counts are alert entries (not recoveries/audits); delivered counts sum EnvChange.count,');
console.log('after actual defaultBodyRules + M1 intake/preStep/flush, not payload delivery-level guesses.\n');
console.log('| Seed (hex) | Cohort | Day | Detector False | Delivery False |');
console.log('| --- | --- | ---: | ---: | ---: |');
const captures = new Map<number, string>();
for (const seed of SEEDS) {
  const snapshot = await warmup(seed);
  captures.set(seed, snapshot);
  await stable(seed, 'cold');
  await stable(seed, 'mature', snapshot);
}
console.log('\n| Seed (hex) | Disturbance | Detector Delay (s) | Delivery Delay (s) |');
console.log('| --- | --- | ---: | ---: |');
for (const seed of SEEDS) {
  const snapshot = captures.get(seed);
  assert(snapshot);
  const delays = await latency(seed, snapshot);
  for (const d of disturbances) {
    const delay = delays.get(d.name);
    assert(delay?.delivery !== undefined);
    console.log(
      `| ${seed.toString(16)} | ${d.name} | ${(delay.detector / 1000).toFixed(3)} | ${(delay.delivery / 1000).toFixed(3)} |`,
    );
  }
}
console.log('\nPASS: 3 seeds x 2 cohorts x 7 daily detector/delivery assertions; five classes detected and delivered.');
console.log(
  'Additional two-hour sustained CPU scenario: >=100 valid samples/seed, every before/after baseline identical.',
);
regressionCases();
console.log('\nLimits: bounded synthetic workloads, not arbitrary real workloads; 14-day training is not scored.');
console.log(`Clock fixtures start ${new Date(START).toISOString()}; each measured cohort spans ${(7 * DAY) / HOUR}h.`);
