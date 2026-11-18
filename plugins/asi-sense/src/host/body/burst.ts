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
  count: number;
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
  key: string;
  prev?: DirState;
  next?: DirState;
  /** Scope id this window belongs to (retention + emitted `data.scope`). */
  scope: string;
  /** Concrete bucket directory (emitted as `subject`/`data.directory`). */
  dir: string;
  win: TimeWindow<FileEvent>;
  counts: Counts;
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
const EMPTY_SIGNALS: BodySignal[] = [];

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
  private head?: DirState;
  private tail?: DirState;
  private readonly maxDirectories: number;
  private lastReceived = Number.NEGATIVE_INFINITY;
  private readonly limBuf = { windowMs: 0, maxChanges: 0, maxDeleted: 0 };
  private readonly singleItem: [{ change: Change; count: number }] = [{ change: 'add', count: 1 }];

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

  private linkTail(st: DirState): void {
    st.prev = this.tail;
    st.next = undefined;
    if (this.tail) this.tail.next = st;
    else this.head = st;
    this.tail = st;
  }

  private unlink(st: DirState): void {
    const { prev, next } = st;
    if (prev) prev.next = next;
    else this.head = next;
    if (next) next.prev = prev;
    else this.tail = prev;
    st.prev = undefined;
    st.next = undefined;
  }

  private moveToTail(st: DirState): void {
    if (st === this.tail) return;
    this.unlink(st);
    this.linkTail(st);
  }

  /**
   * Retains windows whose scope id is listed, dropping all others — a removed
   * or expired rule's history never revives if its scope returns.
   */
  setScopes(scopes: readonly string[]): void {
    if (scopes.length === 0) {
      this.dirs.clear();
      this.head = undefined;
      this.tail = undefined;
      return;
    }
    const retained = new Set(scopes);
    for (const [key, entry] of this.dirs) {
      if (!retained.has(entry.scope)) {
        this.unlink(entry);
        this.dirs.delete(key);
      }
    }
  }

  private limitVal(param: string, fallback: number): number {
    const v = this.threshold(param, fallback);
    return Number.isFinite(v) && v > 0 ? v : fallback;
  }

  /** Live limits: the resolver is consulted per accept; bad reads fall back to config. */
  private limits(): { windowMs: number; maxChanges: number; maxDeleted: number } {
    this.limBuf.windowMs = this.limitVal('file.burst.windowMs', this.windowMs);
    this.limBuf.maxChanges = this.limitVal('file.burst.maxChanges', this.maxChanges);
    this.limBuf.maxDeleted = this.limitVal('file.burst.maxDeleted', this.maxDeleted);
    return this.limBuf;
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
      return EMPTY_SIGNALS;
    let items: { change: Change; count: number }[];
    let path = '';
    if (signal.kind === 'file.changed') {
      const change = signal.data.change as Change | undefined;
      if (change !== 'add' && change !== 'modify' && change !== 'delete') return EMPTY_SIGNALS;
      this.singleItem[0].change = change;
      items = this.singleItem;
      if (dirs === undefined) {
        path = typeof signal.data.path === 'string' ? signal.data.path : signal.subject;
      }
    } else {
      const created = activityCount(signal.data.created);
      const modified = activityCount(signal.data.modified);
      const deleted = activityCount(signal.data.deleted);
      if (created === undefined || modified === undefined || deleted === undefined) return EMPTY_SIGNALS;
      items = [];
      if (created > 0) items.push({ change: 'add', count: created });
      if (modified > 0) items.push({ change: 'modify', count: modified });
      if (deleted > 0) items.push({ change: 'delete', count: deleted });
      if (items.length === 0) return EMPTY_SIGNALS;
      if (dirs === undefined) {
        path =
          typeof signal.data.directory === 'string' && signal.data.directory.length > 0
            ? signal.data.directory
            : signal.subject;
      }
    }
    const targets =
      dirs === undefined
        ? this.groups(path, signal.kind === 'file.activity')
        : dirs.length <= 1
          ? dirs
          : [...new Map(dirs.map((t) => [`${t.scope}${t.dir}`, t] as const)).values()];
    if (targets.length === 0) return EMPTY_SIGNALS; // outside every watched scope
    const lim = this.limits();
    this.lastReceived = receivedAt;
    const cutoff = receivedAt - lim.windowMs;
    // `head..tail` is kept in ascending `lastAt` order, so expired
    // directories sit at the head and we stop at the first fresh entry.
    while (this.head && this.head.lastAt < cutoff) {
      const old = this.head;
      this.unlink(old);
      this.dirs.delete(old.key);
    }
    let out: BodySignal[] | undefined;
    for (let i = 0; i < targets.length; i++) {
      const emitted = this.record(targets[i] as BurstTarget, signal, items, receivedAt, lim);
      if (emitted) {
        out ??= [];
        out.push(emitted);
      }
    }
    return out ?? EMPTY_SIGNALS;
  }

  private adjustCounts(c: Counts, change: Change, agent: boolean, delta: number): void {
    if (change === 'add') {
      c.created += delta;
      if (agent) c.agentCreated += delta;
    } else if (change === 'modify') {
      c.modified += delta;
      if (agent) c.agentModified += delta;
    } else {
      c.deleted += delta;
      if (agent) c.agentDeleted += delta;
    }
  }

  private hasOverlappingWake(
    target: BurstTarget,
    receivedAt: number,
    windowMs: number,
    deletionOnly: boolean,
  ): boolean {
    const isGlobal = target.scope === 'global';
    const cutoff = receivedAt - windowMs;
    for (let entry = this.tail; entry !== undefined; entry = entry.prev) {
      if (entry.lastAt < cutoff) break;
      if (isGlobal ? entry.scope === 'global' : entry.scope !== 'global') continue;
      if (deletionOnly ? !entry.deletion : !entry.wake && !entry.deletion) continue;
      if (entry.dir === target.dir) return true;
      if (isGlobal && entry.scope.startsWith('dir:')) {
        if (entry.dir === '/' || target.dir.startsWith(`${entry.dir}/`)) return true;
      } else if (!isGlobal && target.scope.startsWith('dir:')) {
        if (target.dir === '/' || entry.dir.startsWith(`${target.dir}/`)) return true;
      }
    }
    return false;
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
      const cutoff = receivedAt - lim.windowMs;
      for (;;) {
        const evicted = st.win.shiftBefore(cutoff);
        if (!evicted) break;
        this.adjustCounts(st.counts, evicted.change, evicted.agent, -evicted.count);
      }
      if (st.win.size === 0) {
        st.counts.created = 0;
        st.counts.modified = 0;
        st.counts.deleted = 0;
        st.counts.agentCreated = 0;
        st.counts.agentModified = 0;
        st.counts.agentDeleted = 0;
        st.wake = false;
        st.deletion = false;
        st.agentOnly = false;
      }
      this.moveToTail(st);
    } else {
      let reused: DirState | undefined;
      if (this.dirs.size >= this.maxDirectories && this.head) {
        const oldest = this.head;
        this.unlink(oldest);
        this.dirs.delete(oldest.key);
        if (oldest.win.capacity <= 64) {
          reused = oldest;
          reused.key = key;
          reused.scope = target.scope;
          reused.dir = target.dir;
          reused.win.clear();
          reused.counts.created = 0;
          reused.counts.modified = 0;
          reused.counts.deleted = 0;
          reused.counts.agentCreated = 0;
          reused.counts.agentModified = 0;
          reused.counts.agentDeleted = 0;
          reused.lastAt = Number.NEGATIVE_INFINITY;
          reused.wake = false;
          reused.deletion = false;
          reused.agentOnly = false;
        }
      }
      st = reused ?? {
        key,
        scope: target.scope,
        dir: target.dir,
        win: new TimeWindow<FileEvent>(),
        counts: { created: 0, modified: 0, deleted: 0, agentCreated: 0, agentModified: 0, agentDeleted: 0 },
        lastAt: Number.NEGATIVE_INFINITY,
        wake: false,
        deletion: false,
        agentOnly: false,
      };
      this.dirs.set(key, st);
      this.linkTail(st);
    }
    st.lastAt = receivedAt;
    const agent = signal.cause === 'agent';
    for (let i = 0; i < items.length; i++) {
      const item = items[i] as { change: Change; count: number };
      st.win.push({ at: receivedAt, change: item.change, agent, count: item.count });
      this.adjustCounts(st.counts, item.change, agent, item.count);
    }
    const counts = st.counts;
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
      if (totalCrossed || deletionCrossed) {
        if (this.hasOverlappingWake(target, receivedAt, lim.windowMs, !totalCrossed && deletionCrossed)) {
          return undefined;
        }
        return this.emit(signal, st, 'wake', { ...counts }, lim, externalDeletionExceeded);
      }
      return undefined;
    }
    // Pure self-cause crossing: totals only breach through agent events.
    const total = counts.created + counts.modified + counts.deleted;
    if (total > lim.maxChanges || counts.deleted > lim.maxDeleted) {
      if (!st.agentOnly) {
        st.agentOnly = true;
        return this.emit(signal, st, 'record', { ...counts }, lim, externalDeletionExceeded, 'agent');
      }
    } else if (st.agentOnly && total < lim.maxChanges * REARM && counts.deleted < lim.maxDeleted * REARM) {
      st.agentOnly = false;
    }
    return undefined;
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
