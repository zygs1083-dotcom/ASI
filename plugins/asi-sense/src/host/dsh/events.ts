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
  status: string;
  detail?: string;
  startedAt: number;
  finishedAt?: number;
}

export function mapJobEvent(event: { type: string; job: JobView; awaited?: boolean }): JobEvent | undefined {
  const { job } = event;
  if (event.type === 'registered') return { type: 'started', id: job.id, command: job.label, at: job.startedAt };
  if (event.type !== 'settled') return undefined;
  const match =
    !event.awaited && job.kind === 'bash' && job.status === 'completed'
      ? /^exit code: (\d+)(?:;|$)/.exec(job.detail ?? '')
      : null;
  return {
    type: 'exited',
    id: job.id,
    command: job.label,
    ...(job.finishedAt !== undefined ? { at: job.finishedAt } : {}),
    ...(match ? { exitCode: Number(match[1]) } : {}),
  };
}
