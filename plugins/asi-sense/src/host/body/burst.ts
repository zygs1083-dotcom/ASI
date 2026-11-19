import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import type { Signal } from '@asi/sense-types';
import type { BodySignal } from './metrics.ts';

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

const RING_SLOTS = 64;
const RING_DIVISOR = 60;
const COUNT_FIELDS = 6;
const F_CREATED = 0;
const F_MODIFIED = 1;
const F_DELETED = 2;
const F_AGENT_CREATED = 3;
const F_AGENT_MODIFIED = 4;
const F_AGENT_DELETED = 5;

function ringPos(slotIdx: number): number {
  const r = slotIdx % RING_SLOTS;
  return r < 0 ? r + RING_SLOTS : r;
}

function slotWidthMs(windowMs: number): number {
  return Math.max(1, Math.ceil(windowMs / RING_DIVISOR));
}

function scopeRoot(scope: string): string {
  if (scope === 'global') return '/';
  if (scope.startsWith('dir:')) return scope.slice(4) || '/';
  if (scope.startsWith('glob:')) {
    const pat = scope.slice(5);
    const w = pat.search(/[*?]/);
    if (w < 0) return pat || '/';
    const slash = pat.lastIndexOf('/', w);
    return slash <= 0 ? '/' : pat.slice(0, slash);
  }
  return '/';
}

function pathDepth(dir: string): number {
  let d = 0;
  for (let i = 0; i < dir.length; i++) {
    if (dir.charCodeAt(i) === 47) d++;
  }
  return d;
}

function parentDirWithin(dir: string, root: string): string | undefined {
  if (dir === root || dir === '/') return undefined;
  if (root !== '/' && !dir.startsWith(`${root}/`)) return undefined;
  const slash = dir.lastIndexOf('/');
  const parent = slash <= 0 ? '/' : dir.slice(0, slash);
  if (root !== '/' && parent.length < root.length) return root;
  return parent;
}

interface DirState {
  key: string;
  prev?: DirState;
  next?: DirState;
  /** Scope id this window belongs to (retention + emitted `data.scope`). */
  scope: string;
  /** Concrete bucket directory (emitted as `subject`/`data.directory`). */
  dir: string;
  slotMs: number;
  slotIds: Float64Array;
  slotCounts: Uint32Array;
  oldestSlot: number;
  lastSlot: number;
  counts: Counts;
  lastAt: number;
  /** External-burst wake latch. */
  wake: boolean;
  deletion: boolean;
  /** Self-cause crossing audit latch (never suppresses `wake`). */
  agentOnly: boolean;
  /** Whether overflow directories were merged into this bucket. */
  rolledUp: boolean;
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
 * fixed-size slotted ring window per directory — never retaining individual
 * event objects — and rolls overflow directories above `maxDirectories`
 * into ancestor buckets marked `rolledUp`. Pure bookkeeping — never touches
 * the filesystem.
 */
export class FileBurstDetector {
  private readonly windowMs: number;
  private readonly maxChanges: number;
  private readonly maxDeleted: number;
  private roots?: readonly string[];
  private readonly threshold: (param: string, fallback: number) => number;
  private readonly dirs = new Map<string, DirState>();
  private readonly pool: DirState[] = [];
  private head?: DirState;
  private tail?: DirState;
  private readonly maxDirectories: number;
  private lastReceived = Number.NEGATIVE_INFINITY;
  private readonly limBuf = { windowMs: 0, maxChanges: 0, maxDeleted: 0 };
  private readonly singleItem: [{ change: Change; count: number }] = [{ change: 'add', count: 1 }];
  private readonly rebucketBuf: {
    at: number;
    c0: number;
    c1: number;
    c2: number;
    c3: number;
    c4: number;
    c5: number;
  }[] = [];

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

  private allocState(key: string, scope: string, dir: string, slotMs: number): DirState {
    const recycled = this.pool.pop();
    if (recycled) {
      recycled.key = key;
      recycled.scope = scope;
      recycled.dir = dir;
      recycled.slotMs = slotMs;
      recycled.prev = undefined;
      recycled.next = undefined;
      recycled.lastAt = Number.NEGATIVE_INFINITY;
      this.clearStateWindow(recycled);
      return recycled;
    }
    const slotIds = new Float64Array(RING_SLOTS);
    slotIds.fill(Number.NEGATIVE_INFINITY);
    return {
      key,
      scope,
      dir,
      slotMs,
      slotIds,
      slotCounts: new Uint32Array(RING_SLOTS * COUNT_FIELDS),
      oldestSlot: Number.POSITIVE_INFINITY,
      lastSlot: Number.NEGATIVE_INFINITY,
      counts: { created: 0, modified: 0, deleted: 0, agentCreated: 0, agentModified: 0, agentDeleted: 0 },
      lastAt: Number.NEGATIVE_INFINITY,
      wake: false,
      deletion: false,
      agentOnly: false,
      rolledUp: false,
    };
  }

  private recycleState(st: DirState): void {
    st.prev = undefined;
    st.next = undefined;
    if (this.pool.length < Math.min(this.maxDirectories, 256)) {
      this.pool.push(st);
    }
  }

  private clearStateWindow(st: DirState): void {
    st.slotIds.fill(Number.NEGATIVE_INFINITY);
    st.oldestSlot = Number.POSITIVE_INFINITY;
    st.lastSlot = Number.NEGATIVE_INFINITY;
    st.counts.created = 0;
    st.counts.modified = 0;
    st.counts.deleted = 0;
    st.counts.agentCreated = 0;
    st.counts.agentModified = 0;
    st.counts.agentDeleted = 0;
    st.wake = false;
    st.deletion = false;
    st.agentOnly = false;
    st.rolledUp = false;
  }

  private linkTail(st: DirState): void {
    st.prev = this.tail;
    st.next = undefined;
    if (this.tail) this.tail.next = st;
    else this.head = st;
    this.tail = st;
  }

  private insertBefore(st: DirState, anchor: DirState | undefined): void {
    if (!anchor) {
      this.linkTail(st);
      return;
    }
    const prev = anchor.prev;
    st.prev = prev;
    st.next = anchor;
    anchor.prev = st;
    if (prev) prev.next = st;
    else this.head = st;
  }

  private insertByLastAt(st: DirState): void {
    let cur = this.head;
    while (cur && cur.lastAt <= st.lastAt) cur = cur.next;
    this.insertBefore(st, cur);
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
      for (const entry of this.dirs.values()) this.recycleState(entry);
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
        this.recycleState(entry);
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
          : [...new Map(dirs.map((t) => [`${t.scope}\0${t.dir}`, t] as const)).values()];
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
      this.recycleState(old);
    }
    let out: BodySignal[] | undefined;
    for (let i = 0; i < targets.length; i++) {
      out = this.record(targets[i] as BurstTarget, signal, items, receivedAt, lim, out);
    }
    return out ?? EMPTY_SIGNALS;
  }

  private addSlotCounts(
    st: DirState,
    slotIdx: number,
    c0: number,
    c1: number,
    c2: number,
    c3: number,
    c4: number,
    c5: number,
  ): void {
    const pos = ringPos(slotIdx);
    const base = pos * COUNT_FIELDS;
    if (st.slotIds[pos] !== slotIdx) {
      st.slotIds[pos] = slotIdx;
      st.slotCounts[base] = c0;
      st.slotCounts[base + 1] = c1;
      st.slotCounts[base + 2] = c2;
      st.slotCounts[base + 3] = c3;
      st.slotCounts[base + 4] = c4;
      st.slotCounts[base + 5] = c5;
    } else {
      st.slotCounts[base] = (st.slotCounts[base] as number) + c0;
      st.slotCounts[base + 1] = (st.slotCounts[base + 1] as number) + c1;
      st.slotCounts[base + 2] = (st.slotCounts[base + 2] as number) + c2;
      st.slotCounts[base + 3] = (st.slotCounts[base + 3] as number) + c3;
      st.slotCounts[base + 4] = (st.slotCounts[base + 4] as number) + c4;
      st.slotCounts[base + 5] = (st.slotCounts[base + 5] as number) + c5;
    }
    st.counts.created += c0;
    st.counts.modified += c1;
    st.counts.deleted += c2;
    st.counts.agentCreated += c3;
    st.counts.agentModified += c4;
    st.counts.agentDeleted += c5;
    if (slotIdx < st.oldestSlot) st.oldestSlot = slotIdx;
    if (slotIdx > st.lastSlot) st.lastSlot = slotIdx;
  }

  private pruneState(st: DirState, receivedAt: number, windowMs: number): void {
    const nextSlotMs = slotWidthMs(windowMs);
    const cutoff = receivedAt - windowMs;
    const cutoffSlot = Math.floor(cutoff / nextSlotMs);
    if (st.lastSlot === Number.NEGATIVE_INFINITY) {
      st.slotMs = nextSlotMs;
      return;
    }
    if (st.slotMs !== nextSlotMs) {
      const oldSlotMs = st.slotMs;
      const saved = this.rebucketBuf;
      saved.length = 0;
      for (let s = st.oldestSlot; s <= st.lastSlot; s++) {
        const pos = ringPos(s);
        if (st.slotIds[pos] !== s) continue;
        const at = s * oldSlotMs;
        if (at < cutoff) continue;
        const base = pos * COUNT_FIELDS;
        saved.push({
          at,
          c0: st.slotCounts[base] as number,
          c1: st.slotCounts[base + 1] as number,
          c2: st.slotCounts[base + 2] as number,
          c3: st.slotCounts[base + 3] as number,
          c4: st.slotCounts[base + 4] as number,
          c5: st.slotCounts[base + 5] as number,
        });
      }
      const { wake, deletion, agentOnly, rolledUp } = st;
      this.clearStateWindow(st);
      st.slotMs = nextSlotMs;
      if (saved.length > 0) {
        st.wake = wake;
        st.deletion = deletion;
        st.agentOnly = agentOnly;
        st.rolledUp = rolledUp;
        for (let i = 0; i < saved.length; i++) {
          const item = saved[i]!;
          this.addSlotCounts(
            st,
            Math.floor(item.at / nextSlotMs),
            item.c0,
            item.c1,
            item.c2,
            item.c3,
            item.c4,
            item.c5,
          );
        }
      }
      saved.length = 0;
      return;
    }

    if (cutoffSlot > st.lastSlot) {
      this.clearStateWindow(st);
      return;
    }
    if (st.oldestSlot < cutoffSlot) {
      for (let s = st.oldestSlot; s < cutoffSlot; s++) {
        const pos = ringPos(s);
        if (st.slotIds[pos] !== s) continue;
        const base = pos * COUNT_FIELDS;
        st.counts.created -= st.slotCounts[base] as number;
        st.counts.modified -= st.slotCounts[base + 1] as number;
        st.counts.deleted -= st.slotCounts[base + 2] as number;
        st.counts.agentCreated -= st.slotCounts[base + 3] as number;
        st.counts.agentModified -= st.slotCounts[base + 4] as number;
        st.counts.agentDeleted -= st.slotCounts[base + 5] as number;
        st.slotIds[pos] = Number.NEGATIVE_INFINITY;
      }
      st.oldestSlot = cutoffSlot;
      if (st.counts.created + st.counts.modified + st.counts.deleted === 0) {
        st.slotIds.fill(Number.NEGATIVE_INFINITY);
        st.oldestSlot = Number.POSITIVE_INFINITY;
        st.lastSlot = Number.NEGATIVE_INFINITY;
        st.wake = false;
        st.deletion = false;
        st.agentOnly = false;
        st.rolledUp = false;
      }
    }
  }

  private mergeStateInto(target: DirState, child: DirState, receivedAt: number, windowMs: number): void {
    this.pruneState(target, receivedAt, windowMs);
    this.pruneState(child, receivedAt, windowMs);
    if (child.lastSlot === Number.NEGATIVE_INFINITY) return;
    for (let s = child.oldestSlot; s <= child.lastSlot; s++) {
      const pos = ringPos(s);
      if (child.slotIds[pos] !== s) continue;
      const base = pos * COUNT_FIELDS;
      this.addSlotCounts(
        target,
        s,
        child.slotCounts[base] as number,
        child.slotCounts[base + 1] as number,
        child.slotCounts[base + 2] as number,
        child.slotCounts[base + 3] as number,
        child.slotCounts[base + 4] as number,
        child.slotCounts[base + 5] as number,
      );
    }
    target.rolledUp = true;
    target.wake ||= child.wake;
    target.deletion ||= child.deletion;
    target.agentOnly ||= child.agentOnly;
  }

  private findAncestorInDirs(scope: string, dir: string): DirState | undefined {
    const root = scopeRoot(scope);
    let cur = parentDirWithin(dir, root);
    while (cur !== undefined) {
      const found = this.dirs.get(`${scope}\0${cur}`);
      if (found) return found;
      cur = parentDirWithin(cur, root);
    }
    return undefined;
  }

  private rollUpOldestUntilUnderCap(
    signal: Signal,
    receivedAt: number,
    lim: { windowMs: number; maxChanges: number; maxDeleted: number },
    out: BodySignal[] | undefined,
  ): BodySignal[] | undefined {
    while (this.dirs.size >= this.maxDirectories) {
      let picked: DirState | undefined;
      let existingParent: DirState | undefined;
      for (let cur = this.head; cur !== undefined; cur = cur.next) {
        const anc = this.findAncestorInDirs(cur.scope, cur.dir);
        if (anc) {
          picked = cur;
          existingParent = anc;
          break;
        }
      }
      if (picked && existingParent) {
        this.unlink(picked);
        this.dirs.delete(picked.key);
        this.mergeStateInto(existingParent, picked, receivedAt, lim.windowMs);
        if (picked.lastAt > existingParent.lastAt) {
          existingParent.lastAt = picked.lastAt;
          this.unlink(existingParent);
          this.insertByLastAt(existingParent);
        }
        this.recycleState(picked);
        const emitted = this.evaluateLatches(
          { scope: existingParent.scope, dir: existingParent.dir },
          existingParent,
          signal,
          receivedAt,
          lim,
        );
        if (emitted) {
          out ??= [];
          out.push(emitted);
        }
        continue;
      }
      let bestDepth = -1;
      let pDir: string | undefined;
      for (let cur = this.head; cur !== undefined; cur = cur.next) {
        const candidate = parentDirWithin(cur.dir, scopeRoot(cur.scope));
        if (candidate === undefined) continue;
        const depth = pathDepth(cur.dir);
        if (depth > bestDepth) {
          bestDepth = depth;
          picked = cur;
          pDir = candidate;
        }
      }
      if (!picked || pDir === undefined) {
        if (!this.head) break;
        const oldest = this.head;
        this.unlink(oldest);
        this.dirs.delete(oldest.key);
        this.recycleState(oldest);
        break;
      }
      const nextAfter = picked.next;
      this.unlink(picked);
      this.dirs.delete(picked.key);
      this.pruneState(picked, receivedAt, lim.windowMs);
      if (picked.lastSlot === Number.NEGATIVE_INFINITY) {
        this.recycleState(picked);
        continue;
      }
      const pKey = `${picked.scope}\0${pDir}`;
      picked.key = pKey;
      picked.dir = pDir;
      picked.rolledUp = true;
      this.dirs.set(pKey, picked);
      this.insertBefore(picked, nextAfter);
    }
    return out;
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
    out: BodySignal[] | undefined,
  ): BodySignal[] | undefined {
    const key = `${target.scope}\0${target.dir}`;
    let st = this.dirs.get(key);
    if (st && receivedAt < st.lastAt) return out; // backward per-directory event
    if (st) {
      this.pruneState(st, receivedAt, lim.windowMs);
      this.moveToTail(st);
    } else if (this.dirs.size >= this.maxDirectories) {
      const ancestor = this.findAncestorInDirs(target.scope, target.dir);
      if (ancestor) {
        st = ancestor;
        this.pruneState(st, receivedAt, lim.windowMs);
        st.rolledUp = true;
        this.moveToTail(st);
      } else {
        out = this.rollUpOldestUntilUnderCap(signal, receivedAt, lim, out);
        const afterAncestor = this.findAncestorInDirs(target.scope, target.dir);
        if (afterAncestor) {
          st = afterAncestor;
          this.pruneState(st, receivedAt, lim.windowMs);
          st.rolledUp = true;
          this.moveToTail(st);
        } else {
          st = this.allocState(key, target.scope, target.dir, slotWidthMs(lim.windowMs));
          this.dirs.set(key, st);
          this.linkTail(st);
        }
      }
    } else {
      st = this.allocState(key, target.scope, target.dir, slotWidthMs(lim.windowMs));
      this.dirs.set(key, st);
      this.linkTail(st);
    }
    st.lastAt = receivedAt;
    const slotIdx = Math.floor(receivedAt / st.slotMs);
    const agent = signal.cause === 'agent';
    for (let i = 0; i < items.length; i++) {
      const item = items[i] as { change: Change; count: number };
      const c = item.count;
      if (item.change === 'add') this.addSlotCounts(st, slotIdx, c, 0, 0, agent ? c : 0, 0, 0);
      else if (item.change === 'modify') this.addSlotCounts(st, slotIdx, 0, c, 0, 0, agent ? c : 0, 0);
      else this.addSlotCounts(st, slotIdx, 0, 0, c, 0, 0, agent ? c : 0);
    }
    const emitted = this.evaluateLatches({ scope: st.scope, dir: st.dir }, st, signal, receivedAt, lim);
    if (emitted) {
      out ??= [];
      out.push(emitted);
    }
    return out;
  }

  private evaluateLatches(
    target: BurstTarget,
    st: DirState,
    signal: Signal,
    receivedAt: number,
    lim: { windowMs: number; maxChanges: number; maxDeleted: number },
  ): BodySignal | undefined {
    const counts = st.counts;
    const extDeleted = counts.deleted - counts.agentDeleted;
    const extTotal = counts.created + counts.modified + counts.deleted - agentCounts(counts);
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
        externalDeleted: Math.max(0, c.deleted - c.agentDeleted),
        ...(st.rolledUp ? { rolledUp: true } : {}),
        ...c,
      },
    };
  }
}

const agentCounts = (c: Counts): number => c.agentCreated + c.agentModified + c.agentDeleted;
