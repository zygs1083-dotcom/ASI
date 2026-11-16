import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { RuntimeAttention } from '../runtime/attention.ts';
import type { Clock, HelperSpawner } from '../runtime/ports.ts';
import type { BodySource } from './body.ts';
import { SnapshotBackoff } from './helper-backoff.ts';
import { axStatus, clearWindow, helperError, helperStatus, type Message, object, strip } from './helper-events.ts';
import { applyHelperEvent, HelperRecovery, markHelperFacts } from './helper-recovery.ts';
import { HelperWriter } from './helper-writer.ts';

const HANDSHAKE_MS = 3_000;
const WINDOW_MS = 600_000;
const MAX_RESTARTS = 5;
export class HelperSource {
  private child?: ChildProcessWithoutNullStreams;
  private stopped = false;
  private retry?: number;
  private readonly snapshots = new SnapshotBackoff();
  private deadline?: number;
  private crashes: number[] = [];
  private session?: string;
  private gen = -1;
  private sequence = 0;
  private intent?: { id: string; enabled: boolean };
  private titles = false;
  private desired = true;
  private buffer = '';
  private readonly children = new Map<ChildProcessWithoutNullStreams, { done: Promise<void>; killAt?: number }>();
  private readonly writer = new HelperWriter((child) => this.fail('stdin-error', child));
  private recovery = new HelperRecovery();
  private lastFailure?: string;
  constructor(
    private readonly spawner: HelperSpawner,
    private readonly path: string | undefined,
    private readonly platform: string,
    private readonly clock: Clock,
    private readonly attention: RuntimeAttention,
    private readonly body: BodySource,
    private readonly reschedule: () => void,
    private readonly paused: () => boolean,
  ) {}
  start(enabled: boolean): void {
    this.stopped = false;
    this.desired = enabled;
    if (this.platform !== 'darwin' || !this.path) {
      void this.status('unavailable', 'not-installed');
      return;
    }
    this.launch();
  }
  nextDeadline(): number | undefined {
    const kill = [...this.children.values()].map((child) => child.killAt);
    const due = [this.retry, this.deadline, this.snapshots.deadline, ...kill].filter(
      (v): v is number => v !== undefined,
    );
    return due.length ? Math.min(...due) : undefined;
  }
  tick(): void {
    const now = this.clock.mono();
    for (const [child, state] of this.children) {
      if (state.killAt !== undefined && now >= state.killAt) {
        state.killAt = undefined;
        child.kill('SIGKILL');
      }
    }
    if (this.deadline !== undefined && now >= this.deadline) this.fail('handshake-timeout');
    if (this.snapshots.due(now)) this.requestSnapshot();
    if (this.retry !== undefined && now >= this.retry) {
      if (this.children.size) this.retry = now + 50;
      else {
        this.retry = undefined;
        this.launch();
      }
    }
  }
  titlesEnabled(): boolean {
    return this.titles;
  }
  setTitles(enabled: boolean): void {
    this.desired = enabled;
    this.titles = false;
    clearWindow(this.attention, this.clock.wall());
    if (this.child && this.session) this.sendIntent();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.retry = undefined;
    this.snapshots.reset();
    this.deadline = undefined;
    this.child = undefined;
    this.writer.stop();
    const children = [...this.children.entries()];
    for (const [child] of children) {
      child.stdin.end();
      child.kill('SIGTERM');
    }
    if (!children.length) return;
    const done = Promise.all(children.map(([, state]) => state.done));
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        done,
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, 350);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    for (const [child] of children) if (this.children.has(child)) child.kill('SIGKILL');
    await done;
  }
  private launch(): void {
    if (this.stopped || !this.path) return;
    let child: ChildProcessWithoutNullStreams | undefined;
    try {
      child = this.spawner.spawn(this.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') void this.status('unavailable', 'not-installed');
      else this.restart('spawn-failed');
      return;
    }
    if (!child) return void this.status('unavailable', 'not-installed');
    this.child = child;
    this.session = undefined;
    this.gen = -1;
    this.titles = false;
    this.buffer = '';
    this.intent = undefined;
    this.writer.start(child);
    this.recovery = new HelperRecovery(this.recovery.degraded);
    this.deadline = this.clock.mono() + HANDSHAKE_MS;
    const done = new Promise<void>((resolve) => child.once('close', () => resolve()));
    this.children.set(child, { done });
    child.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') {
        this.child = undefined;
        this.deadline = undefined;
        void this.status('unavailable', 'not-installed');
        this.reschedule();
      } else this.fail('process-error', child);
    });
    child.once('close', () => {
      this.children.delete(child);
      if (this.child === child) {
        this.child = undefined;
        clearWindow(this.attention, this.clock.wall());
        this.restart('process-exited');
      }
      this.reschedule();
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      child.stdout.pause();
      void this.read(chunk, child).then(
        () => {
          if (this.child === child) child.stdout.resume();
        },
        () => this.fail('protocol-error', child),
      );
    });
    child.stdout.once('error', () => this.fail('stdout-error', child));
    child.stdin.once('error', () => this.fail('stdin-error', child));
    child.stderr.resume();
    this.reschedule();
  }
  private async read(chunk: string, child: ChildProcessWithoutNullStreams): Promise<void> {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > 1_048_576) throw new Error('helper output too large');
    let end = this.buffer.indexOf('\n');
    while (end >= 0 && this.child === child) {
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      const event = object(JSON.parse(line));
      if (
        event?.v !== 1 ||
        typeof event.type !== 'string' ||
        typeof event.at !== 'number' ||
        !Number.isFinite(event.at)
      ) {
        throw new Error('invalid helper event');
      }
      await this.event(event);
      end = this.buffer.indexOf('\n');
    }
  }
  private async event(raw: Message): Promise<void> {
    const child = this.child;
    const recovery = this.recovery;
    const valid = () => !this.stopped && this.child === child && this.recovery === recovery;
    if (raw.type === 'hello') {
      if (typeof raw.session !== 'string' || (this.session && this.session !== raw.session))
        throw new Error('invalid session');
      const first = !this.session;
      this.session = raw.session;
      if (first) this.sendIntent();
      this.recovery.delta(raw);
      const permissions = object(raw.permissions);
      await axStatus(this.attention, permissions?.accessibility === 'granted' ? 'ok' : 'denied', raw.at as number);
      return;
    }
    if (!this.session) throw new Error('missing hello');
    if (raw.type === 'titles.ack') {
      const intent = this.intent;
      if (
        intent &&
        raw.session === this.session &&
        raw.id === intent.id &&
        raw.enabled === intent.enabled &&
        typeof raw.gen === 'number' &&
        Number.isSafeInteger(raw.gen) &&
        raw.gen > this.gen
      ) {
        this.gen = raw.gen;
        this.titles = intent.enabled;
        this.intent = undefined;
        this.deadline = undefined;
        this.reschedule();
        if (!this.recovery.degraded) await this.status('ok', 'ready');
        if (!valid()) return;
        this.requestSnapshot();
      }
      return;
    }
    if (raw.type === 'error') {
      if (!this.recovery.degraded) this.snapshots.reset();
      this.recovery.degraded = true;
      markHelperFacts(this.attention, this.body, raw.at as number, ['frontApp', 'focusedWindow', 'thermal'], 'stale');
      const code = await helperError(this.attention, raw);
      if (!valid()) return;
      if (code === 'privacy-generation-exhausted') throw new Error('privacy generation exhausted');
      if (this.recovery.waiting) this.recovery.obsolete = true;
      else this.requestSnapshot();
      return;
    }
    if (this.paused()) return;
    if (raw.type === 'snapshot') {
      this.recovery.waiting = false;
      if (this.recovery.obsolete) {
        this.recovery.obsolete = false;
        this.requestSnapshot();
        return;
      }
    }
    const safe = (this.titles ? raw : strip(raw)) as Message;
    const recovered = await applyHelperEvent(recovery, raw, safe, this.attention, this.body, valid);
    if (!valid()) return;
    if (recovered) {
      this.snapshots.reset();
      await this.status('ok', 'snapshot');
    } else if (raw.type === 'snapshot' && this.recovery.degraded) this.snapshots.failed(this.clock.mono());
    else if (this.recovery.degraded && !this.recovery.waiting && this.snapshots.delta(raw)) this.requestSnapshot();
    this.reschedule();
  }
  private async status(status: 'ok' | 'unavailable' | 'error', reason: string): Promise<void> {
    await helperStatus(this.attention, this.clock.wall(), status, reason, this.crashes.length, this.lastFailure);
  }
  private sendIntent(): void {
    const child = this.child;
    if (!child) return;
    const intent = { id: String(++this.sequence), enabled: this.desired };
    this.intent = intent;
    this.titles = false;
    this.deadline ??= this.clock.mono() + HANDSHAKE_MS;
    this.writer.write({ cmd: 'titles', ...intent });
    this.reschedule();
  }
  private requestSnapshot(): void {
    if (!this.recovery.request()) return;
    this.writer.write({ cmd: 'snapshot' });
  }
  private fail(reason: string, expected = this.child): void {
    const child = this.child;
    if (!child || child !== expected) return;
    this.child = undefined;
    this.writer.stop();
    this.titles = false;
    clearWindow(this.attention, this.clock.wall());
    const state = this.children.get(child);
    if (state) state.killAt = this.clock.mono() + 300;
    child.stdin.end();
    child.kill('SIGTERM');
    this.restart(reason);
  }
  private restart(reason: string): void {
    this.deadline = undefined;
    this.snapshots.reset();
    this.titles = false;
    this.lastFailure = reason;
    if (this.stopped) return;
    const now = this.clock.mono();
    this.crashes = this.crashes.filter((at) => now - at < WINDOW_MS);
    if (this.crashes.length >= MAX_RESTARTS) {
      void this.status('error', 'restart-limit');
    } else {
      this.crashes.push(now);
      this.retry = now + Math.min(30_000, 250 * 2 ** (this.crashes.length - 1));
    }
    this.reschedule();
  }
}
