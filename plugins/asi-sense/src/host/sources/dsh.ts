import os from 'node:os';
import type { SenseState, Signal } from '@asi/sense-types';
import { classifyCause, type ToolWindow } from '../attention/selfcause.ts';
import type { RuntimeAttention } from '../runtime/attention.ts';
import type { AgentEvent, Clock, DshPort, JobEvent, ToolEvent, Unsubscribe } from '../runtime/ports.ts';
import { StateStore } from '../state/store.ts';

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
  private readonly windows = new Map<string, ToolWindow & { sessionToken?: string }>();
  private readonly jobs = new Map<string, { sessionId?: string; sessionToken?: string }>();
  private readonly off: Unsubscribe[] = [];
  private active = false;
  private readonly inflight = new Set<Promise<void>>();
  private readonly instances = new Map<string, object>();
  private readonly sessions = new Map<string, StateStore>();
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
      selectSession(session?: string): void;
      disposeSession(session: string): void;
      sessionToken(session: string): SenseState['self']['body']['tokens'];
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
    this.jobs.clear();
    this.instances.clear();
    this.sessions.clear();
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
  private refresh(force = false): void {
    if (!this.active || (this.paused() && !force)) return;
    const extended = this.port as DshPort & { nowReadings?: (sessionId?: string) => NowReadings };
    const reason = this.instances.size ? 'DSH 未提供事实来源' : '没有活动会话';
    let readings: NowReadings;
    try {
      readings =
        extended.nowReadings?.(this.attention.currentSessionId()) ??
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
  hasSession(session: string): boolean {
    return this.sessions.has(session);
  }
  targetChanged(): void {
    const session = this.attention.currentSessionId();
    this.body.selectSession(session);
    this.refresh(true);
    if (session && !this.paused()) {
      void this.body.tokens(session, () => this.active && this.attention.currentSessionId() === session);
    }
  }
  stateFor(session: string | undefined, state: SenseState): SenseState {
    const store = session === undefined ? undefined : this.sessions.get(session);
    const view = store ?? new StateStore(() => this.clock.wall());
    const extended = this.port as DshPort & { nowReadings?: (sessionId?: string) => NowReadings };
    const paths = [
      'self.activity',
      'self.pending',
      'self.tools',
      'env.where.model',
      'env.where.toolExec',
      'env.activeJobs',
    ];
    if (store || extended.nowReadings) {
      let readings: NowReadings = {};
      try {
        readings = extended.nowReadings?.(session) ?? {};
      } catch {
        readings = Object.fromEntries(paths.map((path) => [path, { value: null, status: 'unavailable' }]));
      }
      for (const path of paths) {
        if (!store && path !== 'env.activeJobs') continue;
        const reading = readings[path];
        if (!reading) continue;
        view.apply({
          id: this.attention.id(),
          kind: 'fact.updated',
          at: this.clock.wall(),
          source,
          subject: path,
          data: { path, ...reading, ttlMs: 30_000 },
        });
      }
    }
    const own = view.snapshot();
    if (!store) {
      const reason = session === undefined ? '没有活动会话' : '会话不可用';
      for (const fact of [
        own.self.activity,
        own.self.pending,
        own.self.tools,
        own.self.body.tokens,
        own.env.where.model,
        own.env.where.toolExec,
      ])
        fact.reason = reason;
      if (!extended.nowReadings) own.env.activeJobs.reason = reason;
    }
    state.self.activity = own.self.activity;
    state.self.pending = own.self.pending;
    state.self.tools = own.self.tools;
    state.self.body.tokens =
      store && session !== undefined
        ? this.body.sessionToken(session)
        : session === undefined && state.self.body.tokens.value === null
          ? state.self.body.tokens
          : own.self.body.tokens;
    state.env.where.model = own.env.where.model;
    state.env.where.toolExec = own.env.where.toolExec;
    state.env.activeJobs = own.env.activeJobs;
    return state;
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
      if (this.instances.has(event.sessionId)) {
        this.body.disposeSession(event.sessionId);
        if (this.attention.currentSessionId() === event.sessionId) this.body.selectSession(undefined);
      }
      this.instances.set(event.sessionId, {});
      this.sessions.set(
        event.sessionId,
        new StateStore(
          () => this.clock.wall(),
          60_000,
          () => this.clock.mono(),
        ),
      );
      this.attention.create(event.sessionId);
      this.body.sessionsChanged(true);
      if (this.attention.currentSessionId() === event.sessionId) this.body.selectSession(event.sessionId);
    }
    if (event.type === 'disposed') {
      this.attention.store.batch(
        () => {
          this.instances.delete(event.sessionId);
          this.sessions.delete(event.sessionId);
          this.body.disposeSession(event.sessionId);
          this.attention.dispose(event.sessionId);
          this.body.sessionsChanged(this.instances.size > 0);
          this.body.selectSession(this.attention.currentSessionId());
          this.refresh(true);
        },
        () => this.attention.changed(),
      );
    }
    this.requestRefresh();
    if (event.type === 'pre-step') {
      const sequence = ++this.selection;
      const instance = this.instances.get(event.sessionId);
      const valid = () =>
        this.active && !!instance && this.instances.get(event.sessionId) === instance && this.selection === sequence;
      if (!instance) return;
      try {
        if (!this.paused()) await this.body.tokens(event.sessionId, valid);
        if (valid()) {
          let step: Promise<void> | undefined;
          this.attention.store.batch(
            () => {
              step = this.attention.preStep(event.sessionId, event.userInitiated, !this.paused());
              this.body.selectSession(this.attention.currentSessionId());
              this.refresh(true);
            },
            () => this.attention.changed(),
          );
          await step;
        }
      } finally {
        this.requestRefresh();
      }
    }
    if (event.type === 'post-step') {
      this.attention.postStep(event.sessionId);
      const instance = this.instances.get(event.sessionId);
      if (instance && !this.paused()) {
        await this.body.tokens(event.sessionId, () => this.active && this.instances.get(event.sessionId) === instance);
      }
    }
  }
  private async tool(event: ToolEvent): Promise<void> {
    this.requestRefresh();
    const key = `${event.sessionId}:${event.toolCallId}`;
    const at = event.at ?? this.clock.wall();
    if (event.type === 'pre-execute') {
      this.windows.set(key, {
        startedAt: at,
        startedMono: this.clock.mono(),
        cwd: event.cwd,
        pid: event.pid,
        sessionToken: this.attention.sessionToken(event.sessionId),
      });
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
            sessionId: event.sessionId,
            sessionToken: window?.sessionToken,
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
    if (event.type === 'started') {
      this.jobs.set(event.id, {
        sessionId: event.sessionId,
        sessionToken: this.attention.sessionToken(event.sessionId),
      });
    }
    const owner = this.jobs.get(event.id);
    if (event.type === 'exited') this.jobs.delete(event.id);
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
          sessionId: owner ? owner.sessionId : event.sessionId,
          sessionToken: owner?.sessionToken,
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
