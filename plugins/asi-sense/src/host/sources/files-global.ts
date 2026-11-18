import os from 'node:os';
import path from 'node:path';
import type { GlobalFileWatchStatus, GlobalFileWatchValue, Signal } from '@asi/sense-types';
import type { BurstTarget } from '../body/burst.ts';
import type { RuntimeAttention } from '../runtime/attention.ts';
import type { Clock, FileChange, FileWatcher, GlobalFileWatchOptions } from '../runtime/ports.ts';
import type { DshSource } from './dsh.ts';
import { ExclusionMatcher, normalizeAbsPath, resolvePathVariants } from './file-exclusions.ts';

const source = { id: 'files-global', api: 'watch', host: 'local' };
const deniedSubSource = { id: 'files-global-denied', api: 'watch', host: 'local' };

const DEFAULT_WINDOW_MS = 10_000;
const DEFAULT_BUDGET_PER_SEC = 2_000;
const DEFAULT_BUDGET_SUSTAIN_MS = 30_000;
const DEFAULT_DEGRADED_WINDOW_MS = 60_000;
const DEFAULT_RECOVERY_WINDOW_MS = 30_000;
const MAX_BUCKETS = 2_000;
const MAX_FILES_PER_BUCKET = 5;

interface ActivityGroup {
  created: number;
  modified: number;
  deleted: number;
  rolledUp: number;
  files: Set<string>;
}

interface ActivityBucket {
  dir: string;
  latestAt: number;
  ext?: ActivityGroup;
  agent?: ActivityGroup;
}

function resolveDataDirs(dirs: readonly string[] | undefined, platform: string): string[] {
  if (!dirs?.length) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    if (!dir || !path.isAbsolute(dir)) continue;
    for (const variant of resolvePathVariants(path.resolve(dir), platform)) {
      if (!seen.has(variant)) {
        seen.add(variant);
        out.push(variant);
      }
    }
  }
  return out;
}

function newGroup(): ActivityGroup {
  return { created: 0, modified: 0, deleted: 0, rolledUp: 0, files: new Set() };
}

function parentDir(dir: string, root: string): string | undefined {
  if (dir === root || dir === '/') return undefined;
  if (root !== '/' && !dir.startsWith(`${root}/`)) return undefined;
  const slash = dir.lastIndexOf('/');
  const parent = slash <= 0 ? '/' : dir.slice(0, slash);
  if (root !== '/' && parent.length < root.length) return root;
  return parent;
}

export class FileGlobalSource {
  private readonly root: string;
  private readonly baseWindowMs: number;
  private readonly budgetPerSec: number;
  private readonly budgetSustainMs: number;
  private readonly degradedWindowMs: number;
  private readonly recoveryWindowMs: number;
  private readonly homedir: string;
  private readonly dataDirs: string[];

  private handle?: { close(): void | Promise<void> };
  private exclusions: ExclusionMatcher;
  private stopped = false;
  private tail = Promise.resolve();
  private flushEpoch = 0;

  private buckets = new Map<string, ActivityBucket>();
  private windowStartMono?: number;
  private windowDeadlineMono?: number;

  private readonly deniedPaths = new Set<string>();
  private rootDenied = false;
  private watchUnavailable = false;
  private rebuildAttempts = 0;
  private unsupportedReported = false;

  private degraded = false;
  private countOnly = false;
  private secStartMono?: number;
  private countInSec = 0;
  private eventsPerSec = 0;
  private aboveSinceMono?: number;
  private belowSinceMono?: number;
  private scheduledDeadline?: number;
  private lastSourceStatus?: string;
  private lastFactKey = '';
  private lastRolledUp = false;

  constructor(
    private readonly watcher: FileWatcher,
    private readonly clock: Clock,
    private readonly attention: RuntimeAttention,
    private readonly dsh: Pick<DshSource, 'classifyFilePath'>,
    private readonly settings: {
      globalFileWatch: boolean;
      fileExclusions(): string[];
    },
    private readonly paused: () => boolean,
    private readonly burst: (
      signal: Signal,
      dirs: readonly BurstTarget[],
      receivedMono?: number,
    ) => Promise<void> | undefined,
    private readonly setGlobalScope: (enabled: boolean) => void,
    private readonly coveredByDirRule: (absPath: string) => boolean,
    private readonly reschedule: () => void,
    private readonly options: GlobalFileWatchOptions = {},
    private readonly platform: string = process.platform,
  ) {
    this.root = normalizeAbsPath(options.root ?? '/') ?? '/';
    this.baseWindowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.budgetPerSec = options.budgetPerSec ?? DEFAULT_BUDGET_PER_SEC;
    this.budgetSustainMs = options.budgetSustainMs ?? DEFAULT_BUDGET_SUSTAIN_MS;
    this.degradedWindowMs = options.degradedWindowMs ?? DEFAULT_DEGRADED_WINDOW_MS;
    this.recoveryWindowMs = options.recoveryWindowMs ?? DEFAULT_RECOVERY_WINDOW_MS;
    this.homedir = options.homedir ?? os.homedir();
    this.dataDirs = resolveDataDirs(options.dataDirs, this.platform);
    this.exclusions = new ExclusionMatcher(this.settings.fileExclusions(), this.dataDirs, this.homedir, this.platform);
  }

  isWatching(): boolean {
    return (
      !this.stopped &&
      !this.paused() &&
      this.settings.globalFileWatch &&
      this.handle !== undefined &&
      !this.rootDenied &&
      !this.watchUnavailable
    );
  }

  isDegraded(): boolean {
    return this.degraded;
  }

  currentWindowMs(): number {
    return this.degraded ? this.degradedWindowMs : this.baseWindowMs;
  }

  /** Clears latched watch failure state when the user explicitly toggles global watch. */
  resetWatchAvailability(): void {
    this.watchUnavailable = false;
    this.rebuildAttempts = 0;
  }

  private wantsWatch(): boolean {
    return !this.stopped && !this.paused() && this.settings.globalFileWatch && !this.options.disableInTests;
  }

  private currentStatus(): GlobalFileWatchStatus {
    if (!this.settings.globalFileWatch || this.stopped || this.options.disableInTests) return 'disabled';
    if (this.rootDenied) return 'denied';
    if (this.watchUnavailable || this.paused()) return 'disabled';
    if (this.degraded) return 'degraded';
    if (this.deniedPaths.size > 0) return 'partial-denied';
    return 'running';
  }

  private supportedPlatform(): boolean {
    return this.platform === 'darwin' || this.root !== '/' || this.options.allowNonDarwinRoot === true;
  }

  private resetRuntimeState(): void {
    this.buckets.clear();
    this.windowStartMono = undefined;
    this.windowDeadlineMono = undefined;
    this.secStartMono = undefined;
    this.countInSec = 0;
    this.eventsPerSec = 0;
    this.aboveSinceMono = undefined;
    this.belowSinceMono = undefined;
    this.degraded = false;
    this.countOnly = false;
    this.scheduledDeadline = undefined;
  }

  private async closeWatcher(): Promise<void> {
    const existing = this.handle;
    this.handle = undefined;
    if (existing) await existing.close();
  }

  private async openWatcher(probeProtected: boolean): Promise<boolean> {
    try {
      let current: { close(): void | Promise<void> } | undefined;
      current = this.watcher.watch(
        this.root,
        (event) => {
          if (current) this.onWatcherEvent(current, event);
        },
        { recursive: true },
      );
      this.handle = current;
      if (!this.degraded) await this.emitSourceStatus('ok');
      if (probeProtected) {
        for (const dir of this.options.protectedDirs ?? []) {
          const norm = normalizeAbsPath(dir);
          if (!norm || this.exclusions.isExcluded(norm)) continue;
          if (this.options.probeAccess?.(norm) === false) {
            await this.handleDenied(norm, norm === this.root);
          }
        }
      }
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === 'EPERM' || code === 'EACCES') {
        await this.handleDenied(this.root, true);
      } else {
        this.watchUnavailable = true;
        this.setGlobalScope(false);
        await this.emitSourceStatus('error', { error: code ?? 'watch-failed' });
      }
      return false;
    }
  }

  refresh(): Promise<void> {
    if (!this.wantsWatch() || !this.supportedPlatform()) {
      this.flushEpoch++;
    }
    const run = this.tail.then(async () => {
      const enabled = this.settings.globalFileWatch;
      const wantsWatch = this.wantsWatch();
      const supported = this.supportedPlatform();

      if (!wantsWatch || !supported) {
        await this.closeWatcher();
        this.resetRuntimeState();
        if (!enabled || this.stopped || this.options.disableInTests) {
          this.rootDenied = false;
          this.watchUnavailable = false;
          this.rebuildAttempts = 0;
          this.deniedPaths.clear();
        }
        this.setGlobalScope(false);
        if (!this.stopped && !this.attention.isStopped()) {
          if (wantsWatch && !supported) {
            this.watchUnavailable = true;
            if (!this.unsupportedReported) {
              this.unsupportedReported = true;
              await this.emitSourceStatus('unavailable', { reason: 'unsupported-platform' });
            }
            this.publishFact('unavailable', '当前平台不支持全盘 FSEvents 监视');
          } else {
            if (!enabled) await this.emitSourceStatus('unavailable', { reason: 'disabled' });
            this.publishFact('ok');
          }
        }
        this.reschedule();
        return;
      }

      this.exclusions = new ExclusionMatcher(
        this.settings.fileExclusions(),
        this.dataDirs,
        this.homedir,
        this.platform,
      );
      this.unsupportedReported = false;
      if (!this.handle && !this.rootDenied && !this.watchUnavailable) {
        await this.openWatcher(true);
      }

      this.setGlobalScope(this.isWatching());
      if (this.rootDenied) {
        this.publishFact('denied', '全盘文件监视无权限');
      } else {
        this.publishFact(this.watchUnavailable ? 'unavailable' : 'ok');
      }
      this.maybeReschedule();
      if (this.nextDeadline() === undefined) this.reschedule();
    });
    this.tail = run.catch(() => {});
    return run;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.flushEpoch++;
    await this.refresh();
  }

  nextDeadline(): number | undefined {
    if (!this.isWatching()) return undefined;
    let earliest = this.windowDeadlineMono ?? Number.POSITIVE_INFINITY;
    if (
      this.secStartMono !== undefined &&
      (this.countInSec > 0 || (this.degraded && this.belowSinceMono === undefined))
    ) {
      earliest = Math.min(earliest, this.secStartMono + 1_000);
    } else if (this.degraded && this.belowSinceMono !== undefined) {
      earliest = Math.min(earliest, this.belowSinceMono + this.recoveryWindowMs);
    }
    return Number.isFinite(earliest) ? earliest : undefined;
  }

  tick(): Promise<void> {
    if (!this.isWatching()) return Promise.resolve();
    const epoch = this.flushEpoch;
    const run = this.tail.then(async () => {
      if (epoch !== this.flushEpoch || !this.isWatching()) return;
      const mono = this.clock.mono();
      const transition = this.advanceBudget(mono);
      if (transition === 'degraded') await this.applyDegraded();
      else if (transition === 'recovered') await this.applyRecovered();

      if (this.windowDeadlineMono !== undefined && this.windowDeadlineMono <= mono) {
        const flushed = this.buckets;
        this.buckets = new Map();
        this.windowStartMono = undefined;
        this.windowDeadlineMono = undefined;
        for (const bucket of flushed.values()) {
          if (epoch !== this.flushEpoch || !this.isWatching()) break;
          await this.emitBucket(bucket);
        }
      }

      if (!transition && this.buckets.size === 0 && this.countInSec === 0 && this.eventsPerSec !== 0) {
        this.eventsPerSec = 0;
        this.publishFact('ok');
      }
      this.scheduledDeadline = undefined;
    });
    this.tail = run.catch(() => {});
    return run;
  }

  private maybeReschedule(): void {
    const next = this.nextDeadline();
    if (next === undefined) return;
    if (this.scheduledDeadline === undefined || next < this.scheduledDeadline) {
      this.scheduledDeadline = next;
      this.reschedule();
    }
  }

  private onWatcherEvent(handle: { close(): void | Promise<void> }, event: FileChange): void {
    if (this.handle !== handle || !this.isWatching()) return;
    if (event.watchError === true) {
      const code = event.errorCode;
      if (code === 'EPERM' || code === 'EACCES') {
        const target = normalizeAbsPath(event.errorPath ?? event.path) ?? this.root;
        const isRoot = target === this.root;
        const run = this.tail.then(async () => {
          if (this.handle !== handle) return;
          if (isRoot) {
            await this.handleDenied(target, true);
            return;
          }
          await this.handleDenied(target, false);
          // Subtree EPERM via FSWatcher error may leave the native handle broken;
          // close and rebuild once so healthy subtrees continue receiving events.
          await this.closeWatcher();
          if (this.wantsWatch() && this.supportedPlatform() && !this.rootDenied && !this.watchUnavailable) {
            await this.openWatcher(false);
          }
          this.setGlobalScope(this.isWatching());
          if (this.rootDenied) this.publishFact('denied', '全盘文件监视无权限');
          else this.publishFact(this.watchUnavailable ? 'unavailable' : 'ok');
          this.maybeReschedule();
          if (this.nextDeadline() === undefined) this.reschedule();
        });
        this.tail = run.catch(() => {});
        return;
      }

      this.flushEpoch++;
      const run = this.tail.then(async () => {
        if (this.handle !== handle) return;
        await this.closeWatcher();
        this.resetRuntimeState();
        this.reschedule();
        if (this.wantsWatch() && this.supportedPlatform() && this.rebuildAttempts < 1) {
          this.rebuildAttempts++;
          const ok = await this.openWatcher(false);
          this.setGlobalScope(this.isWatching());
          if (ok) {
            this.publishFact('ok');
            this.maybeReschedule();
            return;
          }
        } else {
          this.watchUnavailable = true;
          this.setGlobalScope(false);
          await this.emitSourceStatus('error', { error: code ?? 'watch-failed' });
        }
        if (this.rootDenied) this.publishFact('denied', '全盘文件监视无权限');
        else this.publishFact('unavailable', '全盘文件监视出错');
        this.reschedule();
      });
      this.tail = run.catch(() => {});
      return;
    }

    if (typeof event.path !== 'string' || event.path.charCodeAt(0) !== 47) return;
    if (event.change !== 'add' && event.change !== 'modify' && event.change !== 'delete') return;
    const absPath = normalizeAbsPath(event.path);
    if (!absPath || this.exclusions.isExcludedNormalized(absPath)) return;

    const mono = this.clock.mono();
    const transition = this.advanceBudget(mono);
    if (this.secStartMono === undefined) this.secStartMono = mono;
    this.countInSec++;

    const slash = absPath.lastIndexOf('/');
    const dir = slash <= 0 ? '/' : absPath.slice(0, slash);
    const base = slash < 0 ? absPath : absPath.slice(slash + 1);
    const agent = this.dsh.classifyFilePath(absPath) === 'agent';
    const wallAt = event.at ?? this.clock.wall();

    if (this.windowStartMono === undefined) {
      this.windowStartMono = mono;
      this.windowDeadlineMono = mono + this.currentWindowMs();
    }

    const bucket = this.resolveTargetBucket(dir, wallAt);
    const rolledUp = this.lastRolledUp;
    let group: ActivityGroup;
    if (agent) {
      if (!bucket.agent) bucket.agent = newGroup();
      group = bucket.agent;
    } else {
      if (!bucket.ext) bucket.ext = newGroup();
      group = bucket.ext;
    }
    if (event.change === 'add') group.created++;
    else if (event.change === 'modify') group.modified++;
    else group.deleted++;
    if (rolledUp) group.rolledUp++;
    if (!this.countOnly && base.length > 0 && group.files.size < MAX_FILES_PER_BUCKET) {
      group.files.add(base);
    }

    if (!this.coveredByDirRule(absPath)) {
      const rawSignal: Signal = {
        id: this.attention.id(),
        kind: 'file.changed',
        at: wallAt,
        source,
        subject: absPath,
        cause: agent ? 'agent' : 'unknown',
        data: { path: absPath, change: event.change },
      };
      const pending = this.burst(rawSignal, [{ scope: 'global', dir }], mono);
      if (pending) void pending.catch(() => {});
    }

    if (transition === 'degraded') {
      const work = this.tail.then(() => this.applyDegraded());
      this.tail = work.catch(() => {});
    } else if (transition === 'recovered') {
      const work = this.tail.then(() => this.applyRecovered());
      this.tail = work.catch(() => {});
    }
    this.maybeReschedule();
  }

  private findAncestorBucket(dir: string): ActivityBucket | undefined {
    let cur = parentDir(dir, this.root);
    while (cur !== undefined) {
      const found = this.buckets.get(cur);
      if (found) return found;
      cur = parentDir(cur, this.root);
    }
    return undefined;
  }

  private mergeGroupInto(target: ActivityGroup, child: ActivityGroup): void {
    target.created += child.created;
    target.modified += child.modified;
    target.deleted += child.deleted;
    target.rolledUp += child.created + child.modified + child.deleted;
    if (!this.countOnly && target.files.size < MAX_FILES_PER_BUCKET) {
      for (const f of child.files) {
        if (target.files.size >= MAX_FILES_PER_BUCKET) break;
        target.files.add(f);
      }
    }
  }

  private mergeBucketInto(target: ActivityBucket, child: ActivityBucket): void {
    if (child.latestAt > target.latestAt) target.latestAt = child.latestAt;
    if (child.ext) {
      if (!target.ext) target.ext = newGroup();
      this.mergeGroupInto(target.ext, child.ext);
    }
    if (child.agent) {
      if (!target.agent) target.agent = newGroup();
      this.mergeGroupInto(target.agent, child.agent);
    }
  }

  private rollUpOldestUntilUnderCap(): void {
    while (this.buckets.size >= MAX_BUCKETS) {
      let pickedDir: string | undefined;
      let pickedBucket: ActivityBucket | undefined;
      for (const [k, b] of this.buckets) {
        if (k !== this.root) {
          pickedDir = k;
          pickedBucket = b;
          break;
        }
      }
      if (pickedDir === undefined || pickedBucket === undefined) break;
      const pDir = parentDir(pickedDir, this.root);
      if (pDir === undefined) break;
      this.buckets.delete(pickedDir);
      let pBucket = this.buckets.get(pDir);
      if (!pBucket) {
        pBucket = { dir: pDir, latestAt: pickedBucket.latestAt };
        this.buckets.set(pDir, pBucket);
      }
      this.mergeBucketInto(pBucket, pickedBucket);
    }
  }

  private resolveTargetBucket(dir: string, wallAt: number): ActivityBucket {
    const existing = this.buckets.get(dir);
    if (existing) {
      if (wallAt > existing.latestAt) existing.latestAt = wallAt;
      this.lastRolledUp = false;
      return existing;
    }
    if (this.buckets.size < MAX_BUCKETS) {
      const bucket: ActivityBucket = { dir, latestAt: wallAt };
      this.buckets.set(dir, bucket);
      this.lastRolledUp = false;
      return bucket;
    }

    const ancestor = this.findAncestorBucket(dir);
    if (ancestor) {
      if (wallAt > ancestor.latestAt) ancestor.latestAt = wallAt;
      this.lastRolledUp = true;
      return ancestor;
    }

    this.rollUpOldestUntilUnderCap();
    const afterAncestor = this.findAncestorBucket(dir);
    if (afterAncestor) {
      if (wallAt > afterAncestor.latestAt) afterAncestor.latestAt = wallAt;
      this.lastRolledUp = true;
      return afterAncestor;
    }

    const parent = parentDir(dir, this.root);
    const targetDir = parent ?? dir;
    let target = this.buckets.get(targetDir);
    if (!target) {
      target = { dir: targetDir, latestAt: wallAt };
      this.buckets.set(targetDir, target);
    } else if (wallAt > target.latestAt) {
      target.latestAt = wallAt;
    }
    this.lastRolledUp = parent !== undefined;
    return target;
  }

  private advanceBudget(mono: number): 'degraded' | 'recovered' | undefined {
    if (this.secStartMono === undefined) {
      if (!this.degraded) return undefined;
      this.belowSinceMono ??= mono;
      if (mono - this.belowSinceMono >= this.recoveryWindowMs) {
        this.eventsPerSec = 0;
        this.degraded = false;
        this.countOnly = false;
        this.belowSinceMono = undefined;
        return 'recovered';
      }
      return undefined;
    }
    const elapsedMs = mono - this.secStartMono;
    if (elapsedMs < 1_000) return undefined;

    const elapsedSecs = Math.floor(elapsedMs / 1_000);
    const firstEnd = this.secStartMono + 1_000;
    let transition = this.evaluateRateSecond(this.countInSec, this.secStartMono, firstEnd);
    if (elapsedSecs > 1) {
      const gapTransition = this.evaluateRateSecond(0, firstEnd, this.secStartMono + elapsedSecs * 1_000);
      if (gapTransition) transition = gapTransition;
    }
    this.secStartMono += elapsedSecs * 1_000;
    this.countInSec = 0;
    return transition;
  }

  private evaluateRateSecond(rate: number, startMono: number, endMono: number): 'degraded' | 'recovered' | undefined {
    this.eventsPerSec = rate;
    if (rate > this.budgetPerSec) {
      this.belowSinceMono = undefined;
      this.aboveSinceMono ??= startMono;
      if (!this.degraded && endMono - this.aboveSinceMono >= this.budgetSustainMs) {
        this.degraded = true;
        this.countOnly = true;
        return 'degraded';
      }
      return undefined;
    }
    this.aboveSinceMono = undefined;
    if (this.degraded) {
      this.belowSinceMono ??= startMono;
      if (endMono - this.belowSinceMono >= this.recoveryWindowMs) {
        this.degraded = false;
        this.countOnly = false;
        this.belowSinceMono = undefined;
        return 'recovered';
      }
    }
    return undefined;
  }

  private async applyDegraded(): Promise<void> {
    for (const bucket of this.buckets.values()) {
      bucket.ext?.files.clear();
      bucket.agent?.files.clear();
    }
    if (this.windowStartMono !== undefined) {
      this.windowDeadlineMono = Math.max(this.windowDeadlineMono ?? 0, this.windowStartMono + this.degradedWindowMs);
    }
    this.scheduledDeadline = undefined;
    this.maybeReschedule();
    await this.emitSourceStatus('error', {
      error: 'budget-degraded',
      degraded: true,
      eventsPerSec: this.eventsPerSec,
      windowMs: this.degradedWindowMs,
      reason: '事件速率超预算，已扩大聚合窗口并仅保留计数',
    });
    this.publishFact('ok');
  }

  private async applyRecovered(): Promise<void> {
    if (this.windowStartMono !== undefined && this.windowDeadlineMono !== undefined) {
      this.windowDeadlineMono = Math.min(this.windowDeadlineMono, this.windowStartMono + this.baseWindowMs);
    }
    this.scheduledDeadline = undefined;
    this.maybeReschedule();
    await this.emitSourceStatus('ok', {
      degraded: false,
      eventsPerSec: this.eventsPerSec,
      windowMs: this.baseWindowMs,
      reason: '事件速率恢复正常，已还原聚合窗口',
    });
    this.publishFact('ok');
  }

  private async handleDenied(deniedPath: string, isRoot: boolean): Promise<void> {
    const firstForPath = !this.deniedPaths.has(deniedPath);
    this.deniedPaths.add(deniedPath);
    if (isRoot) {
      this.rootDenied = true;
      this.flushEpoch++;
      await this.closeWatcher();
      this.resetRuntimeState();
      this.setGlobalScope(false);
      await this.emitSourceStatus('denied', {
        error: 'permission-denied',
        path: deniedPath,
        reason: '全盘文件监视无权限',
      });
      this.publishFact('denied', '全盘文件监视无权限');
      this.reschedule();
      return;
    }
    if (firstForPath && !this.attention.isStopped()) {
      await this.attention.accept({
        id: this.attention.id(),
        kind: 'source.status',
        at: this.clock.wall(),
        source: deniedSubSource,
        subject: deniedPath,
        data: {
          status: 'denied',
          error: 'permission-denied',
          path: deniedPath,
          reason: '部分受保护目录无访问权限',
        },
      });
    }
    this.publishFact('ok');
  }

  private async emitSourceStatus(
    status: 'ok' | 'denied' | 'error' | 'unavailable',
    extra: Record<string, unknown> = {},
  ): Promise<void> {
    if (this.attention.isStopped()) return;
    const key = JSON.stringify([status, extra.error ?? '', extra.degraded ?? null]);
    if (this.lastSourceStatus === key) return;
    this.lastSourceStatus = key;
    await this.attention.accept({
      id: this.attention.id(),
      kind: 'source.status',
      at: this.clock.wall(),
      source,
      subject: 'files-global',
      data: { status, ...extra },
    });
  }

  private async emitBucket(bucket: ActivityBucket): Promise<void> {
    if (this.stopped || this.attention.isStopped()) return;
    const groups: { group: ActivityGroup; agent: boolean }[] = [];
    if (bucket.ext) groups.push({ group: bucket.ext, agent: false });
    if (bucket.agent) groups.push({ group: bucket.agent, agent: true });
    if (groups.length === 0) return;

    const preserveSourceStatus = this.degraded || this.deniedPaths.size > 0;
    const windowMs = this.currentWindowMs();
    for (const { group, agent } of groups) {
      const signal: Signal = {
        id: this.attention.id(),
        kind: 'file.activity',
        at: bucket.latestAt,
        source,
        subject: bucket.dir,
        cause: agent ? 'agent' : 'unknown',
        data: {
          directory: bucket.dir,
          windowMs,
          created: group.created,
          modified: group.modified,
          deleted: group.deleted,
          files: this.countOnly ? [] : [...group.files],
          ...(group.rolledUp > 0 ? { rolledUp: group.rolledUp } : {}),
          ...(this.degraded ? { degraded: true } : {}),
          ...(preserveSourceStatus ? { preserveSourceStatus: true } : {}),
        },
      };
      await this.attention.accept(signal);
    }
  }

  private publishFact(factStatus: 'ok' | 'denied' | 'unavailable', reason?: string): void {
    if (this.stopped || this.attention.isStopped()) return;
    const value: GlobalFileWatchValue = {
      enabled: this.settings.globalFileWatch,
      status: this.currentStatus(),
      root: this.root,
      windowMs: this.currentWindowMs(),
      eventsPerSec: this.eventsPerSec,
      degraded: this.degraded,
      countOnly: this.countOnly,
      deniedPaths: [...this.deniedPaths],
      exclusions: this.settings.fileExclusions(),
    };
    const key = JSON.stringify([factStatus, reason ?? '', value]);
    if (key === this.lastFactKey) return;
    this.lastFactKey = key;
    this.attention.store.apply({
      id: this.attention.id(),
      kind: 'fact.updated',
      at: this.clock.wall(),
      source,
      subject: 'env.globalFileWatch',
      data: {
        path: 'env.globalFileWatch',
        value,
        status: factStatus,
        ttlMs: 86_400_000,
        preserveSourceStatus: true,
        ...(reason ? { reason } : {}),
      },
    });
    this.attention.changed();
  }
}
