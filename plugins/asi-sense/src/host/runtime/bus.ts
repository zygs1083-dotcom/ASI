import { randomUUID } from 'node:crypto';
import type { SenseState, Signal } from '@asi/sense-types';
import { StateStore } from '../state/store.ts';
import type { FactExpiry } from './expiry.ts';
import type { Clock } from './ports.ts';

const MAX_RECENT_SIGNALS = 64;

function stripTitleData(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (k === 'title') continue;
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? stripTitleData(v as Record<string, unknown>) : v;
  }
  return out;
}

/**
 * Pure sensory signal bus: feeds signals into `StateStore`, tracks the
 * foreground user session (excluding registered internal daemon sessions),
 * and keeps a small bounded in-memory ring of recent signals for `env_detail`.
 * Never evaluates WatchRules and never delivers messages to conversations.
 */
export class SenseBus {
  readonly store: StateStore;
  private readonly recentSignalsList: Signal[] = [];
  private readonly sessions = new Set<string>();
  private readonly recentSessions: string[] = [];
  private readonly internalSessions = new Set<string>();
  private selected?: string;
  private sequence = 0;
  private stopped = false;
  private readonly prefix = randomUUID();

  constructor(
    clock: Clock,
    private readonly titlesAllowed: () => boolean,
    readonly changed: () => void,
    expiry: FactExpiry,
  ) {
    this.store = new StateStore(
      () => clock.wall(),
      60_000,
      () => clock.mono(),
      expiry,
    );
  }

  id(): string {
    return `${this.prefix}:${++this.sequence}`;
  }

  state(): SenseState {
    return this.store.snapshot();
  }

  isStopped(): boolean {
    return this.stopped;
  }

  stop(): Promise<void> {
    this.stopped = true;
    return Promise.resolve();
  }

  batch<T>(work: () => T, publish: () => void): T {
    return this.store.batch(work, publish);
  }

  registerInternalSession(sessionId: string): () => void {
    this.internalSessions.add(sessionId);
    const idx = this.recentSessions.indexOf(sessionId);
    if (idx >= 0) this.recentSessions.splice(idx, 1);
    if (this.selected === sessionId) {
      this.selected = this.recentSessions.at(-1);
      this.changed();
    }
    return () => {
      this.internalSessions.delete(sessionId);
    };
  }

  isInternalSession(sessionId: string): boolean {
    return this.internalSessions.has(sessionId);
  }

  currentSessionId(): string | undefined {
    return this.selected;
  }

  create(id: string): void {
    this.sessions.add(id);
    if (!this.internalSessions.has(id) && this.selected === undefined) {
      this.recentSessions.push(id);
      this.selected = id;
    }
  }

  dispose(id: string): void {
    this.sessions.delete(id);
    const index = this.recentSessions.indexOf(id);
    if (index >= 0) this.recentSessions.splice(index, 1);
    if (this.selected === id) {
      this.selected = this.recentSessions.at(-1);
    }
  }

  activateSession(id: string): void {
    if (this.stopped || !this.sessions.has(id) || this.internalSessions.has(id)) return;
    const index = this.recentSessions.indexOf(id);
    if (index >= 0) this.recentSessions.splice(index, 1);
    this.recentSessions.push(id);
    this.selected = id;
  }

  recentSignals(): Signal[] {
    const allowTitles = this.titlesAllowed();
    return this.recentSignalsList.map((sig) => {
      const cloned = structuredClone(sig);
      if (!allowTitles) {
        if (cloned.kind.startsWith('window')) cloned.subject = '';
        cloned.data = stripTitleData(cloned.data);
      }
      return cloned;
    });
  }

  async accept(signal: Signal): Promise<void> {
    if (this.stopped) return;
    await new Promise<void>((resolve, reject) => {
      this.store.apply(signal, (result) => {
        try {
          if (result === 'applied' && signal.kind !== 'fact.updated') {
            const copy = structuredClone(signal);
            const front = this.store.snapshot().env.frontApp.value;
            if (copy.kind.startsWith('app.')) {
              const name = typeof copy.data.name === 'string' && copy.data.name.trim() ? copy.data.name : front?.name;
              if (name) copy.subject = name;
            } else if (copy.kind.startsWith('window') && front?.name) {
              copy.subject = front.name;
            }
            this.recentSignalsList.push(copy);
            if (this.recentSignalsList.length > MAX_RECENT_SIGNALS) {
              this.recentSignalsList.shift();
            }
          }
          this.changed();
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
  }
}
