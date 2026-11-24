import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { describe, expect, it, vi } from 'vitest';
import { localPorts } from '../../../src/sense/host/dsh/local-ports.ts';

describe('localPorts', () => {
  it('rejects relative storageRoot paths', () => {
    expect(() => localPorts({ logger: { warn: vi.fn() } } as unknown as Context, 'relative/storage')).toThrow(
      TypeError,
    );
  });

  it('constructs clock, storage, helper, and probe ports without file watchers or history store', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'asi-local-ports-'));
    try {
      const ports = localPorts({ logger: { warn: vi.fn() } } as unknown as Context, dir);
      expect(typeof ports.clock.wall()).toBe('number');
      expect(typeof ports.clock.mono()).toBe('number');
      expect('files' in ports).toBe(false);
      expect('history' in ports).toBe(false);
      await ports.storage.save('settings', '{"version":1,"paused":false,"sendTitles":true}');
      expect(await ports.storage.load('settings')).toBe('{"version":1,"paused":false,"sendTitles":true}');
      const probe = ports.probe.create();
      await probe.stop();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
