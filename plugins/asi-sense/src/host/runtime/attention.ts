import { randomUUID } from 'node:crypto';
import type { DeliveryLevel, SenseState, Signal, SignalCause, SourceRef, WatchRule } from '@asi/sense-types';
import { isSessionContext, isSessionOwned } from '../attention/buckets.ts';
import { DeliveryFailure } from '../attention/drain.ts';
import { injectOutcomes } from '../attention/drain-transfer.ts';
import { AttentionPipeline, type SessionContext } from '../attention/pipeline.ts';
import { isRuleApproved } from '../attention/rules.ts';
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
  feedbackAvailable?: boolean;
}
export type EventLog = EventEntry[];

export class RuntimeAttention {
  readonly store: StateStore;
  readonly pipeline: AttentionPipeline;
  private readonly entries: EventLog = [];
  private batchEntries?: EventLog;
  private readonly pending = new PendingContext(this.mark.bind(this), (id) => this.entries.some((e) => e.id === id));
  private readonly sessions = new Map<string, SessionContext>();
  private readonly sessionTokens = new Map<string, string>();
  private readonly recent: string[] = [];
  private readonly closed = new Map<string, boolean>();
  private readonly inflight = new Set<Promise<void>>();
  private selected?: string;
  private pinned?: string;
  private privateStep?: string;
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
    private readonly ensureTarget?: () => Promise<void>,
    canEnsureTarget?: () => boolean,
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
          !this.stopped &&
          generation === this.selectionGeneration &&
          (this.selected === id || this.privateStep === id) &&
          this.sessions.has(id);
      },
      isWakeOwner: (id) => !this.stopped && this.sessions.has(id) && !this.closed.has(id),
      isPendingTarget: (id) => !this.stopped && this.pinned === id && !this.closed.has(id) && !!canEnsureTarget?.(),
      deliverer: {
        deliver: async (intent) => {
          if (this.stopped) throw new Error('stopped');
          const safe = structuredClone(intent);
          safe.update.changes = safe.update.changes.filter(
            ({ signal }) =>
              (!isSessionContext(signal) && (signal.source.id !== 'dsh' || !signal.kind.startsWith('job.'))) ||
              (signal.data.sessionId === intent.sessionId &&
                typeof signal.data.sessionToken === 'string' &&
                signal.data.sessionToken === this.sessionTokens.get(intent.sessionId)),
          );
          if (!safe.update.changes.length) throw new DeliveryFailure('exhausted');
          for (const { signal } of safe.update.changes) {
            if (isSessionContext(signal)) delete signal.data.sessionToken;
            if (signal.source.id === 'dsh' && signal.kind.startsWith('job.')) {
              signal.subject = typeof signal.data.id === 'string' ? signal.data.id : 'job';
              delete signal.data.command;
              delete signal.data.path;
              delete signal.data.sessionId;
              delete signal.data.sessionToken;
            }
          }
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
    this.offCommit = staged.onDeliveryCommitted?.((session, id) => {
      void this.pending.committed(session, id, this.pipeline).then(() => {
        if (!this.stopped) this.reschedule();
      });
    });
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
    return this.currentSessionId();
  }
  hasSession(id: string): boolean {
    return !this.stopped && this.sessions.has(id) && !this.closed.has(id);
  }
  currentSessionId(): string | undefined {
    return this.selected;
  }
  targetMode(): 'auto' | 'pinned' {
    return this.pinned ? 'pinned' : 'auto';
  }
  recordTargetReset(): void {
    this.log(
      {
        signal: {
          id: this.id(),
          kind: 'delivery.target-unavailable',
          at: this.clock.wall(),
          source: { id: 'delivery', api: 'dsh', host: 'local' },
          subject: 'delivery-target',
          data: {},
        },
        level: 'record',
      },
      this.clock.mono(),
    );
  }
  async setTarget(id: string | undefined): Promise<void> {
    if (id && (!this.sessions.has(id) || this.closed.has(id))) throw new Error('target session unavailable');
    this.pinned = id;
    this.privateStep = undefined;
    this.selected = id ?? this.recent.at(-1);
    const generation = ++this.selectionGeneration;
    if (this.selected) {
      const session = this.sessions.get(this.selected);
      if (session) this.pipeline.setSession(session);
      await this.transfer(this.selected, generation);
    }
    this.reschedule();
    this.changed();
  }
  async closeSession(id: string): Promise<void> {
    this.closed.set(id, false);
    const index = this.recent.indexOf(id);
    if (index >= 0) this.recent.splice(index, 1);
    if (this.selected === id && this.pinned !== id) await this.setTarget(undefined);
  }
  availableSessions(ids: readonly string[]): void {
    const available = new Set(ids);
    for (const [id, absent] of this.closed) {
      if (!available.has(id)) this.closed.set(id, true);
      else if (absent) this.closed.delete(id);
    }
  }
  sessionToken(id: string | undefined): string | undefined {
    return id === undefined ? undefined : this.sessionTokens.get(id);
  }
  activeSessionTokens(): string[] {
    return [...this.sessionTokens.values()];
  }
  feedback(id: string, verdict: 'useful' | 'noise'): void {
    const entry = this.entries.find((item) => item.id === id);
    if (entry) {
      entry.feedback = verdict;
      this.changed();
    }
  }
  refreshFeedback(available: (id: string) => boolean): void {
    this.pipeline.refreshFeedback(available);
    this.pending.refreshFeedback(available);
    for (const entry of this.entries) {
      if (entry.feedbackAvailable !== undefined) entry.feedbackAvailable = available(entry.id);
    }
    this.changed();
  }
  rescheduleDelivery(): void {
    this.reschedule();
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
    if (this.sessions.has(id)) this.pipeline.disposeSession(id, this.sessionTokens.get(id));
    this.sessions.set(id, { id, busy: false, userInitiated: false });
    this.sessionTokens.set(id, randomUUID());
  }
  dispose(id: string): void {
    const token = this.sessionTokens.get(id);
    this.sessions.delete(id);
    this.sessionTokens.delete(id);
    this.pipeline.disposeSession(id, token);
    this.pending.suspend(id, this.pipeline);
    const index = this.recent.indexOf(id);
    if (index >= 0) this.recent.splice(index, 1);
    if (this.selected === id) {
      this.selected = this.recent.at(-1);
      this.selectionGeneration++;
      if (this.selected) void this.pipeline.retarget(this.selected).then(this.reschedule, this.reschedule);
    }
    this.reschedule();
  }
  async preStep(id: string, userInitiated = false, drain = true): Promise<void> {
    if (this.stopped || this.closed.has(id)) return;
    const session = this.sessions.get(id);
    if (!session) return;
    if (this.needsRestore()) {
      await this.ensureTarget?.();
      if (this.stopped || this.sessions.get(id) !== session || this.closed.has(id)) return;
    }
    const generation = ++this.selectionGeneration;
    const index = this.recent.indexOf(id);
    if (index >= 0) this.recent.splice(index, 1);
    this.recent.push(id);
    this.selected = this.pinned && this.sessions.has(this.pinned) && !this.closed.has(this.pinned) ? this.pinned : id;
    this.privateStep = this.selected === id ? undefined : id;
    session.busy = true;
    session.userInitiated = userInitiated;
    this.pipeline.setSession(session);
    if (!drain) {
      this.privateStep = undefined;
      return;
    }
    const selected = this.selected;
    if (!(await this.transfer(selected, generation))) return;
    try {
      await this.pipeline.preStep(id);
    } finally {
      if (generation === this.selectionGeneration) this.privateStep = undefined;
      this.reschedule();
    }
  }
  private async transfer(id: string, generation: number): Promise<boolean> {
    await this.pending.settled();
    if (this.stopped || generation !== this.selectionGeneration || this.selected !== id) return false;
    await this.pipeline.retarget(id);
    if (this.stopped || generation !== this.selectionGeneration || this.selected !== id) return false;
    const session = this.sessions.get(id);
    if (!session) return false;
    let entry = this.pending.take();
    while (entry) {
      if ('batch' in entry) await this.pipeline.restore(id, entry.batch);
      else await this.pipeline.acceptCount(entry.signal, session, entry.count, entry.other, entry.classification);
      if (this.stopped || generation !== this.selectionGeneration || this.selected !== id) return false;
      entry = this.pending.take();
    }
    return true;
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
    const evaluated = signal.kind === 'body.rate' ? signal.data.evaluationMono : undefined;
    const mono =
      typeof evaluated === 'number' && Number.isFinite(evaluated)
        ? evaluated
        : this.clock.mono() - Math.max(0, this.clock.wall() - signal.at);
    const job = signal.source.id === 'dsh' && signal.kind.startsWith('job.');
    if (isSessionOwned(signal) || job) {
      const owner = typeof signal.data.sessionId === 'string' ? signal.data.sessionId : undefined;
      const token = signal.data.sessionToken;
      const session =
        owner && typeof token === 'string' && token === this.sessionTokens.get(owner)
          ? this.sessions.get(owner)
          : undefined;
      if (session) {
        await this.pipeline.accept(
          signal,
          session,
          (change) => {
            this.log(change, mono);
            this.reschedule();
          },
          () =>
            !this.stopped &&
            owner !== undefined &&
            this.sessions.get(owner) === session &&
            this.sessionTokens.get(owner) === token,
        );
      } else {
        if (owner) {
          this.log(
            { signal, level: 'record', reason: signal.cause === 'agent' ? 'self-caused' : 'session-private' },
            mono,
          );
          return;
        }
        await new Promise<void>((resolve) =>
          this.store.apply(signal, () => {
            this.log({ signal, level: 'record', reason: 'session-private' }, mono);
            resolve();
          }),
        );
      }
      return;
    }
    if (this.needsRestore() && signal.cause !== 'agent') {
      const level = this.pipeline.selectRule(signal, this.rules())?.level;
      if (level && level !== 'record') await this.ensureTarget?.();
    }
    if (this.stopped) return;
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
            const rule = signal.cause === 'agent' ? undefined : this.pipeline.selectRule(signal, this.rules());
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
              const evicted = this.pending.add(signal, { rule, reason });
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
      if (this.needsRestore()) {
        await this.pipeline.flushOwned();
        await this.ensureTarget?.();
      }
      if (this.selected) await this.pipeline.retarget(this.selected);
      if (!this.stopped) await this.pipeline.flush();
    } finally {
      this.reschedule();
    }
  }
  private needsRestore(): boolean {
    return !!this.pinned && (this.selected !== this.pinned || !this.sessions.has(this.pinned));
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
      ...(typeof signal.data.feedbackAvailable === 'boolean'
        ? { feedbackAvailable: signal.data.feedbackAvailable }
        : {}),
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
    if (this.entries.length > 200) this.pending.forget(this.entries.shift()?.id);
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
