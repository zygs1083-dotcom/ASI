import { AsyncLocalStorage } from 'node:async_hooks';
import type { Body, BodyThresholdSample, BodyThresholdState, Fact, Signal } from '@asi/sense-types';
import { BODY_THRESHOLDS } from '../attention/thresholds.ts';
import {
  BodyMonitor,
  defaultAnomalyRules,
  defaultRateRules,
  FileBurstDetector,
  type ParameterSpec,
  Tuner,
} from '../body/index.ts';
import { captureRateTimes, type RateTimes } from '../body/rate.ts';
import type { RuntimeAttention } from '../runtime/attention.ts';
import type { FactExpiry } from '../runtime/expiry.ts';
import type { Clock, DshPort, ProbeFactory, StoragePort, TokenSnapshot } from '../runtime/ports.ts';

const source = { id: 'body', api: 'probe', host: 'local' };
const specs: Record<string, ParameterSpec> = {
  'rate.disk.maxDelta': { value: 2 * 1024 ** 3, min: 1, noiseDirection: 'up' },
  'rate.rss.maxRatio': { value: 0.5, min: 0.01, max: 10, noiseDirection: 'up' },
  'rate.context.maxEtaMs': { value: 600_000, min: 1, noiseDirection: 'down' },
  'anomaly.cpu.sigma': { value: 3, min: 0.1, max: 20, noiseDirection: 'up' },
  'anomaly.memory.sigma': { value: 3, min: 0.1, max: 20, noiseDirection: 'up' },
  'anomaly.network.sigma': { value: 3, min: 0.1, max: 20, noiseDirection: 'up' },
  'file.burst.windowMs': { value: 60_000, min: 1 },
  'file.burst.maxChanges': { value: 100, min: 1, noiseDirection: 'up' },
  'file.burst.maxDeleted': { value: 50, min: 1, noiseDirection: 'up' },
  ...Object.fromEntries(
    (['disk', 'context', 'battery'] as const).flatMap((metric) =>
      (['warn', 'critical'] as const).map((severity) => [
        `floor.${metric}.${severity}`,
        { value: BODY_THRESHOLDS[metric][severity], min: 0, max: 1, tighten: 'up' as const },
      ]),
    ),
  ),
};

export class BodySource {
  readonly tuner: Tuner;
  readonly monitor: BodyMonitor;
  private readonly identity = new AsyncLocalStorage<'user'>();
  private readonly probe: ReturnType<ProbeFactory['create']>;
  private previous?: BodyThresholdSample;
  private state: BodyThresholdState = {};
  private tail = Promise.resolve();
  private off?: () => void;
  private stopped = false;
  private intervalMs = 2_000;
  private sampling = false;
  private token?: Fact<NonNullable<Body['tokens']['value']>>;
  private tokenSource?: TokenSnapshot['contextWindowSource'];
  private tokenGeneration = 0;
  private readonly tokenWork = new Set<Promise<void>>();
  private thermal?: Body['thermal'];
  private thermalRecovering = false;
  private burstRoots = '';
  private detector = new FileBurstDetector();
  private rateTimes: RateTimes = {};

  constructor(
    factory: ProbeFactory,
    private readonly dsh: DshPort,
    storage: StoragePort,
    private readonly clock: Clock,
    private readonly attention: RuntimeAttention,
    private readonly expiry: FactExpiry,
    private readonly paused: () => boolean,
    private readonly changed: () => void,
  ) {
    this.probe = factory.create();
    this.tuner = new Tuner(specs, {
      actor: () => this.identity.getStore() ?? 'agent',
      clock: () => clock.mono(),
      wallClock: () => clock.wall(),
      onChange: changed,
    });
    this.monitor = new BodyMonitor({
      tuner: this.tuner,
      clock: () => clock.mono(),
      wallClock: () => clock.wall(),
      persistence: { load: () => storage.load('body'), save: (value) => storage.save('body', value) },
    });
  }
  async start(intervalMs: number): Promise<void> {
    await this.monitor.restore();
    if (this.stopped) {
      await this.monitor.close();
      return;
    }
    this.state = this.monitor.restoredState ?? {};
    this.off = this.probe.onSample((body) => {
      const at = this.clock.wall();
      const mono = this.clock.mono();
      this.enqueue(() => this.sample(body, at, mono));
    });
    this.intervalMs = intervalMs;
    await this.setPaused(this.paused());
  }
  async setPaused(paused: boolean): Promise<void> {
    if (paused) this.tokenGeneration++;
    if (paused && this.sampling) {
      this.sampling = false;
      await this.probe.stop();
    } else if (!paused && !this.sampling && !this.stopped) {
      this.sampling = true;
      this.probe.start({ intervalMs: this.intervalMs });
    }
  }
  asUser<T>(work: () => Promise<T>): Promise<T> {
    return this.identity.run('user', work);
  }
  sync(): void {
    this.state = this.monitor.restoredState ?? this.state;
  }
  tokens(session: string, valid: () => boolean = () => true): Promise<void> {
    if (this.stopped) return Promise.resolve();
    const work = this.readTokens(session, valid);
    this.tokenWork.add(work);
    void work.then(
      () => this.tokenWork.delete(work),
      () => this.tokenWork.delete(work),
    );
    return work;
  }
  private async readTokens(session: string, valid: () => boolean): Promise<void> {
    const generation = ++this.tokenGeneration;
    const snapshot = await Promise.resolve()
      .then(() => this.dsh.tokenSnapshot(session))
      .catch(() => undefined);
    if (this.stopped || generation !== this.tokenGeneration || !valid()) return;
    this.tokenSource = snapshot?.contextWindowSource;
    this.token = {
      value: snapshot ?? null,
      status: snapshot ? 'ok' : 'unavailable',
      source: { id: 'tokens', api: 'dsh', host: 'local' },
      observedAt: this.clock.wall(),
      ttlMs: 15_000,
    };
    this.write('tokens', this.token);
    this.changed();
  }
  setThermal(fact: Body['thermal'], recovering = false): void {
    if (this.stopped) return;
    this.thermal = fact;
    this.thermalRecovering = recovering;
    this.write('thermal', fact);
    this.changed();
  }
  finishThermalRecovery(): void {
    this.thermalRecovering = false;
  }
  setRoots(roots: string[]): void {
    const ordered = [...roots].sort();
    const key = JSON.stringify(ordered);
    if (key === this.burstRoots) return;
    this.burstRoots = key;
    this.detector = new FileBurstDetector({
      ...(ordered.length ? { roots: ordered } : {}),
      threshold: (param, fallback) => this.tuner.number(param, fallback),
    });
  }
  async burst(signal: Signal): Promise<void> {
    if (this.stopped) return;
    for (const burst of this.detector.accept(signal, this.clock.mono())) {
      burst.data.feedbackAvailable = false;
      await this.attention.accept(burst);
      this.register(burst);
    }
  }
  async stop(): Promise<void> {
    this.stopped = true;
    const tokens = Promise.allSettled([...this.tokenWork]);
    this.off?.();
    if (this.sampling) await this.probe.stop();
    this.sampling = false;
    await this.tail;
    await this.monitor.close();
    await tokens;
  }
  private enqueue(work: () => Promise<void>): void {
    const run = this.tail.then(work);
    this.tail = run.catch(() => {});
  }
  private write(key: keyof Body, fact: Fact<unknown>): void {
    if (this.stopped) return;
    this.attention.store.apply({
      id: this.attention.id(),
      kind: 'fact.updated',
      at: fact.observedAt,
      source: fact.source,
      subject: `self.body.${key}`,
      data: {
        path: `self.body.${key}`,
        value: fact.value,
        status: fact.status,
        ttlMs: fact.ttlMs,
        ...(key === 'thermal' && this.thermalRecovering ? { preserveSourceStatus: true } : {}),
        ...('unavailableMounts' in fact ? { unavailableMounts: fact.unavailableMounts } : {}),
      },
    });
  }
  private async sample(body: Body, at: number, mono: number): Promise<void> {
    if (this.stopped || this.paused()) return;
    const current = this.token || this.thermal ? this.attention.state().self.body : undefined;
    if (this.token && current) body.tokens = current.tokens;
    if (this.thermal && current) body.thermal = current.thermal;
    const tokenTime = this.token && this.expiry.factMeta('/self/body/tokens');
    if (tokenTime && current?.tokens.status === 'ok')
      this.rateTimes.context = { wall: current.tokens.observedAt, mono: tokenTime.observedMono };
    this.rateTimes = captureRateTimes(body, mono, at, this.rateTimes);
    const evaluated = structuredClone(body);
    for (const [key, metric] of Object.entries({
      cpu: 'cpu',
      memory: 'memory',
      battery: 'battery',
      network: 'network.rx',
      harnessProcess: 'rss',
      tokens: 'context',
    })) {
      const stamp = this.rateTimes[metric];
      if (stamp) evaluated[key as keyof Body].observedAt = at - (mono - stamp.mono);
    }
    for (const disk of evaluated.disks.value ?? []) {
      const stamp = this.rateTimes[`disk:${disk.mount}`];
      if (stamp) disk.observedAt = at - (mono - stamp.mono);
    }
    const diskTimes = (evaluated.disks.value ?? []).flatMap((disk) =>
      disk.observedAt === undefined ? [] : [disk.observedAt],
    );
    if (diskTimes.length) evaluated.disks.observedAt = Math.min(...diskTimes);
    if (this.thermal && evaluated.thermal.status === 'ok') evaluated.thermal.observedAt = at;
    if (
      evaluated.tokens.value &&
      (this.tokenSource === 'fallback' ||
        ('contextWindowSource' in evaluated.tokens.value && evaluated.tokens.value.contextWindowSource === 'fallback'))
    )
      delete evaluated.tokens.value.contextWindow;
    const next = { body: evaluated, at, monotonicAt: mono, source, rateTimes: this.rateTimes };
    this.sync();
    const pending: Promise<void>[] = [];
    let signals: Signal[] = [];
    await this.monitor.evaluateAuto(this.previous ?? next, next, this.state, (result, publish) => {
      this.state = result.state;
      this.previous = next;
      signals = [...result.signals];
      if (result.tuningError) {
        signals.push({
          id: this.attention.id(),
          kind: 'source.error',
          at,
          source,
          subject: 'body-tuning',
          data: { error: 'tuning-error' },
        });
      }
      this.expiry.withObservationTimes(this.rateTimes, () =>
        this.attention.batch(() => {
          for (const key of Object.keys(body) as (keyof Body)[]) {
            if ((key === 'tokens' && this.token) || (key === 'thermal' && this.thermal)) continue;
            this.write(key, body[key]);
          }
          for (const signal of signals) {
            signal.data.feedbackAvailable = false;
            pending.push(this.attention.accept(signal));
          }
          this.changed();
        }, publish),
      );
    });
    await Promise.all(pending);
    for (const signal of signals) this.register(signal);
  }
  private register(signal: Signal): void {
    if (this.stopped) return;
    const id = signal.data.ruleId;
    const rules = [...defaultRateRules(), ...defaultAnomalyRules()];
    const param =
      signal.kind === 'file.burst'
        ? signal.data.externalDeletionExceeded
          ? 'file.burst.maxDeleted'
          : 'file.burst.maxChanges'
        : rules.find((rule) => rule.id === id)?.param;
    if (typeof id === 'string' && param && signal.data.severity !== 'normal' && signal.cause !== 'agent') {
      void this.tuner.registerAlert(signal.id, id, param).then(
        () => this.changed(),
        () =>
          this.attention.accept({
            id: this.attention.id(),
            kind: 'source.error',
            at: this.clock.wall(),
            source,
            subject: 'body-tuning',
            data: { error: 'tuning-error' },
          }),
      );
    }
  }
}
