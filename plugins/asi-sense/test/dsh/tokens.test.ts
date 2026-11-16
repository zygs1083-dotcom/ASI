import { describe, expect, it } from 'vitest';
import { tokenSnapshot } from '../../src/host/dsh/tokens.ts';

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
});
