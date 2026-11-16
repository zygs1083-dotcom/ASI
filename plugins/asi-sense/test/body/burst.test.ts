import type { Signal } from '@asi/sense-types';
import { describe, expect, it } from 'vitest';
import { FileBurstDetector as Detector } from '../../src/host/body/burst.ts';
import { fileChanged } from './helpers.ts';

let seq = 0;
const ev = (at: number, path: string, change: string, cause?: 'agent') =>
  fileChanged(`e${seq++}`, at, path, change, cause);
const del = (at: number, path: string, cause?: 'agent') => ev(at, path, 'delete', cause);
const add = (at: number, path: string, cause?: 'agent') => ev(at, path, 'add', cause);
const mod = (at: number, path: string, cause?: 'agent') => ev(at, path, 'modify', cause);

class FileBurstDetector extends Detector {
  accept(signal: Signal, receivedAt = signal.at) {
    return super.accept(signal, receivedAt);
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
  it('aggregates scattered child dirs under the longest matching root', () => {
    const d = new FileBurstDetector({ roots: ['/fixture/work'], maxDeleted: 3 });
    expect(d.accept(del(0, '/outside/f'))).toHaveLength(0); // outside roots → ignored
    expect(d.accept(del(1, '/fixture/work/a/f'))).toHaveLength(0);
    expect(d.accept(del(2, '/fixture/work/b/f'))).toHaveLength(0);
    expect(d.accept(del(3, '/fixture/work/c/f'))).toHaveLength(0);
    const out = d.accept(del(4, '/fixture/work/a/g')); // 4 ext deletes under one root > 3
    expect(out[0]).toMatchObject({ subject: '/fixture/work', data: { externalDeletionExceeded: true, wake: true } });
  });

  it('prefers the longest matching root and treats root==path as a member', () => {
    const d = new FileBurstDetector({ roots: ['/r', '/r/sub'], maxDeleted: 1 });
    expect(d.accept(del(0, '/r/sub/deep/f'))).toHaveLength(0); // groups under /r/sub → count 1
    const out = d.accept(del(1, '/r/sub')); // path == root counts under /r/sub → 2 > 1
    expect(out[0]?.subject).toBe('/r/sub');
    expect(d.accept(del(2, '/rish/f'))).toHaveLength(0); // prefix-only is NOT a match
  });
});
