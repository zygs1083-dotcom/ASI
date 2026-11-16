import os from 'node:os';
import type { Signal } from '@asi/sense-types';
import { classifyCause, type ToolWindow } from '../attention/selfcause.ts';
import type { RuntimeAttention } from '../runtime/attention.ts';
import type { AgentEvent, Clock, DshPort, JobEvent, ToolEvent, Unsubscribe } from '../runtime/ports.ts';

export type NowReadings = Record<
  string,
  {
    value: unknown;
    status?: 'unknown' | 'unavailable';
    reason?: string;
  }
>;

const source = { id: 'dsh', api: 'events', host: 'local' };

export class DshSource {
  private readonly windows = new Map<string, ToolWindow>();
  private readonly off: Unsubscribe[] = [];
  private active = false;
  private readonly inflight = new Set<Promise<void>>();
  private readonly instances = new Map<string, object>();
  private selection = 0;
  private timer?: ReturnType<typeof setInterval>;
  private refreshQueued = false;
  constructor(
    private readonly port: DshPort,
    private readonly clock: Clock,
    private readonly attention: RuntimeAttention,
    private readonly body: {
      tokens(session: string, valid?: () => boolean): Promise<void>;
      sessionsChanged(present: boolean): void;
    },
    private readonly paused: () => boolean,
    private readonly selfCauseGraceMs = 2_000,
  ) {}
  start(): void {
    this.active = true;
    this.body.sessionsChanged(false);
    const host = os.hostname();
    this.publish(
      {
        'env.where.harness': { value: { host, os: `${os.platform()} ${os.release()}`, pid: process.pid } },
        'env.where.observed': { value: { host, userSession: '本机控制台会话' } },
        'self.permissions': { value: null, status: 'unknown', reason: '辅助功能状态尚未收到' },
      },
      { id: 'local', api: 'node', host },
    );
    this.refresh();
    const extended = this.port as DshPort & { onNowChanged?: (cb: () => void) => Unsubscribe };
    if (extended.onNowChanged) this.off.push(extended.onNowChanged(() => this.requestRefresh()));
    this.off.push(this.port.onAgentEvent((event) => this.track(() => this.agent(event))));
    this.off.push(this.port.onTool((event) => this.track(() => this.tool(event))));
    this.off.push(this.port.onJob((event) => this.track(() => this.job(event))));
    if ('nowReadings' in this.port) {
      this.timer = setInterval(() => this.refresh(), 5_000);
      this.timer.unref?.();
    }
  }
  stop(): Promise<void> {
    this.active = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const off of this.off.splice(0)) off();
    this.windows.clear();
    this.instances.clear();
    return Promise.allSettled([...this.inflight]).then(() => {});
  }
  private publish(readings: NowReadings, source = { id: 'dsh', api: 'registry', host: os.hostname() }): void {
    if (!this.active || this.attention.isStopped()) return;
    this.attention.store.batch(
      () => {
        for (const [path, reading] of Object.entries(readings)) {
          this.attention.store.apply({
            id: this.attention.id(),
            kind: 'fact.updated',
            at: this.clock.wall(),
            source,
            subject: path,
            data: { path, ...reading, ttlMs: source.id === 'local' ? 86_400_000 : 30_000 },
          });
        }
      },
      () => this.attention.changed(),
    );
  }
  private refresh(): void {
    if (!this.active || this.paused()) return;
    const extended = this.port as DshPort & { nowReadings?: () => NowReadings };
    const reason = this.instances.size ? 'DSH 未提供事实来源' : '没有活动会话';
    let readings: NowReadings;
    try {
      readings =
        extended.nowReadings?.() ??
        Object.fromEntries(
          [
            'env.where.model',
            'env.where.toolExec',
            'self.activity',
            'self.pending',
            'self.tools',
            'env.activeJobs',
          ].map((path) => [path, { value: null, status: 'unknown', reason }]),
        );
    } catch {
      readings = Object.fromEntries(
        ['env.where.model', 'env.where.toolExec', 'self.activity', 'self.pending', 'self.tools', 'env.activeJobs'].map(
          (path) => [path, { value: null, status: 'unavailable', reason: 'DSH 状态读取失败' }],
        ),
      );
    }
    this.publish(readings);
  }
  private requestRefresh(): void {
    if (this.refreshQueued || !this.active || !('nowReadings' in this.port)) return;
    this.refreshQueued = true;
    queueMicrotask(() => {
      this.refreshQueued = false;
      this.refresh();
    });
  }
  private track(work: () => Promise<void>): Promise<void> {
    if (!this.active) return Promise.resolve();
    const result = work();
    this.inflight.add(result);
    void result.then(
      () => this.inflight.delete(result),
      () => this.inflight.delete(result),
    );
    return result;
  }
  classify(signal: Signal): Signal {
    return {
      ...signal,
      cause: classifyCause(signal, [...this.windows.values()], this.selfCauseGraceMs, this.clock.mono()),
    };
  }
  private async agent(event: AgentEvent): Promise<void> {
    if (event.type === 'created') {
      this.instances.set(event.sessionId, {});
      this.attention.create(event.sessionId);
      this.body.sessionsChanged(true);
    }
    if (event.type === 'disposed') {
      this.instances.delete(event.sessionId);
      this.attention.dispose(event.sessionId);
      this.body.sessionsChanged(this.instances.size > 0);
    }
    this.requestRefresh();
    if (event.type === 'pre-step') {
      const sequence = ++this.selection;
      const instance = this.instances.get(event.sessionId);
      const valid = () =>
        this.active && !!instance && this.instances.get(event.sessionId) === instance && this.selection === sequence;
      if (!instance) return;
      if (!this.paused()) await this.body.tokens(event.sessionId, valid);
      if (valid()) await this.attention.preStep(event.sessionId, event.userInitiated, !this.paused());
    }
    if (event.type === 'post-step') {
      this.attention.postStep(event.sessionId);
      if (!this.paused()) await this.body.tokens(event.sessionId);
    }
  }
  private async tool(event: ToolEvent): Promise<void> {
    this.requestRefresh();
    const key = `${event.sessionId}:${event.toolCallId}`;
    const at = event.at ?? this.clock.wall();
    if (event.type === 'pre-execute') {
      this.windows.set(key, { startedAt: at, startedMono: this.clock.mono(), cwd: event.cwd, pid: event.pid });
      if (this.windows.size > 1024) this.windows.delete(this.windows.keys().next().value as string);
      return;
    }
    const window = this.windows.get(key);
    if (window) {
      window.endedAt = at;
      window.endedMono = this.clock.mono();
      window.pid ??= event.pid;
    }
    if (!this.paused() && event.exitCode !== undefined && event.exitCode !== 0) {
      await this.attention.accept(
        this.classify({
          id: this.attention.id(),
          kind: 'job.exited',
          at,
          source,
          subject: event.command ?? event.toolCallId,
          cause: 'agent',
          data: {
            id: event.toolCallId,
            command: event.command,
            pid: event.pid ?? window?.pid,
            ppid: event.ppid,
            ancestors: event.ancestors,
            path: event.cwd ?? window?.cwd,
            exitCode: event.exitCode,
          },
        }),
      );
    }
  }
  private async job(event: JobEvent): Promise<void> {
    if (this.paused()) return;
    await this.attention.accept(
      this.classify({
        id: this.attention.id(),
        kind: `job.${event.type}`,
        at: event.at ?? this.clock.wall(),
        source,
        subject: event.command ?? event.id,
        data: {
          id: event.id,
          command: event.command,
          pid: event.pid,
          ppid: event.ppid,
          ancestors: event.ancestors,
          path: event.cwd,
          exitCode: event.exitCode,
        },
      }),
    );
  }
}
