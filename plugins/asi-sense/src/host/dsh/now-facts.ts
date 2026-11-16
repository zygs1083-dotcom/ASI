import type { JobSummary } from '@asi/sense-types';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { NowReadings } from '../sources/dsh.ts';

type SettingsReader = {
  describe(options: { redactSecrets: true }): { ns: string; value: unknown }[];
};

type PendingGateway = {
  getPendingRemoteEvents(): readonly { event: string; agentId: string }[];
};

function member(value: unknown, key: string): unknown {
  return value && typeof value === 'object' && Object.hasOwn(value, key)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function endpoint(ctx: Context, provider: string): string | undefined {
  const entry = ctx.llm.listConfigurableProviders().find((item) => item.provider === provider);
  if (!entry) return undefined;
  const settings = (ctx as Context & { get(name: 'settings'): SettingsReader | undefined }).get('settings');
  if (!settings) return undefined;
  let value: unknown = settings.describe({ redactSecrets: true }).find((row) => row.ns === entry.settingsNs)?.value;
  for (const segment of entry.settingsPath) value = member(value, segment);
  const configured = member(value, 'baseURL');
  if (typeof configured !== 'string') return undefined;
  try {
    const url = new URL(configured);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

function localEndpoint(endpoint: string): boolean {
  const host = new URL(endpoint).hostname.toLowerCase();
  return host === 'localhost' || host === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

export function nowReadings(
  ctx: Context,
  selected: string | undefined,
  executingTools: ReadonlyMap<string, string>,
  thinking: ReadonlySet<string>,
  waitingSessions: ReadonlySet<string> = new Set(),
): NowReadings {
  const agents = ctx.agents.list();
  const agent: Agent | undefined = agents.find((item) => item.id === selected);
  const reason = '没有活动会话';
  const missing = { value: null, status: 'unknown' as const, reason };
  const result: NowReadings = {
    'env.where.model': missing,
    'env.where.toolExec': { value: null, status: 'unknown', reason: agent ? 'DSH 未提供工具执行宿主' : reason },
    'self.activity': missing,
    'self.pending': missing,
    'self.tools': missing,
  };
  let jobs: JobSummary[] | undefined;
  let selectedJobs: number | undefined;
  try {
    const perSession = new Map(agents.map((item) => [item.id, ctx.jobs.list(item.id)]));
    const visible = [ctx.jobs.list(), ...perSession.values()].flat();
    jobs = [
      ...new Map(
        visible
          .filter((job) => job.status === 'running' || job.status === 'stopping')
          .map((job) => [
            job.id,
            { id: job.id, startedAt: job.startedAt, command: job.label, status: 'running' as const },
          ]),
      ).values(),
    ];
    result['env.activeJobs'] = { value: jobs };
    if (agent) {
      selectedJobs = perSession
        .get(agent.id)
        ?.filter((job) => job.owner === agent.id && (job.status === 'running' || job.status === 'stopping')).length;
    }
  } catch {
    result['env.activeJobs'] = { value: null, status: 'unavailable', reason: 'DSH 任务列表不可用' };
  }
  if (!agent) return result;
  const route = agent.model.current();
  if (route) {
    let url: string | undefined;
    try {
      url = endpoint(ctx, route.provider);
    } catch {
      url = undefined;
    }
    result['env.where.model'] = url
      ? { value: { provider: route.provider, endpoint: url, local: localEndpoint(url) } }
      : { value: null, status: 'unknown', reason: `DSH 未提供 ${route.provider} 的实际 endpoint` };
  } else {
    result['env.where.model'] = { value: null, status: 'unknown', reason: '会话尚未选择模型' };
  }
  const gateway = (ctx as Context & { get(name: 'typertGateway'): PendingGateway | undefined }).get('typertGateway');
  const waiting =
    waitingSessions.has(agent.id) ||
    gateway
      ?.getPendingRemoteEvents()
      .some(
        (event) =>
          event.agentId === agent.id &&
          (event.event === 'approval/request' || event.event === 'user-questions/request'),
      );
  const executing = [...executingTools.values()].includes(agent.id);
  result['self.activity'] =
    agent.status === 'idle'
      ? { value: 'idle' }
      : waiting
        ? { value: 'waiting-user' }
        : executing
          ? { value: 'tool' }
          : thinking.has(agent.id)
            ? { value: 'thinking' }
            : { value: null, status: 'unknown', reason: 'DSH 未区分运行中与等待用户' };
  if (jobs && selectedJobs !== undefined) {
    result['self.pending'] = {
      value: { inbox: agent.inbox.nextTurn.length + agent.inbox.nextStep.length, jobs: selectedJobs },
    };
  } else {
    result['self.pending'] = { value: null, status: 'unavailable', reason: 'DSH 任务列表不可用' };
  }
  try {
    result['self.tools'] = {
      value: ctx.tools
        .definitions(agent)
        .filter((tool) => ctx.tools.executable(tool.name, agent))
        .map((tool) => tool.name),
    };
  } catch {
    result['self.tools'] = { value: null, status: 'unavailable', reason: 'DSH 工具列表不可用' };
  }
  return result;
}
