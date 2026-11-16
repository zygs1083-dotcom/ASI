import * as fact from './fact.js';
import { TOKEN_READ_TIMEOUT_MS } from './probe-options.js';
import type { Fact, TokenSource, TokensValue } from './types.js';

export async function readTokens(source: TokenSource | undefined, ttl: number, signal: AbortSignal): Promise<Fact<TokensValue>> {
  const fallback = (reason: string) => ({ ...fact.fail<TokensValue>('unavailable', fact.source('tokens', 'TokenSource.read'), ttl), reason });
  if (!source || signal.aborted) return fallback(source ? '用量读取已取消' : '未接入用量来源'); // abort may predate this call
  let timer: NodeJS.Timeout | undefined;
  let rejectAbort!: (e: unknown) => void;
  const aborted = new Promise<never>((_res, rej) => { rejectAbort = rej; });
  const onAbort = () => rejectAbort(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    const f = await Promise.race([
      Promise.resolve().then(() => source.read()),
      aborted,
      new Promise<never>((_res, rej) => {
        timer = setTimeout(() => rej(new Error('tokenSource read timeout')), TOKEN_READ_TIMEOUT_MS);
      }),
    ]);
    return f as Fact<TokensValue>;
  } catch {
    return fallback(signal.aborted ? '用量读取已取消' : '用量读取失败');
  } finally {
    signal.removeEventListener('abort', onAbort);
    if (timer) clearTimeout(timer);
  }
}
