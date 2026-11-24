import os from 'node:os';
import type { SenseState } from '@asi/sense-types';
import type { SenseBus } from '../runtime/bus.ts';
import type { AgentEvent, Clock, DshPort, JobEvent, ToolEvent, Unsubscribe } from '../runtime/ports.ts';
import { initialState } from '../state/facts.ts';
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
  private readonly jobs = new Map<string, { sessionId?: string }>();
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
    private readonly bus: SenseBus,
    private readonly body: {
      tokens(session: string, valid?: () => boolean): Promise<void>;
      sessionsChanged(present: boolean): void;
      selectSession(session?: string): void;
      disposeSession(session: string): void;
      sessionToken(session: string): SenseState['self']['body']['tokens'];
    },
    private readonly paused: () => boolean,
  ) {}

  start(refreshIntervalMs: number | undefined = 5_000): void {
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
    this.setRefreshInterval(refreshIntervalMs);
  }

  setRefreshInterval(intervalMs: number | undefined): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.active && intervalMs !== undefined && 'nowReadings' in this.port) {
      this.timer = setInterval(() => this.refresh(), intervalMs);
      this.timer.unref?.();
    }
  }

  stop(): Promise<void> {
    this.active = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const off of this.off.splice(0)) off();
    this.jobs.clear();
    this.instances.clear();
    this.sessions.clear();
    return Promise.allSettled([...this.inflight]).then(() => {});
  }

  private userInstanceCount(): number {
    let count = 0;
    for (const id of this.instances.keys()) {
      if (!this.bus.isInternalSession(id)) count++;
    }
    return count;
  }

  private publish(readings: NowReadings, src = { id: 'dsh', api: 'registry', host: os.hostname() }): void {
    if (!this.active || this.bus.isStopped()) return;
    this.bus.store.batch(
      () => {
        for (const [path, reading] of Object.entries(readings)) {
          this.bus.store.apply({
            id: this.bus.id(),
            kind: 'fact.updated',
            at: this.clock.wall(),
            source: src,
            subject: path,
            data: { path, ...reading, ttlMs: src.id === 'local' ? 86_400_000 : 30_000 },
          });
        }
      },
      () => this.bus.changed(),
    );
  }

  private refresh(force = false): void {
    if (!this.active || (this.paused() && !force)) return;
    const extended = this.port as DshPort & { nowReadings?: (sessionId?: string) => NowReadings };
    const reason = this.userInstanceCount() ? 'DSH 未提供事实来源' : '没有活动会话';
    let readings: NowReadings;
    try {
      readings =
        extended.nowReadings?.(this.bus.currentSessionId()) ??
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
    const session = this.bus.currentSessionId();
    this.body.sessionsChanged(this.userInstanceCount() > 0);
    this.body.selectSession(session);
    this.refresh(true);
    if (session && !this.paused()) {
      void this.body.tokens(session, () => this.active && this.bus.currentSessionId() === session);
    }
  }

  stateFor(session: string | undefined, state: SenseState): SenseState {
    const store = session === undefined ? undefined : this.sessions.get(session);
    const extended = this.port as DshPort & { nowReadings?: (sessionId?: string) => NowReadings };
    const paths = [
      'self.activity',
      'self.pending',
      'self.tools',
      'env.where.model',
      'env.where.toolExec',
      'env.activeJobs',
    ];
    let own: SenseState;
    if (store || extended.nowReadings) {
      const view = store ?? new StateStore(() => this.clock.wall());
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
          id: this.bus.id(),
          kind: 'fact.updated',
          at: this.clock.wall(),
          source,
          subject: path,
          data: { path, ...reading, ttlMs: 30_000 },
        });
      }
      own = view.snapshot();
    } else {
      own = initialState(this.clock.wall(), 60_000);
    }
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

  private async agent(event: AgentEvent): Promise<void> {
    const isInternal = this.bus.isInternalSession(event.sessionId);
    if (event.type === 'created') {
      if (this.instances.has(event.sessionId)) {
        this.body.disposeSession(event.sessionId);
        if (this.bus.currentSessionId() === event.sessionId) this.body.selectSession(undefined);
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
      this.bus.create(event.sessionId);
      this.body.sessionsChanged(this.userInstanceCount() > 0);
      if (this.bus.currentSessionId() === event.sessionId) this.body.selectSession(event.sessionId);
    }
    if (event.type === 'disposed') {
      this.bus.store.batch(
        () => {
          this.instances.delete(event.sessionId);
          this.sessions.delete(event.sessionId);
          this.body.disposeSession(event.sessionId);
          this.bus.dispose(event.sessionId);
          this.body.sessionsChanged(this.userInstanceCount() > 0);
          this.body.selectSession(this.bus.currentSessionId());
          this.refresh(true);
        },
        () => this.bus.changed(),
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
        if (!this.paused() && !isInternal) await this.body.tokens(event.sessionId, valid);
        if (valid() && !isInternal) {
          this.bus.store.batch(
            () => {
              this.bus.activateSession(event.sessionId);
              this.body.selectSession(this.bus.currentSessionId());
              this.refresh(true);
            },
            () => this.bus.changed(),
          );
        }
      } finally {
        this.requestRefresh();
      }
    }
    if (event.type === 'post-step' && !isInternal) {
      const instance = this.instances.get(event.sessionId);
      if (instance && !this.paused()) {
        await this.body.tokens(event.sessionId, () => this.active && this.instances.get(event.sessionId) === instance);
      }
    }
  }

  private async tool(event: ToolEvent): Promise<void> {
    this.requestRefresh();
    if (!this.paused() && event.type === 'post-execute' && event.exitCode !== undefined && event.exitCode !== 0) {
      const at = event.at ?? this.clock.wall();
      await this.bus.accept({
        id: this.bus.id(),
        kind: 'job.exited',
        at,
        source,
        subject: event.command ?? event.toolCallId,
        cause: 'agent',
        data: {
          id: event.toolCallId,
          sessionId: event.sessionId,
          command: event.command,
          pid: event.pid,
          ppid: event.ppid,
          ancestors: event.ancestors,
          path: event.cwd,
          exitCode: event.exitCode,
        },
      });
    }
  }

  private async job(event: JobEvent): Promise<void> {
    if (event.type === 'started') {
      this.jobs.set(event.id, { sessionId: event.sessionId });
    }
    const owner = this.jobs.get(event.id);
    if (event.type === 'exited') this.jobs.delete(event.id);
    if (this.paused()) return;
    await this.bus.accept({
      id: this.bus.id(),
      kind: `job.${event.type}`,
      at: event.at ?? this.clock.wall(),
      source,
      subject: event.command ?? event.id,
      cause: 'agent',
      data: {
        id: event.id,
        sessionId: owner ? owner.sessionId : event.sessionId,
        command: event.command,
        pid: event.pid,
        ppid: event.ppid,
        ancestors: event.ancestors,
        path: event.cwd,
        exitCode: event.exitCode,
      },
    });
  }
}
