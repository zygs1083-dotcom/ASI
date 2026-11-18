import { randomUUID } from 'node:crypto';
import type { DeliveryLevel, SenseState, Signal, SignalCause, SourceRef, WatchRule } from '@asi/sense-types';
import { isSessionContext, isSessionOwned } from '../attention/buckets.ts';
import { DeliveryFailure } from '../attention/drain.ts';
import { injectOutcomes } from '../attention/drain-transfer.ts';
import { AttentionPipeline, type SessionContext } from '../attention/pipeline.ts';
import { isRuleApproved } from '../attention/rules.ts';
import { formatEnvUpdate } from '../delivery/format.ts';
import { sourceObservation } from '../state/source-health.ts';
import { StateStore } from '../state/store.ts';
import { eventDetail } from './event-detail.ts';
import type { FactExpiry } from './expiry.ts';
import { PendingContext, withoutTitles } from './pending-context.ts';
import type { Clock, DshPort } from './ports.ts';

export interface AttentionHistorySink {
  recordEvent(entry: EventEntry, meta?: { bundleId?: string; title?: string }): void;
  patchEvent(
    id: string,
    patch: { at?: number; level?: DeliveryLevel; reason?: string; feedback?: 'useful' | 'noise' },
  ): void;
}
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
  detail?: Record<string, string | number | boolean | string[]>;
  currentEta?: { asOf: number; ratePerMinute: number; timeToThresholdMs?: number };
  feedback?: 'useful' | 'noise';
  feedbackAvailable?: boolean;
  restored?: boolean;
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
  private readonly activeWakeSkips = new Map<string, boolean>();
  private selected?: string;
  private pinned?: string;
  private readonly steps = new Map<string, symbol>();
  private selectionGeneration = 0;
  private sequence = 0;
  private stopped = false;
  private readonly prefix = randomUUID();
  private readonly offCommit?: () => void;
  private readonly offSkip?: () => void;
  private readonly offDiscard?: () => void;

  constructor(
    private readonly clock: Clock,
    dsh: DshPort,
    private readonly rules: () => WatchRule[],
    private readonly reschedule: () => void,
    private readonly titlesAllowed: () => boolean,
    readonly changed: () => void,
    expiry: FactExpiry,
    private readonly ensureTarget?: () => void,
    private readonly canEnsureTarget?: () => boolean,
    private readonly history?: AttentionHistorySink,
    platform: string = process.platform,
  ) {
    const staged = dsh as DshPort & {
      onDeliveryCommitted?: (cb: (session: string, id: string) => void) => () => void;
      onDeliverySkipped?: (
        cb: (session: string, id: string, kind: 'inject' | 'followup' | 'send') => void | Promise<void>,
      ) => () => void;
    };
    this.store = new StateStore(
      () => clock.wall(),
      60_000,
      () => clock.mono(),
      expiry,
    );
    this.pipeline = new AttentionPipeline({
      store: this.store,
      rules: rules(),
      platform,
      clock: () => clock.mono(),
      wallClock: () => clock.wall(),
      isCurrent: () => {
        const generation = this.selectionGeneration;
        const steps = new Map(this.steps);
        return (id) =>
          !this.stopped &&
          !this.closed.has(id) &&
          ((generation === this.selectionGeneration && this.selected === id) ||
            (steps.has(id) && steps.get(id) === this.steps.get(id))) &&
          this.sessions.has(id);
      },
      isTarget: (id) => this.selected === id,
      isDeliveryProtected: (id, deliveryId) => dsh.isDeliveryProtected?.(id, deliveryId) ?? false,
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
          const includeWindowTitles = this.titlesAllowed();
          if (!includeWindowTitles) {
            safe.update.changes = safe.update.changes
              .filter(
                ({ signal }) =>
                  signal.kind !== 'window.focused' &&
                  signal.kind !== 'window.title-changed' &&
                  !(signal.kind === 'fact.updated' && signal.data.path === 'env.focusedWindow'),
              )
              .map((change) => ({
                ...change,
                signal: { ...change.signal, data: withoutTitles(change.signal.data) as Signal['data'] },
              }));
          }
          const empty =
            !includeWindowTitles &&
            !formatEnvUpdate(safe.update, { includeWindowTitles: false, includeJobCommands: false });
          if (empty && (intent.kind !== 'inject' || !staged.onDeliverySkipped)) {
            if (intent.kind === 'inject' && this.offCommit) this.pending.unstage(intent);
            if (!this.offCommit) {
              for (const outcome of injectOutcomes(intent)) {
                for (const id of outcome.ids) this.mark(id, undefined, 'record');
              }
            }
            throw new DeliveryFailure('skipped');
          }
          if (intent.kind === 'inject' && this.offCommit) this.pending.stage(intent);
          const token = this.sessionTokens.get(intent.sessionId);
          const isCurrent = () =>
            this.hasSession(intent.sessionId) && this.sessionTokens.get(intent.sessionId) === token;
          const skipKey =
            intent.kind !== 'inject' && intent.deliveryId
              ? JSON.stringify([intent.sessionId, `asi-sense:${intent.deliveryId}`])
              : undefined;
          if (skipKey) this.activeWakeSkips.set(skipKey, false);
          let wakeSkipped = false;
          const delivery = dsh.deliver(intent.sessionId, safe, isCurrent);
          this.inflight.add(delivery);
          try {
            await delivery;
          } catch (error) {
            if (!isCurrent()) {
              for (const outcome of injectOutcomes(intent)) {
                for (const id of outcome.ids) this.mark(id, 'session-closed', 'record');
              }
            }
            throw error;
          } finally {
            this.inflight.delete(delivery);
            if (skipKey) {
              wakeSkipped = this.activeWakeSkips.get(skipKey) === true;
              this.activeWakeSkips.delete(skipKey);
            }
          }
          if (wakeSkipped) {
            if (!this.offCommit) {
              for (const outcome of injectOutcomes(intent)) {
                for (const id of outcome.ids) this.mark(id, undefined, 'record');
              }
            }
            throw new DeliveryFailure('skipped');
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
    this.offSkip = staged.onDeliverySkipped?.((session, id, kind) => {
      if (kind !== 'inject') {
        const key = JSON.stringify([session, id]);
        if (this.activeWakeSkips.has(key)) this.activeWakeSkips.set(key, true);
        return;
      }
      return this.pending.skipped(session, id, this.pipeline).then(() => {
        if (!this.stopped) this.reschedule();
      });
    });
    this.offDiscard = dsh.onStepDiscarded?.(() => {
      if (this.selected && !this.stopped)
        void this.pipeline.retarget(this.selected).then(this.reschedule, this.reschedule);
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
  restoreEntries(entries: readonly EventEntry[]): void {
    const restored = entries.slice(-200).map((entry) => {
      const copy = structuredClone(entry) as EventEntry & { bundleId?: unknown; title?: unknown };
      delete copy.bundleId;
      delete copy.title;
      return {
        ...copy,
        restored: true,
      };
    });
    const live = this.entries.filter((entry) => !entry.restored);
    const combined = [...restored, ...live].slice(-200);
    this.entries.splice(0, this.entries.length, ...combined);
    this.changed();
  }
  clearEvents(): void {
    this.entries.length = 0;
    if (this.batchEntries) this.batchEntries.length = 0;
    this.changed();
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
    this.steps.delete(id);
    if (this.selected === id) this.selectionGeneration++;
    const token = this.sessionTokens.get(id);
    if (token !== undefined) {
      this.sessionTokens.set(id, randomUUID());
      this.pipeline.disposeSession(id, token);
    }
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
      this.history?.patchEvent(id, { at: entry.at, feedback: verdict });
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
    this.offSkip?.();
    this.offDiscard?.();
    return Promise.allSettled([...this.inflight, this.pending.settled()]).then(() => {});
  }
  create(id: string): void {
    if (this.sessions.has(id)) this.pipeline.disposeSession(id, this.sessionTokens.get(id));
    this.sessions.set(id, { id, busy: false, userInitiated: false });
    this.sessionTokens.set(id, randomUUID());
  }
  dispose(id: string): void {
    this.steps.delete(id);
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
    if (this.needsRestore()) this.ensureTarget?.();
    const generation = ++this.selectionGeneration;
    const step = Symbol();
    this.steps.set(id, step);
    const index = this.recent.indexOf(id);
    if (index >= 0) this.recent.splice(index, 1);
    this.recent.push(id);
    this.selected =
      this.pinned && this.sessions.has(this.pinned) && !this.closed.has(this.pinned) && !this.canEnsureTarget?.()
        ? this.pinned
        : id;
    session.busy = true;
    session.userInitiated = userInitiated;
    this.pipeline.setSession(session);
    if (!drain) {
      if (this.steps.get(id) === step) this.steps.delete(id);
      return;
    }
    const selected = this.selected;
    try {
      await this.transfer(selected, generation);
      if (this.stopped || this.steps.get(id) !== step || this.sessions.get(id) !== session) return;
      await this.pipeline.preStep(id);
    } finally {
      if (this.steps.get(id) === step) this.steps.delete(id);
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
        owner && !this.closed.has(owner) && typeof token === 'string' && token === this.sessionTokens.get(owner)
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
            !this.closed.has(owner) &&
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
      if (level && level !== 'record') this.ensureTarget?.();
    }
    if (this.stopped) return;
    const session = this.selected && this.sessions.get(this.selected);
    if (!session) {
      const priorStatus = this.store.sourceStatus(signal.source.id);
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
              priorStatus === sourceObservation(signal).status
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
  async acceptBatch(signals: readonly Signal[]): Promise<void> {
    if (this.stopped || signals.length === 0) return;
    if (
      signals.length === 1 ||
      signals.some((s) => isSessionOwned(s) || (s.source.id === 'dsh' && s.kind.startsWith('job.')))
    ) {
      for (const s of signals) await this.accept(s);
      return;
    }
    const rules = this.rules();
    if (this.needsRestore()) {
      for (const signal of signals) {
        if (signal.cause !== 'agent') {
          const level = this.pipeline.selectRule(signal, rules)?.level;
          if (level && level !== 'record') {
            this.ensureTarget?.();
            break;
          }
        }
      }
      if (this.stopped) return;
    }
    const nowMono = this.clock.mono();
    const nowWall = this.clock.wall();
    const monoFor = (signal: Signal) => nowMono - Math.max(0, nowWall - signal.at);
    const session = this.selected && this.sessions.get(this.selected);
    if (!session) {
      const priorStatuses = new Map<string, ReturnType<typeof this.store.sourceStatus>>();
      for (const s of signals) {
        if (!priorStatuses.has(s.source.id)) priorStatuses.set(s.source.id, this.store.sourceStatus(s.source.id));
      }
      await new Promise<void>((resolve, reject) =>
        this.store.applyBatch(signals, (results) => {
          try {
            for (let i = 0; i < signals.length; i++) {
              const signal = signals[i]!;
              const result = results[i];
              const mono = monoFor(signal);
              if (result !== 'applied') {
                this.logEntry(
                  { signal, level: 'record', reason: result === 'older' ? 'older-sequence' : 'duplicate' },
                  mono,
                );
                continue;
              }
              const rule = signal.cause === 'agent' ? undefined : this.pipeline.selectRule(signal, rules);
              let level = rule?.level ?? 'record';
              let reason = signal.cause === 'agent' ? 'self-caused' : undefined;
              if (level === 'wake' && rule && !isRuleApproved(rule)) {
                level = 'context';
                reason = 'rule-pending-approval';
              }
              if (
                (signal.kind === 'source.status' || signal.kind === 'source.error') &&
                priorStatuses.get(signal.source.id) === sourceObservation(signal).status
              ) {
                level = 'record';
              }
              if (level === 'wake') reason = 'no-session';
              if (level === 'context') {
                const evicted = this.pending.add(signal, { rule, reason });
                if (evicted !== undefined) reason = `pending-evicted:${evicted}`;
              }
              this.logEntry({ signal, level, ruleId: rule?.id, reason }, mono);
            }
            this.changed();
            resolve();
          } catch (error) {
            reject(error);
          }
        }),
      );
      return;
    }
    await this.pipeline.acceptBatch(signals, session, (changes) => {
      let needsSchedule = false;
      for (const change of changes) {
        this.logEntry(change, monoFor(change.signal));
        if (change.level !== 'record') needsSchedule = true;
      }
      this.changed();
      if (needsSchedule) this.reschedule();
    });
  }
  async flush(): Promise<void> {
    try {
      this.pipeline.pruneSessions();
      if (this.needsRestore()) this.ensureTarget?.();
      if (this.selected) await this.pipeline.retarget(this.selected);
      if (!this.stopped) await this.pipeline.flush();
    } finally {
      this.reschedule();
    }
  }
  private needsRestore(): boolean {
    return !!this.pinned && (this.selected !== this.pinned || !this.sessions.has(this.pinned));
  }
  private normalizeEventSubject(signal: Signal): { subject: string; bundleId?: string; title?: string } {
    if (!signal.kind.startsWith('app.') && !signal.kind.startsWith('window')) {
      return { subject: signal.subject };
    }
    const front = this.store.snapshot().env.frontApp.value;
    if (signal.kind.startsWith('app.')) {
      const dataName = typeof signal.data.name === 'string' && signal.data.name.trim() ? signal.data.name : undefined;
      const dataBundleId =
        typeof signal.data.bundleId === 'string' && signal.data.bundleId.trim()
          ? signal.data.bundleId
          : typeof signal.data.bundle === 'string' && signal.data.bundle.trim()
            ? signal.data.bundle
            : undefined;
      const matchingFrontName =
        front?.name?.trim() &&
        ((dataBundleId !== undefined && front.bundleId === dataBundleId) ||
          front.bundleId === signal.subject ||
          front.name === signal.subject)
          ? front.name
          : undefined;
      const subject = dataName ?? matchingFrontName ?? signal.subject;
      const bundleId =
        dataBundleId ??
        (front?.bundleId && (front.bundleId === signal.subject || front.name === subject)
          ? front.bundleId
          : signal.subject && signal.subject !== subject
            ? signal.subject
            : undefined);
      return { subject, ...(bundleId ? { bundleId } : {}) };
    }
    if (signal.kind.startsWith('window')) {
      const dataBundleId =
        typeof signal.data.bundleId === 'string' && signal.data.bundleId.trim()
          ? signal.data.bundleId
          : typeof signal.data.bundle === 'string' && signal.data.bundle.trim()
            ? signal.data.bundle
            : undefined;
      const matchingFront = front && (!dataBundleId || front.bundleId === dataBundleId) ? front : undefined;
      const dataApp =
        typeof signal.data.appName === 'string' && signal.data.appName.trim()
          ? signal.data.appName
          : typeof signal.data.app === 'string' && signal.data.app.trim()
            ? signal.data.app
            : undefined;
      const subject = (matchingFront?.name?.trim() ? matchingFront.name : undefined) ?? dataApp ?? signal.subject;
      const title =
        typeof signal.data.title === 'string'
          ? signal.data.title
          : signal.subject && signal.subject !== subject
            ? signal.subject
            : undefined;
      const bundleId = dataBundleId ?? (matchingFront?.bundleId || undefined);
      return {
        subject,
        ...(bundleId ? { bundleId } : {}),
        ...(title !== undefined ? { title } : {}),
      };
    }
    return { subject: signal.subject };
  }
  private log(change: { signal: Signal; level: DeliveryLevel; ruleId?: string; reason?: string }, mono: number): void {
    this.logEntry(change, mono);
    this.changed();
  }
  private logEntry(
    change: { signal: Signal; level: DeliveryLevel; ruleId?: string; reason?: string },
    mono: number,
  ): void {
    const { signal, level, ruleId, reason } = change;
    const { subject, bundleId, title } = this.normalizeEventSubject(signal);
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
    const entry: EventEntry = {
      id: signal.id,
      kind: signal.kind,
      subject,
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
    };
    this.entries.push(entry);
    if (this.entries.length > 200) this.pending.forget(this.entries.shift()?.id);
    this.history?.recordEvent(entry, bundleId !== undefined || title !== undefined ? { bundleId, title } : undefined);
  }
  private mark(id: string, reason?: string, level?: DeliveryLevel): void {
    const entry = this.entries.find((item) => item.id === id);
    if (!entry) return;
    if (reason !== undefined) entry.reason = reason;
    if (level !== undefined) entry.level = level;
    this.history?.patchEvent(id, {
      at: entry.at,
      ...(reason !== undefined ? { reason } : {}),
      ...(level !== undefined ? { level } : {}),
    });
    this.changed();
  }
}
