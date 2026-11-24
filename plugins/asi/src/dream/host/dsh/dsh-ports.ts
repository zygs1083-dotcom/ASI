/**
 * DSH Host Ports for Default Mode Network Cross-Repo Insight (`asi-dream`).
 *
 * - Strictly excludes internal ASI storage/sandbox directories and subagent sessions.
 * - Hydrates cold persisted sessions via `ctx.sessionQuery` (bounded <= 24 sessions)
 *   so historical cross-repo `cwd` provenance and troubleshooting trajectories are available.
 * - Connects LLM streaming synthesis with automatic route fallback and `AbortSignal`.
 */

import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';
import type { AsiSleepServiceApi, AsiTomServiceApi } from '@asi/sense-types';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session';
import type { SessionQueryEngine } from '@deepseek-ai/dsh-session-query';
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace';
import {
  ASI_INTERNAL_CWD_RE,
  ASI_INTERNAL_SESSION_ID_RE,
  buildUnifiedExcludedInternalRoots,
} from '../../../shared/internal-guards.js';
import { extractRouteFromEvents } from '../../../sleep/host/dsh/dsh-ports.ts';
import type {
  DreamConversationPort,
  DreamHostPorts,
  DreamMemoryAdoptionBridge,
  DreamSkillDraftBridge,
  DreamTurnTrajectoryInput,
} from '../ports.ts';

const INTERNAL_CWD_RE = ASI_INTERNAL_CWD_RE;
const INTERNAL_SESSION_ID_RE = ASI_INTERNAL_SESSION_ID_RE;

function safeRealpath(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return resolve(target);
  }
}

function isSameOrInsideRoot(candidate: string, root: string | undefined): boolean {
  if (!root || !root.trim()) return false;
  const normCand = safeRealpath(candidate);
  const normRoot = safeRealpath(root);
  if (normCand === normRoot) return true;
  const rel = relative(normRoot, normCand);
  return Boolean(rel && !rel.startsWith('..') && !isAbsolute(rel));
}

export function buildExcludedDreamRoots(dreamStorageRoot: string, senseStorageRoot?: string): string[] {
  return buildUnifiedExcludedInternalRoots(dreamStorageRoot, senseStorageRoot);
}

export function isOrdinaryDreamSession(
  session: {
    id: unknown;
    header?: { cwd?: string; parentId?: unknown; isSeeded?: boolean; origin?: string; delegationDepth?: number };
  },
  excludedRoots: readonly (string | undefined)[] = [],
): boolean {
  const sid = String(session.id ?? '');
  if (!sid || INTERNAL_SESSION_ID_RE.test(sid)) return false;
  if (session.header?.origin === 'subagent') return false;
  if (typeof session.header?.delegationDepth === 'number' && session.header.delegationDepth > 0) return false;
  if (session.header?.parentId !== undefined && session.header?.parentId !== null) return false;
  if (session.header?.isSeeded) return false;
  const cwd = session.header?.cwd;
  if (cwd) {
    if (INTERNAL_CWD_RE.test(cwd)) return false;
    if (excludedRoots.some((r) => isSameOrInsideRoot(cwd, r))) return false;
  }
  return true;
}

export function extractDreamTurnsFromOwnEvents(
  sessionId: string,
  cwd: string | undefined,
  events: readonly SessionEvent[],
  isRunning: boolean,
  fallbackAt: number,
  sessionTitle?: string,
): DreamTurnTrajectoryInput[] {
  interface DraftTurn {
    turnNum: number;
    at: number;
    userTexts: string[];
    assistantTexts: string[];
    toolNames: string[];
    failedToolCount: number;
    ended: boolean;
  }

  const drafts: DraftTurn[] = [];
  let current: DraftTurn | undefined;

  for (const ev of events) {
    const raw = ev as {
      type?: string;
      time?: number;
      surfaceOp?: string;
      data?: Record<string, unknown>;
    };
    const evTime = typeof raw.time === 'number' && Number.isFinite(raw.time) ? raw.time : fallbackAt;

    if (raw.type === 'turn/start') {
      const turnNum = typeof raw.data?.turn === 'number' ? raw.data.turn : drafts.length + 1;
      current = {
        turnNum,
        at: evTime,
        userTexts: [],
        assistantTexts: [],
        toolNames: [],
        failedToolCount: 0,
        ended: false,
      };
      drafts.push(current);
      continue;
    }

    if (raw.type === 'user/message') {
      if (raw.surfaceOp !== 'append') continue;
      const msg = raw.data as {
        source?: { kind?: string; form?: string };
        content?: ReadonlyArray<{ type?: string; text?: string }>;
      };
      if (msg?.source?.kind !== 'user' || msg.source.form !== undefined) continue;
      const text = (msg.content ?? [])
        .filter((b) => b?.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text?.trim() ?? '')
        .filter(Boolean)
        .join('\n');
      if (!text) continue;
      if (!current || current.ended) {
        current = {
          turnNum: drafts.length + 1,
          at: evTime,
          userTexts: [],
          assistantTexts: [],
          toolNames: [],
          failedToolCount: 0,
          ended: false,
        };
        drafts.push(current);
      }
      current.userTexts.push(text);
      continue;
    }

    if (!current) continue;

    if (raw.type === 'assistant/message') {
      if (raw.surfaceOp !== 'append') continue;
      const message = (raw.data?.message ?? raw.data) as {
        content?: ReadonlyArray<{ type?: string; text?: string; name?: string }>;
      };
      for (const block of message?.content ?? []) {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          current.assistantTexts.push(block.text.trim());
        } else if (block?.type === 'tool-call' && typeof block.name === 'string') {
          current.toolNames.push(block.name);
        }
      }
      continue;
    }

    if (raw.type === 'tool/call') {
      const name = raw.data?.name;
      if (typeof name === 'string' && name.trim()) {
        current.toolNames.push(name.trim());
      }
      continue;
    }

    if (raw.type === 'tool/result') {
      const isError = Boolean(
        raw.data?.isError ||
          raw.data?.error ||
          (raw.data?.outcome &&
            typeof raw.data.outcome === 'object' &&
            (raw.data.outcome as { ok?: boolean }).ok === false),
      );
      if (isError) current.failedToolCount += 1;
      continue;
    }

    if (raw.type === 'turn/end') {
      current.ended = true;
    }
  }

  const completed = isRunning && drafts.length > 0 && !drafts[drafts.length - 1]?.ended ? drafts.slice(0, -1) : drafts;
  const out: DreamTurnTrajectoryInput[] = [];

  for (const d of completed) {
    const userText = d.userTexts.join('\n').trim();
    const assistantText = d.assistantTexts.join('\n').trim();
    if (!userText || !assistantText) continue;
    out.push({
      turnId: `${sessionId}:t${d.turnNum}`,
      sessionId,
      ...(sessionTitle ? { sessionTitle } : {}),
      ...(cwd ? { cwd } : {}),
      at: d.at,
      userText,
      assistantText,
      toolNames: [...new Set(d.toolNames)],
      failedToolCount: d.failedToolCount,
    });
  }
  return out;
}

const ROUTE_FALLBACK_CODES = new Set([
  'NO_ADAPTER',
  'MISSING_CREDENTIAL',
  'INVALID_CREDENTIAL',
  'AUTH',
  'INVALID_REQUEST',
  'UNSUPPORTED_REASONING_EFFORT',
  'INVALID_MODEL_INFO',
  'INVALID_MODEL_CONTEXT',
  'INVALID_MODEL_MAX_TOKENS',
  'INVALID_MODEL_REASONING',
  'REGISTRATION_DISPOSED',
]);

export function createDshDreamPorts(
  ctx: Context,
  storageRoot: string,
  options?: {
    homeDir?: string;
    memoryAdoption?: DreamMemoryAdoptionBridge;
    skillDrafts?: DreamSkillDraftBridge;
    tom?: Pick<AsiTomServiceApi, 'shouldDeferProactiveWork' | 'subscribe'>;
  },
): DreamHostPorts {
  const excludedRoots = buildExcludedDreamRoots(storageRoot, ctx.asiSense?.storageRoot);
  const coldSessionTurns = new Map<string, DreamTurnTrajectoryInput[]>();
  const coldSessionCwds = new Map<string, string>();
  const coldSessionRoutes = new Map<string, { provider: string; model: string; createdAt: number }>();
  const sessionTitles = new Map<string, string>();

  const getProfileHome = (): string | undefined => {
    const pc = (ctx as Context & { get(name: 'profileContext'): { home?: string } | undefined }).get('profileContext');
    return pc?.home?.trim() ? pc.home.trim() : undefined;
  };

  const getWorkspaceRegistry = (): WorkspaceRegistry | undefined =>
    (ctx as Context & { get(name: 'workspaceRegistry'): WorkspaceRegistry | undefined }).get('workspaceRegistry');

  const getSessionQuery = (): SessionQueryEngine | undefined =>
    (ctx as Context & { get(name: 'sessionQuery'): SessionQueryEngine | undefined }).get('sessionQuery');

  const getSessionProjections = () =>
    (
      ctx as Context & {
        get(
          name: 'sessionProjections',
        ):
          | { snapshot?: (s: Session, keys?: readonly string[]) => { values?: Record<string, unknown> } | undefined }
          | undefined;
      }
    ).get('sessionProjections');

  const getSleepService = (): AsiSleepServiceApi | undefined =>
    (ctx as Context & { get(name: 'asiSleep'): AsiSleepServiceApi | undefined }).get('asiSleep');

  const isInternalPath = (candidate: string | undefined): boolean => {
    if (!candidate || !candidate.trim()) return true;
    if (INTERNAL_CWD_RE.test(candidate)) return true;
    return excludedRoots.some((r) => isSameOrInsideRoot(candidate, r));
  };

  const isArchived = (sessionId: string): boolean => {
    const wr = getWorkspaceRegistry();
    return Boolean(wr?.archivedSessionIds.some((id) => String(id) === sessionId));
  };

  const isOrdinaryAgent = (agent: Agent): boolean => {
    const sid = String(agent?.id ?? '');
    if (!sid || INTERNAL_SESSION_ID_RE.test(sid) || isArchived(sid)) return false;
    if (!agent?.session) return true;
    return isOrdinaryDreamSession(agent.session, excludedRoots);
  };

  const conversations: DreamConversationPort = {
    listCompletedOrdinaryTurns(): DreamTurnTrajectoryInput[] {
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
        if (!sessionsMap.has(sid) && !isArchived(sid) && isOrdinaryDreamSession(session, excludedRoots)) {
          sessionsMap.set(sid, session);
        }
      }

      const out: DreamTurnTrajectoryInput[] = [];
      for (const [sid, session] of sessionsMap) {
        coldSessionTurns.delete(sid);
        if (typeof session.ownEvents === 'function') {
          try {
            out.push(
              ...extractDreamTurnsFromOwnEvents(
                sid,
                session.header?.cwd,
                session.ownEvents(),
                runningIds.has(sid),
                now,
                sessionTitles.get(sid),
              ),
            );
          } catch {
            // Isolate mock session event error
          }
        }
      }
      for (const [sid, cold] of coldSessionTurns) {
        if (isArchived(sid)) {
          coldSessionTurns.delete(sid);
          continue;
        }
        out.push(...cold);
      }
      return out;
    },

    anyOrdinarySessionRunning(): boolean {
      for (const agent of ctx.agents?.list() ?? []) {
        if (isOrdinaryAgent(agent) && agent.status === 'running') return true;
      }
      return false;
    },

    listKnownWorkspaces(): string[] {
      const found = new Set<string>();
      const wr = getWorkspaceRegistry();
      for (const ws of wr?.list() ?? []) {
        if (typeof ws.path === 'string' && ws.path.trim() && !isInternalPath(ws.path)) {
          found.add(ws.path.trim());
        }
      }
      for (const s of ctx.sessions?.list() ?? []) {
        const cwd = s.header?.cwd;
        if (cwd && !isArchived(String(s.id)) && isOrdinaryDreamSession(s, excludedRoots) && !isInternalPath(cwd)) {
          found.add(cwd);
        }
      }
      for (const a of ctx.agents?.list() ?? []) {
        const cwd = a.session?.header?.cwd;
        if (cwd && isOrdinaryAgent(a) && !isInternalPath(cwd)) {
          found.add(cwd);
        }
      }
      for (const [sid, cwd] of coldSessionCwds) {
        if (!isArchived(sid) && !isInternalPath(cwd)) {
          found.add(cwd);
        }
      }
      return [...found];
    },

    listSessionWorkspaces(): ReadonlyMap<string, string> {
      const map = new Map<string, string>();
      for (const [sid, cwd] of coldSessionCwds) {
        if (!isArchived(sid) && !isInternalPath(cwd)) {
          map.set(sid, cwd);
        }
      }
      for (const s of ctx.sessions?.list() ?? []) {
        const sid = String(s.id);
        const cwd = s.header?.cwd;
        if (cwd && !isArchived(sid) && isOrdinaryDreamSession(s, excludedRoots) && !isInternalPath(cwd)) {
          map.set(sid, cwd);
        }
      }
      for (const a of ctx.agents?.list() ?? []) {
        const sid = String(a.id);
        const cwd = a.session?.header?.cwd;
        if (cwd && isOrdinaryAgent(a) && !isInternalPath(cwd)) {
          map.set(sid, cwd);
        }
      }
      return map;
    },

    onOrdinaryActivity(listener: () => void): () => void {
      const offSessionEvent = ctx.on(
        'session/event',
        (session, event) => {
          if (!isOrdinaryDreamSession(session, excludedRoots) || isArchived(String(session.id))) return;
          if (event.type === 'user/message') {
            if (event.surfaceOp !== 'append') return;
            const src = (event.data as { source?: { kind?: string; form?: string } })?.source;
            if (src?.kind === 'user' && src.form === undefined) listener();
            return;
          }
          if (event.type === 'assistant/message') {
            if (event.surfaceOp !== 'append') return;
            listener();
            return;
          }
          if (event.type === 'turn/start' || event.type === 'turn/end') {
            listener();
          }
        },
        { global: true },
      );

      const offAgentStatus = ctx.on('agent/status', ({ agent }) => {
        if (isOrdinaryAgent(agent)) listener();
      });

      return () => {
        offSessionEvent();
        offAgentStatus();
      };
    },

    async warmColdSessions(signal: AbortSignal): Promise<void> {
      const sq = getSessionQuery();
      if (!sq || typeof sq.listSessions !== 'function' || typeof sq.readSession !== 'function') return;
      const records = await sq.listSessions(signal);
      if (signal.aborted) return;

      const liveIds = new Set<string>([
        ...(ctx.agents?.list() ?? []).map((a) => String(a.id)),
        ...(ctx.sessions?.list() ?? []).map((s) => String(s.id)),
      ]);

      let inspected = 0;
      for (const rec of records) {
        if (signal.aborted) break;
        const sid = String(rec.header.id);
        if (isArchived(sid)) continue;
        if (!isOrdinaryDreamSession({ id: rec.header.id, header: rec.header }, excludedRoots)) continue;
        if (rec.header.cwd && !isInternalPath(rec.header.cwd)) {
          coldSessionCwds.set(sid, rec.header.cwd);
        }
        if (rec.live || liveIds.has(sid) || inspected >= 24) continue;
        inspected += 1;
        try {
          if (typeof sq.readTitle === 'function') {
            const t = await sq.readTitle(rec.header.id as SessionId, signal).catch(() => undefined);
            if (t && typeof t.title === 'string' && t.title.trim()) {
              sessionTitles.set(sid, t.title.trim());
            }
          }
          const logSnap = await sq.readSession(rec.header.id as SessionId);
          if (signal.aborted) return;
          const route = extractRouteFromEvents(logSnap.events);
          if (route) {
            coldSessionRoutes.set(sid, { ...route, createdAt: logSnap.session.createdAt || 0 });
          }
          if (logSnap.session.cwd && !isInternalPath(logSnap.session.cwd)) {
            coldSessionCwds.set(sid, logSnap.session.cwd);
          }
          if (ctx.sessions?.get?.(rec.header.id as SessionId)) continue;
          const inherited = Math.max(0, Number(logSnap.inheritedEventCount ?? 0));
          const extracted = extractDreamTurnsFromOwnEvents(
            sid,
            logSnap.session.cwd,
            logSnap.events.slice(inherited),
            false,
            logSnap.session.createdAt || Date.now(),
            sessionTitles.get(sid),
          );
          if (extracted.length > 0) {
            coldSessionTurns.set(sid, extracted);
          }
        } catch {
          // Ignore unreadable cold session
        }
      }
    },
  };

  const llmDream = async (prompt: string, signal: AbortSignal): Promise<string | undefined> => {
    if (!ctx.llm || typeof ctx.llm.stream !== 'function' || signal.aborted) return undefined;

    const candidates: Array<{ provider: string; model: string }> = [];
    const seen = new Set<string>();
    const addRoute = (cand: { provider?: unknown; model?: unknown } | undefined) => {
      const p = typeof cand?.provider === 'string' ? cand.provider.trim() : '';
      const m = typeof cand?.model === 'string' ? cand.model.trim() : '';
      if (!p || !m) return;
      const k = `${p}\0${m}`;
      if (seen.has(k)) return;
      seen.add(k);
      candidates.push({ provider: p, model: m });
    };

    for (const agent of ctx.agents?.list() ?? []) {
      if (isOrdinaryAgent(agent)) addRoute(agent.model?.current?.());
    }

    const sp = getSessionProjections();
    for (const session of ctx.sessions?.list() ?? []) {
      if (!isOrdinaryDreamSession(session, excludedRoots) || isArchived(String(session.id))) continue;
      if (sp?.snapshot) {
        try {
          const ms = sp.snapshot(session, ['modelSelection'])?.values?.modelSelection as
            | { next?: { provider?: unknown; model?: unknown }; lastUsed?: { provider?: unknown; model?: unknown } }
            | undefined;
          addRoute(ms?.next ?? ms?.lastUsed);
        } catch {
          // Ignore projection error
        }
      }
      try {
        const events =
          typeof session.snapshotEvents === 'function'
            ? session.snapshotEvents()
            : typeof session.ownEvents === 'function'
              ? session.ownEvents()
              : [];
        addRoute(extractRouteFromEvents(events));
      } catch {
        // Ignore session event error
      }
    }

    for (const [, info] of [...coldSessionRoutes.entries()].sort((a, b) => b[1].createdAt - a[1].createdAt)) {
      addRoute(info);
    }

    if (
      candidates.length === 0 &&
      typeof ctx.llm.listProviders === 'function' &&
      typeof ctx.llm.listModels === 'function'
    ) {
      for (const prov of ctx.llm.listProviders() ?? []) {
        if (signal.aborted) return undefined;
        const pid = typeof prov?.id === 'string' ? prov.id.trim() : '';
        if (!pid) continue;
        const models = await ctx.llm.listModels(pid).catch(() => []);
        const firstModel = models?.find((m) => typeof m?.id === 'string' && m.id.trim());
        if (firstModel) {
          addRoute({ provider: pid, model: firstModel.id });
          break;
        }
      }
    }

    for (const route of candidates) {
      if (signal.aborted) return undefined;
      try {
        let text = '';
        const deltaIndices = new Set<number>();
        const stream = ctx.llm.stream({
          provider: route.provider,
          model: route.model,
          system:
            'You synthesize concise cross-repository engineering insights in JSON and never output secrets, credentials, or executable scripts.',
          messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
          signal,
        });
        let routeFailed = false;
        for await (const chunk of stream) {
          if (signal.aborted) return undefined;
          if (chunk.type === 'text-delta') {
            deltaIndices.add(chunk.index);
            text += chunk.text;
          } else if (chunk.type === 'block-end' && chunk.block?.type === 'text' && !deltaIndices.has(chunk.index)) {
            text += chunk.block.text;
          } else if (chunk.type === 'finish') {
            if (chunk.reason.kind === 'aborted') return undefined;
            if (chunk.reason.kind === 'error') {
              const code = (chunk.reason as { failure?: { code?: unknown } }).failure?.code;
              if (typeof code === 'string' && ROUTE_FALLBACK_CODES.has(code)) {
                routeFailed = true;
                break;
              }
              return undefined;
            }
          }
        }
        if (routeFailed) continue;
        return text.trim() || undefined;
      } catch (err) {
        const code = (err as { code?: unknown } | undefined)?.code;
        if (typeof code === 'string' && ROUTE_FALLBACK_CODES.has(code)) continue;
        return undefined;
      }
    }
    return undefined;
  };

  const getTom = (): Pick<AsiTomServiceApi, 'shouldDeferProactiveWork' | 'subscribe'> | undefined =>
    options?.tom ??
    (ctx as Context & { asiTom?: AsiTomServiceApi; get?(name: 'asiTom'): AsiTomServiceApi | undefined }).asiTom ??
    (ctx as Context & { get?(name: 'asiTom'): AsiTomServiceApi | undefined }).get?.('asiTom');

  const tomProxy: DreamHostPorts['tom'] = {
    shouldDeferProactiveWork: () => Boolean(getTom()?.shouldDeferProactiveWork()),
    subscribe: (listener) => {
      const direct = getTom();
      if (direct?.subscribe) return direct.subscribe(listener);
      const fiber = ctx.inject(['asiTom'], (sub) => {
        const svc = (sub as Context & { asiTom?: AsiTomServiceApi }).asiTom;
        if (svc?.subscribe) {
          const off = svc.subscribe(listener);
          sub.effect(() => off, 'asi-dream tom subscription');
        }
      });
      return () => fiber.dispose();
    },
  };

  return {
    storageRoot,
    homeDir: options?.homeDir ?? getProfileHome() ?? homedir(),
    excludedInternalRoots: excludedRoots,
    sense: ctx.asiSense,
    drives: ctx.asiDrives,
    getSleep: getSleepService,
    onSleepChanged: (listener: () => void) => {
      let offDirect: (() => void) | undefined;
      const existing = getSleepService();
      if (existing && typeof existing.subscribe === 'function') {
        offDirect = existing.subscribe(listener);
      }
      const injectFiber = ctx.inject(['asiSleep'], (sub) => {
        const svc = (sub as Context & { asiSleep?: AsiSleepServiceApi }).asiSleep;
        if (svc && typeof svc.subscribe === 'function') {
          offDirect?.();
          offDirect = undefined;
          const offSub = svc.subscribe(listener);
          listener();
          sub.effect(() => offSub, 'asi-dream sleep subscription');
        }
      });
      return () => {
        offDirect?.();
        offDirect = undefined;
        injectFiber.dispose();
      };
    },
    tom: tomProxy,
    conversations,
    ...(options?.memoryAdoption ? { memoryAdoption: options.memoryAdoption } : {}),
    ...(options?.skillDrafts ? { skillDrafts: options.skillDrafts } : {}),
    llmDream,
  };
}
