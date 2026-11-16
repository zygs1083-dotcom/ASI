import { isSessionContext } from '../attention/buckets.ts';
import { DeliveryFailure } from '../attention/drain.ts';
import type { RuntimeAttention } from './attention.ts';
import type { Clock, DshPort } from './ports.ts';

export function deliveryRetry(
  port: DshPort & { onDeliveryCommitted?: (cb: (sessionId: string) => void) => () => void },
  clock: Clock,
  getAttention: () => RuntimeAttention,
): DshPort {
  let session: string | undefined;
  let degraded = false;
  const retries = new Map<string, { count: number; first: number; next: number }>();
  const ownedRetries = new Map<string, Map<string, { count: number; first: number; next: number }>>();
  const select = (id: string | undefined) => {
    if (session !== id) {
      session = id;
      retries.clear();
    }
  };
  const report = async (status: 'ok' | 'unavailable', error?: string, kind = 'source.status') => {
    const attention = getAttention();
    await attention.accept({
      id: attention.id(),
      kind,
      at: clock.wall(),
      source: { id: 'delivery', api: 'dsh', host: 'local' },
      subject: 'delivery',
      cause: 'agent',
      data: { status, ...(error === undefined ? {} : { error }) },
    });
  };
  return {
    ...port,
    onAgentEvent: (cb) => {
      const offCommitted = port.onDeliveryCommitted?.((id) => {
        if (!degraded || id !== getAttention().current()) return;
        degraded = false;
        void report('ok').catch(() => {
          degraded = true;
        });
      });
      const off = port.onAgentEvent(async (event) => {
        try {
          await cb(event);
        } finally {
          if (event.type === 'disposed') ownedRetries.delete(event.sessionId);
          select(getAttention().current());
        }
      });
      return () => {
        off();
        offCommitted?.();
      };
    },
    deliver: async (sessionId, intent) => {
      const owned = intent.update.changes.some(
        ({ signal }) => isSessionContext(signal) || (signal.source.id === 'dsh' && signal.kind.startsWith('job.')),
      );
      if (!owned) select(sessionId);
      const attempts = owned ? (ownedRetries.get(sessionId) ?? new Map()) : retries;
      if (owned) ownedRetries.set(sessionId, attempts);
      const key = intent.deliveryId ?? JSON.stringify(intent);
      const retry = attempts.get(key);
      const now = clock.mono();
      if (retry && now < retry.next) throw new DeliveryFailure('deferred', retry.next);
      if (retry && now - retry.first >= 600_000) {
        attempts.delete(key);
        degraded = true;
        await report('unavailable', `投递失败，已暂停重试（${retry.count} 次）`);
        throw new DeliveryFailure('exhausted');
      }
      try {
        await port.deliver(sessionId, intent);
      } catch (error) {
        if (error instanceof DeliveryFailure && error.kind === 'unknown') {
          attempts.delete(key);
          degraded = true;
          await report('unavailable', '投递结果未知，未重试', 'delivery-unknown');
          await report('unavailable', '投递结果未知，未重试');
          throw error;
        }
        if (
          owned
            ? !getAttention().hasSession(sessionId)
            : session !== sessionId || getAttention().current() !== sessionId
        )
          throw error;
        const count = (retry?.count ?? 0) + 1;
        const first = retry?.first ?? now;
        if (count >= 10 || clock.mono() - first >= 600_000) {
          attempts.delete(key);
          degraded = true;
          await report('unavailable', `投递失败，已暂停重试（${count} 次）`);
          throw new DeliveryFailure('exhausted', 0, error);
        }
        const next = Math.min(clock.mono() + Math.min(1_000 * 2 ** (count - 1), 60_000), first + 600_000);
        attempts.set(key, { count, first, next });
        degraded = true;
        await report('unavailable', `投递失败，正在重试（${count} 次）`);
        throw new DeliveryFailure('deferred', next, error);
      }
      if (
        owned ? !getAttention().hasSession(sessionId) : session !== sessionId || getAttention().current() !== sessionId
      )
        return;
      attempts.delete(key);
      if (degraded && (intent.kind !== 'inject' || !port.onDeliveryCommitted)) {
        degraded = false;
        await report('ok');
      }
    },
  };
}
