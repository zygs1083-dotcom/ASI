import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import type { AsiSleepServiceApi } from '@asi/sense-types';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-llm';
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session';
import type { SessionQueryEngine } from '@deepseek-ai/dsh-session-query';
import type { SkillCandidate, SkillDefinition, SkillLookupOptions, SkillProvider } from '@deepseek-ai/dsh-skill';
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace';
import { isValidSkillName } from '../../shared/skill-spec.js';
import type { OrdinaryTurnTrajectoryInput } from '../evidence.js';
import type { GrowthConversationPort, GrowthHostPorts, SkillTurnLifecycleEvent } from '../ports.js';
import type { GrowthSkillCatalogBridge } from '../runtime.js';

export const INTERNAL_SESSION_ID_RE = /^asi-(?:maint|sleep|care|sense|growth|internal)(?:[-_:]|$)/i;
const INTERNAL_CWD_RE =
  /(?:^|[\\/])(?:(?:asi[-_])?(?:needs|sleep|care|sense|growth)[\\/](?:sandbox|vault|skills)|data[\\/]asi(?:-(?:needs|sleep|care|sense|growth))?)(?:[\\/]|$)/i;

const WORKSPACE_SKILL_RANK = 200;
const GLOBAL_SKILL_RANK = 400;

function safeRealpath(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return resolve(target);
  }
}

function isSameOrInsideRoot(candidate: string | undefined, root: string | undefined): boolean {
  if (!candidate || !root) return false;
  const normCand = resolve(candidate);
  const normRoot = resolve(root);
  const prefix = normRoot.endsWith(sep) ? normRoot : `${normRoot}${sep}`;
  if (normCand === normRoot || normCand.startsWith(prefix)) return true;

  const rc = safeRealpath(normCand);
  const rr = safeRealpath(normRoot);
  const rPrefix = rr.endsWith(sep) ? rr : `${rr}${sep}`;
  return rc === rr || rc.startsWith(rPrefix);
}

export function buildExcludedInternalRoots(storageRoot: string, senseStorageRoot?: string): string[] {
  const roots = new Set<string>([storageRoot]);
  const shortSiblingNames = new Set(['sense', 'needs', 'sleep', 'care', 'growth']);
  for (const anchor of [storageRoot, senseStorageRoot]) {
    if (!anchor) continue;
    roots.add(anchor);
    const parent = dirname(anchor);
    const anchorBase = basename(anchor).toLowerCase();
    if (parent && parent !== '/' && parent !== '.') {
      roots.add(join(parent, 'asi-sense'));
      roots.add(join(parent, 'asi-needs'));
      roots.add(join(parent, 'asi-sleep'));
      roots.add(join(parent, 'asi-care'));
      roots.add(join(parent, 'asi-growth'));
      roots.add(join(parent, 'needs', 'sandbox'));
      roots.add(join(parent, 'sleep', 'vault'));
      roots.add(join(parent, 'sleep', 'memories'));
      roots.add(join(parent, 'care', 'sandbox'));
      roots.add(join(parent, 'growth', 'skills'));
      roots.add(join(parent, 'growth', 'sandbox'));
      if (shortSiblingNames.has(anchorBase)) {
        for (const sib of shortSiblingNames) {
          roots.add(join(parent, sib));
        }
        if (basename(parent).toLowerCase() === 'asi') {
          roots.add(parent);
          const grandParent = dirname(parent);
          if (grandParent && grandParent !== '/' && grandParent !== '.' && grandParent !== parent) {
            roots.add(join(grandParent, 'asi-sense'));
            roots.add(join(grandParent, 'asi-needs'));
            roots.add(join(grandParent, 'asi-sleep'));
            roots.add(join(grandParent, 'asi-care'));
            roots.add(join(grandParent, 'asi-growth'));
          }
        }
      }
    }
  }
  return [...roots];
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
      if (isSameOrInsideRoot(cwd, root)) return false;
    }
  }
  return true;
}

export function extractTrajectoryTurnsFromOwnEvents(
  sessionId: string,
  cwd: string | undefined,
  events: readonly SessionEvent[],
  isRunning: boolean,
  fallbackNow: number,
  sessionTitle?: string,
): OrdinaryTurnTrajectoryInput[] {
  interface DraftTurn {
    turnId: string;
    seq: number;
    at: number;
    turnNumber?: number;
    closedStatus?: 'completed' | 'failed' | 'open';
    stepCount: number;
    hadToolError: boolean;
    userText: string;
    assistantTexts: string[];
    toolNames: string[];
  }

  const drafts: DraftTurn[] = [];
  let current: DraftTurn | undefined;
  let activeTurnNumber: number | undefined;
  let sawTurnLifecycle = false;

  for (const event of events) {
    if (event.type === 'turn/start') {
      sawTurnLifecycle = true;
      activeTurnNumber = event.data.turn;
      if (
        current &&
        current.turnNumber === undefined &&
        current.assistantTexts.length === 0 &&
        current.toolNames.length === 0
      ) {
        current.turnNumber = event.data.turn;
        current.closedStatus = 'open';
        current.stepCount = Math.max(current.stepCount, 1);
      }
      continue;
    }

    if (event.type === 'step/start') {
      if (current) current.stepCount += 1;
      continue;
    }

    if (event.type === 'user/message') {
      if (event.surfaceOp !== 'append') continue;
      const src = event.data.source as { kind?: string; form?: string } | undefined;
      if (src?.kind !== 'user' || src.form !== undefined) continue;
      const textParts: string[] = [];
      for (const block of event.data.content ?? []) {
        if (block.type === 'text' && block.text.trim()) {
          textParts.push(block.text.trim());
        }
      }
      const userText = textParts.join('\n').trim();
      if (!userText) continue;
      const eventTime =
        typeof event.time === 'number' && Number.isFinite(event.time) && event.time > 0 ? event.time : fallbackNow;
      current = {
        turnId: String(event.data.id),
        seq: Number(event.seq),
        at: eventTime,
        ...(activeTurnNumber !== undefined ? { turnNumber: activeTurnNumber, closedStatus: 'open' } : {}),
        stepCount: activeTurnNumber !== undefined ? 1 : 0,
        hadToolError: false,
        userText,
        assistantTexts: [],
        toolNames: [],
      };
      drafts.push(current);
      continue;
    }

    if (event.type === 'assistant/message' && current) {
      if (event.surfaceOp !== 'append' || event.data.interrupted) continue;
      current.seq = Math.max(current.seq, Number(event.seq));
      for (const block of event.data.message.content ?? []) {
        if (block.type === 'text' && block.text.trim()) {
          current.assistantTexts.push(block.text.trim());
        } else if (block.type === 'tool-call' && typeof block.name === 'string') {
          current.toolNames.push(block.name);
        }
      }
      continue;
    }

    if (event.type === 'tool/call' && current) {
      current.seq = Math.max(current.seq, Number(event.seq));
      if (typeof event.data.name === 'string') {
        current.toolNames.push(event.data.name);
      }
      continue;
    }

    if (event.type === 'tool/result' && current) {
      const resData = event.data as { isError?: boolean; status?: string } | undefined;
      if (resData?.isError === true || resData?.status === 'error') {
        current.hadToolError = true;
      }
      continue;
    }

    if (event.type === 'turn/end') {
      sawTurnLifecycle = true;
      const reasonKind = event.data.reason?.kind;
      if (current && (current.turnNumber === undefined || current.turnNumber === event.data.turn)) {
        current.seq = Math.max(current.seq, Number(event.seq));
        current.closedStatus = reasonKind === 'completed' || reasonKind === 'max-tokens' ? 'completed' : 'failed';
      }
      activeTurnNumber = undefined;
    }
  }

  const completedDrafts = sawTurnLifecycle
    ? drafts.filter((d, idx) => {
        if (isRunning && idx === drafts.length - 1 && d.closedStatus !== 'completed') return false;
        if (d.closedStatus === 'open' || d.closedStatus === 'failed') return false;
        return true;
      })
    : isRunning && drafts.length > 0
      ? drafts.slice(0, -1)
      : drafts;

  const out: OrdinaryTurnTrajectoryInput[] = [];
  for (const d of completedDrafts) {
    const assistantText = d.assistantTexts.join('\n').trim();
    if (!assistantText) continue;
    out.push({
      turnId: d.turnId,
      sessionId,
      seq: d.seq,
      ...(sessionTitle ? { sessionTitle } : {}),
      ...(cwd ? { cwd } : {}),
      at: d.at,
      stepCount: Math.max(d.stepCount, d.toolNames.length),
      toolNames: d.toolNames,
      ...(d.hadToolError ? { hadToolError: true } : {}),
      userText: d.userText,
      assistantText,
    });
  }
  return out;
}

function extractRouteFromEvents(events: readonly SessionEvent[]): { provider: string; model: string } | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const raw = events[i] as { type?: string; data?: unknown } | undefined;
    if (!raw || typeof raw.type !== 'string') continue;
    if (raw.type === 'model/selection') {
      const sel = raw.data as { provider?: unknown; model?: unknown } | undefined;
      if (
        typeof sel?.provider === 'string' &&
        sel.provider.trim() &&
        typeof sel?.model === 'string' &&
        sel.model.trim()
      ) {
        return { provider: sel.provider.trim(), model: sel.model.trim() };
      }
    } else if (raw.type === 'request/header') {
      const cfg = (raw.data as { header?: { config?: { provider?: unknown; model?: unknown } } } | undefined)?.header
        ?.config;
      if (
        typeof cfg?.provider === 'string' &&
        cfg.provider.trim() &&
        typeof cfg?.model === 'string' &&
        cfg.model.trim()
      ) {
        return { provider: cfg.provider.trim(), model: cfg.model.trim() };
      }
    } else if (raw.type === 'request/context') {
      const rc = raw.data as { provider?: unknown; model?: unknown } | undefined;
      if (typeof rc?.provider === 'string' && rc.provider.trim() && typeof rc?.model === 'string' && rc.model.trim()) {
        return { provider: rc.provider.trim(), model: rc.model.trim() };
      }
    }
  }
  return undefined;
}

export function createDshGrowthPorts(
  ctx: Context,
  storageRoot: string,
  options?: { homeDir?: string },
): GrowthHostPorts {
  const excludedRoots = buildExcludedInternalRoots(storageRoot, ctx.asiSense?.storageRoot);
  const coldSessionTurns = new Map<string, OrdinaryTurnTrajectoryInput[]>();
  const coldSessionCwds = new Map<string, string>();
  const coldSessionRoutes = new Map<string, { provider: string; model: string; createdAt: number }>();
  const sessionTitles = new Map<string, string>();
  const activeTurnSkillsBySession = new Map<string, Set<string>>();

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
    if (!agent?.session) return !INTERNAL_SESSION_ID_RE.test(String(agent?.id ?? ''));
    if (isArchived(String(agent.id))) return false;
    return isOrdinaryDshSession(agent.session, excludedRoots);
  };

  const conversations: GrowthConversationPort = {
    listCompletedOrdinaryTurns(): OrdinaryTurnTrajectoryInput[] {
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

      const out: OrdinaryTurnTrajectoryInput[] = [];
      for (const [sid, session] of sessionsMap) {
        coldSessionTurns.delete(sid);
        if (typeof session.ownEvents === 'function') {
          try {
            out.push(
              ...extractTrajectoryTurnsFromOwnEvents(
                sid,
                session.header?.cwd,
                session.ownEvents(),
                runningIds.has(sid),
                now,
                sessionTitles.get(sid),
              ),
            );
          } catch {
            // Ignore mock session event errors
          }
        }
      }
      for (const [sid, coldTurns] of coldSessionTurns) {
        if (isArchived(sid)) {
          coldSessionTurns.delete(sid);
          continue;
        }
        out.push(...coldTurns);
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
        if (cwd && !isArchived(String(s.id)) && isOrdinaryDshSession(s, excludedRoots) && !isInternalPath(cwd)) {
          found.add(cwd);
        }
      }
      for (const a of ctx.agents?.list() ?? []) {
        const cwd = a.session?.header?.cwd;
        if (cwd && isOrdinaryAgent(a) && !isInternalPath(cwd)) {
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
        if (cwd && !isArchived(sid) && isOrdinaryDshSession(s, excludedRoots) && !isInternalPath(cwd)) {
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
          if (!isOrdinaryDshSession(session, excludedRoots) || isArchived(String(session.id))) return;
          if (event.type === 'user/message') {
            if (event.surfaceOp !== 'append') return;
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

    onSkillTurnCompleted(listener: (ev: SkillTurnLifecycleEvent) => void): () => void {
      const off = ctx.on(
        'session/event',
        (session, event) => {
          const sid = String(session.id);
          if (!isOrdinaryDshSession(session, excludedRoots) || isArchived(sid)) return;

          if (event.type === 'agent/inbox/spliced') {
            const spliceData = event.data as {
              outcome?: unknown;
              inserted?: ReadonlyArray<{ source?: { kind?: unknown; name?: unknown } }>;
            };
            if (spliceData?.outcome === 'canceled' && (!spliceData.inserted || spliceData.inserted.length === 0)) {
              activeTurnSkillsBySession.delete(sid);
              return;
            }
            for (const msg of spliceData?.inserted ?? []) {
              if (
                msg?.source?.kind === 'skill-invocation' &&
                typeof msg.source.name === 'string' &&
                isValidSkillName(msg.source.name)
              ) {
                let set = activeTurnSkillsBySession.get(sid);
                if (!set) {
                  set = new Set<string>();
                  activeTurnSkillsBySession.set(sid, set);
                }
                set.add(msg.source.name);
              }
            }
            return;
          }

          if (event.type === 'user/message') {
            const src = (event.data as { source?: { kind?: string; name?: unknown } })?.source;
            if (src?.kind === 'skill-invocation' && typeof src.name === 'string' && isValidSkillName(src.name)) {
              let set = activeTurnSkillsBySession.get(sid);
              if (!set) {
                set = new Set<string>();
                activeTurnSkillsBySession.set(sid, set);
              }
              set.add(src.name);
            }
            return;
          }

          if (event.type === 'tool/call') {
            const callData = event.data as {
              name?: unknown;
              args?: Record<string, unknown>;
              input?: Record<string, unknown>;
            };
            if (callData?.name === 'skill') {
              const skillArg = (callData.args?.name ?? callData.input?.name) as unknown;
              if (typeof skillArg === 'string' && isValidSkillName(skillArg)) {
                let set = activeTurnSkillsBySession.get(sid);
                if (!set) {
                  set = new Set<string>();
                  activeTurnSkillsBySession.set(sid, set);
                }
                set.add(skillArg);
              }
            }
            return;
          }

          if (event.type === 'assistant/message') {
            for (const block of event.data.message.content ?? []) {
              if (block.type === 'tool-call' && block.name === 'skill') {
                const inputObj = (block as { input?: Record<string, unknown> }).input;
                const skillArg = inputObj?.name;
                if (typeof skillArg === 'string' && isValidSkillName(skillArg)) {
                  let set = activeTurnSkillsBySession.get(sid);
                  if (!set) {
                    set = new Set<string>();
                    activeTurnSkillsBySession.set(sid, set);
                  }
                  set.add(skillArg);
                }
              }
            }
            return;
          }

          if (event.type === 'turn/end') {
            const tracked = activeTurnSkillsBySession.get(sid);
            activeTurnSkillsBySession.delete(sid);
            if (!tracked || tracked.size === 0) return;
            const reasonKind = event.data.reason?.kind;
            const completed = reasonKind === 'completed' || reasonKind === 'max-tokens';
            const at = typeof event.time === 'number' && Number.isFinite(event.time) ? event.time : Date.now();
            listener({
              sessionId: sid,
              skillNames: [...tracked],
              completed,
              at,
            });
          }
        },
        { global: true },
      );
      return off;
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
        if (!isOrdinaryDshSession({ id: rec.header.id, header: rec.header }, excludedRoots)) continue;
        if (rec.header.cwd && !isInternalPath(rec.header.cwd)) {
          coldSessionCwds.set(sid, rec.header.cwd);
        }
        if (rec.live || liveIds.has(sid) || inspected >= 20) continue;
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
          const extracted = extractTrajectoryTurnsFromOwnEvents(
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
          // Isolate cold read failures
        }
      }
    },
  };

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

  const llmSynthesize = async (prompt: string, signal: AbortSignal): Promise<string | undefined> => {
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
      if (!isOrdinaryDshSession(session, excludedRoots) || isArchived(String(session.id))) continue;
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
          system: 'You synthesize concise plain-text SKILL.md JSON definitions and never output secrets or scripts.',
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
          sub.effect(() => offSub, 'asi-growth sleep subscription');
        }
      });
      return () => {
        offDirect?.();
        offDirect = undefined;
        injectFiber.dispose();
      };
    },
    conversations,
    llmSynthesize,
  };
}

/**
 * Mount approved active skills dynamically into DSH's `ctx.skills` registry
 * via `ctx.skills.registerProvider`, supporting instant hot-reload (`control.invalidate()`)
 * and `global` vs `workspace` (`options.cwd`) scope isolation.
 */
export function registerDshSkillBridge(
  ctx: Context,
  bridge: GrowthSkillCatalogBridge,
  storageRoot?: string,
): () => void {
  const excludedRoots = storageRoot ? buildExcludedInternalRoots(storageRoot, ctx.asiSense?.storageRoot) : [];

  const isExcludedSkillLookup = (options: SkillLookupOptions): boolean => {
    if (options.cwd) {
      if (INTERNAL_CWD_RE.test(options.cwd)) return true;
      if (excludedRoots.some((r) => isSameOrInsideRoot(options.cwd, r))) return true;
    }
    const rawScope = (options as { scope?: { id?: unknown; session?: Session } }).scope;
    if (rawScope && typeof rawScope === 'object') {
      const sid = typeof rawScope.id === 'string' ? rawScope.id : String(rawScope.session?.id ?? '');
      if (sid && INTERNAL_SESSION_ID_RE.test(sid)) return true;
      if (rawScope.session && !isOrdinaryDshSession(rawScope.session, excludedRoots)) return true;
    }
    return false;
  };

  const mountOnRegistry = (registry: Context['skills']): (() => void) => {
    let offInvalidate: (() => void) | undefined;
    const offProvider = registry.registerProvider((control): SkillProvider => {
      offInvalidate = bridge.onInvalidate(() => {
        if (!control.signal.aborted) {
          control.invalidate();
        }
      });
      return {
        name: 'asi-growth',
        async list(options: SkillLookupOptions): Promise<readonly SkillCandidate[]> {
          if (options.signal?.aborted) {
            throw options.signal.reason ?? new Error('Aborted');
          }
          if (isExcludedSkillLookup(options)) return [];
          const items = bridge.listCandidates(options.cwd);
          return items.map(
            (item): SkillCandidate => ({
              name: item.name,
              description: item.description,
              ...(item.whenToUse ? { whenToUse: item.whenToUse } : {}),
              invocation: { modelInvocable: true, userInvocable: true },
              source: item.scope === 'workspace' ? 'project-dsh' : 'user-dsh',
              provider: 'asi-growth',
              rank: item.scope === 'workspace' ? WORKSPACE_SKILL_RANK : GLOBAL_SKILL_RANK,
              path: item.filePath,
              resourceBase: { kind: 'directory', path: item.directoryPath },
              locator: { name: item.name, version: item.version },
            }),
          );
        },
        async get(candidate: SkillCandidate, options: SkillLookupOptions): Promise<SkillDefinition | undefined> {
          if (options.signal?.aborted) {
            throw options.signal.reason ?? new Error('Aborted');
          }
          if (isExcludedSkillLookup(options)) return undefined;
          const loaded = await bridge.loadDefinition(candidate.name, options.cwd);
          if (!loaded) return undefined;
          return {
            name: loaded.name,
            description: loaded.description,
            ...(loaded.whenToUse ? { whenToUse: loaded.whenToUse } : {}),
            invocation: { modelInvocable: true, userInvocable: true },
            source: loaded.scope === 'workspace' ? 'project-dsh' : 'user-dsh',
            provider: 'asi-growth',
            path: loaded.filePath,
            resourceBase: { kind: 'directory', path: loaded.directoryPath },
            content: loaded.content,
            ...(loaded.metadata ? { metadata: loaded.metadata } : {}),
          };
        },
      };
    });
    return () => {
      offInvalidate?.();
      offProvider();
    };
  };

  const immediateSkills = (ctx as Context & { get(name: 'skills'): Context['skills'] | undefined }).get('skills');
  if (immediateSkills) {
    return mountOnRegistry(immediateSkills);
  }

  const fiber = ctx.inject(['skills'], (scope) => {
    const off = mountOnRegistry(scope.skills);
    scope.effect(() => off, 'asi-growth deferred skill provider');
  });
  return () => {
    fiber.dispose();
  };
}
