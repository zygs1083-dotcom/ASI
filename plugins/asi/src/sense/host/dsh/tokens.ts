import type { ContextPressureProjection, TokenUsageProjection } from '@deepseek-ai/dsh-token-meter';
import type { TokenSnapshot } from '../runtime/ports.ts';

export function tokenSnapshot(pressure: ContextPressureProjection, usage: TokenUsageProjection): TokenSnapshot {
  return {
    ...(pressure.pressureTokens !== undefined ? { contextUsed: pressure.pressureTokens } : {}),
    ...(pressure.projectedTokens !== undefined ? { contextProjected: pressure.projectedTokens } : {}),
    ...(pressure.contextWindow !== undefined
      ? { contextWindow: pressure.contextWindow, contextWindowSource: 'fallback' }
      : {}),
    sessionUsage: {
      input: usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
      output: usage.outputTokens,
      cacheRead: usage.cacheReadTokens,
      cacheWrite: usage.cacheWriteTokens,
    },
  };
}
