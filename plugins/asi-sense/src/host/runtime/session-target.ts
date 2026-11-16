import type { DshPort, SessionRow, StoragePort } from './ports.ts';

export function createSessionTarget(
  port: Pick<DshPort, 'listSessions' | 'ensureSession' | 'onSessionsChanged'>,
  storage: StoragePort,
  key: string,
  apply: (id: string | undefined) => Promise<void>,
  recordReset: () => void,
  changed: () => void,
) {
  let rows: SessionRow[] = [];
  let selected: string | undefined;
  let notice = false;
  let unavailable = false;
  let active = false;
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
    unavailable = false;
  };
  const save = (id: string | undefined) => storage.save(key, JSON.stringify({ version: 1, sessionId: id ?? null }));
  const reset = async () => {
    selected = undefined;
    notice = true;
    recordReset();
    changed();
    const results = await Promise.allSettled([apply(undefined), save(undefined)]);
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failed) throw failed.reason;
    check();
  };
  return {
    async start(): Promise<void> {
      active = true;
      off = port.onSessionsChanged?.((closed) => {
        void enqueue(async () => {
          if (!active) return;
          if (selected && closed === selected) await reset();
          await refresh();
          if (selected && !rows.some((row) => row.id === selected)) await reset();
          changed();
        }).catch(() => {
          if (active) {
            unavailable = true;
            changed();
          }
        });
      });
      await enqueue(async () => {
        await refresh();
        const text = await storage.load(key);
        check();
        if (text === undefined) return;
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
        if (data.sessionId === null) return;
        if (!rows.some((row) => row.id === data.sessionId)) {
          await reset();
          return;
        }
        await port.ensureSession?.(data.sessionId);
        check();
        await apply(data.sessionId);
        check();
        selected = data.sessionId;
      });
      changed();
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
        notice = false;
        changed();
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
      off?.();
      await tail;
    },
  };
}
