import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { expect, it, vi } from 'vitest';
import { localPorts } from '../../src/host/dsh/local-ports.ts';
import { createSenseRuntime } from '../../src/host/runtime/index.ts';
import type { AgentEvent, DshPort, SensePorts, ToolEvent } from '../../src/host/runtime/ports.ts';

it.skipIf(process.platform !== 'darwin')(
  'delivers chmod and preserved-mtime edits after grace while suppressing a timely tool write',
  async () => {
    const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'asi-sense-file-cause-')));
    const file = join(root, 'fixture.txt');
    await fs.writeFile(file, 'initial');
    let agent: (event: AgentEvent) => Promise<void> = async () => {};
    let tool: (event: ToolEvent) => Promise<void> = async () => {};
    const delivered: Parameters<DshPort['deliver']>[1][] = [];
    const local = localPorts({ logger: { warn: vi.fn() } } as unknown as Context, join(root, 'storage'));
    const ports: SensePorts = {
      ...local,
      storage: { load: async () => undefined, save: async () => {} },
      helper: { spawn: () => undefined },
      probe: { create: () => ({ onSample: () => () => {}, start: () => {}, stop: async () => {} }) },
      dsh: {
        onAgentEvent: (cb) => {
          agent = cb;
          return () => {};
        },
        onTool: (cb) => {
          tool = cb;
          return () => {};
        },
        onJob: () => () => {},
        deliver: async (_id, intent) => {
          delivered.push(intent);
        },
        tokenSnapshot: async () => undefined,
      },
    };
    const runtime = createSenseRuntime(ports, {
      platform: 'linux',
      rules: [
        {
          id: 'file',
          match: { kind: 'file.changed', subject: file },
          level: 'wake',
          createdBy: 'user',
          approved: true,
        },
      ],
    });
    const changes = () => runtime.events().filter((event) => event.kind === 'file.changed');
    try {
      await runtime.start();
      await agent({ type: 'created', sessionId: 'fixture' });
      await agent({ type: 'pre-step', sessionId: 'fixture' });
      await agent({ type: 'post-step', sessionId: 'fixture' });
      await tool({ type: 'pre-execute', sessionId: 'fixture', toolCallId: 'fixture', cwd: root });
      await fs.writeFile(file, 'tool');
      await vi.waitFor(() => expect(changes().length).toBeGreaterThan(0), { timeout: 5_000 });
      await tool({ type: 'post-execute', sessionId: 'fixture', toolCallId: 'fixture' });
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      let count = changes().length;
      await fs.appendFile(file, ' timely');
      await vi.waitFor(() => expect(changes().length).toBeGreaterThan(count), { timeout: 5_000 });
      expect(changes().at(-1)).toMatchObject({ cause: 'agent', level: 'record' });
      const mtime = (await fs.stat(file)).mtime;
      await new Promise((resolve) => setTimeout(resolve, 850));
      count = changes().length;
      await fs.chmod(file, 0o600);
      await vi.waitFor(() => expect(changes().length).toBeGreaterThan(count), { timeout: 5_000 });
      expect(changes().at(-1)).toMatchObject({ cause: 'unknown', level: 'wake' });
      count = changes().length;
      const replacement = join(root, 'replacement.txt');
      await fs.writeFile(replacement, 'user content');
      await fs.utimes(replacement, mtime, mtime);
      await fs.rename(replacement, file);
      await vi.waitFor(() => expect(changes().length).toBeGreaterThan(count), { timeout: 5_000 });
      expect(changes().at(-1)).toMatchObject({ cause: 'unknown', level: 'wake' });
      await vi.waitFor(() => expect(delivered.some((item) => item.kind === 'followup')).toBe(true), { timeout: 8_000 });
    } finally {
      await runtime.stop();
      await fs.rm(root, { recursive: true });
    }
  },
  20_000,
);
