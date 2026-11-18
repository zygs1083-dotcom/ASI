import type { Signal } from '@asi/sense-types';
import { describe, expect, it } from 'vitest';
import { type BurstTarget, FileBurstDetector as Detector } from '../../src/host/body/burst.ts';
import { sig } from '../helpers.ts';
import { fileChanged } from './helpers.ts';

let seq = 0;
const ev = (at: number, path: string, change: string, cause?: 'agent') =>
  fileChanged(`e${seq++}`, at, path, change, cause);
const del = (at: number, path: string, cause?: 'agent') => ev(at, path, 'delete', cause);
const add = (at: number, path: string, cause?: 'agent') => ev(at, path, 'add', cause);
const mod = (at: number, path: string, cause?: 'agent') => ev(at, path, 'modify', cause);

class FileBurstDetector extends Detector {
  accept(signal: Signal, receivedAt = signal.at, dirs?: readonly BurstTarget[]) {
    return super.accept(signal, receivedAt, dirs);
  }
}

describe('FileBurstDetector per-directory windows', () => {
  it('requires a finite monotonic receipt time at the detector seam', () => {
    const detector = new Detector();
    const signal = del(0, '/w/x');
    expect(() => detector.accept(signal, undefined as unknown as number)).toThrow(TypeError);
    expect(() => detector.accept(signal, Number.NaN)).toThrow(TypeError);
  });

  it('counts each directory on its own watermark — /a@0 /b@2000 /a@10,20', () => {
    const d = new FileBurstDetector({ windowMs: 1000, maxDeleted: 2 });
    expect(d.accept(del(0, '/a/x'))).toHaveLength(0);
    expect(d.accept(del(2000, '/b/y'), 1)).toHaveLength(0); // /b starts its own window
    expect(d.accept(del(10, '/a/y'))).toHaveLength(0);
    const out = d.accept(del(20, '/a/z')); // /a third external delete > 2 → wake
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      kind: 'file.burst',
      subject: '/a',
      layer: 'rate',
      data: { wake: true, externalDeletionExceeded: true, deleted: 3, agentDeleted: 0 },
    });
  });

  it('prunes only within the same directory (old /a events expire on /a time)', () => {
    const d = new FileBurstDetector({ windowMs: 1000, maxDeleted: 2 });
    d.accept(del(0, '/a/x'));
    d.accept(del(10, '/a/y'));
    // A far-future /b event must NOT prune /a's pending window — and a fresh
    // /a event at the same late stamp does.
    expect(d.accept(del(60_000, '/b/z'), 20)).toHaveLength(0);
    expect(d.accept(del(60_000, '/a/q'))).toHaveLength(0); // window emptied first → 1 delete only
    d.accept(del(60_500, '/a/r'));
    const out = d.accept(del(61_000, '/a/s')); // q@60000 kept at cutoff → 3 > 2
    expect(out[0]?.data.externalDeletionExceeded).toBe(true);
  });

  it('rejects backward per-directory events without wiping history', () => {
    const d = new FileBurstDetector({ windowMs: 1000, maxDeleted: 1 });
    d.accept(del(100, '/a/x')); // 1 delete — not yet over
    d.accept(del(50, '/a/y')); // backward — ignored, must not wipe the window
    const out = d.accept(del(200, '/a/y')); // 100 still in window → 2 > 1
    expect(out).toHaveLength(1);
    expect(out[0]?.data.deleted).toBe(2);
  });
});

describe('FileBurstDetector external vs agent counts', () => {
  it('detects 51 deletes after a wall-clock jump and rollback using receipt time', () => {
    const d = new FileBurstDetector();
    d.accept(add(10_000_000, '/w/a'), 0);
    const out = [];
    for (let i = 0; i < 51; i++) out.push(...d.accept(del(i, `/w/${i}`), i + 1));
    expect(out.at(-1)?.data.externalDeletionExceeded).toBe(true);
  });

  it('reclaims one-off directories and caps active directories', () => {
    const d = new FileBurstDetector();
    for (let i = 0; i < 1000; i++) d.accept(add(i * 120_000, `/w${i}/x`));
    const dirs = (d as unknown as { dirs: Map<string, unknown> }).dirs;
    expect(dirs.size).toBeLessThanOrEqual(1);
    for (let i = 0; i < 1100; i++) d.accept(add(200_000_000 + i, `/active${i}/x`));
    expect(dirs.size).toBeLessThanOrEqual(1024);
    expect(dirs.has('/active0')).toBe(false);
  });

  it('emits a deletion upgrade after total external changes already crossed', () => {
    const d = new FileBurstDetector();
    const output = [];
    for (let i = 0; i < 101; i++) output.push(...d.accept(add(i, `/w/a${i}`)));
    for (let i = 0; i < 51; i++) output.push(...d.accept(del(101 + i, `/w/d${i}`)));
    expect(output).toHaveLength(2);
    expect(output[0]?.data.externalDeletionExceeded).toBe(false);
    expect(output[1]?.data.externalDeletionExceeded).toBe(true);
  });

  it('counts agent add/modify/delete separately; pure agent crossings never wake', () => {
    const d = new FileBurstDetector({ windowMs: 60_000, maxChanges: 2, maxDeleted: 50 });
    expect(d.accept(add(0, '/w/a', 'agent'))).toHaveLength(0);
    expect(d.accept(mod(1, '/w/b', 'agent'))).toHaveLength(0);
    const out = d.accept(del(2, '/w/c', 'agent')); // 3 changes > 2 — ALL agent-caused
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      kind: 'file.burst',
      cause: 'agent',
      data: {
        level: 'record',
        wake: false,
        created: 1,
        modified: 1,
        deleted: 1,
        agentCreated: 1,
        agentModified: 1,
        agentDeleted: 1,
      },
    });
    expect(out[0]?.data.wake).not.toBe(true);
  });

  it('wakes on mixed bursts using external counts only', () => {
    const d = new FileBurstDetector({ windowMs: 60_000, maxChanges: 10, maxDeleted: 2 });
    d.accept(del(0, '/w/a', 'agent'));
    d.accept(del(1, '/w/b')); // external
    d.accept(del(2, '/w/c')); // external
    const out = d.accept(del(3, '/w/d')); // external → extDeletes 3 > 2 → wake
    expect(out[0]).toMatchObject({
      data: {
        wake: true,
        deleted: 4,
        agentDeleted: 1,
        externalDeletionExceeded: true,
      },
    });
  });
});

describe('FileBurstDetector watched roots', () => {
  it('keeps unchanged root windows but drops removed roots even if re-added', () => {
    const d = new FileBurstDetector({ roots: ['/a', '/b'], maxDeleted: 1 });
    d.accept(del(0, '/a/one'));
    d.accept(del(1, '/b/one'));
    d.setScopes(['dir:/a', 'dir:/c']);
    expect(d.accept(del(2, '/a/two'))[0]?.data.deleted).toBe(2);
    d.setScopes(['dir:/a', 'dir:/b']);
    expect(d.accept(del(3, '/b/two'))).toHaveLength(0);
    expect(d.accept(del(4, '/b/three'))[0]?.data.deleted).toBe(2);
  });

  it('aggregates scattered child dirs under the longest matching root', () => {
    const d = new FileBurstDetector({ roots: ['/fixture/work'], maxDeleted: 3 });
    expect(d.accept(del(0, '/outside/f'))).toHaveLength(0); // outside roots → ignored
    expect(d.accept(del(1, '/fixture/work/a/f'))).toHaveLength(0);
    expect(d.accept(del(2, '/fixture/work/b/f'))).toHaveLength(0);
    expect(d.accept(del(3, '/fixture/work/c/f'))).toHaveLength(0);
    const out = d.accept(del(4, '/fixture/work/a/g')); // 4 ext deletes under one root > 3
    expect(out[0]).toMatchObject({ subject: '/fixture/work', data: { externalDeletionExceeded: true, wake: true } });
  });

  it('counts an event toward every covering root and treats root==path as a member', () => {
    const d = new FileBurstDetector({ roots: ['/r', '/r/sub'], maxDeleted: 1 });
    expect(d.accept(del(0, '/r/sub/deep/f'))).toHaveLength(0); // both /r and /r/sub → count 1 each
    const out = d.accept(del(1, '/r/sub')); // path == root member of both → 2 > 1 each
    expect(out.map((s) => s.subject).sort()).toEqual(['/r', '/r/sub']);
    expect(d.accept(del(2, '/rish/f'))).toHaveLength(0); // prefix-only is NOT a match
  });

  it('accepts explicit (scope, dir) attribution covering several roots', () => {
    const d = new FileBurstDetector({ maxDeleted: 1 });
    d.setScopes(['dir:/r', 'dir:/r/sub']);
    const out = d.accept(del(0, '/r/sub/f'), 0, [
      { scope: 'dir:/r', dir: '/r' },
      { scope: 'dir:/r/sub', dir: '/r/sub' },
    ]);
    expect(out).toHaveLength(0);
    const out2 = d.accept(del(1, '/r/sub/g'), 1, [{ scope: 'dir:/r/sub', dir: '/r/sub' }]);
    expect(out2.map((s) => s.subject)).toEqual(['/r/sub']);
    const out3 = d.accept(del(2, '/r/sub/h'), 2, []);
    expect(out3).toHaveLength(0);
  });
});

describe('FileBurstDetector per-scope windows', () => {
  it('keeps sibling glob scopes on one watch root latched independently', () => {
    const d = new FileBurstDetector({ maxDeleted: 2 });
    const tmp = { scope: 'glob:/demo/tmp-*/**', dir: '/demo/tmp-1' };
    const proj = { scope: 'glob:/demo/proj-*/**', dir: '/demo/proj-b1' };
    // tmp-1 bursts and latches its own scope only.
    const first = [];
    for (let i = 0; i < 3; i++) first.push(...d.accept(del(i, '/demo/tmp-1/f'), i, [tmp]));
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ subject: '/demo/tmp-1', data: { scope: 'glob:/demo/tmp-*/**' } });
    // A fresh burst in proj-b1 is not masked by tmp-1's latch.
    const second = [];
    for (let i = 0; i < 3; i++) second.push(...d.accept(del(10 + i, '/demo/proj-b1/f'), 10 + i, [proj]));
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ subject: '/demo/proj-b1', data: { scope: 'glob:/demo/proj-*/**', deleted: 3 } });
  });

  it('counts the same directory in distinct scopes independently', () => {
    const d = new FileBurstDetector({ maxDeleted: 2 });
    const dirScope = { scope: 'dir:/w', dir: '/w' };
    const globScope = { scope: 'glob:/w/*', dir: '/w' };
    // Each scope only sees the events attributed to it.
    d.accept(del(0, '/w/a'), 0, [dirScope]);
    d.accept(del(1, '/w/b'), 1, [globScope]);
    const out = d.accept(del(2, '/w/c'), 2, [dirScope, globScope]);
    expect(out).toHaveLength(0); // each scope has just 2 deletes — below the limit
    const out2 = d.accept(del(3, '/w/d'), 3, [dirScope, globScope]);
    expect(out2).toHaveLength(2); // 3rd delete in EACH scope → two tagged signals
    expect(out2.map((s) => s.data.scope).sort()).toEqual(['dir:/w', 'glob:/w/*']);
  });

  it('counts aggregated file.activity deletions and keeps agent cause from waking', () => {
    const d = new FileBurstDetector({ windowMs: 60_000, maxChanges: 100, maxDeleted: 50 });
    d.setScopes(['global']);
    const globalTarget = [{ scope: 'global', dir: '/workspace/proj' }];
    const agentAct = sig({
      id: 'act-agent',
      kind: 'file.activity',
      at: 100,
      subject: '/workspace/proj',
      cause: 'agent',
      data: { directory: '/workspace/proj', windowMs: 10_000, created: 0, modified: 0, deleted: 60, files: ['a.ts'] },
    });
    const agentOut = d.accept(agentAct, 100, globalTarget);
    expect(agentOut).toHaveLength(1);
    expect(agentOut[0]).toMatchObject({
      kind: 'file.burst',
      cause: 'agent',
      data: {
        agentDeleted: 60,
        deleted: 60,
        externalDeletionExceeded: false,
        wake: false,
        level: 'record',
      },
    });

    const extAct = sig({
      id: 'act-ext',
      kind: 'file.activity',
      at: 200,
      subject: '/workspace/proj',
      data: { directory: '/workspace/proj', windowMs: 10_000, created: 1, modified: 2, deleted: 51, files: ['b.ts'] },
    });
    const out = d.accept(extAct, 200, globalTarget);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      kind: 'file.burst',
      subject: '/workspace/proj',
      data: {
        created: 1,
        modified: 2,
        deleted: 111,
        agentDeleted: 60,
        externalDeletionExceeded: true,
        wake: true,
        scope: 'global',
      },
    });
  });
});
