import { afterEach, describe, expect, it, vi } from 'vitest';
import { type ContextPressure, deepseekBalance, type FetchFn, mapTokenMeter, type TokenUsage } from '../src/tokens.js';

const usage: TokenUsage = {
  uncachedInputTokens: 100,
  outputTokens: 40,
  cacheReadTokens: 200,
  cacheWriteTokens: 30,
};

describe('mapTokenMeter', () => {
  it('copies usage into sessionUsage and maps pressure fields', () => {
    const v = mapTokenMeter({ pressureTokens: 500, projectedTokens: 900, contextWindow: 64000 }, usage);
    expect(v).toEqual({
      contextWindow: 64000,
      contextUsed: 500,
      contextProjected: 900,
      sessionUsage: { input: 100, output: 40, cacheRead: 200, cacheWrite: 30 },
    });
  });

  it('falls back to modelContext only when pressure.contextWindow is absent', () => {
    expect(mapTokenMeter({ pressureTokens: 1 }, usage, 32000).contextWindow).toBe(32000);
    expect(mapTokenMeter({ contextWindow: 64000 }, usage, 32000).contextWindow).toBe(64000);
    expect(mapTokenMeter(undefined, usage).contextWindow).toBeUndefined();
  });

  it('preserves zeros and omits absent optional fields', () => {
    const v = mapTokenMeter({ pressureTokens: 0, contextWindow: 0 }, usage);
    expect(v.contextUsed).toBe(0);
    expect(v.contextWindow).toBe(0);
    expect('contextProjected' in v).toBe(false);
  });

  it('requires usage and does not pretend zero usage', () => {
    const v = mapTokenMeter(undefined as ContextPressure | undefined, {
      uncachedInputTokens: 7,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(v.sessionUsage.input).toBe(7);
    expect(v.sessionUsage.output).toBe(0);
  });
});

describe('deepseekBalance', () => {
  afterEach(() => vi.useRealTimers());

  const respond =
    (status: number, body: unknown): FetchFn =>
    async () => ({ status, json: async () => body });

  it('GETs baseUrl/user/balance with trailing slashes removed', async () => {
    let url = '';
    const fetchFn: FetchFn = async (u, init) => {
      url = u;
      expect(init?.method ?? 'GET').toBe('GET');
      return {
        status: 200,
        json: async () => ({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '9.5' }] }),
      };
    };
    const f = await deepseekBalance(fetchFn, 'https://api.example.com///');
    expect(url).toBe('https://api.example.com/user/balance');
    expect(f.status).toBe('ok');
    expect(f.value).toEqual({ amount: 9.5, currency: 'CNY', source: 'deepseek' });
    expect(f.source.api).toBe('GET /user/balance');
    expect(f.ttlMs).toBe(600_000);
  });

  it('takes the first balance entry in returned order, even non-USD', async () => {
    const f = await deepseekBalance(
      respond(200, {
        is_available: true,
        balance_infos: [
          { currency: 'EUR', total_balance: '3.25' },
          { currency: 'USD', total_balance: '100.00' },
        ],
      }),
      'https://api.example.com',
    );
    expect(f.value?.currency).toBe('EUR');
    expect(f.value?.amount).toBe(3.25);
  });

  it.each([
    ['is_available false', { is_available: false, balance_infos: [{ currency: 'USD', total_balance: '1' }] }],
    ['empty list', { is_available: true, balance_infos: [] }],
    ['malformed structure', { unexpected: 1 }],
    ['bad amount string', { is_available: true, balance_infos: [{ currency: 'USD', total_balance: 'abc' }] }],
    ['empty amount', { is_available: true, balance_infos: [{ currency: 'USD', total_balance: '' }] }],
    ['non-string amount', { is_available: true, balance_infos: [{ currency: 'USD', total_balance: 5 }] }],
  ])('reports unavailable for %s', async (_name, body) => {
    expect((await deepseekBalance(respond(200, body), 'https://api.example.com')).status).toBe('unavailable');
  });

  it('reports unavailable on non-200 status', async () => {
    expect((await deepseekBalance(respond(500, {}), 'https://api.example.com')).status).toBe('unavailable');
  });

  it('reports unavailable when json() or fetch rejects', async () => {
    const badJson: FetchFn = async () => ({
      status: 200,
      json: async () => {
        throw new Error('bad json');
      },
    });
    expect((await deepseekBalance(badJson, 'https://api.example.com')).status).toBe('unavailable');
    const badFetch: FetchFn = async () => {
      throw new Error('network down');
    };
    expect((await deepseekBalance(badFetch, 'https://api.example.com')).status).toBe('unavailable');
  });

  it.each([
    [
      'malformed second entry',
      {
        is_available: true,
        balance_infos: [
          { currency: 'USD', total_balance: '1' },
          { currency: 'EUR', total_balance: 'oops' },
        ],
      },
    ],
    ['null list item', { is_available: true, balance_infos: [null] }],
    ['primitive list item', { is_available: true, balance_infos: ['USD'] }],
    ['whitespace currency', { is_available: true, balance_infos: [{ currency: '   ', total_balance: '1' }] }],
    [
      'overflow second entry amount',
      {
        is_available: true,
        balance_infos: [
          { currency: 'USD', total_balance: '1' },
          { currency: 'EUR', total_balance: '9'.repeat(400) },
        ],
      },
    ],
  ])('reports unavailable for %s anywhere in the list', async (_name, body) => {
    expect((await deepseekBalance(respond(200, body), 'https://api.example.com')).status).toBe('unavailable');
  });

  it('bounds a hanging json() at the shared 1000ms deadline and aborts the signal', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetchFn: FetchFn = (_u, init) => {
      signal = init?.signal;
      return Promise.resolve({ status: 200, json: () => new Promise<never>(() => {}) });
    };
    const pending = deepseekBalance(fetchFn, 'https://api.example.com');
    await vi.advanceTimersByTimeAsync(1001);
    expect((await pending).status).toBe('unavailable');
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds a hanging fetch at 1000ms and aborts the signal', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetchFn: FetchFn = (_u, init) => {
      signal = init?.signal;
      return new Promise(() => {});
    };
    const pending = deepseekBalance(fetchFn, 'https://api.example.com');
    await vi.advanceTimersByTimeAsync(1001);
    expect((await pending).status).toBe('unavailable');
    expect(signal?.aborted).toBe(true);
  });

  it('accepts signed decimal balances', async () => {
    const f = await deepseekBalance(
      respond(200, {
        is_available: true,
        balance_infos: [{ currency: 'USD', total_balance: '-1.50' }],
      }),
      'https://api.example.com',
    );
    expect(f.value?.amount).toBe(-1.5);
  });
});
