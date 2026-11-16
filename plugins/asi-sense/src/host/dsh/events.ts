import type { JobEvent, ToolEvent } from '../runtime/ports.ts';

interface ToolExecution {
  sessionId: string;
  toolCallId: string;
  name: string;
  args: unknown;
  defaultCwd?: string;
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function mapToolEvent(type: ToolEvent['type'], execution: ToolExecution, result?: unknown): ToolEvent {
  const args = object(execution.args);
  const value = object(result);
  const shell = execution.name === 'bash';
  const cwd = typeof value.cwd === 'string' ? value.cwd : (args.workdir ?? execution.defaultCwd);
  return {
    type,
    sessionId: execution.sessionId,
    toolCallId: execution.toolCallId,
    ...(shell && typeof args.command === 'string' ? { command: args.command } : {}),
    ...(typeof cwd === 'string' ? { cwd } : {}),
    ...(shell && value.kind === 'foreground' && typeof value.exitCode === 'number' ? { exitCode: value.exitCode } : {}),
  };
}

interface JobView {
  id: string;
  kind: string;
  label: string;
  owner?: string;
  status: string;
  detail?: string;
  startedAt: number;
  finishedAt?: number;
}

interface RegistryJobEvent {
  type: string;
  job: JobView;
  awaited?: boolean;
}

export interface ActiveTool {
  sessionId: string;
  name: string;
  cwd?: string;
  command?: string;
  jobId?: string;
  waitsForJob?: boolean;
}

export function awaitedJobCwd(event: RegistryJobEvent, tools: Iterable<ActiveTool>): string | undefined {
  if (event.type !== 'settled' || !event.awaited || !event.job.owner) return undefined;
  for (const tool of tools) {
    if (tool.sessionId !== event.job.owner || !tool.cwd) continue;
    if (
      (tool.name === 'bash' && event.job.kind === 'bash' && tool.command === event.job.label) ||
      (tool.name === 'job_output' && tool.waitsForJob && tool.jobId === event.job.id)
    )
      return tool.cwd;
  }
  return undefined;
}

export function mapJobEvent(event: RegistryJobEvent, cwd?: string): JobEvent | undefined {
  const { job } = event;
  if (event.type === 'registered')
    return {
      type: 'started',
      id: job.id,
      command: job.label,
      at: job.startedAt,
      ...(job.owner ? { sessionId: job.owner } : {}),
    };
  if (event.type !== 'settled') return undefined;
  const match =
    !event.awaited && job.kind === 'bash' && job.status === 'completed'
      ? /^exit code: (\d+)(?:;|$)/.exec(job.detail ?? '')
      : null;
  return {
    type: 'exited',
    id: job.id,
    command: job.label,
    ...(job.owner ? { sessionId: job.owner } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(job.finishedAt !== undefined ? { at: job.finishedAt } : {}),
    ...(match ? { exitCode: Number(match[1]) } : {}),
  };
}

export class JobEventCorrelator {
  private readonly origins = new Map<string, string>();

  constructor(private readonly tools: ReadonlyMap<string, ActiveTool>) {}

  map(event: RegistryJobEvent): JobEvent | undefined {
    if (event.type === 'registered' && event.job.kind === 'bash' && event.job.owner) {
      const matches = [...this.tools].filter(
        ([, tool]) => tool.sessionId === event.job.owner && tool.name === 'bash' && tool.command === event.job.label,
      );
      if (matches.length === 1) this.origins.set(event.job.id, matches[0][0]);
    }
    const origin = this.origins.get(event.job.id);
    const eligible = [...this.tools]
      .filter(([key, tool]) => tool.name !== 'bash' || key === origin)
      .map(([, tool]) => tool);
    const result = mapJobEvent(event, awaitedJobCwd(event, eligible));
    if (event.type === 'settled' || event.type === 'removed') this.origins.delete(event.job.id);
    return result;
  }

  clear(): void {
    this.origins.clear();
  }
}
