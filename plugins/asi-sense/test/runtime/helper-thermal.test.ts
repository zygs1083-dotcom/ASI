import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { Body } from '@asi/sense-types';
import { afterEach, expect, it, vi } from 'vitest';
import { createSenseRuntime } from '../../src/host/runtime/index.ts';
import type { SensePorts } from '../../src/host/runtime/ports.ts';
import { mkBody } from '../body/helpers.ts';

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  private closed = false;

  constructor() {
    super();
    this.stdin.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n').filter(Boolean)) {
        const command = JSON.parse(line) as { cmd: string; id: string; enabled: boolean };
        if (command.cmd === 'titles') {
          this.send({
            type: 'titles.ack',
            session: 'fixture-session',
            id: command.id,
            enabled: command.enabled,
            gen: 1,
          });
        } else if (command.cmd === 'snapshot') {
          this.send({
            type: 'snapshot',
            frontApp: { name: 'ExampleApp', bundleId: 'example.app', pid: 123 },
            focusedWindow: { status: 'unknown', pid: 123 },
            thermal: 'nominal',
          });
        }
      }
    });
  }
  send(message: object): void {
    this.stdout.write(`${JSON.stringify({ v: 1, at: Date.now(), ...message })}\n`);
  }
  crash(): void {
    this.closed = true;
    this.emit('close', 1, null);
  }
  kill(): boolean {
    if (!this.closed) {
      this.closed = true;
      queueMicrotask(() => this.emit('close', 0, 'SIGTERM'));
    }
    return true;
  }
}

afterEach(() => vi.useRealTimers());

it('keeps repeated thermal readings fresh without extra events and expires after a helper crash', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
  let mono = 0;
  let sample: (body: Body) => void = () => {};
  let allowSpawn = true;
  const child = new FakeChild();
  const ports: SensePorts = {
    clock: { wall: () => Date.now(), mono: () => mono },
    dsh: {
      onAgentEvent: () => () => {},
      onTool: () => () => {},
      onJob: () => () => {},
      tokenSnapshot: async () => undefined,
      deliver: async () => {},
    },
    storage: { load: async () => undefined, save: async () => {} },
    helper: {
      spawn: () => {
        if (!allowSpawn) throw Object.assign(new Error('missing helper'), { code: 'ENOENT' });
        queueMicrotask(() => {
          child.send({ type: 'hello', session: 'fixture-session', permissions: { accessibility: 'granted' } });
          child.send({ type: 'thermal', state: 'nominal' });
        });
        return child as unknown as ChildProcessWithoutNullStreams;
      },
    },
    probe: {
      create: () => ({
        onSample: (cb) => {
          sample = cb;
          return () => {};
        },
        start: () => {},
        stop: async () => {},
      }),
    },
    files: { watch: () => ({ close: () => {} }) },
  };
  const runtime = createSenseRuntime(ports, { platform: 'darwin', helperPath: '/fixture/helper' });
  const settle = () => vi.advanceTimersByTimeAsync(0);
  const advance = async (ms: number) => {
    mono += ms;
    await vi.advanceTimersByTimeAsync(ms);
  };
  const sampleBody = async () => {
    sample(mkBody());
    await settle();
  };
  try {
    await runtime.start();
    await settle();
    await sampleBody();
    await advance(1);
    child.send({ type: 'thermal', state: 'critical' });
    await settle();
    await sampleBody();
    const thermalEvents = () => runtime.events().filter((event) => event.subject === 'thermal');
    const helperEvents = () => runtime.events().filter((event) => event.source.id === 'helper');
    expect(thermalEvents()).toHaveLength(1);
    const helperEventCount = helperEvents().length;
    for (let i = 0; i < 7; i++) {
      await advance(30_000);
      expect(runtime.state().self.body.thermal).toMatchObject({ status: 'ok', value: 'critical' });
      child.send({ type: 'thermal', state: 'critical' });
      await settle();
      await sampleBody();
      expect(runtime.state().self.body.thermal.observedAt).toBe(Date.now());
      expect(thermalEvents()).toHaveLength(1);
      expect(helperEvents()).toHaveLength(helperEventCount);
    }
    allowSpawn = false;
    child.crash();
    await advance(59_999);
    expect(runtime.state().self.body.thermal.status).toBe('ok');
    await advance(1);
    expect(runtime.state().self.body.thermal.status).toBe('stale');
  } finally {
    await runtime.stop();
  }
});
