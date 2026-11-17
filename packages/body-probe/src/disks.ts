import fs from 'node:fs';
import path from 'node:path';
import { ttlStatusAt } from '@asi/sense-types';
import * as fact from './fact.js';
import type { DisksFact, DisksValue, DiskVolume, SourceRef } from './types.js';

export interface StatFsResult {
  bsize: number;
  blocks: number;
  bavail: number;
}

export interface DisksDeps {
  stat?: (p: string) => Promise<{ dev: number }>;
  statfs?: (p: string) => Promise<StatFsResult>;
  resolve?: (p: string) => string;
  now?: () => number; // monotonic clock for cadence and staleness
  wall?: () => number; // wall clock stamped on observations
  src?: SourceRef;
}

// mount is the queried path ('/' or the resolved absolute cwd): statfs does
// not report a mountpoint name, so the path we asked about is what we publish.
// The signal is checked before every stat and statfs so an aborted in-flight
// stat can never start statfs or a later queried path.
export async function collectDisks(cwd: string, deps: DisksDeps = {}, signal?: AbortSignal): Promise<DisksValue> {
  const stat = deps.stat ?? ((p: string) => fs.promises.stat(p));
  const statfs = deps.statfs ?? ((p: string) => fs.promises.statfs(p));
  const resolve = deps.resolve ?? ((p: string) => path.resolve(p));
  const seen = new Set<number>();
  const volumes: DisksValue = [];
  for (const queried of ['/', resolve(cwd)]) {
    signal?.throwIfAborted();
    const dev = (await stat(queried)).dev;
    if (seen.has(dev)) continue;
    seen.add(dev);
    signal?.throwIfAborted();
    const s = await statfs(queried);
    volumes.push({ mount: queried, total: s.blocks * s.bsize, free: s.bavail * s.bsize });
  }
  return volumes;
}

const VOLUME_TIMEOUT_MS = 3000;

interface VolumeJob {
  controller: AbortController;
  detach: () => void; // clears the timeout and the parent-signal listener
}

interface VolumeState {
  job?: VolumeJob | undefined; // held until the fs calls really settle, never on abort
  dev?: number; // stat.dev of the last successful read
  value?: { total: number; free: number };
  observedAt?: number; // wall of the last success
  at?: number; // monotonic of the last success
  ttl?: number; // ttl in force at the read; deadline = at + ttl
  attemptedAt?: number; // monotonic settle time; relaunch after period
  failed?: boolean; // stale-known: set on timeout/abort/stop/reject, cleared on success
}

// Each queried path gets its own background job (stat for dev-dedup, then
// statfs) with an independent ~3s timeout, an AbortController linked to the
// caller's signal, and an I/O lock that releases only when the calls settle —
// a wedged volume can never block the tick or pile up operations. sample()
// resolves immediately with current per-volume state: retained numbers stay
// published (stale past their own deadline or once a refresh is known-failed);
// volumes that never succeeded are omitted and listed in unavailableMounts.
export class DiskSampler {
  private readonly volumes = new Map<string, VolumeState>();
  private readonly src: SourceRef;

  constructor(private readonly deps: DisksDeps = {}) {
    this.src = deps.src ?? fact.source('disks', 'fs.statfs');
  }

  sample(cwd: string, ttlMs: number = fact.DEFAULT_TTL_MS, signal?: AbortSignal): Promise<DisksFact> {
    const stat = this.deps.stat ?? ((p: string) => fs.promises.stat(p));
    const statfs = this.deps.statfs ?? ((p: string) => fs.promises.statfs(p));
    const resolve = this.deps.resolve ?? ((p: string) => path.resolve(p));
    const now = (this.deps.now ?? (() => globalThis.performance.now()))();
    const wall = (this.deps.wall ?? (() => Date.now()))();
    const period = ttlMs / 3; // per-volume cadence inferred from the caller's ttl
    const queried: string[] = [];
    for (const q of ['/', resolve(cwd)]) if (!queried.includes(q)) queried.push(q);
    const records: DisksValue = [];
    const seenDev = new Set<number>();
    const missing: string[] = [];
    const parts: fact.FactMeta[] = [];
    const freshParts: fact.FactMeta[] = [];
    for (const q of queried) {
      let v = this.volumes.get(q);
      if (!v) {
        v = {};
        this.volumes.set(q, v);
      }
      if (!signal?.aborted && !v.job && (v.attemptedAt === undefined || now - v.attemptedAt >= period)) {
        this.launch(v, q, stat, statfs, ttlMs, signal);
      }
      if (
        v.value !== undefined &&
        v.observedAt !== undefined &&
        v.at !== undefined &&
        v.ttl !== undefined &&
        (v.dev === undefined || !seenDev.has(v.dev))
      ) {
        if (v.dev !== undefined) seenDev.add(v.dev);
        const deadline = v.at + v.ttl;
        const rec: DiskVolume = {
          mount: q,
          total: v.value.total,
          free: v.value.free,
          status: v.failed ? 'stale' : ttlStatusAt({ status: 'ok', observedAt: v.at, ttlMs: v.ttl }, now),
          observedAt: v.observedAt,
          ttlMs: v.ttl,
        };
        fact.trackDeadline(rec, deadline);
        records.push(rec);
        const part = { observedAt: v.observedAt, periodMs: v.ttl / 3, at: v.at };
        parts.push(part);
        if (rec.status === 'ok') freshParts.push(part);
      } else if (v.value === undefined) {
        missing.push(q);
      }
    }
    // 父级元数据只聚合新鲜卷；全部失鲜时才回落到全部记录（最旧观察 +
    // 最早过期）。父状态：任一 ok → ok；有记录全失鲜 → stale；无记录 → unknown。
    const pool = freshParts.length ? freshParts : parts;
    const meta = pool.length ? fact.oldestMeta(pool) : undefined;
    const f: DisksFact = {
      kind: 'disks',
      value: records.length ? records : null,
      status: records.some((r) => r.status === 'ok') ? 'ok' : records.length ? 'stale' : 'unknown',
      source: this.src,
      observedAt: meta?.observedAt ?? wall,
      ttlMs: meta?.ttlMs ?? ttlMs,
      ...(missing.length ? { unavailableMounts: missing } : {}),
    };
    if (meta?.expiresAt !== undefined) fact.trackDeadline(f, meta.expiresAt);
    return Promise.resolve(fact.stale(f, now, wall));
  }

  private launch(
    v: VolumeState,
    q: string,
    stat: (p: string) => Promise<{ dev: number }>,
    statfs: (p: string) => Promise<StatFsResult>,
    ttlMs: number,
    signal?: AbortSignal,
  ): void {
    const controller = new AbortController();
    const detach = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', fail);
    };
    // Timeout or parent abort kills the generation instantly — timer and
    // listener go, late results are discarded — but the lock stays until the
    // finally below, when the fs calls really settle.
    const fail = () => {
      v.failed = true;
      detach();
      controller.abort(new Error('disk volume aborted'));
    };
    const timer = setTimeout(fail, VOLUME_TIMEOUT_MS);
    timer.unref?.();
    signal?.addEventListener('abort', fail, { once: true });
    const job: VolumeJob = { controller, detach };
    v.job = job;
    void (async () => {
      try {
        const dev = (await stat(q)).dev;
        if (controller.signal.aborted) return;
        const s = await statfs(q);
        if (controller.signal.aborted) return;
        v.dev = dev;
        v.value = { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
        v.observedAt = this.wall();
        v.at = this.now();
        v.ttl = ttlMs;
        v.failed = false;
      } catch {
        v.failed = true; // rejected I/O affects only this volume
      } finally {
        try {
          v.attemptedAt = this.now();
        } catch {
          /* a broken clock must not leak the lock or the timer */
        }
        if (v.job === job) v.job = undefined;
        detach();
      }
    })().catch(() => {});
  }

  private now(): number {
    return (this.deps.now ?? (() => globalThis.performance.now()))();
  }

  private wall(): number {
    return (this.deps.wall ?? (() => Date.now()))();
  }

  // Aborts in-flight jobs and clears their timers/listeners; locks stay held
  // until the underlying calls settle, across any number of restarts.
  stop(): void {
    for (const v of this.volumes.values()) {
      if (!v.job) continue;
      v.failed = true;
      v.job.detach();
      v.job.controller.abort(new Error('disk sampler stopped'));
    }
  }
}
