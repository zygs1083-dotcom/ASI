import { expect, it, vi } from 'vitest';
import { createChanges } from '../../src/host/runtime/changes.ts';

it('coalesces nested asynchronous batches and isolates subscriber failures', async () => {
  const changes = createChanges();
  const listener = vi.fn();
  changes.subscribe(() => {
    throw new Error('subscriber failure');
  });
  changes.subscribe(listener);
  await changes.batch(async () => {
    changes.changed();
    await Promise.resolve();
    await changes.batch(async () => {
      changes.changed();
      await Promise.resolve();
      expect(listener).not.toHaveBeenCalled();
    });
    expect(listener).not.toHaveBeenCalled();
  });
  await Promise.resolve();
  expect(listener).toHaveBeenCalledTimes(1);
});
