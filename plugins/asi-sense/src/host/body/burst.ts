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
   * Watched roots: an event counts toward EVERY root containing it
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
  count?: number;
}

function activityCount(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : undefined;
}

/**
 * One burst bucket an event legitimately belongs to: `scope` is the canonical
 * {@link burstScopeId} of the observing rule (so sibling globs on the same
 * watch root keep independent windows and latches), `dir` the concrete bucket
 * directory that becomes the emitted `file.burst` subject.
 */
export interface BurstTarget {
  scope: string;
  dir: string;
}

interface DirState {
  /** Scope id this window belongs to (retention + emitted `data.scope`). */
  scope: string;
  /** Concrete bucket directory (emitted as `subject`/`data.directory`). */
  dir: string;
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
  private roots?: readonly string[];
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

  /**
   * Retains windows whose scope id is listed, dropping all others — a removed
   * or expired rule's history never revives if its scope returns.
   */
  setScopes(scopes: readonly string[]): void {
    const retained = new Set(scopes);
    for (const [key, entry] of this.dirs) if (!retained.has(entry.scope)) this.dirs.delete(key);
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

  /** Every watched root containing `path`, or `[dirname]` without roots. */
  private groups(path: string, isDir = false): BurstTarget[] {
    if (!this.roots) {
      const dir = isDir ? path : posix.dirname(path);
      return [{ scope: `dir:${dir}`, dir }];
    }
    const out: BurstTarget[] = [];
    for (const r of this.roots) {
      if (path === r || path.startsWith(r === '/' ? '/' : `${r}/`)) out.push({ scope: `dir:${r}`, dir: r });
    }
    return out;
  }

  /**
   * `dirs` overrides auto-grouping: the caller supplies the (scope, dir)
   * buckets the event legitimately belongs to — an empty list means the
   * event counts toward no scope at all.
   */
  accept(signal: Signal, receivedAt: number, dirs?: readonly BurstTarget[]): BodySignal[] {
    // All cheap validation first: a malformed or backward event must never
    // touch (and thereby erase) healthy per-directory history.
    if (!Number.isFinite(receivedAt)) throw new TypeError('file.burst: receivedAt must be finite');
    if (
      (signal.kind !== 'file.changed' && signal.kind !== 'file.activity') ||
      !Number.isFinite(signal.at) ||
      receivedAt < this.lastReceived
    )
      return [];
    const items: { change: Change; count: number }[] = [];
    let path: string;
    if (signal.kind === 'file.changed') {
      const change = signal.data.change as Change | undefined;
      if (change !== 'add' && change !== 'modify' && change !== 'delete') return [];
      items.push({ change, count: 1 });
      path = typeof signal.data.path === 'string' ? signal.data.path : signal.subject;
    } else {
      const created = activityCount(signal.data.created);
      const modified = activityCount(signal.data.modified);
      const deleted = activityCount(signal.data.deleted);
      if (created === undefined || modified === undefined || deleted === undefined) return [];
      if (created > 0) items.push({ change: 'add', count: created });
      if (modified > 0) items.push({ change: 'modify', count: modified });
      if (deleted > 0) items.push({ change: 'delete', count: deleted });
      if (items.length === 0) return [];
      path =
        typeof signal.data.directory === 'string' && signal.data.directory.length > 0
          ? signal.data.directory
          : signal.subject;
    }
    const targets =
      dirs === undefined
        ? this.groups(path, signal.kind === 'file.activity')
        : [...new Map(dirs.map((t) => [`${t.scope}${t.dir}`, t] as const)).values()];
    if (targets.length === 0) return []; // outside every watched scope
    const lim = this.limits();
    this.lastReceived = receivedAt;
    for (const [key, entry] of this.dirs) {
      entry.win.prune(receivedAt - lim.windowMs);
      if (entry.win.size === 0) this.dirs.delete(key);
    }
    const out: BodySignal[] = [];
    for (const target of targets) {
      const emitted = this.record(target, signal, items, receivedAt, lim);
      if (emitted) out.push(emitted);
    }
    return out;
  }

  /** Counts one event (or aggregated `file.activity` batch) against a single scope window; emits on a new crossing. */
  private record(
    target: BurstTarget,
    signal: Signal,
    items: readonly { change: Change; count: number }[],
    receivedAt: number,
    lim: { windowMs: number; maxChanges: number; maxDeleted: number },
  ): BodySignal | undefined {
    const key = `${target.scope}${target.dir}`;
    let st = this.dirs.get(key);
    if (st && receivedAt < st.lastAt) return undefined; // backward per-directory event
    if (st) {
      st.win.prune(receivedAt - lim.windowMs);
      if (st.win.size === 0) {
        this.dirs.delete(key);
        st = undefined; // expired under its own watermark: fresh state
      }
    }
    if (!st) {
      if (this.dirs.size >= this.maxDirectories) {
        let oldestKey: string | undefined;
        let oldest = Number.POSITIVE_INFINITY;
        for (const [k, entry] of this.dirs) {
          if (entry.lastAt < oldest) {
            oldestKey = k;
            oldest = entry.lastAt;
          }
        }
        if (oldestKey !== undefined) this.dirs.delete(oldestKey);
      }
      st = {
        scope: target.scope,
        dir: target.dir,
        win: new TimeWindow<FileEvent>(),
        lastAt: Number.NEGATIVE_INFINITY,
        wake: false,
        deletion: false,
        agentOnly: false,
      };
      this.dirs.set(key, st);
    }
    st.lastAt = receivedAt;
    const agent = signal.cause === 'agent';
    for (const item of items) {
      st.win.push({ at: receivedAt, change: item.change, agent, ...(item.count === 1 ? {} : { count: item.count }) });
    }
    const counts = this.count(st.win);
    const extDeleted = counts.deleted - counts.agentDeleted;
    const extTotal = counts.created + counts.modified + counts.deleted - extCounts(counts);
    const externalDeletionExceeded = extDeleted > lim.maxDeleted;
    const totalCrossed = extTotal > lim.maxChanges && !st.wake;
    const deletionCrossed = externalDeletionExceeded && !st.deletion;
    if (extTotal > lim.maxChanges) st.wake = true;
    else if (extTotal < lim.maxChanges * REARM) st.wake = false;
    if (externalDeletionExceeded) st.deletion = true;
    else if (extDeleted < lim.maxDeleted * REARM) st.deletion = false;
    if (extTotal > lim.maxChanges || externalDeletionExceeded) {
      if (totalCrossed || deletionCrossed) return this.emit(signal, st, 'wake', counts, lim, externalDeletionExceeded);
      return undefined;
    }
    // Pure self-cause crossing: totals only breach through agent events.
    const total = counts.created + counts.modified + counts.deleted;
    if (total > lim.maxChanges || counts.deleted > lim.maxDeleted) {
      if (!st.agentOnly) {
        st.agentOnly = true;
        return this.emit(signal, st, 'record', counts, lim, externalDeletionExceeded, 'agent');
      }
    } else if (st.agentOnly && total < lim.maxChanges * REARM && counts.deleted < lim.maxDeleted * REARM) {
      st.agentOnly = false;
    }
    return undefined;
  }

  private count(win: TimeWindow<FileEvent>): Counts {
    const c: Counts = { created: 0, modified: 0, deleted: 0, agentCreated: 0, agentModified: 0, agentDeleted: 0 };
    for (const e of win.values()) {
      const n = e.count ?? 1;
      if (e.change === 'add') {
        c.created += n;
        if (e.agent) c.agentCreated += n;
      } else if (e.change === 'modify') {
        c.modified += n;
        if (e.agent) c.agentModified += n;
      } else {
        c.deleted += n;
        if (e.agent) c.agentDeleted += n;
      }
    }
    return c;
  }

  private emit(
    src: Signal,
    st: DirState,
    level: 'wake' | 'record',
    c: Counts,
    lim: { windowMs: number; maxDeleted: number },
    externalDeletionExceeded: boolean,
    cause?: 'agent',
  ): BodySignal {
    return {
      id: `file.burst:${createHash('sha256')
        .update(JSON.stringify([src.source.id, st.scope, st.dir, src.at, src.id, level]))
        .digest('hex')}`,
      kind: 'file.burst',
      at: src.at,
      source: src.source,
      subject: st.dir,
      layer: 'rate',
      ...(cause ? { cause } : {}),
      data: {
        layer: 'rate',
        level,
        wake: level === 'wake',
        ruleId: 'file.burst',
        directory: st.dir,
        scope: st.scope,
        windowMs: lim.windowMs,
        externalDeletionExceeded,
        ...c,
      },
    };
  }
}

const extCounts = (c: Counts): number => c.agentCreated + c.agentModified + c.agentDeleted;
