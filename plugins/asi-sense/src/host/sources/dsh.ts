import type { Signal } from '@asi/sense-types';
import { classifyCause, type ToolWindow } from '../attention/selfcause.ts';
import type { RuntimeAttention } from '../runtime/attention.ts';
import type { AgentEvent, Clock, DshPort, JobEvent, ToolEvent, Unsubscribe } from '../runtime/ports.ts';

const source = { id: 'dsh', api: 'events', host: 'local' };

export class DshSource {
  private readonly windows = new Map<string, ToolWindow>();
  private readonly off: Unsubscribe[] = [];
  private active = false;
  private readonly inflight = new Set<Promise<void>>();
  private readonly instances = new Map<string, object>();
  private selection = 0;
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
    this.off.push(this.port.onAgentEvent((event) => this.track(() => this.agent(event))));
    this.off.push(this.port.onTool((event) => this.track(() => this.tool(event))));
    this.off.push(this.port.onJob((event) => this.track(() => this.job(event))));
  }
  stop(): Promise<void> {
    this.active = false;
    for (const off of this.off.splice(0)) off();
    this.windows.clear();
    this.instances.clear();
    return Promise.allSettled([...this.inflight]).then(() => {});
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
