import { randomUUID } from 'node:crypto';
import type { DeliveryLevel, SenseState, Signal, SignalCause, WatchRule } from '@asi/sense-types';
import { AttentionPipeline, type SessionContext } from '../attention/pipeline.ts';
import { isRuleApproved, selectRule } from '../attention/rules.ts';
import { sourceObservation } from '../state/source-health.ts';
import { StateStore } from '../state/store.ts';
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
  restarts?: number;
}
export type EventLog = EventEntry[];

function withoutTitles(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutTitles);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'title')
      .map(([key, child]) => [key, withoutTitles(child)]),
  );
}

export class RuntimeAttention {
  readonly store: StateStore;
  readonly pipeline: AttentionPipeline;
  private readonly entries: EventLog = [];
  private readonly pending: Signal[] = [];
  private readonly sessions = new Map<string, SessionContext>();
  private readonly recent: string[] = [];
  private selected?: string;
  private sequence = 0;
  private readonly prefix = randomUUID();

  constructor(
    private readonly clock: Clock,
    dsh: DshPort,
    private readonly rules: () => WatchRule[],
    private readonly reschedule: () => void,
    private readonly titlesAllowed: () => boolean,
  ) {
    this.store = new StateStore(
      () => clock.wall(),
      60_000,
      () => clock.mono(),
    );
    this.pipeline = new AttentionPipeline({
      store: this.store,
      rules: rules(),
      clock: () => clock.mono(),
      wallClock: () => clock.wall(),
      deliverer: {
        deliver: async (intent) => {
          if (!this.selected) {
            for (const change of intent.update.changes) this.mark(change.signal.id, 'no-session');
            return;
          }
          const safe = structuredClone({ ...intent, sessionId: this.selected });
          if (!this.titlesAllowed()) {
            for (const change of safe.update.changes) {
              change.signal.data = withoutTitles(change.signal.data) as Signal['data'];
            }
          }
          await dsh.deliver(this.selected, safe);
          for (const change of intent.update.changes) {
            if (change.reason) this.mark(change.signal.id, change.reason);
          }
        },
      },
    });
  }

  id(): string {
    return `${this.prefix}:${++this.sequence}`;
  }
  state(): SenseState {
    return this.store.snapshot();
  }
  events(): EventLog {
    return structuredClone(this.entries);
  }
  current(): string | undefined {
    return this.selected;
  }
  create(id: string): void {
    this.sessions.set(id, { id, busy: false, userInitiated: false });
  }
  dispose(id: string): void {
    this.sessions.delete(id);
    const index = this.recent.indexOf(id);
    if (index >= 0) this.recent.splice(index, 1);
    if (this.selected === id) this.selected = this.recent.at(-1);
  }
  async preStep(id: string, userInitiated = false, drain = true): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    this.selected = id;
    const index = this.recent.indexOf(id);
    if (index >= 0) this.recent.splice(index, 1);
    this.recent.push(id);
    session.busy = true;
    session.userInitiated = userInitiated;
    this.pipeline.setSession(session);
    if (!drain) return;
    for (const signal of this.pending.splice(0)) await this.pipeline.accept(signal, session);
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
    const session = this.selected && this.sessions.get(this.selected);
    if (!session) {
      const prior = this.store.snapshot().observation.sources[signal.source.id];
      this.store.apply(signal);
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
        this.pending.push(signal);
      }
      this.log({ signal, level, ruleId: rule?.id, reason });
      return;
    }
    const change = await this.pipeline.accept(signal, session);
    this.log(change);
    this.reschedule();
  }
  async flush(): Promise<void> {
    try {
      await this.pipeline.flush();
    } finally {
      this.reschedule();
    }
  }
  private log(change: { signal: Signal; level: DeliveryLevel; ruleId?: string; reason?: string }): void {
    const { signal, level, ruleId, reason } = change;
    const sourceReason =
      signal.kind === 'source.status' && typeof signal.data.reason === 'string' ? signal.data.reason : undefined;
    const restarts = typeof signal.data.restarts === 'number' ? signal.data.restarts : undefined;
    this.entries.push({
      id: signal.id,
      kind: signal.kind,
      subject: signal.subject,
      at: signal.at,
      level,
      ruleId,
      reason: reason ?? sourceReason,
      cause: signal.cause,
      restarts,
    });
    if (this.entries.length > 200) this.entries.shift();
  }
  private mark(id: string, reason: string): void {
    const entry = this.entries.find((item) => item.id === id);
    if (entry) entry.reason = reason;
  }
}
