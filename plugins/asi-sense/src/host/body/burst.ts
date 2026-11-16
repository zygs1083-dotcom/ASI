import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import type { Signal } from '@asi/sense-types';
import type { BodySignal } from './metrics.ts';
import { TimeWindow } from './window.ts';

export interface FileBurstOptions {
  windowMs?: number;
  maxChanges?: number;
  maxDeleted?: number;
  maxDirectories?: number;
  /**
   * Watched roots: an event groups under the LONGEST matching root
   * (`path === root` or `path` under `root/`); events outside every root
   * are ignored. Absent: each event groups under its own dirname.
   */
  roots?: readonly string[];
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
  deletion: boolean;
  /** Self-cause crossing audit latch (never suppresses `wake`). */
  agentOnly: boolean;
}

interface Counts {
  created: number;
  modified: number;
  deleted: number;
  agentCreated: number;
  agentModified: number;
  agentDeleted: number;
}

const DEFAULTS = { windowMs: 60_000, maxChanges: 100, maxDeleted: 50 } as const;
const REARM = 0.8;

/**
 * Per-directory (or per watched root) file-burst detector (DESIGN §2.2c,
 * layer `rate`, kind `file.burst`). Counts `file.changed` events inside a
 * sliding window on each directory's OWN watermark — an event never prunes
 * another directory's history. External and agent-caused events are
 * counted separately for every change type; only EXTERNAL counts arm the
 * `wake` latch (`externalDeletionExceeded` names the deletion trigger).
 * A burst that crosses a limit purely through agent-caused events emits a
 * `record`-level `cause:'agent'` audit instead — never a wake. Pure
 * bookkeeping — never touches the filesystem.
 */
export class FileBurstDetector {
  private readonly windowMs: number;
  private readonly maxChanges: number;
  private readonly maxDeleted: number;
  private readonly roots?: readonly string[];
  private readonly threshold: (param: string, fallback: number) => number;
  private readonly dirs = new Map<string, DirState>();
  private readonly maxDirectories: number;
  private lastReceived = Number.NEGATIVE_INFINITY;

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
    this.maxDirectories = options.maxDirectories ?? 1024;
    if (!Number.isSafeInteger(this.maxDirectories) || this.maxDirectories <= 0) {
      throw new TypeError('file.burst: maxDirectories must be a positive integer');
    }
    if (options.roots !== undefined) {
      if (
        !Array.isArray(options.roots) ||
        options.roots.length === 0 ||
        !options.roots.every((r) => typeof r === 'string' && r.startsWith('/'))
      ) {
        throw new TypeError('file.burst: roots must be nonempty absolute paths');
      }
      this.roots = options.roots.map((r) => (r === '/' ? r : r.replace(/\/+$/, '')));
    }
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

  /** Longest watched root containing `path`, or its dirname without roots. */
  private group(path: string): string | undefined {
    if (!this.roots) return posix.dirname(path);
    let best: string | undefined;
    for (const r of this.roots) {
      if (path === r || path.startsWith(r === '/' ? '/' : `${r}/`)) {
        if (best === undefined || r.length > best.length) best = r;
      }
    }
    return best;
  }

  accept(signal: Signal, receivedAt: number): BodySignal[] {
    // All cheap validation first: a malformed or backward event must never
    // touch (and thereby erase) healthy per-directory history.
    if (!Number.isFinite(receivedAt)) throw new TypeError('file.burst: receivedAt must be finite');
    if (signal.kind !== 'file.changed' || !Number.isFinite(signal.at) || receivedAt < this.lastReceived) return [];
    const change = signal.data.change as Change | undefined;
    if (change !== 'add' && change !== 'modify' && change !== 'delete') return [];
    const path = typeof signal.data.path === 'string' ? signal.data.path : signal.subject;
    const dir = this.group(path);
    if (dir === undefined) return []; // outside every watched root
    const existing = this.dirs.get(dir);
    if (existing && receivedAt < existing.lastAt) return []; // backward per-directory event
    const lim = this.limits();
    this.lastReceived = receivedAt;
    for (const [key, entry] of this.dirs) {
      entry.win.prune(receivedAt - lim.windowMs);
      if (entry.win.size === 0) this.dirs.delete(key);
    }
    let st = this.dirs.get(dir);
    if (st) {
      st.win.prune(receivedAt - lim.windowMs);
      if (st.win.size === 0) {
        this.dirs.delete(dir);
        st = undefined; // expired under its own watermark: fresh state
      }
    }
    if (!st) {
      if (this.dirs.size >= this.maxDirectories) {
        let oldestKey: string | undefined;
        let oldest = Number.POSITIVE_INFINITY;
        for (const [key, entry] of this.dirs) {
          if (entry.lastAt < oldest) {
            oldestKey = key;
            oldest = entry.lastAt;
          }
        }
        if (oldestKey !== undefined) this.dirs.delete(oldestKey);
      }
      st = {
        win: new TimeWindow<FileEvent>(),
        lastAt: Number.NEGATIVE_INFINITY,
        wake: false,
        deletion: false,
        agentOnly: false,
      };
      this.dirs.set(dir, st);
    }
    st.lastAt = receivedAt;
    st.win.push({ at: receivedAt, change, agent: signal.cause === 'agent' });
    const counts = this.count(st.win);
    const extDeleted = counts.deleted - counts.agentDeleted;
    const extTotal = counts.created + counts.modified + counts.deleted - extCounts(counts);
    const externalDeletionExceeded = extDeleted > lim.maxDeleted;
    const out: BodySignal[] = [];
    const totalCrossed = extTotal > lim.maxChanges && !st.wake;
    const deletionCrossed = externalDeletionExceeded && !st.deletion;
    if (extTotal > lim.maxChanges) st.wake = true;
    else if (extTotal < lim.maxChanges * REARM) st.wake = false;
    if (externalDeletionExceeded) st.deletion = true;
    else if (extDeleted < lim.maxDeleted * REARM) st.deletion = false;
    if (extTotal > lim.maxChanges || externalDeletionExceeded) {
      if (totalCrossed || deletionCrossed)
        out.push(this.emit(signal, dir, 'wake', counts, lim, externalDeletionExceeded));
    } else {
      // Pure self-cause crossing: totals only breach through agent events.
      const total = counts.created + counts.modified + counts.deleted;
      if (total > lim.maxChanges || counts.deleted > lim.maxDeleted) {
        if (!st.agentOnly) {
          st.agentOnly = true;
          out.push(this.emit(signal, dir, 'record', counts, lim, externalDeletionExceeded, 'agent'));
        }
      } else if (st.agentOnly && total < lim.maxChanges * REARM && counts.deleted < lim.maxDeleted * REARM) {
        st.agentOnly = false;
      }
    }
    return out;
  }

  private count(win: TimeWindow<FileEvent>): Counts {
    const c: Counts = { created: 0, modified: 0, deleted: 0, agentCreated: 0, agentModified: 0, agentDeleted: 0 };
    for (const e of win.values()) {
      if (e.change === 'add') {
        c.created++;
        if (e.agent) c.agentCreated++;
      } else if (e.change === 'modify') {
        c.modified++;
        if (e.agent) c.agentModified++;
      } else {
        c.deleted++;
        if (e.agent) c.agentDeleted++;
      }
    }
    return c;
  }

  private emit(
    src: Signal,
    dir: string,
    level: 'wake' | 'record',
    c: Counts,
    lim: { windowMs: number; maxDeleted: number },
    externalDeletionExceeded: boolean,
    cause?: 'agent',
  ): BodySignal {
    return {
      id: `file.burst:${createHash('sha256')
        .update(JSON.stringify([src.source.id, dir, src.at, src.id, level]))
        .digest('hex')}`,
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
        windowMs: lim.windowMs,
        externalDeletionExceeded,
        ...c,
      },
    };
  }
}

const extCounts = (c: Counts): number => c.agentCreated + c.agentModified + c.agentDeleted;
