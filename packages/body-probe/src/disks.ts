import fs from 'node:fs';
import path from 'node:path';
import * as fact from './fact.js';
import type { DisksValue, Fact, SourceRef } from './types.js';

export interface StatFsResult {
  bsize: number;
  blocks: number;
  bavail: number;
}

export interface DisksDeps {
  stat?: (p: string) => Promise<{ dev: number }>;
  statfs?: (p: string) => Promise<StatFsResult>;
  resolve?: (p: string) => string;
  src?: SourceRef;
}

// mount is the queried path ('/' or the resolved absolute cwd): statfs does
// not report a mountpoint name, so the path we asked about is what we publish.
export async function collectDisks(cwd: string, deps: DisksDeps = {}): Promise<DisksValue> {
  const stat = deps.stat ?? ((p: string) => fs.promises.stat(p));
  const statfs = deps.statfs ?? ((p: string) => fs.promises.statfs(p));
  const resolve = deps.resolve ?? ((p: string) => path.resolve(p));
  const seen = new Set<number>();
  const volumes: DisksValue = [];
  for (const queried of ['/', resolve(cwd)]) {
    const dev = (await stat(queried)).dev;
    if (seen.has(dev)) continue;
    seen.add(dev);
    const s = await statfs(queried);
    volumes.push({ mount: queried, total: s.blocks * s.bsize, free: s.bavail * s.bsize });
  }
  return volumes;
}

export class DiskSampler {
  private readonly src: SourceRef;

  constructor(private readonly deps: DisksDeps = {}) {
    this.src = deps.src ?? fact.source('disks', 'fs.statfs');
  }

  sample(cwd: string, ttlMs: number = fact.DEFAULT_TTL_MS): Promise<Fact<DisksValue>> {
    return fact.collect(this.src, () => collectDisks(cwd, this.deps), ttlMs);
  }
}
