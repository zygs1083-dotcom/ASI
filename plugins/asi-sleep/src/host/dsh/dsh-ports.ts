import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type {} from '@deepseek-ai/dsh-llm';
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session';
import type { SessionQueryEngine } from '@deepseek-ai/dsh-session-query';
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace';
import type { ConversationTurnInput } from '../consolidator.js';
import type { SleepConversationPort, SleepHostPorts } from '../ports.js';

export const INTERNAL_SESSION_ID_RE = /^asi-(?:maint|sleep|care|sense|growth|internal)(?:[-_:]|$)/i;
const INTERNAL_CWD_RE =
  /(?:^|[\\/])(?:(?:asi[-_])?(?:needs|sleep|care|sense|growth)[\\/](?:sandbox|vault|skills)|data[\\/]asi-(?:needs|sleep|care|sense|growth))(?:[\\/]|$)/i;

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
      roots.add(join(parent, 'care', 'sandbox'));
      roots.add(join(parent, 'growth', 'skills'));
      roots.add(join(parent, 'growth', 'sandbox'));
      if (shortSiblingNames.has(anchorBase)) {
        for (const sib of shortSiblingNames) {
          roots.add(join(parent, sib));
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
      if (isInsideRoot(cwd, root)) return false;
    }
  }
  return true;
}

export function extractTurnsFromOwnEvents(
  sessionId: string,
  cwd: string | undefined,
  events: readonly SessionEvent[],
  isRunning: boolean,
  fallbackNow: number,
  sessionTitle?: string,
): ConversationTurnInput[] {
  interface DraftEventTurn {
    turnId: string;
    seq: number;
    at: number;
    turnNumber?: number;
    closedStatus?: 'completed' | 'failed' | 'open';
    userText: string;
    assistantTexts: string[];
    toolNames: string[];
  }

  const drafts: DraftEventTurn[] = [];
  let current: DraftEventTurn | undefined;
  let activeTurnNumber: number | undefined;
  let sawTurnLifecycle = false;

  for (const event of events) {
    if (event.type === 'turn/start') {
      sawTurnLifecycle = true;
      activeTurnNumber = event.data.turn;
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
        userText,
        assistantTexts: [],
        toolNames: [],
      };
      drafts.push(current);
      continue;
    }

    if (event.type === 'assistant/message' && current) {
      if (event.surfaceOp !== 'append') continue;
      if (event.data.interrupted) continue;
      current.seq = Math.max(current.seq, Number(event.seq));
      for (const block of event.data.message.content ?? []) {
        if (block.type === 'text' && block.text.trim()) {
          current.assistantTexts.push(block.text.trim());
        } else if (block.type === 'tool-call' && typeof block.name === 'string') {
          if (!current.toolNames.includes(block.name)) current.toolNames.push(block.name);
        }
      }
      continue;
    }

    if (event.type === 'tool/call' && current) {
      current.seq = Math.max(current.seq, Number(event.seq));
      if (typeof event.data.name === 'string' && !current.toolNames.includes(event.data.name)) {
        current.toolNames.push(event.data.name);
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

  const out: ConversationTurnInput[] = [];
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
      userText: d.userText,
      assistantText,
      ...(d.toolNames.length > 0 ? { toolNames: d.toolNames } : {}),
    });
  }
  return out;
}

export function extractRouteFromEvents(
  events: readonly SessionEvent[],
): { provider: string; model: string } | undefined {
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
      const hdr = raw.data as { header?: { config?: { provider?: unknown; model?: unknown } } } | undefined;
      const cfg = hdr?.header?.config;
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

export function createDshSleepPorts(ctx: Context, storageRoot: string, options?: { homeDir?: string }): SleepHostPorts {
  const excludedRoots = buildExcludedInternalRoots(storageRoot, ctx.asiSense?.storageRoot);
  const turnFirstSeenAt = new Map<string, number>();
  const coldSessionTurns = new Map<string, ConversationTurnInput[]>();
  const coldSessionRoutes = new Map<string, { provider: string; model: string; createdAt: number }>();
  const inspectedColdRouteSessionIds = new Set<string>();
  const sessionTitles = new Map<string, string>();

  const getWorkspaceRegistry = (): WorkspaceRegistry | undefined =>
    (ctx as Context & { get(name: 'workspaceRegistry'): WorkspaceRegistry | undefined }).get('workspaceRegistry');

  const getSessionQuery = (): SessionQueryEngine | undefined =>
    (ctx as Context & { get(name: 'sessionQuery'): SessionQueryEngine | undefined }).get('sessionQuery');

  const getSessionProjections = ():
    | {
        snapshot?: (session: Session, keys?: readonly string[]) => { values?: Record<string, unknown> } | undefined;
      }
    | undefined =>
    (
      ctx as Context & {
        get(name: 'sessionProjections'):
          | {
              snapshot?: (
                session: Session,
                keys?: readonly string[],
              ) => { values?: Record<string, unknown> } | undefined;
            }
          | undefined;
      }
    ).get('sessionProjections');

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
    const sid = String(session.id);
    const cwd = session.header?.cwd;
    const title = sessionTitles.get(sid);

    if (typeof session.ownEvents === 'function') {
      try {
        const own = session.ownEvents();
        return extractTurnsFromOwnEvents(sid, cwd, own, isRunning, now, title);
      } catch {
        // Fall through to deriveMessages fallback if mock session throws
      }
    }

    if (typeof session.deriveMessages !== 'function') return [];

    let messages: ReturnType<Session['deriveMessages']>;
    try {
      messages = session.deriveMessages();
    } catch {
      return [];
    }

    interface FallbackDraftTurn {
      turnId: string;
      userText: string;
      assistantTexts: string[];
      toolNames: string[];
    }

    const drafts: FallbackDraftTurn[] = [];
    let current: FallbackDraftTurn | undefined;

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
        ...(title ? { sessionTitle: title } : {}),
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
        coldSessionTurns.delete(sid);
        allTurns.push(...extractSessionTurns(session, runningIds.has(sid), now));
      }
      for (const [sid, coldTurns] of coldSessionTurns) {
        if (isArchived(sid)) {
          coldSessionTurns.delete(sid);
          continue;
        }
        allTurns.push(...coldTurns);
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
        if (signal.aborted || inspected >= 25) break;
        const sid = String(rec.header.id);
        if (rec.live || liveIds.has(sid) || isArchived(sid)) continue;
        if (!isOrdinaryDshSession({ id: rec.header.id, header: rec.header }, excludedRoots)) continue;
        inspected += 1;
        try {
          if (typeof sq.readTitle === 'function') {
            const titleSnap = await sq.readTitle(rec.header.id as SessionId, signal).catch(() => undefined);
            if (titleSnap && typeof titleSnap.title === 'string' && titleSnap.title.trim()) {
              sessionTitles.set(sid, titleSnap.title.trim());
            }
          }
          const logSnap = await sq.readSession(rec.header.id as SessionId);
          if (signal.aborted) return;
          inspectedColdRouteSessionIds.add(sid);
          const recordedRoute = extractRouteFromEvents(logSnap.events);
          if (recordedRoute) {
            coldSessionRoutes.set(sid, {
              ...recordedRoute,
              createdAt: logSnap.session.createdAt || 0,
            });
          }
          if (ctx.sessions?.get?.(rec.header.id as SessionId)) continue;
          const inherited = Math.max(0, Number(logSnap.inheritedEventCount ?? 0));
          const ownEvents = logSnap.events.slice(inherited);
          const extracted = extractTurnsFromOwnEvents(
            sid,
            logSnap.session.cwd,
            ownEvents,
            false,
            logSnap.session.createdAt || Date.now(),
            sessionTitles.get(sid),
          );
          if (extracted.length > 0) {
            coldSessionTurns.set(sid, extracted);
          }
        } catch {
          // Isolate cold-session read errors
        }
      }
    },
  };

  const ROUTE_FALLBACK_FAILURE_CODES = new Set([
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

  const collectSyncCandidateRoutes = (): {
    usable: Array<{ provider: string; model: string }>;
    unverified: Array<{ provider: string; model: string }>;
  } => {
    const registeredProviders =
      typeof ctx.llm?.listProviders === 'function'
        ? new Set(
            (ctx.llm.listProviders() ?? []).map((p) => (typeof p?.id === 'string' ? p.id.trim() : '')).filter(Boolean),
          )
        : new Set<string>();
    const isProviderUsable = (provider: string): boolean =>
      registeredProviders.size === 0 || registeredProviders.has(provider);

    const usable: Array<{ provider: string; model: string }> = [];
    const unverified: Array<{ provider: string; model: string }> = [];
    const seen = new Set<string>();

    const recordCandidate = (cand: { provider?: unknown; model?: unknown } | undefined): void => {
      const provider = typeof cand?.provider === 'string' ? cand.provider.trim() : '';
      const model = typeof cand?.model === 'string' ? cand.model.trim() : '';
      if (!provider || !model) return;
      const key = `${provider}\0${model}`;
      if (seen.has(key)) return;
      seen.add(key);
      if (isProviderUsable(provider)) {
        usable.push({ provider, model });
      } else {
        unverified.push({ provider, model });
      }
    };

    // 1. Live ordinary Agent current model selection
    for (const agent of ctx.agents?.list() ?? []) {
      if (!isOrdinaryAgent(agent)) continue;
      recordCandidate(agent.model?.current?.());
    }

    // Collect live ordinary Sessions ordered newest first
    const liveOrdinarySessionsMap = new Map<string, Session>();
    for (const agent of ctx.agents?.list() ?? []) {
      if (isOrdinaryAgent(agent) && agent.session) {
        liveOrdinarySessionsMap.set(String(agent.id), agent.session);
      }
    }
    for (const session of ctx.sessions?.list() ?? []) {
      const sid = String(session.id);
      if (!liveOrdinarySessionsMap.has(sid) && !isArchived(sid) && isOrdinaryDshSession(session, excludedRoots)) {
        liveOrdinarySessionsMap.set(sid, session);
      }
    }
    const liveOrdinarySessions = [...liveOrdinarySessionsMap.values()].sort(
      (a, b) => (b.header?.createdAt ?? 0) - (a.header?.createdAt ?? 0),
    );

    // 2. Session projections (`modelSelection.next ?? modelSelection.lastUsed`)
    const sp = getSessionProjections();
    if (sp && typeof sp.snapshot === 'function') {
      for (const session of liveOrdinarySessions) {
        try {
          const snap = sp.snapshot(session, ['modelSelection']);
          const ms = snap?.values?.modelSelection as
            | {
                next?: { provider?: unknown; model?: unknown } | null;
                lastUsed?: { provider?: unknown; model?: unknown } | null;
              }
            | undefined;
          recordCandidate(ms?.next ?? ms?.lastUsed ?? undefined);
        } catch {
          // Ignore projection snapshot errors on mock sessions
        }
      }
    }

    // 3. Recorded request headers / model selections in live ordinary Session logs
    for (const session of liveOrdinarySessions) {
      try {
        const events =
          typeof session.snapshotEvents === 'function'
            ? session.snapshotEvents()
            : typeof session.ownEvents === 'function'
              ? session.ownEvents()
              : [];
        recordCandidate(extractRouteFromEvents(events));
        const liveHeaderCfg = (
          session as Session & { requestHeader?: () => { config?: unknown } | undefined }
        ).requestHeader?.()?.config as { provider?: unknown; model?: unknown } | undefined;
        recordCandidate(liveHeaderCfg);
      } catch {
        // Ignore session event read errors
      }
    }

    // 4a. Already-cached cold persisted ordinary Session routes
    const cachedEntries = [...coldSessionRoutes.entries()].sort((a, b) => b[1].createdAt - a[1].createdAt);
    for (const [sid, info] of cachedEntries) {
      if (isArchived(sid)) {
        coldSessionRoutes.delete(sid);
        continue;
      }
      recordCandidate(info);
    }

    return { usable, unverified };
  };

  const collectAsyncFallbackRoutes = async (
    signal: AbortSignal,
    alreadyTried: ReadonlySet<string>,
    syncUnverified: ReadonlyArray<{ provider: string; model: string }>,
  ): Promise<Array<{ provider: string; model: string }>> => {
    const registeredProviders =
      typeof ctx.llm?.listProviders === 'function'
        ? new Set(
            (ctx.llm.listProviders() ?? []).map((p) => (typeof p?.id === 'string' ? p.id.trim() : '')).filter(Boolean),
          )
        : new Set<string>();
    const isProviderUsable = (provider: string): boolean =>
      registeredProviders.size === 0 || registeredProviders.has(provider);

    const usable: Array<{ provider: string; model: string }> = [];
    const unverified: Array<{ provider: string; model: string }> = [...syncUnverified];
    const seen = new Set<string>(alreadyTried);
    for (const u of unverified) seen.add(`${u.provider}\0${u.model}`);

    const recordAsyncCandidate = (cand: { provider?: unknown; model?: unknown } | undefined): void => {
      const provider = typeof cand?.provider === 'string' ? cand.provider.trim() : '';
      const model = typeof cand?.model === 'string' ? cand.model.trim() : '';
      if (!provider || !model) return;
      const key = `${provider}\0${model}`;
      if (seen.has(key)) return;
      seen.add(key);
      if (isProviderUsable(provider)) {
        usable.push({ provider, model });
      } else {
        unverified.push({ provider, model });
      }
    };

    // 4b. Uncached cold persisted ordinary Sessions (`ctx.sessionQuery`) — never blocked by earlier stale cache entries
    const sq = getSessionQuery();
    if (sq && typeof sq.listSessions === 'function' && typeof sq.readSession === 'function') {
      try {
        const records = await sq.listSessions(signal);
        let inspected = 0;
        for (const rec of records) {
          if (signal.aborted || inspected >= 15) break;
          const sid = String(rec.header.id);
          if (isArchived(sid) || !isOrdinaryDshSession({ id: rec.header.id, header: rec.header }, excludedRoots)) {
            continue;
          }
          const cached = coldSessionRoutes.get(sid);
          if (cached) {
            recordAsyncCandidate(cached);
            continue;
          }
          if (inspectedColdRouteSessionIds.has(sid)) continue;
          inspected += 1;
          try {
            const logSnap = await sq.readSession(rec.header.id as SessionId);
            if (signal.aborted) return [];
            inspectedColdRouteSessionIds.add(sid);
            const found = extractRouteFromEvents(logSnap.events);
            if (found) {
              coldSessionRoutes.set(sid, { ...found, createdAt: logSnap.session.createdAt || 0 });
              recordAsyncCandidate(found);
            }
          } catch {
            // Isolate cold-session read errors
          }
        }
      } catch {
        // Isolate sessionQuery list errors
      }
    }

    // 5. Registered `ctx.llm` providers & advertised models
    if (typeof ctx.llm?.listProviders === 'function' && typeof ctx.llm?.listModels === 'function') {
      for (const prov of ctx.llm.listProviders() ?? []) {
        if (signal.aborted) return [];
        const providerId = typeof prov?.id === 'string' ? prov.id.trim() : '';
        if (!providerId) continue;
        const models = await ctx.llm.listModels(providerId).catch(() => []);
        if (signal.aborted) return [];
        for (const m of models ?? []) {
          const modelId = typeof m?.id === 'string' ? m.id.trim() : '';
          if (modelId) {
            const key = `${providerId}\0${modelId}`;
            if (!seen.has(key)) {
              seen.add(key);
              usable.push({ provider: providerId, model: modelId });
            }
            break;
          }
        }
      }
    }

    for (const u of unverified) {
      const key = `${u.provider}\0${u.model}`;
      if (!alreadyTried.has(key)) {
        usable.push(u);
      }
    }
    return usable;
  };

  type StreamAttemptResult =
    | { status: 'ok'; text: string | undefined }
    | { status: 'aborted' }
    | { status: 'route-error' }
    | { status: 'failed' };

  const runStreamOnce = async (
    route: { provider: string; model: string },
    prompt: string,
    signal: AbortSignal,
  ): Promise<StreamAttemptResult> => {
    let onAbort: (() => void) | undefined;
    const abortPromise = new Promise<'aborted'>((resolve) => {
      if (signal.aborted) {
        resolve('aborted');
        return;
      }
      onAbort = () => resolve('aborted');
      signal.addEventListener('abort', onAbort, { once: true });
    });

    const consumePromise = (async (): Promise<StreamAttemptResult> => {
      try {
        let text = '';
        const deltaBlockIndices = new Set<number>();
        // Omit both `temperature` and hardcoded `maxTokens` so reasoning models (DeepSeek Reasoner,
        // OpenAI o-series, etc.) use route-native sampling defaults and DSH's `LlmRuntime` materializes
        // each exact model's `defaultMaxTokens` without starving chain-of-thought reasoning blocks.
        const stream = ctx.llm.stream({
          provider: route.provider,
          model: route.model,
          system: 'You extract concise structured JSON memories and never output secrets.',
          messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
          signal,
        });
        for await (const chunk of stream) {
          if (signal.aborted) return { status: 'aborted' };
          if (chunk.type === 'text-delta') {
            deltaBlockIndices.add(chunk.index);
            text += chunk.text;
          } else if (
            chunk.type === 'block-end' &&
            chunk.block?.type === 'text' &&
            !deltaBlockIndices.has(chunk.index)
          ) {
            text += chunk.block.text;
          } else if (chunk.type === 'finish') {
            if (chunk.reason.kind === 'aborted') {
              return { status: 'aborted' };
            }
            if (chunk.reason.kind === 'error') {
              const errCode = (chunk.reason as { failure?: { code?: unknown } }).failure?.code;
              if (typeof errCode === 'string' && ROUTE_FALLBACK_FAILURE_CODES.has(errCode)) {
                return { status: 'route-error' };
              }
              return { status: 'failed' };
            }
          }
        }
        return { status: 'ok', text: text.trim() || undefined };
      } catch (err) {
        const errCode = (err as { code?: unknown } | undefined)?.code;
        if (typeof errCode === 'string' && ROUTE_FALLBACK_FAILURE_CODES.has(errCode)) {
          return { status: 'route-error' };
        }
        return { status: 'failed' };
      }
    })();

    try {
      const raced = await Promise.race([consumePromise, abortPromise]);
      if (raced === 'aborted') {
        void consumePromise.catch(() => undefined);
        return { status: 'aborted' };
      }
      return raced;
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  };

  const llmExtract = async (prompt: string, signal: AbortSignal): Promise<string | undefined> => {
    if (!ctx.llm || typeof ctx.llm.stream !== 'function' || signal.aborted) return undefined;

    const executeWithFallback = async (): Promise<string | undefined> => {
      const tried = new Set<string>();
      const syncRoutes = collectSyncCandidateRoutes();

      for (const route of syncRoutes.usable.slice(0, 4)) {
        if (signal.aborted) return undefined;
        tried.add(`${route.provider}\0${route.model}`);
        const res = await runStreamOnce(route, prompt, signal);
        if (res.status === 'ok') return res.text;
        if (res.status === 'aborted' || res.status === 'failed') return undefined;
      }

      if (signal.aborted) return undefined;
      const asyncRoutes = await collectAsyncFallbackRoutes(signal, tried, syncRoutes.unverified);
      for (const route of asyncRoutes.slice(0, 4)) {
        if (signal.aborted) return undefined;
        const key = `${route.provider}\0${route.model}`;
        if (tried.has(key)) continue;
        tried.add(key);
        const res = await runStreamOnce(route, prompt, signal);
        if (res.status === 'ok') return res.text;
        if (res.status === 'aborted' || res.status === 'failed') return undefined;
      }
      return undefined;
    };

    if (typeof ctx.agents?.withoutInitiator === 'function') {
      return ctx.agents.withoutInitiator(executeWithFallback);
    }
    return executeWithFallback();
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
