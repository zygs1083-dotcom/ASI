import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { AsiTomServiceApi } from '@asi/sense-types';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { freezeMessage, type MessageId as LlmMessageId, MessageId } from '@deepseek-ai/dsh-llm';
import { type Session, SessionId } from '@deepseek-ai/dsh-session';
import type { ToolExecution } from '@deepseek-ai/dsh-tools';
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace';
import {
  ASI_INTERNAL_CWD_RE,
  ASI_INTERNAL_SESSION_ID_RE,
  buildUnifiedExcludedInternalRoots,
} from '../../../shared/internal-guards.js';
import type { SleepRuntime } from '../../../sleep/host/runtime.js';
import type { IntuitionHostPorts } from '../ports.js';

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'asi-intuition': { kind: 'asi-intuition' };
  }
}

const INTERNAL_SESSION_ID_RE = ASI_INTERNAL_SESSION_ID_RE;
const INTERNAL_SANDBOX_CWD_RE = ASI_INTERNAL_CWD_RE;

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function isInsideRoot(candidate: string, root: string): boolean {
  const normRoot = root.endsWith(sep) ? root : `${root}${sep}`;
  return candidate === root || candidate.startsWith(normRoot);
}

function extractToolTargetText(exec: Readonly<ToolExecution>): { targetText: string; cwd?: string } {
  const args =
    exec.arguments !== null && typeof exec.arguments === 'object' && !Array.isArray(exec.arguments)
      ? (exec.arguments as Record<string, unknown>)
      : {};
  const parts: string[] = [];
  for (const key of ['command', 'path', 'filePath', 'file', 'target', 'query', 'url', 'pattern']) {
    const val = args[key];
    if (typeof val === 'string' && val.trim()) {
      parts.push(val.trim());
    }
  }
  const cwdRaw =
    typeof args.workdir === 'string' && args.workdir.trim() ? args.workdir : exec.agent?.session?.header?.cwd;
  return {
    targetText: parts.join(' ').slice(0, 600),
    ...(typeof cwdRaw === 'string' && cwdRaw.trim() ? { cwd: cwdRaw } : {}),
  };
}

function extractUserBatchText(
  messages: readonly { source?: { kind?: string }; content?: readonly unknown[] }[],
): string {
  const chunks: string[] = [];
  for (const msg of messages) {
    if (msg.source?.kind !== 'user') continue;
    for (const block of msg.content ?? []) {
      if (block && typeof block === 'object' && (block as { type?: unknown }).type === 'text') {
        const text = (block as { text?: unknown }).text;
        if (typeof text === 'string' && text.trim()) {
          chunks.push(text.trim());
        }
      }
    }
  }
  return chunks.join('\n').slice(0, 2_000);
}

export function createDshIntuitionPorts(
  ctx: Context,
  storageRoot: string,
  options?: {
    excludedRoots?: readonly (string | undefined)[];
    sleepRuntime?: Pick<SleepRuntime, 'panelModel' | 'subscribe' | 'listMemories' | 'subscribeVault'>;
    tom?: Pick<AsiTomServiceApi, 'shouldDeferProactiveWork' | 'subscribe'>;
  },
): IntuitionHostPorts {
  const normExcluded = buildUnifiedExcludedInternalRoots(
    storageRoot,
    ctx.asiSense?.storageRoot,
    ...(options?.excludedRoots ?? []),
  );

  const getWorkspaceRegistry = (): WorkspaceRegistry | undefined =>
    (ctx as Context & { get(name: 'workspaceRegistry'): WorkspaceRegistry | undefined }).get('workspaceRegistry');

  const isArchived = (sid: string): boolean =>
    Boolean(getWorkspaceRegistry()?.archivedSessionIds.some((id) => String(id) === sid));

  const isOrdinarySession = (session: Session | undefined, fallbackId?: string): boolean => {
    const sid = String(session?.id ?? fallbackId ?? '');
    if (!sid || INTERNAL_SESSION_ID_RE.test(sid) || isArchived(sid)) return false;
    const header = session?.header;
    if (header?.origin === 'subagent') return false;
    if (typeof header?.delegationDepth === 'number' && header.delegationDepth > 0) return false;
    const cwd = header?.cwd;
    if (typeof cwd === 'string' && cwd.trim()) {
      if (INTERNAL_SANDBOX_CWD_RE.test(cwd)) return false;
      const normCwd = resolve(cwd);
      const realCwd = safeRealpath(normCwd);
      for (const ex of normExcluded) {
        if (isInsideRoot(normCwd, ex) || isInsideRoot(realCwd, ex)) return false;
      }
    }
    return true;
  };

  const isOrdinaryAgent = (agent: Agent | undefined): agent is Agent =>
    Boolean(agent && isOrdinarySession(agent.session, String(agent.id ?? '')));

  // Track latest parked next-step message ID per session so we can replace/coalesce or remove cleanly
  const parkedNextStepMsgId = new Map<string, LlmMessageId>();
  const claimedListeners = new Set<(sessionId: string) => void>();

  const sessions: IntuitionHostPorts['sessions'] = {
    listOrdinarySessionIds(): string[] {
      return ctx.agents
        .list()
        .filter((a) => isOrdinaryAgent(a))
        .map((a) => String(a.id));
    },

    getSessionCwd(sessionId: string): string | undefined {
      const agent = ctx.agents.get(SessionId(sessionId));
      if (agent?.session?.header?.cwd) return agent.session.header.cwd;
      const sess = ctx.sessions?.list().find((s) => String(s.id) === sessionId);
      return sess?.header?.cwd;
    },

    syncParkedMessage(sessionId: string, content: string | null): boolean {
      const agent = ctx.agents.get(SessionId(sessionId));
      const prevMsgId = parkedNextStepMsgId.get(sessionId);

      if (content === null || !content.trim()) {
        parkedNextStepMsgId.delete(sessionId);
        if (prevMsgId && typeof agent?.inbox?.remove === 'function') {
          try {
            return Boolean(agent.inbox.remove(prevMsgId));
          } catch {
            return false;
          }
        }
        return false;
      }

      if (!isOrdinaryAgent(agent)) {
        parkedNextStepMsgId.delete(sessionId);
        if (prevMsgId && typeof agent?.inbox?.remove === 'function') {
          try {
            agent.inbox.remove(prevMsgId);
          } catch {
            // ignore
          }
        }
        return false;
      }

      const sid = String(agent.id);
      const msgId = MessageId(`asi-intuition-ns:${randomUUID()}`);
      const msg = freezeMessage({
        id: msgId,
        role: 'user',
        source: { kind: 'asi-intuition' },
        content: [{ type: 'text', text: content }],
      });

      if (prevMsgId && typeof agent.inbox?.replace === 'function') {
        try {
          if (agent.inbox.replace(prevMsgId, msg)) {
            parkedNextStepMsgId.set(sid, msgId);
            return true;
          }
        } catch {
          // Fall back to send(..., 'next-step', false)
        }
      }

      if (typeof agent.send === 'function') {
        agent.send(msg, 'next-step', false);
        parkedNextStepMsgId.set(sid, msgId);
        return true;
      }
      if (typeof agent.inbox?.append === 'function') {
        agent.inbox.append('next-step', msg);
        parkedNextStepMsgId.set(sid, msgId);
        return true;
      }
      return false;
    },

    injectNextStep(sessionId: string, content: string): boolean {
      const agent = ctx.agents.get(SessionId(sessionId));
      if (!isOrdinaryAgent(agent)) return false;

      const msg = freezeMessage({
        id: MessageId(`asi-intuition-step:${randomUUID()}`),
        role: 'user',
        source: { kind: 'asi-intuition' },
        content: [{ type: 'text', text: content }],
      });

      if (typeof agent.inject === 'function') {
        agent.inject(msg);
        return true;
      }
      if (typeof agent.send === 'function') {
        agent.send(msg, 'next-step', false);
        return true;
      }
      return false;
    },
  };

  const events: IntuitionHostPorts['events'] = {
    onSessionCreated(cb) {
      return ctx.on('agent/created', ({ agent }) => {
        if (!isOrdinaryAgent(agent)) return undefined;
        cb({
          sessionId: String(agent.id),
          ...(agent.session?.header?.cwd ? { cwd: agent.session.header.cwd } : {}),
        });
        return undefined;
      });
    },

    onSessionTurnClaimed(cb) {
      claimedListeners.add(cb);
      const notifyClaimed = (sid: string) => {
        for (const fn of [...claimedListeners]) fn(sid);
      };
      const offClaim = ctx.on('agent/inbox/claimed', ({ agent, message }) => {
        const sid = String(agent.id);
        if (parkedNextStepMsgId.get(sid) === message.id || message.source?.kind === 'asi-intuition') {
          parkedNextStepMsgId.delete(sid);
          notifyClaimed(sid);
        }
      });
      const offDiscard = ctx.on('agent/inbox/discarded', ({ agent, message }) => {
        const sid = String(agent.id);
        if (parkedNextStepMsgId.get(sid) === message.id) {
          parkedNextStepMsgId.delete(sid);
          notifyClaimed(sid);
        }
      });
      const offDisposed = ctx.on('agent/disposed', ({ agent }) => {
        const sid = String(agent.id);
        parkedNextStepMsgId.delete(sid);
        notifyClaimed(sid);
      });
      return () => {
        claimedListeners.delete(cb);
        offClaim();
        offDiscard();
        offDisposed();
      };
    },

    onUserPreStep(cb) {
      return ctx.on('agent/pre-step', async (payload, next) => {
        const decision = await next();
        if (decision.kind === 'reject' || payload.signal.aborted) return decision;
        if (!isOrdinaryAgent(payload.agent)) return decision;
        if (payload.step !== 1) return decision;

        const promptText = extractUserBatchText(decision.messages);
        if (!promptText) return decision;

        try {
          const sid = String(payload.agent.id);
          const existingParkedId = parkedNextStepMsgId.get(sid);
          if (
            existingParkedId &&
            decision.messages.some(
              (m) => (m as { id?: unknown }).id === existingParkedId || m.source?.kind === 'asi-intuition',
            )
          ) {
            parkedNextStepMsgId.delete(sid);
            for (const fn of [...claimedListeners]) fn(sid);
          }
          const tailNote = await cb({
            sessionId: sid,
            ...(payload.agent.session?.header?.cwd ? { cwd: payload.agent.session.header.cwd } : {}),
            promptText,
          });
          if (!tailNote || payload.signal.aborted) return decision;

          const intuitionMsg = freezeMessage({
            id: MessageId(`asi-intuition-pre:${randomUUID()}`),
            role: 'user',
            source: { kind: 'asi-intuition' },
            content: [{ type: 'text', text: tailNote }],
          });
          return {
            ...decision,
            messages: [...decision.messages, intuitionMsg],
          };
        } catch {
          return decision;
        }
      });
    },

    onToolPreExecute(cb) {
      return ctx.on('tools/pre-execute', async (exec, next) => {
        if (
          exec.agent &&
          isOrdinaryAgent(exec.agent) &&
          exec.name !== 'intuition_status' &&
          exec.name !== 'prospective_remember' &&
          exec.name !== 'prospective_resolve'
        ) {
          const { targetText, cwd } = extractToolTargetText(exec);
          if (targetText || exec.name) {
            try {
              await cb({
                sessionId: String(exec.agent.id),
                ...(cwd ? { cwd } : {}),
                toolName: exec.name,
                targetText,
              });
            } catch {
              // Never obstruct user tool execution
            }
          }
        }
        return next();
      });
    },

    onToolResult(cb) {
      return ctx.on('tools/result', (exec, result) => {
        if (!exec.agent || !isOrdinaryAgent(exec.agent)) return undefined;
        if (
          exec.name === 'intuition_status' ||
          exec.name === 'prospective_remember' ||
          exec.name === 'prospective_resolve'
        ) {
          return undefined;
        }
        const { targetText, cwd } = extractToolTargetText(exec);
        const resObj = result as unknown as {
          isError?: boolean;
          failure?: { message?: string };
          value?: unknown;
        };
        const valObj =
          resObj.value !== null && typeof resObj.value === 'object' && !Array.isArray(resObj.value)
            ? (resObj.value as Record<string, unknown>)
            : {};
        const nonZeroBash = exec.name === 'bash' && typeof valObj.exitCode === 'number' && valObj.exitCode !== 0;
        const failed = Boolean(resObj.isError || resObj.failure || nonZeroBash);

        const errorSummary =
          resObj.failure?.message ?? (nonZeroBash ? `exit code ${String(valObj.exitCode)}` : undefined);

        try {
          cb({
            sessionId: String(exec.agent.id),
            ...(cwd ? { cwd } : {}),
            toolName: exec.name,
            targetText,
            failed,
            ...(errorSummary ? { errorSummary } : {}),
          });
        } catch {
          // Never throw from tools/result observer
        }
        return undefined;
      });
    },

    onJobFinished(cb) {
      return ctx.jobs.events.subscribe({ owners: 'all' }, (event) => {
        if (event.type !== 'settled') return;
        const job = event.job;
        cb({
          jobId: String(job.id),
          ...(job.owner ? { ownerSessionId: String(job.owner) } : {}),
          ...(job.label ? { label: job.label } : {}),
          status: job.status,
        });
      });
    },

    ...(options?.sleepRuntime
      ? {
          onSleepConsolidationCompleted(cb: () => void) {
            const sleepRt = options.sleepRuntime;
            if (!sleepRt) return () => {};
            let lastRecId = sleepRt.panelModel().recentConsolidations[0]?.id ?? '';
            return sleepRt.subscribe(() => {
              const curId = sleepRt.panelModel().recentConsolidations[0]?.id ?? '';
              if (curId && curId !== lastRecId) {
                lastRecId = curId;
                cb();
              }
            });
          },
        }
      : {}),
  };

  const getDrives = (): Context['asiDrives'] | undefined =>
    (ctx as Context & { asiDrives?: Context['asiDrives']; get(name: 'asiDrives'): Context['asiDrives'] | undefined })
      .asiDrives ?? (ctx as Context & { get(name: 'asiDrives'): Context['asiDrives'] | undefined }).get('asiDrives');

  const getSleep = (): Context['asiSleep'] | undefined =>
    (ctx as Context & { asiSleep?: Context['asiSleep']; get(name: 'asiSleep'): Context['asiSleep'] | undefined })
      .asiSleep ?? (ctx as Context & { get(name: 'asiSleep'): Context['asiSleep'] | undefined }).get('asiSleep');

  const drivesProxy: Context['asiDrives'] = {
    snapshot: () =>
      getDrives()?.snapshot() ?? {
        now: Date.now(),
        powerMode: 'normal',
        higherOrderSuppressed: false,
        activeTier: null,
        drives: [],
      },
    subscribe: (listener) => {
      const direct = getDrives();
      if (direct) return direct.subscribe(listener);
      const fiber = ctx.inject(['asiDrives'], (sub) => {
        const svc = (sub as Context & { asiDrives?: Context['asiDrives'] }).asiDrives;
        if (svc) {
          const off = svc.subscribe(listener);
          sub.effect(() => off, 'asi-intuition drives sub');
        }
      });
      return () => fiber.dispose();
    },
    registerSource: (reg) => {
      const direct = getDrives();
      if (direct) return direct.registerSource(reg);
      const fiber = ctx.inject(['asiDrives'], (sub) => {
        const svc = (sub as Context & { asiDrives?: Context['asiDrives'] }).asiDrives;
        if (svc) {
          const off = svc.registerSource(reg);
          sub.effect(() => off, 'asi-intuition drive source');
        }
      });
      return () => fiber.dispose();
    },
    notifySourceChanged: (sourceId) => {
      getDrives()?.notifySourceChanged(sourceId);
    },
  };

  const sleepProxy: Context['asiSleep'] = {
    listMemories: (queryOpts) => {
      const svc = getSleep();
      if (svc) return svc.listMemories(queryOpts);
      return options?.sleepRuntime?.listMemories(queryOpts) ?? [];
    },
    subscribe: (listener) => {
      if (options?.sleepRuntime?.subscribeVault) {
        return options.sleepRuntime.subscribeVault(listener);
      }
      const direct = getSleep();
      if (direct) return direct.subscribe(listener);
      const fiber = ctx.inject(['asiSleep'], (sub) => {
        const svc = (sub as Context & { asiSleep?: Context['asiSleep'] }).asiSleep;
        if (svc) {
          const off = svc.subscribe(listener);
          sub.effect(() => off, 'asi-intuition sleep sub');
        }
      });
      return () => fiber.dispose();
    },
  };

  const getTom = (): Pick<AsiTomServiceApi, 'shouldDeferProactiveWork' | 'subscribe'> | undefined =>
    options?.tom ??
    (ctx as Context & { asiTom?: AsiTomServiceApi; get?(name: 'asiTom'): AsiTomServiceApi | undefined }).asiTom ??
    (ctx as Context & { get?(name: 'asiTom'): AsiTomServiceApi | undefined }).get?.('asiTom');

  const tomProxy: IntuitionHostPorts['tom'] = {
    shouldDeferProactiveWork: () => Boolean(getTom()?.shouldDeferProactiveWork()),
    subscribe: (listener) => {
      const direct = getTom();
      if (direct?.subscribe) return direct.subscribe(listener);
      const fiber = ctx.inject(['asiTom'], (sub) => {
        const svc = (sub as Context & { asiTom?: AsiTomServiceApi }).asiTom;
        if (svc?.subscribe) {
          const off = svc.subscribe(listener);
          sub.effect(() => off, 'asi-intuition tom sub');
        }
      });
      return () => fiber.dispose();
    },
  };

  return {
    storageRoot,
    sense: ctx.asiSense,
    drives: drivesProxy,
    sleep: sleepProxy,
    tom: tomProxy,
    sessions,
    events,
  };
}
