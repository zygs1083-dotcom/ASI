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
  let saves = Promise.resolve();
  let generation = 0;
  let changes = 0;
  let selecting = 0;
  let cancelRestore: (() => void) | undefined;
  const closed = new Map<string, boolean>();
  const invalidate = () => {
    generation++;
    cancelRestore?.();
    cancelRestore = undefined;
  };
  const enqueue = (work: () => Promise<void>) => {
    const run = tail.then(work);
    tail = run.catch(() => {});
    return run;
  };
  const check = () => {
    if (!active) throw new Error('stopped');
  };
  const refresh = async () => {
    if (!port.listSessions) return true;
    const revision = changes;
    const next = await port.listSessions();
    check();
    if (revision !== changes) return false;
    const ids = new Set(next.map((row) => row.id));
    for (const [id, absent] of closed) {
      if (!ids.has(id)) closed.set(id, true);
      else if (absent) closed.delete(id);
    }
    rows = next.filter((row) => !closed.has(row.id));
    lifecycle?.refreshed(rows);
    return true;
  };
  const save = (id: string | undefined) => {
    const run = saves.then(() => storage.save(key, JSON.stringify({ version: 1, sessionId: id ?? null })));
    saves = run.catch(() => {});
    return run;
  };
  const reset = async () => {
    invalidate();
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
  const closeAndReset = (id: string) =>
    Promise.all([lifecycle?.closed(id), selected === id ? reset() : undefined]).then(() => {});
  const subscribe = () => {
    if (off || !port.onSessionsChanged) return;
    off = port.onSessionsChanged((id) => {
      if (!active) return;
      changes++;
      if (id) {
        rows = rows.filter((row) => row.id !== id);
        closed.set(id, false);
        void lifecycle?.closed(id).catch(failed);
        if (selected === id) void reset().catch(failed);
        else changed();
      }
      void enqueue(async () => {
        if (!active) return;
        await recover();
      }).catch(failed);
    });
  };
  const restore = () => {
    if (!active || !selected || applied || cancelRestore || selecting) return;
    const id = selected;
    const revision = generation;
    const current = () => active && generation === revision && selected === id;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const cancelled = new Promise<false>((resolve) => {
      cancelRestore = () => resolve(false);
    });
    const expired = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('session restore timed out')), 10_000);
      timeout.unref?.();
    });
    void (async () => {
      try {
        const restored = await Promise.race([
          Promise.resolve()
            .then(() => (current() ? port.ensureSession?.(id) : undefined))
            .then(() => true),
          cancelled,
          expired,
        ]);
        if (!restored || !current()) return;
        applied = true;
        try {
          await apply(id);
        } catch (error) {
          if (current()) {
            applied = false;
            await apply(undefined);
          }
          throw error;
        }
        if (!current()) return;
        unavailable = false;
        retryDelay = 1_000;
        changed();
      } catch (error) {
        if (!current()) return;
        applied = false;
        if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'session/not-found') {
          void closeAndReset(id).catch(failed);
        } else {
          failed();
        }
      } finally {
        if (timeout) clearTimeout(timeout);
        if (current()) cancelRestore = undefined;
      }
    })().catch(failed);
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
    if (selected && closed.has(selected)) {
      void closeAndReset(selected).catch(failed);
    }
    if (pendingClear) {
      await save(undefined);
      check();
      pendingClear = false;
    }
    if (!(await refresh())) return;
    if (selected && (closed.has(selected) || !rows.some((row) => row.id === selected))) {
      void closeAndReset(selected).catch(failed);
    } else if (selected && !applied && !lazy) {
      restore();
    }
    if (!selected || applied) {
      unavailable = false;
      retryDelay = 1_000;
    }
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
      subscribe();
      void enqueue(recover).catch(failed);
    },
    select(id: string | undefined): Promise<void> {
      invalidate();
      selecting++;
      const revision = generation;
      const valid = () => {
        check();
        if (revision !== generation) throw new Error('target selection superseded');
      };
      return enqueue(async () => {
        valid();
        if (!(await refresh())) throw new Error('session list changed');
        valid();
        if (id && !rows.some((row) => row.id === id)) throw new Error('target session unavailable');
        if (id) await port.ensureSession?.(id);
        valid();
        const previous = selected;
        await save(id);
        if (revision !== generation) {
          if (active) await save(selected);
          valid();
        }
        valid();
        try {
          await apply(id);
          valid();
        } catch (error) {
          if (active && revision === generation) {
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
      }).finally(() => {
        selecting--;
        if (!selecting && active && selected && !applied && !lazy && !cancelRestore) failed();
      });
    },
    unload(id: string): void {
      if (selected === id) {
        invalidate();
        applied = false;
        lazy = true;
      }
    },
    canEnsure: () => active && !!selected && !applied,
    ensure(): void {
      if (!active || !selected || applied || !lazy) return;
      lazy = false;
      restore();
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
      invalidate();
      if (timer) clearTimeout(timer);
      timer = undefined;
      off?.();
      await saves;
    },
  };
}
