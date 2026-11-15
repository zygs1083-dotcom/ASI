import { posix } from 'node:path';
import type { Signal } from '@asi/sense-types';
import type { BodySignal } from './metrics.ts';
import { TimeWindow } from './window.ts';

export interface FileBurstOptions {
  windowMs?: number;
  maxChanges?: number;
  maxDeleted?: number;
  /** When true, agent-caused deletes count toward the eligible totals. */
  includeAgentDeletes?: boolean;
  /** Live tuning lookup; falls back to the configured value. */
  threshold?: (param: string, fallback: number) => number;
}

type Change = 'add' | 'modify' | 'delete';

interface FileEvent {
  at: number;
  change: Change;
  agent: boolean;
}

interface DirState {
  win: TimeWindow<FileEvent>;
  lastAt: number;
  /** External-burst wake latch. */
  wake: boolean;
  /** Agent-only delete-burst audit latch (never suppresses `wake`). */
  agentOnly: boolean;
}

interface Counts {
  created: number;
  modified: number;
  deleted: number;
  agentDeleted: number;
}

const DEFAULTS = { windowMs: 60_000, maxChanges: 100, maxDeleted: 50 } as const;
const REARM = 0.8;

/**
 * Per-directory file-burst detector (DESIGN §2.2c, layer `rate`, kind
 * `file.burst`). Counts `file.changed` events inside a sliding time window;
 * a burst of external changes (or eligible deletes) emits a `wake` signal
 * once per latch. A burst attributable solely to agent deletes instead
 * emits a `record`-level audit signal that can never trigger or suppress
 * the wake latch. Pure bookkeeping — never touches the filesystem.
 */
export class FileBurstDetector {
  private readonly windowMs: number;
  private readonly maxChanges: number;
  private readonly maxDeleted: number;
  private readonly includeAgentDeletes: boolean;
  private readonly threshold: (param: string, fallback: number) => number;
  private readonly dirs = new Map<string, DirState>();

  constructor(options: FileBurstOptions = {}) {
    if (options.threshold !== undefined && typeof options.threshold !== 'function') {
      throw new TypeError('file.burst: threshold must be a function');
    }
    this.threshold = options.threshold ?? ((_p: string, n: number) => n);
    const opts = {
      windowMs: options.windowMs ?? DEFAULTS.windowMs,
      maxChanges: options.maxChanges ?? DEFAULTS.maxChanges,
      maxDeleted: options.maxDeleted ?? DEFAULTS.maxDeleted,
    };
    for (const [k, v] of Object.entries(opts)) {
      if (!Number.isFinite(v) || v <= 0) throw new TypeError(`file.burst: ${k} must be positive and finite`);
    }
    this.windowMs = opts.windowMs;
    this.maxChanges = opts.maxChanges;
    this.maxDeleted = opts.maxDeleted;
    this.includeAgentDeletes = options.includeAgentDeletes ?? false;
  }

  /** Live limits: the resolver is consulted per accept; bad reads fall back to config. */
  private limits(): { windowMs: number; maxChanges: number; maxDeleted: number } {
    const r = (param: string, fallback: number) => {
      const v = this.threshold(param, fallback);
      return Number.isFinite(v) && v > 0 ? v : fallback;
    };
    return {
      windowMs: r('file.burst.windowMs', this.windowMs),
      maxChanges: r('file.burst.maxChanges', this.maxChanges),
      maxDeleted: r('file.burst.maxDeleted', this.maxDeleted),
    };
  }

  accept(signal: Signal): BodySignal[] {
    // All cheap validation first: a malformed or backward event must never
    // sweep (and thereby erase) healthy per-directory history.
    if (signal.kind !== 'file.changed' || !Number.isFinite(signal.at)) return [];
    const change = signal.data.change as Change | undefined;
    if (change !== 'add' && change !== 'modify' && change !== 'delete') return [];
    const dir = posix.dirname(typeof signal.data.path === 'string' ? signal.data.path : signal.subject);
    const existing = this.dirs.get(dir);
    if (existing && signal.at < existing.lastAt) return []; // backward per-directory event
    const lim = this.limits();
    this.sweep(signal.at, lim.windowMs);
    let st = this.dirs.get(dir);
    if (!st) {
      st = { win: new TimeWindow<FileEvent>(), lastAt: Number.NEGATIVE_INFINITY, wake: false, agentOnly: false };
      this.dirs.set(dir, st);
    }
    st.lastAt = signal.at;
    st.win.push({ at: signal.at, change, agent: signal.cause === 'agent' });
    st.win.prune(signal.at - lim.windowMs);
    const counts = this.count(st.win);
    const eligibleDeleted = counts.deleted - (this.includeAgentDeletes ? 0 : counts.agentDeleted);
    const eligibleTotal = counts.created + counts.modified + eligibleDeleted;
    const out: BodySignal[] = [];
    if (eligibleTotal > lim.maxChanges || eligibleDeleted > lim.maxDeleted) {
      if (!st.wake) {
        st.wake = true;
        out.push(this.emit(signal, dir, 'wake', counts, lim.windowMs));
      }
    } else {
      if (st.wake && eligibleTotal < lim.maxChanges * REARM && eligibleDeleted < lim.maxDeleted * REARM) {
        st.wake = false;
      }
      if (counts.deleted > lim.maxDeleted) {
        if (!st.agentOnly) {
          st.agentOnly = true;
          out.push(this.emit(signal, dir, 'record', counts, lim.windowMs, 'agent'));
        }
      } else if (st.agentOnly && counts.deleted < lim.maxDeleted * REARM) {
        st.agentOnly = false;
      }
    }
    return out;
  }

  private count(win: TimeWindow<FileEvent>): Counts {
    const c: Counts = { created: 0, modified: 0, deleted: 0, agentDeleted: 0 };
    for (const e of win.values()) {
      if (e.change === 'add') c.created++;
      else if (e.change === 'modify') c.modified++;
      else {
        c.deleted++;
        if (e.agent) c.agentDeleted++;
      }
    }
    return c;
  }

  /** Drops every directory whose window expired — latched or not. */
  private sweep(at: number, windowMs: number): void {
    for (const [dir, st] of this.dirs) {
      st.win.prune(at - windowMs);
      if (st.win.size === 0) this.dirs.delete(dir);
    }
  }

  private emit(
    src: Signal,
    dir: string,
    level: 'wake' | 'record',
    c: Counts,
    windowMs: number,
    cause?: 'agent',
  ): BodySignal {
    return {
      id: `${src.source.id}:file.burst:${dir}:${src.at}:${level}`,
      kind: 'file.burst',
      at: src.at,
      source: src.source,
      subject: dir,
      layer: 'rate',
      ...(cause ? { cause } : {}),
      data: {
        layer: 'rate',
        level,
        wake: level === 'wake',
        ruleId: 'file.burst',
        directory: dir,
        windowMs,
        ...c,
      },
    };
  }
}
