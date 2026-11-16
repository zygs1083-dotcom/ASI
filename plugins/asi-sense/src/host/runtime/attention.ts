import { randomUUID } from 'node:crypto';
import type { DeliveryLevel, SenseState, Signal, SignalCause, SourceRef, WatchRule } from '@asi/sense-types';
import { DeliveryFailure } from '../attention/drain.ts';
import { injectOutcomes } from '../attention/drain-transfer.ts';
import { AttentionPipeline, type SessionContext } from '../attention/pipeline.ts';
import { isRuleApproved, selectRule } from '../attention/rules.ts';
import { sourceObservation } from '../state/source-health.ts';
import { StateStore } from '../state/store.ts';
import { eventDetail } from './event-detail.ts';
import type { FactExpiry } from './expiry.ts';
import { PendingContext, withoutTitles } from './pending-context.ts';
import type { Clock, DshPort } from './ports.ts';

export interface EventEntry {
  id: string;
  kind: string;
  subject: string;
  level: DeliveryLevel;
  reason?: string;
  ruleId?: string;
  cause?: SignalCause;
  at: number;
  mono?: number;
  restarts?: number;
  source: SourceRef;
  detail?: Record<string, string | number | boolean>;
  currentEta?: { asOf: number; ratePerMinute: number; timeToThresholdMs?: number };
  feedback?: 'useful' | 'noise';
}
export type EventLog = EventEntry[];

export class RuntimeAttention {
  readonly store: StateStore;
  readonly pipeline: AttentionPipeline;
  private readonly entries: EventLog = [];
  private batchEntries?: EventLog;
  private readonly pending = new PendingContext((...args) => this.mark(...args));
  private readonly sessions = new Map<string, SessionContext>();
  private readonly recent: string[] = [];
  private readonly inflight = new Set<Promise<void>>();
  private selected?: string;
  private selectionGeneration = 0;
  private sequence = 0;
  private stopped = false;
  private readonly prefix = randomUUID();
  private readonly offCommit?: () => void;

  constructor(
    private readonly clock: Clock,
    dsh: DshPort,
    private readonly rules: () => WatchRule[],
    private readonly reschedule: () => void,
    private readonly titlesAllowed: () => boolean,
    readonly changed: () => void,
    expiry: FactExpiry,
  ) {
    const staged = dsh as DshPort & { onDeliveryCommitted?: (cb: (session: string, id: string) => void) => () => void };
    this.store = new StateStore(
      () => clock.wall(),
      60_000,
      () => clock.mono(),
      expiry,
    );
    this.pipeline = new AttentionPipeline({
      store: this.store,
      rules: rules(),
      clock: () => clock.mono(),
      wallClock: () => clock.wall(),
      isCurrent: () => {
        const generation = this.selectionGeneration;
        return (id) =>
          !this.stopped && generation === this.selectionGeneration && this.selected === id && this.sessions.has(id);
      },
      deliverer: {
        deliver: async (intent) => {
          if (this.stopped) throw new Error('stopped');
          const safe = structuredClone(intent);
          if (!this.titlesAllowed()) {
            for (const change of safe.update.changes) {
              change.signal.data = withoutTitles(change.signal.data) as Signal['data'];
            }
          }
          if (intent.kind === 'inject' && this.offCommit) this.pending.stage(intent);
          const delivery = dsh.deliver(intent.sessionId, safe);
          this.inflight.add(delivery);
          try {
            await delivery;
          } finally {
            this.inflight.delete(delivery);
          }
          if (intent.kind === 'inject' && staged.onDeliveryCommitted) throw new DeliveryFailure('deferred');
          if (this.stopped) return;
          for (const outcome of injectOutcomes(intent)) {
            for (const id of outcome.ids) this.mark(id, outcome.reason, outcome.level);
          }
        },
      },
    });
    this.offCommit = staged.onDeliveryCommitted?.((session, id) => this.pending.committed(session, id, this.pipeline));
  }

  id(): string {
    return `${this.prefix}:${++this.sequence}`;
  }
  state(): SenseState {
    return this.store.snapshot();
  }
  batch<T>(work: () => T, publish: () => void): T {
    this.batchEntries = structuredClone(this.entries);
    return this.store.batch(work, () => {
      this.batchEntries = undefined;
      publish();
    });
  }
  events(): EventLog {
    const events = structuredClone(this.batchEntries ?? this.entries);
    if (!this.titlesAllowed()) {
      for (const entry of events) {
        if (!entry.kind.startsWith('window')) continue;
        entry.subject = '';
        delete entry.reason;
        delete entry.ruleId;
        delete entry.detail;
      }
    }
    return events;
  }
  current(): string | undefined {
    return this.selected;
  }
  feedback(id: string, verdict: 'useful' | 'noise'): void {
    const entry = this.entries.find((item) => item.id === id);
    if (entry) {
      entry.feedback = verdict;
      this.changed();
    }
  }
  isStopped(): boolean {
    return this.stopped;
  }
  stop(): Promise<void> {
    this.stopped = true;
    this.offCommit?.();
    return Promise.allSettled([...this.inflight, this.pending.settled()]).then(() => {});
  }
  create(id: string): void {
    this.sessions.set(id, { id, busy: false, userInitiated: false });
  }
  dispose(id: string): void {
    this.sessions.delete(id);
    this.pipeline.disposeSession(id);
    this.pending.suspend(id, this.pipeline);
    const index = this.recent.indexOf(id);
    if (index >= 0) this.recent.splice(index, 1);
    if (this.selected === id) {
      this.selected = this.recent.at(-1);
      this.selectionGeneration++;
      if (this.selected) void this.pipeline.retarget(this.selected);
    }
    this.reschedule();
  }
  async preStep(id: string, userInitiated = false, drain = true): Promise<void> {
    if (this.stopped) return;
    const session = this.sessions.get(id);
    if (!session) return;
    const generation = ++this.selectionGeneration;
    this.selected = id;
    const index = this.recent.indexOf(id);
    if (index >= 0) this.recent.splice(index, 1);
    this.recent.push(id);
    session.busy = true;
    session.userInitiated = userInitiated;
    this.pipeline.setSession(session);
    if (!drain) return;
    await this.pending.settled();
    await this.pipeline.retarget(id);
    if (this.stopped || generation !== this.selectionGeneration || this.selected !== id) return;
    let entry = this.pending.take();
    while (entry) {
      if ('batch' in entry) await this.pipeline.restore(id, entry.batch);
      else await this.pipeline.acceptCount(entry.signal, session, entry.count, entry.other);
      if (this.stopped || generation !== this.selectionGeneration || this.selected !== id) return;
      entry = this.pending.take();
    }
    try {
      await this.pipeline.preStep(id);
    } finally {
      this.reschedule();
    }
  }
  postStep(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    session.busy = false;
    session.userInitiated = false;
    this.pipeline.setSession(session);
  }
  async accept(signal: Signal): Promise<void> {
    if (this.stopped) return;
    const mono = this.clock.mono() - Math.max(0, this.clock.wall() - signal.at);
    const session = this.selected && this.sessions.get(this.selected);
    if (!session) {
      const prior = this.store.snapshot().observation.sources[signal.source.id];
      await new Promise<void>((resolve, reject) =>
        this.store.apply(signal, (result) => {
          try {
            if (result !== 'applied') {
              this.log({ signal, level: 'record', reason: result === 'older' ? 'older-sequence' : 'duplicate' }, mono);
              resolve();
              return;
            }
            const rule = signal.cause === 'agent' ? undefined : selectRule(this.rules(), signal, this.clock.wall());
            let level = rule?.level ?? 'record';
            let reason = signal.cause === 'agent' ? 'self-caused' : undefined;
            if (level === 'wake' && rule && !isRuleApproved(rule)) {
              level = 'context';
              reason = 'rule-pending-approval';
            }
            if (
              (signal.kind === 'source.status' || signal.kind === 'source.error') &&
              prior?.status === sourceObservation(signal).status
            ) {
              level = 'record';
            }
            if (level === 'wake') reason = 'no-session';
            if (level === 'context') {
              const evicted = this.pending.add(signal);
              if (evicted !== undefined) reason = `pending-evicted:${evicted}`;
            }
            this.log({ signal, level, ruleId: rule?.id, reason }, mono);
            resolve();
          } catch (error) {
            reject(error);
          }
        }),
      );
      return;
    }
    await this.pipeline.accept(signal, session, (change) => {
      this.log(change, mono);
      this.reschedule();
    });
  }
  async flush(): Promise<void> {
    try {
      this.pipeline.pruneSessions();
      if (this.selected) {
        await this.pipeline.retarget(this.selected);
        if (!this.stopped && this.selected) await this.pipeline.flush();
      }
    } finally {
      this.reschedule();
    }
  }
  private log(change: { signal: Signal; level: DeliveryLevel; ruleId?: string; reason?: string }, mono: number): void {
    const { signal, level, ruleId, reason } = change;
    const sourceReason =
      signal.kind === 'source.status' && typeof signal.data.reason === 'string'
        ? signal.data.reason
        : signal.kind === 'source.error' && typeof signal.data.error === 'string'
          ? `${signal.data.error}${typeof signal.data.dropped === 'number' ? ` (dropped=${signal.data.dropped})` : ''}`
          : undefined;
    const restarts = typeof signal.data.restarts === 'number' ? signal.data.restarts : undefined;
    const detail = eventDetail(signal);
    const slope = signal.kind === 'body.rate' && typeof detail?.slope === 'number' ? detail.slope : undefined;
    const eta = typeof detail?.timeToFloorMs === 'number' ? detail.timeToFloorMs : undefined;
    this.entries.push({
      id: signal.id,
      kind: signal.kind,
      subject: signal.subject,
      at: signal.at,
      mono,
      level: this.offCommit && level !== 'record' && reason !== 'no-session' ? 'record' : level,
      ruleId,
      reason: reason ?? sourceReason,
      cause: signal.cause,
      restarts,
      source: { ...signal.source },
      ...(detail ? { detail } : {}),
      ...(slope === undefined
        ? {}
        : {
            currentEta: {
              asOf: signal.at,
              ratePerMinute: slope * 60,
              ...(eta === undefined ? {} : { timeToThresholdMs: eta }),
            },
          }),
    });
    if (this.entries.length > 200) this.entries.shift();
    this.changed();
  }
  private mark(id: string, reason?: string, level?: DeliveryLevel): void {
    const entry = this.entries.find((item) => item.id === id);
    if (!entry) return;
    if (reason !== undefined) entry.reason = reason;
    if (level !== undefined) entry.level = level;
    this.changed();
  }
}
