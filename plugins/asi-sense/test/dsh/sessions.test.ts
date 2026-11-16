import { Context } from '@deepseek-ai/cordis';
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session';
import { describe, expect, it } from 'vitest';
import { sessionCatalog, sessionRows } from '../../src/host/dsh/sessions.ts';

describe('DSH session rows', () => {
  it('sorts ordinary available sessions by activity and preserves titles and running status', () => {
    expect(
      sessionRows([
        { sessionId: 'older', updatedAt: 1, running: false, projections: { values: { title: 'First fixture' } } },
        { sessionId: 'newer', updatedAt: 3, running: true, projections: { values: { title: 'Second fixture' } } },
        { sessionId: 'child', updatedAt: 4, running: true, origin: 'subagent' },
        { sessionId: 'incompatible', updatedAt: 5, running: false, formatStatus: 'migration-required' },
        { sessionId: 'untitled', updatedAt: 2, running: false },
      ]),
    ).toEqual([
      { id: 'newer', title: 'Second fixture', updatedAt: 3, running: true },
      { id: 'untitled', title: '', updatedAt: 2, running: false },
      { id: 'older', title: 'First fixture', updatedAt: 1, running: false },
    ]);
    expect(sessionRows([{ sessionId: 'archived', updatedAt: 1, running: false }], ['archived'])).toEqual([]);
  });

  it('notifies on creation, title changes, archive and disposal, and unregisters listeners', async () => {
    const ctx = new Context();
    const seen: Array<string | undefined> = [];
    const stop = sessionCatalog(ctx).onSessionsChanged((closed) => seen.push(closed));
    const session = Session.create(SessionId('fixture'));
    ctx.emit('session/created', session);
    ctx.emit('session/event', session, {
      type: 'session/title',
      seq: SessionSeq(1),
      time: 2,
      data: { title: 'Fixture', messageSeqs: [], source: { kind: 'user' } },
    });
    await ctx.parallel('workspace/session-archived', { sessionId: session.id });
    ctx.emit('session/disposed', session);
    expect(seen).toEqual([undefined, undefined, 'fixture', 'fixture']);
    stop();
    ctx.emit('session/disposed', session);
    expect(seen).toHaveLength(4);
    await ctx.fiber.dispose();
  });
});
