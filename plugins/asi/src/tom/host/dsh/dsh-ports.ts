/**
 * DSH host adapter for ASI Theory of Mind (`src/tom/`).
 *
 * Observes ordinary user conversation rhythm (message cadence, prompt character
 * length, explicit stream interruptions, turn completion/abort status, and
 * approval response latency) without storing any raw conversation content.
 */

import { performance } from 'node:perf_hooks';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace';
import { buildExcludedInternalRoots, isOrdinaryDshSession } from '../../../sleep/host/dsh/dsh-ports.js';
import type { OrdinaryApprovalSignal, OrdinaryPromptSignal, OrdinaryTurnSignal, TomHostPorts } from '../ports.js';

export const TOM_INTERNAL_SESSION_RE = /^asi-(?:maint|sleep|care|sense|growth|tom|internal)(?:[-_:]|$)/i;

export function createDshTomPorts(
  ctx: Context,
  storageRoot: string,
  now: () => number = () => Date.now(),
  mono: () => number = () => performance.now(),
): TomHostPorts {
  const sense = ctx.asiSense;
  const drives = ctx.asiDrives;
  const sleep = ctx.asiSleep;
  const agents = ctx.agents;
  const excludedRoots = buildExcludedInternalRoots(storageRoot, sense.storageRoot);

  const isArchived = (sessionId: string): boolean => {
    try {
      const wr = (ctx as Context & { get(name: 'workspaceRegistry'): WorkspaceRegistry | undefined }).get(
        'workspaceRegistry',
      );
      return Boolean(wr?.archivedSessionIds.some((id) => String(id) === sessionId));
    } catch {
      return false;
    }
  };

  const isEligibleSession = (session: Pick<Session, 'id'> & { header?: Partial<Session['header']> }): boolean => {
    const sid = String(session.id ?? '');
    if (!sid || TOM_INTERNAL_SESSION_RE.test(sid) || isArchived(sid)) return false;
    return isOrdinaryDshSession(session, excludedRoots);
  };

  return {
    storageRoot,
    now,
    sense,
    drives,
    sleep,
    sessions: {
      hasActiveOrdinarySession(): boolean {
        try {
          for (const agent of agents.list()) {
            const sid = String(agent.id ?? '');
            if (!sid || TOM_INTERNAL_SESSION_RE.test(sid) || isArchived(sid)) continue;
            if (agent.session && !isOrdinaryDshSession(agent.session, excludedRoots)) continue;
            return true;
          }
        } catch {
          return false;
        }
        return false;
      },

      onUserPrompt(cb: (signal: OrdinaryPromptSignal) => void): () => void {
        return ctx.on(
          'session/event',
          (session: Session, event: SessionEvent) => {
            if (event.type !== 'user/message' || event.surfaceOp !== 'append') return;
            if (!isEligibleSession(session)) return;
            const src = event.data.source as { kind?: string; form?: string } | undefined;
            if (src?.kind !== 'user' || src.form !== undefined) return;

            let charCount = 0;
            for (const block of event.data.content ?? []) {
              if (block.type === 'text' && typeof block.text === 'string') {
                charCount += block.text.trim().length;
              }
            }
            if (charCount <= 0) return;

            const eventAt =
              typeof event.time === 'number' && Number.isFinite(event.time) && event.time > 0 ? event.time : now();
            cb({
              sessionId: String(session.id),
              at: eventAt,
              charCount,
            });
          },
          { global: true },
        );
      },

      onTurnSettled(cb: (signal: OrdinaryTurnSignal) => void): () => void {
        const interruptedTurns = new Set<string>();

        const offEvent = ctx.on(
          'session/event',
          (session: Session, event: SessionEvent) => {
            if (!isEligibleSession(session)) return;
            const sid = String(session.id);
            const eventAt =
              typeof event.time === 'number' && Number.isFinite(event.time) && event.time > 0 ? event.time : now();

            if (event.type === 'assistant/message' && event.surfaceOp === 'append' && event.data.interrupted) {
              const turnKey = `${sid}:${String(event.data.turn ?? '')}`;
              interruptedTurns.add(turnKey);
              if (interruptedTurns.size > 128) {
                const first = interruptedTurns.values().next().value;
                if (first) interruptedTurns.delete(first);
              }
              cb({ sessionId: sid, at: eventAt, outcome: 'interrupted' });
              return;
            }

            if (event.type === 'turn/end') {
              const turnKey = `${sid}:${String(event.data.turn ?? '')}`;
              const alreadyMarkedInterrupted = interruptedTurns.delete(turnKey);
              if (alreadyMarkedInterrupted) return;

              const kind = String(event.data.reason?.kind ?? '');
              if (kind === 'completed' || kind === 'max-tokens') {
                cb({ sessionId: sid, at: eventAt, outcome: 'completed' });
              } else if (kind === 'interrupted' || kind === 'cancelled' || kind === 'aborted' || kind === 'abort') {
                cb({ sessionId: sid, at: eventAt, outcome: 'aborted' });
              } else if (kind) {
                cb({ sessionId: sid, at: eventAt, outcome: 'error' });
              }
            }
          },
          { global: true },
        );

        return () => {
          interruptedTurns.clear();
          offEvent();
        };
      },

      onApprovalResolved(cb: (signal: OrdinaryApprovalSignal) => void): () => void {
        const observeInteraction = async (request: { agent?: Agent }, next: () => Promise<unknown>) => {
          const agent = request.agent;
          if (!agent) return next();
          const sid = String(agent.id ?? '');
          const eligible = agent.session
            ? isEligibleSession(agent.session)
            : Boolean(sid && !TOM_INTERNAL_SESSION_RE.test(sid) && !isArchived(sid));
          if (!eligible) return next();

          const startMono = mono();
          try {
            return await next();
          } finally {
            const latencyMs = Math.max(0, Math.round(mono() - startMono));
            cb({
              sessionId: sid,
              at: now(),
              latencyMs,
            });
          }
        };

        const bus = ctx as unknown as {
          on(
            name: string,
            listener: typeof observeInteraction,
            options: { prepend: boolean; global: boolean },
          ): () => void;
        };
        const offApproval = bus.on('approval/request', observeInteraction, { prepend: true, global: true });
        const offQuestions = bus.on('user-questions/request', observeInteraction, { prepend: true, global: true });
        return () => {
          offQuestions();
          offApproval();
        };
      },
    },
  };
}
