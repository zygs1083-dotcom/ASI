import { Context } from '@deepseek-ai/cordis';
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent';
import LlmRuntime, { LlmAdapter, type LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm';
import { Session, SessionId } from '@deepseek-ai/dsh-session';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { createDshPort } from '../../../src/sense/host/dsh/port.ts';
import { tokenSnapshot } from '../../../src/sense/host/dsh/tokens.ts';

describe('DSH token projections', () => {
  it('keeps usage separate from context pressure and marks unverified capacity as fallback', () => {
    expect(
      tokenSnapshot(
        { pressureTokens: 120, projectedTokens: 150, contextWindow: 1000 },
        { uncachedInputTokens: 20, outputTokens: 5, cacheReadTokens: 10, cacheWriteTokens: 3 },
      ),
    ).toEqual({
      contextUsed: 120,
      contextProjected: 150,
      contextWindow: 1000,
      contextWindowSource: 'fallback',
      sessionUsage: { input: 33, output: 5, cacheRead: 10, cacheWrite: 3 },
    });
  });

  it('does not invent missing context values', () => {
    expect(
      tokenSnapshot({}, { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }),
    ).toEqual({ sessionUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
  });

  it('keeps fallback in createDshPort.tokenSnapshot because DSH strips context provenance', async () => {
    const ctx = new Context();
    onTestFinished(() => ctx.fiber.dispose());
    await ctx.plugin(SessionProjectionRegistry);
    await ctx.plugin(AgentRegistry);
    await ctx.plugin(LlmRuntime);
    await ctx.plugin(TokenMeter);
    class FixtureAdapter extends LlmAdapter {
      override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
        return {
          provider,
          id: model,
          name: model,
          context: Object.assign({ contextWindow: 256_000 }, { source: 'configured' }),
        };
      }
      async *stream() {}
    }
    ctx.llm.registerAdapter(['fixture'], new FixtureAdapter());
    const resolved = await ctx.llm.resolveModelInfo('fixture', 'm');
    expect(resolved.context).toEqual({ contextWindow: 256_000 });
    expect('source' in (resolved.context ?? {})).toBe(false);

    const id = SessionId('token-session');
    const session = Session.create(id);
    const agent: Agent = {
      id,
      ctx,
      session,
      options: {},
      model: { current: () => ({ provider: 'fixture', model: 'm' }), select: () => {} },
      inbox: {
        nextTurn: [],
        nextStep: [],
        clear: () => {},
        append: () => {},
        prepend: () => {},
        replace: () => false,
        remove: () => false,
        splice: () => [],
      },
      status: 'idle',
      cancel: () => {},
      whenIdle: async () => {},
      runMaintenance: (task) => task(new AbortController().signal),
      send: vi.fn(),
      inject: vi.fn(),
      followup: vi.fn(),
      steer: vi.fn(),
    };
    const unregister = await ctx.agents.register(agent);
    onTestFinished(unregister);
    const port = createDshPort(ctx);
    expect(await port.tokenSnapshot(id)).toEqual({
      contextWindow: 256_000,
      contextWindowSource: 'fallback',
      sessionUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });

    session.append('request/context', { provider: 'fixture', model: 'm', contextWindow: 1_000_000 });
    expect(ctx.tokenMeter.contextPressure(session)).toEqual({ contextWindow: 1_000_000 });
    expect(await port.tokenSnapshot(id)).toEqual({
      contextWindow: 1_000_000,
      contextWindowSource: 'fallback',
      sessionUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
  });
});
