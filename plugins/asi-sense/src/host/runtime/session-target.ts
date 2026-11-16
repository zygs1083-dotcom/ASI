import type { DshPort, SessionRow, StoragePort } from './ports.ts';

export function createSessionTarget(
  port: Pick<DshPort, 'listSessions' | 'ensureSession' | 'onSessionsChanged'>,
  storage: StoragePort,
  key: string,
  apply: (id: string | undefined) => Promise<void>,
  recordReset: () => void,
  changed: () => void,
  lifecycle?: { closed: (id: string) => Promise<void>; refreshed: (rows: SessionRow[]) => void },
) {
  let rows: SessionRow[] = [];
  let selected: string | undefined;
  let notice = false;
  let unavailable = false;
  let active = false;
  let loaded = false;
  let applied = false;
  let lazy = false;
  let pendingClear = false;
  let retryDelay = 1_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let off: (() => void) | undefined;
  let tail = Promise.resolve();
  const enqueue = (work: () => Promise<void>) => {
    const run = tail.then(work);
    tail = run.catch(() => {});
    return run;
  };
  const check = () => {
    if (!active) throw new Error('stopped');
  };
  const refresh = async () => {
    if (!port.listSessions) return;
    const next = await port.listSessions();
    check();
    rows = next;
    lifecycle?.refreshed(rows);
  };
  const save = (id: string | undefined) => storage.save(key, JSON.stringify({ version: 1, sessionId: id ?? null }));
  const reset = async () => {
    selected = undefined;
    applied = false;
    lazy = false;
    notice = true;
    pendingClear = true;
    recordReset();
    changed();
    const results = await Promise.allSettled([
      apply(undefined),
      save(undefined).then(() => {
        pendingClear = false;
      }),
    ]);
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed) throw failed.reason;
    check();
  };
  const subscribe = () => {
    if (off || !port.onSessionsChanged) return;
    off = port.onSessionsChanged((closed) => {
      void enqueue(async () => {
        if (!active) return;
        if (closed) await lifecycle?.closed(closed);
        if (selected && closed === selected) await reset();
        await recover();
      }).catch(failed);
    });
  };
  const recover = async () => {
    subscribe();
    if (!loaded) {
      const text = await storage.load(key);
      check();
      if (text !== undefined) {
        const data: unknown = JSON.parse(text);
        if (
          !data ||
          typeof data !== 'object' ||
          !('version' in data) ||
          data.version !== 1 ||
          !('sessionId' in data) ||
          (data.sessionId !== null && typeof data.sessionId !== 'string')
        )
          throw new TypeError('invalid delivery target');
        selected = data.sessionId ?? undefined;
      }
      loaded = true;
    }
    if (pendingClear) {
      await save(undefined);
      check();
      pendingClear = false;
    }
    await refresh();
    if (selected && !rows.some((row) => row.id === selected)) {
      await lifecycle?.closed(selected);
      await reset();
    } else if (selected && !applied && !lazy) {
      try {
        await port.ensureSession?.(selected);
      } catch (error) {
        check();
        if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'session/not-found')
          throw error;
        await lifecycle?.closed(selected);
        await reset();
      }
      check();
      if (selected) {
        try {
          await apply(selected);
        } catch (error) {
          await apply(undefined);
          throw error;
        }
        check();
        applied = true;
      }
    }
    unavailable = false;
    retryDelay = 1_000;
    changed();
  };
  const failed = () => {
    if (!active) return;
    unavailable = true;
    changed();
    if (timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      void enqueue(recover).catch(failed);
    }, retryDelay);
    timer.unref?.();
    retryDelay = Math.min(retryDelay * 2, 60_000);
  };
  return {
    async start(): Promise<void> {
      active = true;
      await enqueue(recover).catch(failed);
    },
    select(id: string | undefined): Promise<void> {
      return enqueue(async () => {
        check();
        await refresh();
        if (id && !rows.some((row) => row.id === id)) throw new Error('target session unavailable');
        if (id) await port.ensureSession?.(id);
        check();
        const previous = selected;
        await save(id);
        check();
        try {
          await apply(id);
          check();
        } catch (error) {
          if (active) {
            const rollback = await Promise.allSettled([apply(previous), save(previous)]);
            const failed = rollback.find((result): result is PromiseRejectedResult => result.status === 'rejected');
            if (failed) throw new AggregateError([error, failed.reason], 'target selection rollback failed');
          }
          throw error;
        }
        selected = id;
        loaded = true;
        applied = !!id;
        lazy = false;
        pendingClear = false;
        notice = false;
        changed();
      });
    },
    unload(id: string): void {
      if (selected === id) {
        applied = false;
        lazy = true;
      }
    },
    canEnsure: () => active && !!selected && !applied && lazy,
    ensure(): Promise<void> {
      return enqueue(async () => {
        if (!active || !selected || applied || (!lazy && unavailable)) return;
        lazy = false;
        await recover().catch(failed);
      });
    },
    dismiss(): void {
      notice = false;
      changed();
    },
    snapshot() {
      return {
        mode: selected ? ('pinned' as const) : ('auto' as const),
        ...(selected ? { sessionId: selected } : {}),
        sessions: rows.map((row) => ({ ...row })),
        ...(notice ? { notice } : {}),
        ...(unavailable ? { unavailable } : {}),
      };
    },
    settled: () => tail,
    async stop(): Promise<void> {
      active = false;
      if (timer) clearTimeout(timer);
      timer = undefined;
      off?.();
      await tail;
    },
  };
}
