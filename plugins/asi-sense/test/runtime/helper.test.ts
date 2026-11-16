import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import type { Body } from '@asi/sense-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { environmentDetail } from '../../src/host/dsh/tool-output.ts';
import { createSenseRuntime } from '../../src/host/runtime/index.ts';
import type { AgentEvent, DshPort, SensePorts } from '../../src/host/runtime/ports.ts';
import { mkBody } from '../body/helpers.ts';

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
          this.send({
            type: 'snapshot',
            frontApp: { name: 'ExampleApp', bundleId: 'example.app', pid: 123 },
            focusedWindow: { status: 'ok', pid: 123 },
            thermal: 'nominal',
          });
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
  let sample: (body: Body) => void = () => {};
  let snapshotReply = true;
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
        child.snapshotReply = snapshotReply;
        children.push(child);
        queueMicrotask(() => child.emitFixture());
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
    sample: async () => {
      sample(mkBody());
      await vi.advanceTimersByTimeAsync(0);
    },
    jumpWall: (ms: number) => {
      vi.setSystemTime(Date.now() + ms);
    },
    snapshotReply: (value: boolean) => {
      snapshotReply = value;
    },
  };
}

afterEach(() => vi.useRealTimers());

describe('helper protocol integration', () => {
  it('refreshes metadata without another activation event or delivery', async () => {
    const h = setup();
    await h.runtime.start();
    await h.settle();
    await h.runtime.tools.envWatch({
      action: 'add',
      rule: { id: 'activation-context', match: { kind: 'app.activated' }, level: 'context' },
    });
    await h.agent({ type: 'created', sessionId: 's' });
    await h.agent({ type: 'pre-step', sessionId: 's' });
    await h.agent({ type: 'post-step', sessionId: 's' });
    const child = h.children[0];
    child.snapshotReply = false;
    const activationCount = h.runtime.events().filter((event) => event.kind === 'app.activated').length;
    child.send({ type: 'window.focused', bundleId: 'example.app', pid: 123, title: 'Synthetic new window' });
    await h.settle();
    child.send({
      type: 'snapshot',
      frontApp: { name: 'ExampleApp', bundleId: 'example.app', pid: 123, windowCount: 4 },
      focusedWindow: { status: 'ok', pid: 123, title: 'Synthetic new window' },
      permissions: { accessibility: 'granted' },
      thermal: 'nominal',
    });
    await h.settle();
    expect(h.runtime.state().env.frontApp.value?.windowCount).toBe(4);
    expect(h.runtime.events().filter((event) => event.kind === 'app.activated')).toHaveLength(activationCount);
    await h.agent({ type: 'pre-step', sessionId: 's' });
    expect(
      h.delivered.flatMap((intent) => intent.update.changes).filter((change) => change.signal.kind === 'app.activated'),
    ).toHaveLength(0);
    await h.runtime.stop();
  });

  it('uses the current app AX result after switching from an unsupported app with titles disabled', async () => {
    const h = setup();
    await h.runtime.start();
    await h.settle();
    await h.runtime.actions.setSendTitles(false);
    await h.settle();
    const child = h.children[0];
    child.snapshotReply = false;
    child.send({ type: 'app.activated', name: 'A', bundleId: 'a', pid: 1 });
    child.send({ type: 'ax.unsupported', bundleId: 'a', pid: 1 });
    await h.settle();
    child.send({
      type: 'snapshot',
      frontApp: { name: 'A', bundleId: 'a', pid: 1 },
      focusedWindow: { status: 'unsupported', pid: 1, bundleId: 'a' },
      permissions: { accessibility: 'granted' },
      thermal: 'nominal',
    });
    await h.settle();
    child.send({
      type: 'snapshot',
      frontApp: { name: 'A', bundleId: 'a', pid: 1 },
      focusedWindow: { status: 'unsupported', pid: 1, bundleId: 'a' },
      permissions: { accessibility: 'granted' },
      thermal: 'nominal',
    });
    await h.settle();
    child.send({ type: 'app.activated', name: 'B', bundleId: 'b', pid: 2 });
    child.send({ type: 'window.focused', bundleId: 'b', pid: 2 });
    await h.settle();
    expect(h.runtime.state().observation.sources['helper.ax']?.status).not.toBe('unsupported');
    child.send({
      type: 'snapshot',
      frontApp: { name: 'B', bundleId: 'b', pid: 2, windowCount: 2 },
      focusedWindow: { status: 'ok', pid: 2, bundleId: 'b' },
      permissions: { accessibility: 'granted' },
      thermal: 'nominal',
    });
    await h.settle();
    expect(h.runtime.state().env.frontApp.value).toEqual({ name: 'B', bundleId: 'b', pid: 2, windowCount: 2 });
    expect(environmentDetail(h.runtime)).toMatchObject({ windowCount: { value: 2, status: 'ok' } });
    expect(h.runtime.state().env.focusedWindow.value).toBeNull();
    await h.runtime.stop();
  });

  it('applies permission revocation from metadata snapshots without restoring a title', async () => {
    const h = setup();
    await h.runtime.start();
    await h.settle();
    const child = h.children[0];
    child.snapshotReply = false;
    child.send({ type: 'window.focused', bundleId: 'example.app', pid: 123, title: 'Synthetic title' });
    await h.settle();
    child.send({
      type: 'snapshot',
      frontApp: { name: 'ExampleApp', bundleId: 'example.app', pid: 123, windowCount: 2 },
      focusedWindow: { status: 'denied', pid: 123, bundleId: 'example.app' },
      permissions: { accessibility: 'denied' },
      thermal: 'nominal',
    });
    await h.settle();
    expect(h.runtime.state().observation.sources['helper.ax']?.status).toBe('denied');
    expect(h.runtime.state().env.focusedWindow).toMatchObject({ status: 'denied', value: null });
    expect(h.runtime.state().env.frontApp.value?.windowCount).toBeUndefined();
    expect(h.runtime.events()).toContainEqual(
      expect.objectContaining({ kind: 'source.status', subject: 'helper.ax', level: 'context' }),
    );
    await h.runtime.stop();
  });

  it('applies snapshot permission revocation even if focus changes while it is in flight', async () => {
    const h = setup();
    await h.runtime.start();
    await h.settle();
    const child = h.children[0];
    child.snapshotReply = false;
    child.send({ type: 'window.focused', bundleId: 'example.app', pid: 123, title: 'Synthetic one' });
    await h.settle();
    child.send({ type: 'window.focused', bundleId: 'example.app', pid: 123, title: 'Synthetic two' });
    child.send({
      type: 'snapshot',
      frontApp: { name: 'ExampleApp', bundleId: 'example.app', pid: 123 },
      focusedWindow: { status: 'denied', pid: 123, bundleId: 'example.app' },
      permissions: { accessibility: 'denied' },
      thermal: 'nominal',
    });
    await h.settle();
    expect(h.runtime.state().observation.sources['helper.ax']?.status).toBe('denied');
    expect(h.runtime.state().env.focusedWindow).toMatchObject({ status: 'denied', value: null });
    await h.runtime.stop();
  });

  it('does not apply snapshot permissions older than a later hello', async () => {
    const h = setup();
    await h.runtime.start();
    await h.settle();
    const child = h.children[0];
    child.snapshotReply = false;
    child.send({ type: 'window.focused', bundleId: 'example.app', pid: 123, title: 'Synthetic' });
    await h.settle();
    child.send({ type: 'hello', session: 'fixture-session', permissions: { accessibility: 'granted' } });
    child.send({
      type: 'snapshot',
      frontApp: { name: 'ExampleApp', bundleId: 'example.app', pid: 123 },
      focusedWindow: { status: 'denied', pid: 123, bundleId: 'example.app' },
      permissions: { accessibility: 'denied' },
      thermal: 'nominal',
    });
    await h.settle();
    expect(h.runtime.state().observation.sources['helper.ax']?.status).toBe('ok');
    await h.runtime.stop();
  });

  it('refreshes window count on demand when another window closes without a focus change', async () => {
    const h = setup();
    await h.runtime.start();
    await h.settle();
    const child = h.children[0];
    child.snapshotReply = false;
    child.send({ type: 'app.activated', name: 'ExampleApp', bundleId: 'example.app', pid: 123 });
    await h.settle();
    child.send({
      type: 'snapshot',
      frontApp: { name: 'ExampleApp', bundleId: 'example.app', pid: 123, windowCount: 3 },
      focusedWindow: { status: 'ok', pid: 123, bundleId: 'example.app' },
      permissions: { accessibility: 'granted' },
      thermal: 'nominal',
    });
    await h.settle();
    expect(h.runtime.state().env.frontApp.value?.windowCount).toBe(3);
    const refresh = h.runtime.tools.refreshDetail();
    await h.settle();
    child.send({
      type: 'snapshot',
      frontApp: { name: 'ExampleApp', bundleId: 'example.app', pid: 123, windowCount: 2 },
      focusedWindow: { status: 'ok', pid: 123, bundleId: 'example.app' },
      permissions: { accessibility: 'granted' },
      thermal: 'nominal',
    });
    await h.settle();
    expect(await refresh).toBe(true);
    expect(environmentDetail(h.runtime)).toMatchObject({ windowCount: { value: 2, status: 'ok' } });
    await h.runtime.stop();
  });

  it('takes a fresh snapshot for each detail read after an already pending snapshot', async () => {
    const h = setup();
    await h.runtime.start();
    await h.settle();
    const child = h.children[0];
    child.snapshotReply = false;
    let requests = 0;
    child.stdin.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('"snapshot"')) requests++;
    });
    child.send({ type: 'window.focused', bundleId: 'example.app', pid: 123, title: 'Synthetic' });
    await h.settle();
    expect(requests).toBe(1);
    const first = h.runtime.tools.refreshDetail();
    const second = h.runtime.tools.refreshDetail();
    expect(await h.runtime.tools.refreshDetail()).toBe(false);
    const snapshot = (count: number) => ({
      type: 'snapshot',
      frontApp: { name: 'ExampleApp', bundleId: 'example.app', pid: 123, windowCount: count },
      focusedWindow: { status: 'ok', pid: 123, bundleId: 'example.app' },
      permissions: { accessibility: 'granted' },
      thermal: 'nominal',
    });
    child.send(snapshot(3));
    await h.settle();
    expect(requests).toBe(2);
    child.send(snapshot(2));
    await h.settle();
    expect(await first).toBe(true);
    expect(requests).toBe(3);
    child.send(snapshot(1));
    await h.settle();
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(h.runtime.state().env.frontApp.value?.windowCount).toBe(1);
    await h.runtime.stop();
  });

  it('times out a missing detail snapshot and cancels outstanding reads on stop', async () => {
    const h = setup();
    await h.runtime.start();
    await h.settle();
    const child = h.children[0];
    child.snapshotReply = false;
    const first = h.runtime.tools.refreshDetail();
    await h.advance(3_000);
    expect(await first).toBe(false);
    const second = h.runtime.tools.refreshDetail();
    await h.runtime.stop();
    expect(await second).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not mark an incomplete matching snapshot as a fresh detail read', async () => {
    const h = setup();
    await h.runtime.start();
    await h.settle();
    const child = h.children[0];
    child.snapshotReply = false;
    const refresh = h.runtime.tools.refreshDetail();
    child.send({
      type: 'snapshot',
      frontApp: { bundleId: 'example.app', pid: 123, windowCount: 2 },
      focusedWindow: { status: 'ok', pid: 123, bundleId: 'example.app' },
      permissions: { accessibility: 'granted' },
      thermal: 'nominal',
    });
    await h.settle();
    expect(await refresh).toBe(false);
    await h.runtime.stop();
  });

  it('rejects an obsolete detail snapshot after the foreground app changes', async () => {
    const h = setup();
    await h.runtime.start();
    await h.settle();
    const child = h.children[0];
    child.snapshotReply = false;
    const refresh = h.runtime.tools.refreshDetail();
    child.send({ type: 'app.activated', name: 'B', bundleId: 'b', pid: 2 });
    child.send({
      type: 'snapshot',
      frontApp: { name: 'ExampleApp', bundleId: 'example.app', pid: 123, windowCount: 5 },
      focusedWindow: { status: 'ok', pid: 123, bundleId: 'example.app' },
      permissions: { accessibility: 'granted' },
      thermal: 'nominal',
    });
    await h.settle();
    expect(await refresh).toBe(false);
    expect(h.runtime.state().env.frontApp.value).toEqual({ name: 'B', bundleId: 'b', pid: 2 });
    await h.runtime.stop();
  });

  it('resets per-process AX state without fabricating an activation for the same bundle', async () => {
    const h = setup();
    await h.runtime.start();
    await h.settle();
    const child = h.children[0];
    child.snapshotReply = false;
    child.send({ type: 'ax.unsupported', bundleId: 'example.app', pid: 123 });
    await h.settle();
    const before = h.runtime.events().filter((event) => event.kind === 'app.activated').length;
    child.send({ type: 'app.activated', name: 'ExampleApp', bundleId: 'example.app', pid: 456 });
    await h.settle();
    expect(h.runtime.state().observation.sources['helper.ax']?.status).toBe('unknown');
    expect(h.runtime.state().env.frontApp.value).toEqual({ name: 'ExampleApp', bundleId: 'example.app', pid: 456 });
    expect(h.runtime.events().filter((event) => event.kind === 'app.activated')).toHaveLength(before);
    child.send({ type: 'ax.unsupported', bundleId: 'example.app', pid: 123 });
    await h.settle();
    expect(h.runtime.state().observation.sources['helper.ax']?.status).toBe('unknown');
    await h.runtime.stop();
  });

  it('passes foreground pid and snapshot window count through to state', async () => {
    const h = setup();
    await h.runtime.start();
    await h.settle();
    const child = h.children[0];
    if (!child) throw new Error('missing helper');
    child.snapshotReply = false;
    child.send({
      type: 'snapshot',
      frontApp: { name: 'Fixture', bundleId: 'fixture.app', pid: 42, windowCount: 3 },
      focusedWindow: { status: 'ok', pid: 42 },
      thermal: 'nominal',
    });
    await h.settle();
    expect(h.runtime.state().env.frontApp.value).toEqual({
      name: 'Fixture',
      bundleId: 'fixture.app',
      pid: 42,
      windowCount: 3,
    });
    await h.runtime.stop();
  });

  it('discards an old metadata snapshot when foreground activation changes in flight', async () => {
    const h = setup();
    await h.runtime.start();
    await h.settle();
    const child = h.children[0];
    if (!child) throw new Error('missing helper');
    child.snapshotReply = false;
    child.send({ type: 'app.activated', name: 'A', bundleId: 'a', pid: 1 });
    await h.settle();
    child.send({ type: 'app.activated', name: 'B', bundleId: 'b', pid: 2 });
    child.send({
      type: 'snapshot',
      frontApp: { name: 'A', bundleId: 'a', pid: 1, windowCount: 9 },
      focusedWindow: { status: 'ok', pid: 1 },
      thermal: 'nominal',
    });
    await h.settle();
    expect(h.runtime.state().env.frontApp.value).toEqual({ name: 'B', bundleId: 'b', pid: 2 });
    child.send({
      type: 'snapshot',
      frontApp: { name: 'B', bundleId: 'b', pid: 2, windowCount: 0 },
      focusedWindow: { status: 'ok', pid: 2 },
      thermal: 'nominal',
    });
    await h.settle();
    expect(h.runtime.state().env.frontApp.value).toEqual({ name: 'B', bundleId: 'b', pid: 2, windowCount: 0 });
    await h.runtime.stop();
  });

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
    expect(h.runtime.state().env.frontApp.value).toEqual({ name: 'ExampleApp', bundleId: 'example.app', pid: 123 });
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
    child.send({
      type: 'snapshot',
      frontApp: { name: 'ExampleApp', bundleId: 'example.app', pid: 123 },
      focusedWindow: { status: 'ok', pid: 123 },
      thermal: 'nominal',
    });
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
    child.send({
      type: 'snapshot',
      frontApp: { name: 'ExampleApp', bundleId: 'example.app', pid: 123 },
      focusedWindow: { status: 'ok', pid: 123 },
      thermal: 'nominal',
    });
    await h.settle();
    expect(h.runtime.state().observation.sources.helper?.status).toBe('ok');
    await h.runtime.stop();
  });

  it('retains thermal and app deltas during overflow recovery and rejects an older snapshot', async () => {
    const h = setup();
    await h.runtime.start();
    await h.settle();
    const child = h.children[0];
    if (!child) throw new Error('missing helper');
    child.snapshotReply = false;
    child.send({ type: 'error', code: 'output_overflow', dropped: 1 });
    await h.settle();
    expect(h.runtime.state().env.frontApp.status).toBe('stale');
    expect(h.runtime.state().self.body.thermal.status).toBe('stale');
    child.send({ type: 'thermal', state: 'critical' });
    child.send({ type: 'app.activated', name: 'NewApp', bundleId: 'new.app', pid: 234 });
    await h.settle();
    expect(h.runtime.state().self.body.thermal.value).toBe('critical');
    expect(h.runtime.state().observation.sources.helper?.status).toBe('unavailable');
    child.send({
      type: 'snapshot',
      frontApp: { name: 'OldApp', bundleId: 'old.app', pid: 123 },
      focusedWindow: { status: 'ok', pid: 123, title: 'Old title' },
      thermal: 'nominal',
    });
    await h.settle();
    expect(h.runtime.state().self.body.thermal).toMatchObject({ status: 'ok', value: 'critical' });
    expect(h.runtime.state().env.frontApp.value).toEqual({ name: 'NewApp', bundleId: 'new.app', pid: 234 });
    expect(h.runtime.state().env.focusedWindow.value).toBeNull();
    expect(h.runtime.state().observation.sources.helper?.status).toBe('ok');
    await h.runtime.stop();
  });

  it('marks a known helper window stale immediately on overflow', async () => {
    const h = setup();
    await h.runtime.start();
    await h.settle();
    await h.runtime.actions.setSendTitles(true);
    await h.settle();
    const child = h.children[0];
    if (!child) throw new Error('missing helper');
    child.send({ type: 'window.focused', bundleId: 'example.app', title: 'Synthetic' });
    await h.settle();
    expect(h.runtime.state().env.focusedWindow.status).toBe('ok');
    child.snapshotReply = false;
    child.send({ type: 'error', code: 'output_overflow', dropped: 1 });
    await h.settle();
    expect(h.runtime.state().env.focusedWindow).toMatchObject({ status: 'stale', value: { title: 'Synthetic' } });
    expect(h.runtime.state().observation.sources.helper?.status).toBe('unavailable');
    await h.runtime.stop();
  });

  it('preserves a permission revocation received while the snapshot is in flight', async () => {
    const h = setup();
    await h.runtime.start();
    await h.settle();
    const child = h.children[0];
    if (!child) throw new Error('missing helper');
    child.snapshotReply = false;
    child.send({ type: 'error', code: 'output_overflow', dropped: 1 });
    await h.settle();
    child.send({ type: 'hello', session: 'fixture-session', permissions: { accessibility: 'denied' } });
    await h.settle();
    child.send({
      type: 'snapshot',
      frontApp: { name: 'ExampleApp', bundleId: 'example.app', pid: 123 },
      focusedWindow: { status: 'ok', pid: 123, title: 'Old title' },
      thermal: 'critical',
    });
    await h.settle();
    expect(h.runtime.state().env.focusedWindow).toMatchObject({ status: 'denied', value: null });
    expect(h.runtime.state().observation.sources['helper.ax']?.status).toBe('denied');
    await h.runtime.stop();
  });

  it('stays degraded across a helper restart until a complete recovery snapshot', async () => {
    const h = setup();
    await h.runtime.start();
    await h.settle();
    const child = h.children[0];
    if (!child) throw new Error('missing helper');
    child.snapshotReply = false;
    h.snapshotReply(false);
    child.send({ type: 'error', code: 'output_overflow', dropped: 1 });
    await h.settle();
    child.crash();
    await h.advance(250);
    const restarted = h.children[1];
    if (!restarted) throw new Error('missing restarted helper');
    expect(h.runtime.state().observation.sources.helper?.status).toBe('unavailable');
    restarted.send({
      type: 'snapshot',
      frontApp: { name: 'ExampleApp', bundleId: 'example.app', pid: 123 },
      focusedWindow: { status: 'unknown', pid: 123 },
      thermal: 'critical',
    });
    await h.settle();
    expect(h.runtime.state().observation.sources.helper?.status).toBe('ok');
    expect(h.runtime.state().self.body.thermal).toMatchObject({ status: 'ok', value: 'critical' });
    await h.runtime.stop();
  });

  it('keeps a missing snapshot field unknown and the helper degraded', async () => {
    const h = setup();
    await h.runtime.start();
    await h.settle();
    const child = h.children[0];
    if (!child) throw new Error('missing helper');
    child.snapshotReply = false;
    child.send({ type: 'error', code: 'output_overflow', dropped: 1 });
    await h.settle();
    child.send({
      type: 'snapshot',
      frontApp: { name: 'ExampleApp', bundleId: 'example.app', pid: 123 },
      focusedWindow: { status: 'unknown', pid: 123 },
    });
    await h.settle();
    expect(h.runtime.state().self.body.thermal.status).toBe('unknown');
    expect(h.runtime.state().observation.sources.helper?.status).toBe('unavailable');
    await h.runtime.stop();
  });

  it('accepts a snapshot without an app or window as a known empty desktop', async () => {
    const h = setup();
    await h.runtime.start();
    await h.settle();
    const child = h.children[0];
    child.snapshotReply = false;
    child.send({ type: 'error', code: 'output_overflow', dropped: 1 });
    await h.settle();
    child.send({ type: 'snapshot', thermal: 'nominal' });
    await h.settle();
    expect(h.runtime.state().env.frontApp).toMatchObject({ status: 'ok', value: null });
    expect(h.runtime.state().env.focusedWindow).toMatchObject({ status: 'ok', value: null });
    expect(h.runtime.state().observation.sources.helper?.status).toBe('ok');
    await h.runtime.stop();
  });

  it('retries incomplete snapshots with bounded exponential backoff and recovers', async () => {
    const h = setup();
    await h.runtime.start();
    await h.settle();
    const child = h.children[0];
    child.snapshotReply = false;
    let snapshots = 0;
    child.stdin.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('"snapshot"')) snapshots++;
    });
    child.send({ type: 'error', code: 'output_overflow', dropped: 1 });
    await h.settle();
    expect(snapshots).toBe(1);
    const incomplete = { type: 'snapshot', frontApp: { name: 'ExampleApp', bundleId: 'example.app' } };
    child.send(incomplete);
    await h.settle();
    await h.advance(1_999);
    expect(snapshots).toBe(1);
    await h.advance(1);
    expect(snapshots).toBe(2);
    child.send(incomplete);
    await h.settle();
    await h.advance(4_000);
    expect(snapshots).toBe(3);
    child.send({ type: 'snapshot', thermal: 'critical' });
    await h.settle();
    expect(h.runtime.state().observation.sources.helper?.status).toBe('ok');
    await h.advance(60_000);
    expect(snapshots).toBe(3);
    await h.runtime.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops retrying incomplete snapshots after ten attempts', async () => {
    const h = setup();
    await h.runtime.start();
    await h.settle();
    const child = h.children[0];
    child.snapshotReply = false;
    let snapshots = 0;
    child.stdin.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('"snapshot"')) snapshots++;
    });
    child.send({ type: 'error', code: 'output_overflow', dropped: 1 });
    await h.settle();
    for (let i = 0; i < 11; i++) {
      child.send({ type: 'snapshot', frontApp: { name: 'ExampleApp', bundleId: 'example.app' } });
      await h.settle();
      await h.advance(Math.min(60_000, 2_000 * 2 ** i));
    }
    expect(snapshots).toBe(11);
    expect(h.runtime.state().observation.sources.helper?.status).toBe('unavailable');
    await h.runtime.stop();
  });

  it.each(['delta', 'cooldown'] as const)(
    'starts another bounded recovery round after %s',
    async (trigger) => {
      const h = setup();
      await h.runtime.start();
      await h.settle();
      const child = h.children[0];
      child.snapshotReply = false;
      let snapshots = 0;
      child.stdin.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('"snapshot"')) snapshots++;
      });
      child.send({ type: 'error', code: 'output_overflow', dropped: 1 });
      await h.settle();
      for (let i = 0; i < 11; i++) {
        child.send({ type: 'snapshot', frontApp: { name: 'ExampleApp', bundleId: 'example.app' } });
        await h.settle();
        if (i < 10) await h.advance(Math.min(60_000, 2_000 * 2 ** i));
      }
      expect(snapshots).toBe(11);
      if (trigger === 'delta') {
        child.send({ type: 'thermal', state: 'unknown' });
        await h.settle();
        expect(snapshots).toBe(11);
        child.send({ type: 'thermal', state: 'nominal' });
        await h.settle();
      } else {
        await h.advance(299_999);
        expect(snapshots).toBe(11);
        await h.advance(1);
      }
      expect(snapshots).toBe(12);
      child.send({ type: 'snapshot', thermal: 'nominal' });
      await h.settle();
      expect(h.runtime.state().observation.sources.helper?.status).toBe('ok');
      await h.runtime.stop();
    },
    30_000,
  ); // cooldown advances a 5-minute fake clock (~3s alone, >5s under root pnpm check)

  it('applies complete snapshot fields after an unusable incremental thermal event', async () => {
    const h = setup();
    await h.runtime.start();
    await h.settle();
    const child = h.children[0];
    if (!child) throw new Error('missing helper');
    child.snapshotReply = false;
    child.send({ type: 'error', code: 'output_overflow', dropped: 1 });
    await h.settle();
    child.send({ type: 'thermal', state: 'unknown' });
    await h.settle();
    expect(h.runtime.state().self.body.thermal.status).toBe('unknown');
    child.send({
      type: 'snapshot',
      frontApp: { name: 'ExampleApp', bundleId: 'example.app', pid: 123 },
      focusedWindow: { status: 'unknown', pid: 123 },
      thermal: 'critical',
    });
    await h.settle();
    expect(h.runtime.state().self.body.thermal).toMatchObject({ status: 'ok', value: 'critical' });
    expect(h.runtime.state().observation.sources.helper?.status).toBe('ok');
    await h.runtime.stop();
  });

  it('does not let malformed app deltas or unknown windows override a complete snapshot', async () => {
    const h = setup();
    await h.runtime.start();
    await h.settle();
    const child = h.children[0];
    if (!child) throw new Error('missing helper');
    child.snapshotReply = false;
    child.send({ type: 'error', code: 'output_overflow', dropped: 1 });
    await h.settle();
    child.send({ type: 'app.activated', bundleId: 'invalid.app' });
    child.send({
      type: 'snapshot',
      frontApp: { name: 'ExampleApp', bundleId: 'example.app', pid: 123 },
      focusedWindow: { status: 'unknown', pid: 123, title: 'Untrusted title' },
      thermal: 'critical',
    });
    await h.settle();
    expect(h.runtime.state().env.frontApp.value).toEqual({ name: 'ExampleApp', bundleId: 'example.app', pid: 123 });
    expect(h.runtime.state().env.focusedWindow).toMatchObject({ status: 'unknown', value: null });
    await h.runtime.stop();
  });

  it.each([
    ['frontApp', 'env.frontApp'],
    ['focusedWindow', 'env.focusedWindow'],
    ['thermal', 'self.body.thermal'],
  ])('marks missing snapshot field %s unknown without recovering the source', async (field, path) => {
    const h = setup();
    await h.runtime.start();
    await h.settle();
    const child = h.children[0];
    if (!child) throw new Error('missing helper');
    child.send({ type: 'window.focused', bundleId: 'example.app', title: 'Synthetic' });
    await h.settle();
    child.snapshotReply = false;
    child.send({ type: 'error', code: 'output_overflow', dropped: 1 });
    await h.settle();
    const snapshot: Record<string, unknown> = {
      type: 'snapshot',
      frontApp: { name: 'ExampleApp', bundleId: 'example.app', pid: 123 },
      focusedWindow: { status: 'ok', pid: 123, title: 'Synthetic' },
      thermal: 'critical',
    };
    delete snapshot[field];
    child.send(snapshot);
    await h.settle();
    expect(
      path.split('.').reduce<unknown>((value, key) => (value as Record<string, unknown>)[key], h.runtime.state()),
    ).toMatchObject({ status: 'unknown' });
    expect(h.runtime.state().observation.sources.helper?.status).toBe('unavailable');
    await h.runtime.stop();
  });

  it('applies critical thermal from a recovery snapshot and emits the critical alert', async () => {
    const h = setup();
    await h.runtime.start();
    await h.settle();
    await h.sample();
    const child = h.children[0];
    if (!child) throw new Error('missing helper');
    child.snapshotReply = false;
    child.send({ type: 'error', code: 'output_overflow', dropped: 1 });
    await h.settle();
    child.send({
      type: 'snapshot',
      frontApp: { name: 'ExampleApp', bundleId: 'example.app', pid: 123 },
      focusedWindow: { status: 'unknown', pid: 123 },
      thermal: 'critical',
    });
    await h.settle();
    await h.advance(1);
    await h.sample();
    expect(h.runtime.state().self.body.thermal).toMatchObject({ status: 'ok', value: 'critical' });
    expect(h.runtime.events()).toContainEqual(
      expect.objectContaining({
        kind: 'body.threshold',
        subject: 'thermal',
        level: 'wake',
      }),
    );
    await h.runtime.stop();
  });

  it('does not refresh helper thermal TTL by replaying it in a probe sample', async () => {
    const h = setup();
    await h.runtime.start();
    await h.settle();
    await h.advance(59_999);
    await h.sample();
    expect(h.runtime.state().self.body.thermal.status).toBe('ok');
    await h.advance(1);
    await h.sample();
    expect(h.runtime.state().self.body.thermal.status).toBe('stale');
    await h.runtime.stop();
  });

  it('evaluates fresh thermal evidence after a wall-clock jump', async () => {
    const h = setup();
    await h.runtime.start();
    await h.settle();
    await h.sample();
    h.children[0]?.send({ type: 'thermal', state: 'critical' });
    await h.settle();
    h.jumpWall(120_000);
    await h.advance(1);
    await h.sample();
    expect(h.runtime.events()).toContainEqual(
      expect.objectContaining({
        kind: 'body.threshold',
        subject: 'thermal',
        level: 'wake',
      }),
    );
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
