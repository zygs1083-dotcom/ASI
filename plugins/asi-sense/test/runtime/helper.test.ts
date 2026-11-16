import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSenseRuntime } from '../../src/host/runtime/index.ts';
import type { AgentEvent, DshPort, SensePorts } from '../../src/host/runtime/ports.ts';

const fixture = readFileSync(new URL('./fixtures/helper.ndjson', import.meta.url), 'utf8');

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly commands: { cmd: string; id: string; enabled: boolean }[] = [];
  closed = false;
  gen = 0;
  snapshotReply = true;
  pendingWrites: { chunk: string; callback: (error?: Error | null) => void }[] = [];
  constructor(
    autoAck: boolean,
    private readonly stubborn = false,
    holdWrites = false,
  ) {
    super();
    if (holdWrites) {
      this.stdin.write = ((chunk: string, callback: (error?: Error | null) => void) => {
        this.pendingWrites.push({ chunk: String(chunk), callback });
        return false;
      }) as typeof this.stdin.write;
    }
    this.stdin.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n').filter(Boolean)) {
        const command = JSON.parse(line) as { cmd: string; id: string; enabled: boolean };
        if (command.cmd === 'titles') {
          this.commands.push(command);
          if (autoAck) this.ack(command);
        } else if (command.cmd === 'snapshot' && this.snapshotReply) {
          this.send({ type: 'snapshot', frontApp: { name: 'ExampleApp', bundleId: 'example.app', pid: 123 } });
        }
      }
    });
  }
  emitFixture(): void {
    this.stdout.write(fixture);
  }
  ack(command: { id: string; enabled: boolean }, generation = ++this.gen): void {
    this.stdout.write(
      `${JSON.stringify({
        v: 1,
        type: 'titles.ack',
        at: Date.now(),
        session: 'fixture-session',
        id: command.id,
        enabled: command.enabled,
        gen: generation,
      })}\n`,
    );
  }
  send(message: object): void {
    this.stdout.write(`${JSON.stringify({ v: 1, at: Date.now(), ...message })}\n`);
  }
  releaseWrite(): void {
    const write = this.pendingWrites.shift();
    if (!write) throw new Error('missing pending write');
    this.stdin.emit('data', Buffer.from(write.chunk));
    write.callback();
  }
  crash(): void {
    if (!this.closed) {
      this.closed = true;
      this.emit('close', 1, null);
    }
  }
  kill(signal?: string): boolean {
    if (this.stubborn && signal !== 'SIGKILL') return true;
    if (!this.closed) {
      this.closed = true;
      queueMicrotask(() => this.emit('close', 0, 'SIGTERM'));
    }
    return true;
  }
}

function setup(autoAck = true, stubborn = false, holdWrites = false) {
  vi.useFakeTimers();
  vi.setSystemTime(1_700_000_000_000);
  let mono = 0;
  let agent: (event: AgentEvent) => Promise<void> = async () => {};
  const children: FakeChild[] = [];
  const delivered: Parameters<DshPort['deliver']>[1][] = [];
  const ports: SensePorts = {
    clock: { wall: () => Date.now(), mono: () => mono },
    dsh: {
      onAgentEvent: (cb) => {
        agent = cb;
        return () => {};
      },
      onTool: () => () => {},
      onJob: () => () => {},
      tokenSnapshot: async () => undefined,
      deliver: async (_, intent) => {
        delivered.push(intent);
      },
    },
    storage: { load: async () => undefined, save: async () => {} },
    helper: {
      spawn: () => {
        const child = new FakeChild(autoAck, stubborn, holdWrites);
        children.push(child);
        queueMicrotask(() => child.emitFixture());
        return child as unknown as ChildProcessWithoutNullStreams;
      },
    },
    probe: { create: () => ({ onSample: () => () => {}, start: () => {}, stop: async () => {} }) },
    files: { watch: () => ({ close: () => {} }) },
  };
  const runtime = createSenseRuntime(ports, { platform: 'darwin', helperPath: '/fixture/helper' });
  return {
    ports,
    runtime,
    children,
    delivered,
    agent: (event: AgentEvent) => agent(event),
    advance: async (ms: number) => {
      mono += ms;
      await vi.advanceTimersByTimeAsync(ms);
    },
    settle: () => vi.advanceTimersByTimeAsync(0),
  };
}

afterEach(() => vi.useRealTimers());

describe('helper protocol integration', () => {
  it('restarts three times and emits one context after exceeding the restart limit', async () => {
    const h = setup();
    await h.runtime.start();
    await h.agent({ type: 'created', sessionId: 's' });
    await h.agent({ type: 'pre-step', sessionId: 's' });
    await h.agent({ type: 'post-step', sessionId: 's' });
    await h.settle();
    expect(h.children).toHaveLength(1);
    for (const delay of [250, 500, 1000]) {
      h.children.at(-1)?.crash();
      await h.advance(delay);
      await h.settle();
    }
    expect(h.children).toHaveLength(4);
    expect(h.runtime.state().env.frontApp.value).toEqual({ name: 'ExampleApp', bundleId: 'example.app' });
    for (const delay of [2000, 4000]) {
      h.children.at(-1)?.crash();
      await h.advance(delay);
      await h.settle();
    }
    expect(h.children).toHaveLength(6);
    h.children.at(-1)?.crash();
    await h.settle();
    expect(h.runtime.state().observation.sources.helper).toMatchObject({
      status: 'unavailable',
      error: 'restart-limit',
    });
    expect(h.runtime.events()).toContainEqual(
      expect.objectContaining({
        kind: 'source.status',
        subject: 'helper',
        reason: 'restart-limit',
        restarts: 5,
      }),
    );
    await h.agent({ type: 'pre-step', sessionId: 's' });
    const changes = h.delivered.flatMap((intent) => intent.update.changes);
    expect(
      changes.filter((change) => change.signal.kind === 'source.status' && change.signal.data.status === 'error'),
    ).toHaveLength(1);
    await h.runtime.stop();
    expect(h.children.filter((child) => !child.closed)).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('strips titles until the latest matching ack, including when disabling', async () => {
    const h = setup(false);
    await h.runtime.start();
    await h.settle();
    const child = h.children[0];
    if (!child) throw new Error('missing helper');
    const first = child.commands[0];
    if (!first) throw new Error('missing first intent');
    expect(first.enabled).toBe(true);
    expect(h.runtime.state().env.focusedWindow.value).toBeNull();
    await h.runtime.actions.setSendTitles(false);
    await h.settle();
    const second = child.commands[1];
    if (!second) throw new Error('missing second intent');
    child.ack(first, 1);
    child.send({ type: 'window.title', bundleId: 'example.app', title: 'Hidden fixture' });
    await h.settle();
    expect(h.runtime.state().env.focusedWindow.value).toBeNull();
    child.ack(second, 2);
    await h.settle();
    expect(h.runtime.tools.envState()).toMatchObject({ env: { focusedWindow: { value: null } } });
    await h.runtime.actions.setSendTitles(true);
    await h.settle();
    const third = child.commands[2];
    if (!third) throw new Error('missing third intent');
    child.ack(third, 3);
    await h.settle();
    child.send({ type: 'window.title', bundleId: 'example.app', title: 'Visible fixture' });
    await h.settle();
    expect(h.runtime.state().env.focusedWindow.value).toEqual({ title: 'Visible fixture' });
    await h.runtime.actions.setSendTitles(false);
    expect(h.runtime.state().env.focusedWindow.value).toBeNull();
    await h.runtime.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('kills and reaps a helper that ignores SIGTERM before shutdown returns', async () => {
    const h = setup(true, true);
    await h.runtime.start();
    await h.settle();
    const stopping = h.runtime.stop().then(
      () => null,
      (error: unknown) => error,
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await stopping).toBeNull();
    expect(h.children.every((child) => child.closed)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('restarts rather than trusting a missing privacy acknowledgement', async () => {
    const h = setup(false);
    await h.runtime.start();
    await h.settle();
    await h.advance(3_000);
    expect(h.children[0]?.closed).toBe(true);
    await h.advance(250);
    expect(h.children).toHaveLength(2);
    expect(h.runtime.state().env.focusedWindow.value).toBeNull();
    await h.runtime.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('exposes denied accessibility on both the source and focused-window fact', async () => {
    const h = setup();
    await h.runtime.start();
    await h.settle();
    h.children[0]?.send({
      type: 'hello',
      session: 'fixture-session',
      permissions: { accessibility: 'denied' },
    });
    await h.settle();
    expect(h.runtime.state().observation.sources['helper.ax']?.status).toBe('denied');
    expect(h.runtime.state().env.focusedWindow).toMatchObject({ status: 'denied', value: null });
    await h.runtime.stop();
  });

  it('leaves no additional active timer or child process resources after stop', async () => {
    const h = setup();
    vi.useRealTimers();
    const count = () =>
      process
        .getActiveResourcesInfo()
        .filter((type) => type === 'Timeout' || type === 'ProcessWrap')
        .sort();
    const before = count();
    await h.runtime.start();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await h.runtime.stop();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(h.children.every((child) => child.closed)).toBe(true);
    const after = count();
    for (const type of ['Timeout', 'ProcessWrap']) {
      expect(after.filter((value) => value === type).length).toBeLessThanOrEqual(
        before.filter((value) => value === type).length,
      );
    }
  });

  it('clears the old title when the next focused window has no readable title', async () => {
    const h = setup();
    await h.runtime.start();
    await h.settle();
    h.children[0]?.send({ type: 'window.focused', bundleId: 'first', title: 'Synthetic title' });
    await h.settle();
    expect(h.runtime.state().env.focusedWindow.value).toEqual({ title: 'Synthetic title' });
    h.children[0]?.send({ type: 'window.focused', bundleId: 'second' });
    await h.settle();
    expect(h.runtime.state().env.focusedWindow).toMatchObject({ status: 'unknown', value: null });
    await h.runtime.stop();
  });

  it('records helper output overflow, marks the source degraded and requests a snapshot', async () => {
    const h = setup();
    await h.runtime.start();
    await h.settle();
    const child = h.children[0];
    if (!child) throw new Error('missing helper');
    child.snapshotReply = false;
    const snapshots: string[] = [];
    child.stdin.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('"snapshot"')) snapshots.push('snapshot');
    });
    child.send({ type: 'error', code: 'output_overflow', dropped: 7, droppedTypes: { 'window.focused': 7 } });
    await h.settle();
    expect(h.runtime.events()).toContainEqual(
      expect.objectContaining({ kind: 'source.error', reason: 'output_overflow (dropped=7)' }),
    );
    expect(h.runtime.state().observation.sources.helper).toMatchObject({
      status: 'unavailable',
      error: 'output_overflow',
    });
    expect(snapshots).toHaveLength(1);
    child.send({ type: 'snapshot', frontApp: { name: 'ExampleApp', bundleId: 'example.app', pid: 123 } });
    await h.settle();
    expect(h.runtime.state().observation.sources.helper?.status).toBe('ok');
    await h.runtime.stop();
  });

  it('does not recover from a snapshot requested before output overflow', async () => {
    const h = setup();
    await h.runtime.start();
    await h.settle();
    const child = h.children[0];
    if (!child) throw new Error('missing helper');
    child.snapshotReply = false;
    const commands: string[] = [];
    child.stdin.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('"snapshot"')) commands.push('snapshot');
    });
    await h.runtime.actions.setSendTitles(false);
    await h.settle();
    expect(commands).toHaveLength(1);
    child.send({ type: 'error', code: 'output_overflow', dropped: 1 });
    await h.settle();
    child.send({ type: 'snapshot' });
    await h.settle();
    expect(h.runtime.state().observation.sources.helper?.status).toBe('unavailable');
    expect(commands).toHaveLength(2);
    child.send({ type: 'snapshot' });
    await h.settle();
    expect(h.runtime.state().observation.sources.helper?.status).toBe('ok');
    await h.runtime.stop();
  });

  it('coalesces title switches behind a blocked stdin write', async () => {
    const h = setup(false, false, true);
    await h.runtime.start();
    await h.settle();
    const child = h.children[0];
    if (!child) throw new Error('missing helper');
    for (let i = 0; i < 100; i++) await h.runtime.actions.setSendTitles(i % 2 === 0);
    expect(child.pendingWrites).toHaveLength(1);
    child.releaseWrite();
    expect(child.pendingWrites).toHaveLength(1);
    expect(JSON.parse(child.pendingWrites[0]?.chunk ?? '{}')).toMatchObject({ cmd: 'titles', enabled: false });
    child.releaseWrite();
    expect(child.pendingWrites).toHaveLength(0);
    await h.runtime.stop();
  });

  it('does not extend the handshake deadline during repeated title switches', async () => {
    const h = setup(false, false, true);
    await h.runtime.start();
    await h.settle();
    await h.advance(2_900);
    await h.runtime.actions.setSendTitles(false);
    await h.advance(100);
    expect(h.children[0]?.closed).toBe(true);
    await h.runtime.stop();
  });

  it('never applies an older enable after a newer disable was requested', async () => {
    const h = setup();
    await h.runtime.start();
    await h.settle();
    await h.runtime.actions.setSendTitles(false);
    await h.settle();
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => {
      entered = resolve;
    });
    h.ports.storage.save = async (key, json) => {
      if (key === 'settings' && JSON.parse(json).sendTitles === true) {
        entered();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
    };
    const enabling = h.runtime.actions.setSendTitles(true);
    await blocked;
    const child = h.children[0];
    if (!child) throw new Error('missing helper');
    const marker = child.commands.length;
    const disabling = h.runtime.actions.setSendTitles(false);
    release();
    await Promise.all([enabling, disabling]);
    await h.settle();
    expect(child.commands.slice(marker).every((command) => !command.enabled)).toBe(true);
    expect(h.runtime.rules.settings().sendTitles).toBe(false);
    await h.runtime.stop();
  });
});
