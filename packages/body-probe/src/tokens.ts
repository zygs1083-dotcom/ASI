import * as fact from './fact.js';
import type { BalanceValue, Fact, SourceRef, TokensValue } from './types.js';

export interface ContextPressure {
  pressureTokens?: number;
  projectedTokens?: number;
  contextWindow?: number;
}

export interface TokenUsage {
  uncachedInputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export function mapTokenMeter(
  pressure: ContextPressure | undefined,
  usage: TokenUsage,
  modelContext?: number,
): TokensValue {
  const out: TokensValue = {
    sessionUsage: {
      input: usage.uncachedInputTokens,
      output: usage.outputTokens,
      cacheRead: usage.cacheReadTokens,
      cacheWrite: usage.cacheWriteTokens,
    },
  };
  if (pressure?.pressureTokens !== undefined) out.contextUsed = pressure.pressureTokens;
  if (pressure?.projectedTokens !== undefined) out.contextProjected = pressure.projectedTokens;
  const contextWindow = pressure?.contextWindow !== undefined ? pressure.contextWindow : modelContext;
  if (contextWindow !== undefined) out.contextWindow = contextWindow;
  return out;
}

export interface FetchLikeResponse {
  status: number;
  json(): Promise<unknown>;
}

export type FetchFn = (
  url: string,
  init?: { method?: string; signal?: AbortSignal },
) => Promise<FetchLikeResponse>;

const BALANCE_TTL_MS = 600_000;
const BALANCE_TIMEOUT_MS = 1000;

function validEntry(entry: unknown): entry is { currency: string; total_balance: string } {
  if (typeof entry !== 'object' || entry === null) return false;
  const { currency, total_balance } = entry as { currency?: unknown; total_balance?: unknown };
  return typeof currency === 'string' && currency.trim() !== ''
    && typeof total_balance === 'string' && /^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(total_balance.trim())
    && Number.isFinite(Number(total_balance));
}

function parseBalance(data: unknown): BalanceValue | null {
  if (typeof data !== 'object' || data === null) return null;
  const { is_available, balance_infos } = data as { is_available?: unknown; balance_infos?: unknown };
  if (is_available !== true || !Array.isArray(balance_infos) || balance_infos.length === 0) return null;
  // Every entry must match the official shape; a malformed entry anywhere in
  // the list means the response cannot be trusted.
  if (!balance_infos.every(validEntry)) return null;
  const first = balance_infos[0]!;
  const amount = Number(first.total_balance);
  if (!Number.isFinite(amount)) return null;
  return { amount, currency: first.currency, source: 'deepseek' };
}

// Reads the DeepSeek /user/balance API through a caller-supplied authenticated
// fetch wrapper. This package never sees or reads credentials.
export async function deepseekBalance(
  fetchFn: FetchFn,
  baseUrl: string,
  src?: SourceRef,
): Promise<Fact<BalanceValue>> {
  const source = src ?? fact.source('balance', 'GET /user/balance');
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  // One shared deadline covers fetch, body read and parse; timeout also aborts
  // the signal handed to the caller's fetch wrapper.
  const expired = new Promise<never>((_res, rej) => {
    timer = setTimeout(() => {
      const err = new Error('balance fetch timeout');
      controller.abort(err);
      rej(err);
    }, BALANCE_TIMEOUT_MS);
  });
  try {
    const url = `${baseUrl.replace(/\/+$/, '')}/user/balance`;
    const res = await Promise.race([
      fetchFn(url, { method: 'GET', signal: controller.signal }),
      expired,
    ]);
    if (res.status !== 200) return fact.fail('unavailable', source, BALANCE_TTL_MS);
    const data = await Promise.race([Promise.resolve().then(() => res.json()), expired]);
    const value = parseBalance(data);
    if (!value) return fact.fail('unavailable', source, BALANCE_TTL_MS);
    return fact.ok(value, source, BALANCE_TTL_MS);
  } catch {
    return fact.fail('unavailable', source, BALANCE_TTL_MS);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
