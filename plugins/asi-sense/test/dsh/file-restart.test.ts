import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { expect, it, vi } from 'vitest';
import { localPorts } from '../../src/host/dsh/local-ports.ts';
import { createSenseRuntime } from '../../src/host/runtime/index.ts';
import type { SensePorts } from '../../src/host/runtime/ports.ts';

it('restores a missing file root and observes it after creation and recreation', async () => {
  const temp = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'asi-sense-watch-')));
  const target = join(temp, 'parent', 'target');
  const values = new Map<string, string>();
  const local = localPorts({ logger: { warn: vi.fn() } } as unknown as Context, join(temp, 'storage'));
  const ports: SensePorts = {
    ...local,
    storage: {
      load: async (key) => values.get(key),
      save: async (key, value) => {
        values.set(key, value);
      },
    },
    probe: { create: () => ({ onSample: () => () => {}, start: () => {}, stop: async () => {} }) },
    dsh: {
      onAgentEvent: () => () => {},
      onTool: () => () => {},
      onJob: () => () => {},
      deliver: async () => {},
      tokenSnapshot: async () => undefined,
    },
  };
  let runtime = createSenseRuntime(ports, { platform: 'linux', rules: [] });
  try {
    await runtime.start();
    await runtime.tools.envWatch({
      action: 'add',
      rule: { id: 'missing', match: { kind: 'file.changed', subject: `${target}/**` }, level: 'context' },
    });
    await runtime.stop();
    runtime = createSenseRuntime(ports, { platform: 'linux', rules: [] });
    await runtime.start();
    expect(runtime.rules.list().some((rule) => rule.id === 'missing')).toBe(true);
    await fs.mkdir(target, { recursive: true });
    await fs.writeFile(join(temp, 'unrelated.txt'), 'synthetic');
    await new Promise((resolve) => setTimeout(resolve, 250));
    const first = join(target, 'first.txt');
    await fs.writeFile(first, 'synthetic');
    await vi.waitFor(() => expect(runtime.state().env.watchedPaths.value?.[first]?.changes).toBeGreaterThan(0), {
      timeout: 5_000,
    });
    expect(runtime.state().env.watchedPaths.value?.[join(temp, 'unrelated.txt')]).toBeUndefined();
    await fs.rm(target, { recursive: true });
    await new Promise((resolve) => setTimeout(resolve, 250));
    await fs.mkdir(target);
    await new Promise((resolve) => setTimeout(resolve, 250));
    const second = join(target, 'second.txt');
    await fs.writeFile(second, 'synthetic');
    await vi.waitFor(() => expect(runtime.state().env.watchedPaths.value?.[second]?.changes).toBeGreaterThan(0), {
      timeout: 5_000,
    });
  } finally {
    await runtime.stop();
    await fs.rm(temp, { recursive: true });
  }
}, 15_000);

it('reports changes to an existing file root using the file path itself', async () => {
  const temp = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'asi-sense-watch-file-')));
  const target = join(temp, 'synthetic.txt');
  await fs.writeFile(target, 'initial');
  const events: string[] = [];
  const local = localPorts({ logger: { warn: vi.fn() } } as unknown as Context, join(temp, 'storage'));
  const watcher = local.files.watch(target, (event) => events.push(event.path));
  try {
    await fs.writeFile(target, 'changed');
    await vi.waitFor(() => expect(events).toContain(target), { timeout: 5_000 });
  } finally {
    watcher.close();
    await fs.rm(temp, { recursive: true });
  }
});
