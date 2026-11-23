import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-llm';
import type { Session } from '@deepseek-ai/dsh-session';
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace';
import type { ConversationTurnInput } from '../consolidator.js';
import type { SleepConversationPort, SleepHostPorts } from '../ports.js';

const INTERNAL_SESSION_ID_RE = /^asi-(?:maint|sleep|care|sense|internal)(?:[-_:]|$)/i;
const INTERNAL_CWD_RE =
  /(?:^|[\\/])(?:asi-(?:needs|sleep|care|sense)[\\/]sandbox|data[\\/]asi-(?:needs|sleep|care|sense))(?:[\\/]|$)/i;

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function isInsideRoot(candidate: string | undefined, root: string | undefined): boolean {
  if (!candidate || !root) return false;
  if (candidate === root || candidate.startsWith(`${root}/`)) return true;
  const rc = safeRealpath(candidate);
  const rr = safeRealpath(root);
  return rc === rr || rc.startsWith(`${rr}/`);
}

export function isOrdinaryDshSession(
  session: Pick<Session, 'id'> & { header?: Partial<Session['header']> },
  excludedRoots: readonly (string | undefined)[],
): boolean {
  const id = String(session.id ?? '');
  if (!id || INTERNAL_SESSION_ID_RE.test(id)) return false;
  const header = session.header;
  if (header?.origin === 'subagent') return false;
  if (typeof header?.delegationDepth === 'number' && header.delegationDepth > 0) return false;
  const cwd = header?.cwd;
  if (cwd) {
    if (INTERNAL_CWD_RE.test(cwd)) return false;
    for (const root of excludedRoots) {
      if (isInsideRoot(cwd, root)) return false;
    }
  }
  return true;
}

export function createDshSleepPorts(ctx: Context, storageRoot: string, options?: { homeDir?: string }): SleepHostPorts {
  const excludedRoots = [storageRoot, ctx.asiSense?.storageRoot];
  const turnFirstSeenAt = new Map<string, number>();

  const getWorkspaceRegistry = (): WorkspaceRegistry | undefined =>
    (ctx as Context & { get(name: 'workspaceRegistry'): WorkspaceRegistry | undefined }).get('workspaceRegistry');

  const isArchived = (sessionId: string): boolean => {
    const wr = getWorkspaceRegistry();
    return Boolean(wr?.archivedSessionIds.some((id) => String(id) === sessionId));
  };

  const isOrdinaryAgent = (agent: Agent): boolean => {
    if (!agent?.session) return !INTERNAL_SESSION_ID_RE.test(String(agent?.id ?? ''));
    if (isArchived(String(agent.id))) return false;
    return isOrdinaryDshSession(agent.session, excludedRoots);
  };

  const extractSessionTurns = (session: Session, isRunning: boolean, now: number): ConversationTurnInput[] => {
    if (!isOrdinaryDshSession(session, excludedRoots)) return [];
    if (typeof session.deriveMessages !== 'function') return [];

    let messages: ReturnType<Session['deriveMessages']>;
    try {
      messages = session.deriveMessages();
    } catch {
      return [];
    }

    interface DraftTurn {
      turnId: string;
      userText: string;
      assistantTexts: string[];
      toolNames: string[];
    }

    const drafts: DraftTurn[] = [];
    let current: DraftTurn | undefined;

    for (const msg of messages) {
      if (msg.role === 'user') {
        const src = msg.source as { kind?: string; form?: string } | undefined;
        if (src?.kind !== 'user' || src.form !== undefined) continue;
        const textParts: string[] = [];
        for (const block of msg.content ?? []) {
          if (block.type === 'text' && block.text.trim()) {
            textParts.push(block.text.trim());
          }
        }
        const userText = textParts.join('\n').trim();
        if (!userText) continue;
        current = {
          turnId: String(msg.id),
          userText,
          assistantTexts: [],
          toolNames: [],
        };
        drafts.push(current);
      } else if (msg.role === 'assistant' && current) {
        for (const block of msg.content ?? []) {
          if (block.type === 'text' && block.text.trim()) {
            current.assistantTexts.push(block.text.trim());
          } else if (block.type === 'tool-call' && typeof block.name === 'string') {
            current.toolNames.push(block.name);
          }
        }
      }
    }

    const completedDrafts = isRunning && drafts.length > 0 ? drafts.slice(0, -1) : drafts;
    const out: ConversationTurnInput[] = [];
    const sid = String(session.id);
    const cwd = session.header?.cwd;

    for (const d of completedDrafts) {
      const assistantText = d.assistantTexts.join('\n').trim();
      if (!assistantText) continue;
      const key = `${sid}::${d.turnId}`;
      let seenAt = turnFirstSeenAt.get(key);
      if (seenAt === undefined) {
        seenAt = now;
        turnFirstSeenAt.set(key, seenAt);
        if (turnFirstSeenAt.size > 4_000) {
          const oldest = turnFirstSeenAt.keys().next().value;
          if (oldest) turnFirstSeenAt.delete(oldest);
        }
      }
      out.push({
        turnId: d.turnId,
        sessionId: sid,
        ...(cwd ? { cwd } : {}),
        at: seenAt,
        userText: d.userText,
        assistantText,
        ...(d.toolNames.length > 0 ? { toolNames: d.toolNames } : {}),
      });
    }

    return out;
  };

  const conversations: SleepConversationPort = {
    listCompletedOrdinaryTurns(): ConversationTurnInput[] {
      const now = Date.now();
      const runningIds = new Set<string>();
      const sessionsMap = new Map<string, Session>();

      for (const agent of ctx.agents?.list() ?? []) {
        if (!isOrdinaryAgent(agent)) continue;
        if (agent.status === 'running') runningIds.add(String(agent.id));
        if (agent.session) sessionsMap.set(String(agent.id), agent.session);
      }
      for (const session of ctx.sessions?.list() ?? []) {
        const sid = String(session.id);
        if (!sessionsMap.has(sid) && !isArchived(sid) && isOrdinaryDshSession(session, excludedRoots)) {
          sessionsMap.set(sid, session);
        }
      }

      const allTurns: ConversationTurnInput[] = [];
      for (const [sid, session] of sessionsMap) {
        allTurns.push(...extractSessionTurns(session, runningIds.has(sid), now));
      }
      return allTurns;
    },

    anyOrdinarySessionRunning(): boolean {
      for (const agent of ctx.agents?.list() ?? []) {
        if (isOrdinaryAgent(agent) && agent.status === 'running') return true;
      }
      return false;
    },

    onOrdinaryActivity(listener: () => void): () => void {
      const offSessionEvent = ctx.on(
        'session/event',
        (session, event) => {
          if (!isOrdinaryDshSession(session, excludedRoots) || isArchived(String(session.id))) return;
          if (event.type === 'user/message') {
            const src = (event.data as { source?: { kind?: string; form?: string } })?.source;
            if (src?.kind === 'user' && src.form === undefined) listener();
            return;
          }
          if (event.type === 'assistant/message' || event.type === 'turn/start' || event.type === 'turn/end') {
            listener();
          }
        },
        { global: true },
      );

      const offAgentStatus = ctx.on('agent/status', ({ agent }) => {
        if (isOrdinaryAgent(agent)) {
          listener();
        }
      });

      return () => {
        offSessionEvent();
        offAgentStatus();
      };
    },
  };

  const llmExtract = async (prompt: string, signal: AbortSignal): Promise<string | undefined> => {
    if (!ctx.llm || typeof ctx.llm.stream !== 'function') return undefined;
    let route: { provider: string; model: string } | undefined;
    for (const agent of ctx.agents?.list() ?? []) {
      if (!isOrdinaryAgent(agent)) continue;
      const sel = agent.model?.current?.();
      if (sel?.provider && sel?.model) {
        route = { provider: sel.provider, model: sel.model };
        break;
      }
    }
    if (!route) return undefined;

    const runStream = async (): Promise<string | undefined> => {
      let text = '';
      const stream = ctx.llm.stream({
        provider: route.provider,
        model: route.model,
        system: 'You extract concise structured JSON memories and never output secrets.',
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        temperature: 0.1,
        maxTokens: 1_200,
        signal,
      });
      for await (const chunk of stream) {
        if (signal.aborted) break;
        if (chunk.type === 'text-delta') {
          text += chunk.text;
        } else if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) {
          return undefined;
        }
      }
      return text.trim() || undefined;
    };

    if (typeof ctx.agents?.withoutInitiator === 'function') {
      return ctx.agents.withoutInitiator(runStream);
    }
    return runStream();
  };

  return {
    storageRoot,
    homeDir: options?.homeDir ?? homedir(),
    sense: ctx.asiSense,
    drives: ctx.asiDrives,
    conversations,
    llmExtract,
  };
}
