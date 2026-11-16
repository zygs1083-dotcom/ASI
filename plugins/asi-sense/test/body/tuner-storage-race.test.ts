import { afterEach, expect, it, vi } from 'vitest';
import { BodyMonitor, Tuner } from '../../src/host/body/index.ts';
import { rssBody, sample } from './helpers.ts';

afterEach(() => vi.useRealTimers());

it('does not publish a queued tuning change after an earlier delayed save fails', async () => {
  vi.useFakeTimers();
  let started: (() => void) | undefined;
  let rejectSave: ((error: Error) => void) | undefined;
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  let saves = 0;
  const persistence = {
    load: async () => undefined,
    save: async (_data: string) => {
      saves++;
      if (saves === 1) {
        started?.();
        await new Promise<void>((_resolve, reject) => {
          rejectSave = reject;
        });
      }
    },
  };
  const tuner = new Tuner({ x: { value: 10 } }, { clock: () => 0 });
  const monitor = new BodyMonitor({ tuner, persistence, clock: () => 0 });
  await monitor.restore();
  monitor.evaluate(sample(rssBody(0), 0), sample(rssBody(1), 1), {});
  vi.advanceTimersByTime(10_000);
  await began;
  const change = tuner.propose({ param: 'x', to: 11 });
  await Promise.resolve();
  if (!rejectSave) throw new Error('save did not start');
  rejectSave(new Error('storage failure'));
  await expect(change).rejects.toThrow('tuning disabled');
  expect(tuner.get('x')).toBe(10);
  expect(tuner.tuningDisabled).toBe('storage-failed');
  await monitor.close();
  expect(vi.getTimerCount()).toBe(0);
});

it('does not publish a standalone tuning change queued behind a failed explicit flush', async () => {
  let started: (() => void) | undefined;
  let rejectSave: ((error: Error) => void) | undefined;
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  let saves = 0;
  const persistence = {
    load: async () => undefined,
    save: async (_data: string) => {
      saves++;
      if (saves === 1) {
        started?.();
        await new Promise<void>((_resolve, reject) => {
          rejectSave = reject;
        });
      }
    },
  };
  const tuner = new Tuner({ x: { value: 10 } }, { persistence });
  await tuner.restore();
  const flushing = tuner.persist();
  await began;
  const change = tuner.propose({ param: 'x', to: 11 });
  await Promise.resolve();
  const flushFailed = expect(flushing).rejects.toThrow('storage failure');
  const changeFailed = expect(change).rejects.toThrow('tuning disabled');
  if (!rejectSave) throw new Error('save did not start');
  rejectSave(new Error('storage failure'));
  await flushFailed;
  await changeFailed;
  expect(tuner.get('x')).toBe(10);
  expect(tuner.tuningDisabled).toBe('storage-failed');
  await tuner.close();
});
