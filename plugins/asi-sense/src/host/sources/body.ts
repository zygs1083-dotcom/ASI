import { AsyncLocalStorage } from 'node:async_hooks';
import type { Body, BodyThresholdSample, BodyThresholdState, Fact, Signal } from '@asi/sense-types';
import { BODY_THRESHOLDS } from '../attention/thresholds.ts';
import {
  BodyMonitor,
  type BurstTarget,
  defaultAnomalyRules,
  defaultRateRules,
  FileBurstDetector,
  type ParameterSpec,
  Tuner,
} from '../body/index.ts';
import { captureRateTimes, type RateTimes } from '../body/rate.ts';
import { markTuningSnapshot, migrateTuningSnapshot } from '../body/tuning-migration.ts';
import type { RuntimeAttention } from '../runtime/attention.ts';
import type { FactExpiry } from '../runtime/expiry.ts';
import type { MetricTimeline } from '../runtime/metrics.ts';
import type { Clock, DshPort, ProbeFactory, StoragePort, TokenSnapshot } from '../runtime/ports.ts';
import { TokenFacts } from './token-facts.ts';

const source = { id: 'body', api: 'probe', host: 'local' };
const specs: Record<string, ParameterSpec> = {
  'rate.disk.maxDelta': { value: 2 * 1024 ** 3, min: 1, noiseDirection: 'up' },
  'rate.rss.maxRatio': { value: 0.5, min: 0.01, max: 10, noiseDirection: 'up' },
  'rate.context.maxEtaMs': { value: 600_000, min: 600_000, tighten: 'up', noiseDirection: 'down' },
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
const attentionSpecs: Record<string, ParameterSpec> = {
  mergeWindowMs: { value: 2_000, min: 1_000, max: 30_000 },
  fileMergeWindowMs: { value: 5_000, min: 1_000, max: 60_000 },
  'deliveryLevel.body.rate': { value: 'context', choices: ['record', 'context'] },
  'deliveryLevel.body.anomaly': { value: 'context', choices: ['record', 'context'] },
  'deliveryLevel.file.burst': { value: 'wake', choices: ['record', 'context', 'wake'] },
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
  private readonly tokenFacts: TokenFacts;
  private thermal?: Body['thermal'];
  private thermalRecovering = false;
  private burstScopes = '';
  private ruleScopes: string[] = [];
  private globalScope = false;
  private burstWindowMs = 60_000;
  private burstMaxChanges = 100;
  private burstMaxDeleted = 50;
  private readonly detector = new FileBurstDetector({
    threshold: (param, fallback) => {
      if (param === 'file.burst.windowMs') return this.burstWindowMs;
      if (param === 'file.burst.maxChanges') return this.burstMaxChanges;
      if (param === 'file.burst.maxDeleted') return this.burstMaxDeleted;
      return this.tuner.number(param, fallback);
    },
  });
  private readonly pendingBursts = new Set<Promise<void>>();
  private rateTimes: RateTimes = {};
  private rateSession?: string;

  constructor(
    factory: ProbeFactory,
    dsh: DshPort,
    storage: StoragePort,
    private readonly clock: Clock,
    private readonly attention: RuntimeAttention,
    private readonly expiry: FactExpiry,
    private readonly paused: () => boolean,
    private readonly changed: () => void,
    private readonly metrics?: MetricTimeline,
  ) {
    this.probe = factory.create();
    this.tokenFacts = new TokenFacts(
      dsh,
      clock,
      () => attention.state().self.body.tokens,
      (fact, mono) => {
        if (mono === undefined) this.write('tokens', fact);
        else
          this.expiry.withObservationTimes({ context: { wall: fact.observedAt, mono } }, () =>
            this.write('tokens', fact),
          );
      },
      changed,
    );
    const applyTuning = (restored = false) => {
      this.syncAttention(restored ? 'user' : undefined);
      changed();
    };
    this.tuner = new Tuner(
      { ...specs, ...attentionSpecs },
      {
        actor: () => this.identity.getStore() ?? 'agent',
        clock: () => clock.mono(),
        wallClock: () => clock.wall(),
        onChange: () => applyTuning(),
      },
    );
    let originalSnapshot: string | undefined;
    this.monitor = new BodyMonitor({
      tuner: this.tuner,
      contextSession: () => attention.sessionToken(attention.currentSessionId()),
      rateRules: defaultRateRules(),
      clock: () => clock.mono(),
      wallClock: () => clock.wall(),
      onTuningApplied: applyTuning,
      persistence: {
        load: async () => {
          originalSnapshot = await storage.load('body');
          return migrateTuningSnapshot(originalSnapshot, specs, attentionSpecs, () => clock.wall());
        },
        onRestoreFailure: async () => {
          if (originalSnapshot === undefined || !storage.backup) {
            throw Object.assign(new Error('body snapshot backup unavailable'), { code: 'BACKUP_UNAVAILABLE' });
          }
          let kind: 'corrupt' | 'unknown-version' = 'corrupt';
          try {
            const value = JSON.parse(originalSnapshot);
            if (value && typeof value === 'object' && 'version' in value && value.version !== 1 && value.version !== 2)
              kind = 'unknown-version';
          } catch {
            kind = 'corrupt';
          }
          const fileName = await storage.backup('body', originalSnapshot);
          // DSH has one writer per home; this check and the later save assume that boundary.
          if ((await storage.load('body')) !== originalSnapshot) {
            throw Object.assign(new Error('body snapshot changed after backup'), { code: 'SNAPSHOT_CHANGED' });
          }
          return { kind, fileName };
        },
        onBackupError: (code) => storage.reportBackupFailure?.(code),
        save: (value) => storage.save('body', markTuningSnapshot(value)),
      },
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
      const sessionId = this.attention.currentSessionId();
      const contextSession = this.attention.sessionToken(sessionId);
      const tokens = this.tokenFacts.hasReading ? this.attention.state().self.body.tokens : undefined;
      const tokenTime = tokens && this.expiry.factMeta('/self/body/tokens');
      const tokenSource = this.tokenFacts.source;
      this.enqueue(() => this.sample(body, at, mono, { sessionId, contextSession, tokens, tokenTime, tokenSource }));
    });
    this.intervalMs = intervalMs;
    await this.setPaused(this.paused());
  }
  async setPaused(paused: boolean): Promise<void> {
    if (paused) this.tokenFacts.pause();
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
  private syncAttention(actor: 'agent' | 'user' = this.identity.getStore() ?? 'agent'): void {
    if (this.stopped) return;
    this.burstWindowMs = this.tuner.number('file.burst.windowMs', 60_000);
    this.burstMaxChanges = this.tuner.number('file.burst.maxChanges', 100);
    this.burstMaxDeleted = this.tuner.number('file.burst.maxDeleted', 50);
    const pipeline = this.attention.pipeline;
    pipeline.setMergeWindows(this.tuner.number('mergeWindowMs', 2_000), this.tuner.number('fileMergeWindowMs', 5_000));
    pipeline.setDeliveryLevels(
      {
        'body.rate': this.tuner.get('deliveryLevel.body.rate') as 'record' | 'context',
        'body.anomaly': this.tuner.get('deliveryLevel.body.anomaly') as 'record' | 'context',
        'file.burst': this.tuner.get('deliveryLevel.file.burst') as 'record' | 'context' | 'wake',
      },
      actor,
    );
    this.attention.refreshFeedback((id) => this.tuner.hasAlert(id));
    this.attention.rescheduleDelivery();
  }
  sessionsChanged(present: boolean): void {
    this.tokenFacts.sessionsChanged(present);
  }
  tokens(session: string, valid: () => boolean = () => true): Promise<void> {
    return this.tokenFacts.tokens(session, valid);
  }
  sessionToken(session: string): Body['tokens'] {
    return this.tokenFacts.fact(session);
  }
  selectSession(session?: string): void {
    this.tokenFacts.select(session);
  }
  disposeSession(session: string): void {
    this.tokenFacts.dispose(session);
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
  setScopes(scopes: string[]): void {
    // Dedupe so a spellings-union cannot split burst windows.
    this.ruleScopes = [...new Set(scopes)];
    this.syncScopes();
  }
  setGlobalScope(enabled: boolean): void {
    if (this.globalScope === enabled) return;
    this.globalScope = enabled;
    this.syncScopes();
  }
  private syncScopes(): void {
    const ordered = [...new Set(this.globalScope ? [...this.ruleScopes, 'global'] : this.ruleScopes)].sort();
    const key = JSON.stringify(ordered);
    if (key === this.burstScopes) return;
    this.burstScopes = key;
    this.detector.setScopes(ordered);
  }
  burst(signal: Signal, dirs?: readonly BurstTarget[], receivedMono = this.clock.mono()): Promise<void> | undefined {
    if (this.stopped) return undefined;
    const emitted = this.detector.accept(signal, receivedMono, dirs);
    if (emitted.length === 0) return undefined;
    const work = (async () => {
      for (const burst of emitted) {
        burst.data.feedbackAvailable = false;
        await this.attention.accept(burst);
        this.register(burst);
      }
    })();
    this.pendingBursts.add(work);
    void work.finally(() => this.pendingBursts.delete(work));
    return work;
  }
  async stop(): Promise<void> {
    this.stopped = true;
    const tokens = this.tokenFacts.stop();
    this.off?.();
    if (this.sampling) await this.probe.stop();
    this.sampling = false;
    await Promise.allSettled([this.tail, ...this.pendingBursts]);
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
        ...(fact.reason === undefined ? {} : { reason: fact.reason }),
        ...(key === 'thermal' && this.thermalRecovering ? { preserveSourceStatus: true } : {}),
        ...('unavailableMounts' in fact ? { unavailableMounts: fact.unavailableMounts } : {}),
      },
    });
  }
  private async sample(
    body: Body,
    at: number,
    mono: number,
    captured: {
      sessionId?: string;
      contextSession?: string;
      tokens?: Body['tokens'];
      tokenTime?: ReturnType<FactExpiry['factMeta']>;
      tokenSource: TokenSnapshot['contextWindowSource'];
    },
  ): Promise<void> {
    if (this.stopped || this.paused()) return;
    // In-memory only: folding this sample into the metric buckets never awaits or touches disk.
    this.metrics?.record(body, at);
    const { sessionId, contextSession, tokens, tokenTime, tokenSource } = captured;
    const current = this.thermal ? this.attention.state().self.body : undefined;
    if (tokens) body.tokens = tokens;
    if (this.thermal && current) body.thermal = current.thermal;
    if (this.rateSession !== contextSession) {
      delete this.rateTimes.context;
      this.rateSession = contextSession;
    }
    if (tokenTime && tokens?.status === 'ok')
      this.rateTimes.context = { wall: tokens.observedAt, mono: tokenTime.observedMono };
    this.rateTimes = captureRateTimes(body, mono, at, this.rateTimes);
    const evaluated = structuredClone(body);
    if (contextSession && this.attention.sessionToken(sessionId) !== contextSession) {
      evaluated.tokens.value = null;
      evaluated.tokens.status = 'unknown';
    }
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
      (tokenSource === 'fallback' ||
        ('contextWindowSource' in evaluated.tokens.value && evaluated.tokens.value.contextWindowSource === 'fallback'))
    )
      delete evaluated.tokens.value.contextWindow;
    const next = {
      body: evaluated,
      at,
      monotonicAt: mono,
      source,
      rateTimes: this.rateTimes,
      contextSession,
      contextSessions: this.attention.activeSessionTokens(),
    };
    this.sync();
    const pending: Promise<void>[] = [];
    let signals: Signal[] = [];
    const commit: NonNullable<Parameters<typeof this.monitor.evaluateAuto>[3]> = (result, publish) => {
      this.state = result.state;
      this.previous = next;
      signals = result.signals;
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
            if ((key === 'tokens' && tokens) || (key === 'thermal' && this.thermal)) continue;
            this.write(key, key === 'tokens' ? this.tokenFacts.decorate(body.tokens) : body[key]);
          }
          for (const signal of signals) {
            signal.data.feedbackAvailable = false;
            if (
              (signal.kind === 'body.threshold' && signal.subject === 'context') ||
              (signal.kind === 'body.rate' && signal.data.metric === 'context')
            ) {
              signal.data.sessionId = sessionId;
              signal.data.sessionToken = contextSession;
            }
            pending.push(this.attention.accept(signal));
          }
          this.changed();
        }, publish),
      );
    };
    await this.monitor.evaluateAuto(this.previous ?? next, next, this.state, commit, this.clock);
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
        () => this.syncAttention(),
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
