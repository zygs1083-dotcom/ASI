import { describe, expect, it, vi } from 'vitest';
import { readTokens } from '../src/token-reader.js';

describe('readTokens reasons', () => {
  it('explains a missing source without claiming there is no active session', async () => {
    const result = await readTokens(undefined, 6000, new AbortController().signal);
    expect(result).toMatchObject({ status: 'unavailable', reason: '未接入用量来源' });
  });
  it('explains a failed source without exposing its exception', async () => {
    const source = {
      read: vi.fn(async () => {
        throw new Error('private details');
      }),
    };
    const result = await readTokens(source, 6000, new AbortController().signal);
    expect(result).toMatchObject({ status: 'unavailable', reason: '用量读取失败' });
    expect(JSON.stringify(result)).not.toContain('private details');
  });
});
