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
  constructor(
    private readonly port: DshPort,
    private readonly clock: Clock,
    private readonly attention: RuntimeAttention,
    private readonly tokens: (session: string) => Promise<void>,
    private readonly paused: () => boolean,
  ) {}
  start(): void {
    this.active = true;
    this.off.push(this.port.onAgentEvent((event) => this.track(() => this.agent(event))));
    this.off.push(this.port.onTool((event) => this.track(() => this.tool(event))));
    this.off.push(this.port.onJob((event) => this.track(() => this.job(event))));
  }
  stop(): Promise<void> {
    this.active = false;
    for (const off of this.off.splice(0)) off();
    this.windows.clear();
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
    return { ...signal, cause: classifyCause(signal, [...this.windows.values()]) };
  }
  private async agent(event: AgentEvent): Promise<void> {
    if (event.type === 'created') this.attention.create(event.sessionId);
    if (event.type === 'disposed') this.attention.dispose(event.sessionId);
    if (event.type === 'pre-step') {
      if (!this.paused()) await this.tokens(event.sessionId);
      if (this.active) await this.attention.preStep(event.sessionId, event.userInitiated, !this.paused());
    }
    if (event.type === 'post-step') {
      this.attention.postStep(event.sessionId);
      if (!this.paused()) await this.tokens(event.sessionId);
    }
  }
  private async tool(event: ToolEvent): Promise<void> {
    const key = `${event.sessionId}:${event.toolCallId}`;
    const at = event.at ?? this.clock.wall();
    if (event.type === 'pre-execute') {
      this.windows.set(key, { startedAt: at, cwd: event.cwd, pid: event.pid });
      if (this.windows.size > 1024) this.windows.delete(this.windows.keys().next().value as string);
      return;
    }
    const window = this.windows.get(key);
    if (window) window.endedAt = at;
    if (!this.paused() && event.exitCode !== undefined && event.exitCode !== 0) {
      await this.attention.accept(
        this.classify({
          id: this.attention.id(),
          kind: 'job.exited',
          at,
          source,
          subject: event.command ?? event.toolCallId,
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
