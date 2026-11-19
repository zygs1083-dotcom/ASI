// Synthetic history-volume benchmark (see docs/reviews/history-volume-fix.md).
// Not part of `pnpm check`. Run:
//   pnpm -C plugins/asi-sense exec tsx scripts/bench-history-volume.ts          # all scenarios
//   pnpm -C plugins/asi-sense exec tsx scripts/bench-history-volume.ts steady   # steady-day bytes
//   pnpm -C plugins/asi-sense exec tsx scripts/bench-history-volume.ts flush    # 4096-bucket flush lag
import { performance } from 'node:perf_hooks';
import { HistoryManager } from '../src/host/runtime/history/index.ts';
import type { HistoryEventInput } from '../src/host/runtime/history/store.ts';
import type { HistoryStoragePort } from '../src/host/runtime/history/types.ts';

const MiB = 1024 * 1024;
const DAY_MINUTES = 1440;
const ACTIVE_MINUTES = 480;
const FLUSH_BUCKETS = 4096;

function memoryPort(): { port: HistoryStoragePort; files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    port: {
      eventFileSize: async (date) => Buffer.byteLength(files.get(date) ?? '', 'utf8'),
      appendEvent: async (date, line) => {
        files.set(date, (files.get(date) ?? '') + line);
      },
      readEvents: async (date) => files.get(date),
      listEventDates: async () => [...files.keys()],
      deleteEventDate: async (date) => {
        files.delete(date);
      },
      readDaily: async () => undefined,
      writeDaily: async () => {},
      listDailyDates: async () => [],
      deleteDailyDate: async () => {},
      readMonthly: async () => undefined,
      writeMonthly: async () => {},
      listMonthlyMonths: async () => [],
      clearAll: async () => {
        files.clear();
      },
    },
  };
}

function manager(port: HistoryStoragePort, wall: () => number, mono: () => number): HistoryManager {
  return new HistoryManager({
    port,
    clock: { wall, mono },
    isPaused: () => false,
    titlesAllowed: () => false,
    restoreEntries: () => {},
    clearMemoryEntries: () => {},
    emitSourceError: () => {},
    emitSourceOk: () => {},
    timeZone: 'UTC',
  });
}

function fileActivity(id: string, dir: string, at: number): HistoryEventInput {
  return {
    id,
    kind: 'file.activity',
    subject: dir,
    level: 'record',
    cause: 'unknown',
    at,
    source: { id: 'files-global', api: 'watch', host: 'local' },
    detail: { directory: dir, windowMs: 10_000, created: 1, modified: 0, deleted: 0 },
  };
}

function nonFileEvent(id: string, kind: string, at: number): HistoryEventInput {
  return {
    id,
    kind,
    subject: kind === 'app.activated' ? 'CodeForge' : `synthetic-${kind}-subject`,
    level: 'record',
    at,
    source: { id: 'helper', api: 'ax', host: 'local' },
  };
}

// 76 (dir, minute) buckets per active minute: 5 heavy dirs x6, 10 mid dirs
// x2/3 alternating, 61 tail dirs x1 (~112 file.activity events/min).
const HEAVY_DIRS = Array.from({ length: 5 }, (_, i) => `/work/heavy-dir-${i}-${'h'.repeat(40)}`);
const MID_DIRS = Array.from({ length: 10 }, (_, i) => `/work/mid-dir-${i}-${'m'.repeat(40)}`);
const TAIL_DIRS = Array.from({ length: 61 }, (_, i) => `/work/tail-dir-${i}-${'t'.repeat(40)}`);
const LIGHT_DIRS = Array.from({ length: 8 }, (_, i) => `/work/light-dir-${i}-${'l'.repeat(40)}`);
const NON_FILE_KINDS = ['app.activated', 'window.focused', 'window.title-changed'];

function emitActiveMinute(mgr: HistoryManager, minute: number, at: number): void {
  let seq = 0;
  for (const dir of HEAVY_DIRS) {
    for (let i = 0; i < 6; i++) mgr.recordEvent(fileActivity(`fa-${minute}-${seq++}`, dir, at + seq * 400));
  }
  for (const dir of MID_DIRS) {
    for (let i = 0; i < (minute % 2 === 0 ? 2 : 3); i++)
      mgr.recordEvent(fileActivity(`fa-${minute}-${seq++}`, dir, at + seq * 400));
  }
  for (const dir of TAIL_DIRS) {
    mgr.recordEvent(fileActivity(`fa-${minute}-${seq++}`, dir, at + seq * 400));
  }
  for (let i = 0; i < 6; i++) {
    mgr.recordEvent(
      nonFileEvent(`nf-${minute}-${i}`, NON_FILE_KINDS[i % NON_FILE_KINDS.length], at + 30_000 + i * 5_000),
    );
  }
}

function emitLightMinute(mgr: HistoryManager, minute: number, at: number): void {
  for (let i = 0; i < LIGHT_DIRS.length; i++) {
    mgr.recordEvent(fileActivity(`fl-${minute}-${i}`, LIGHT_DIRS[i], at + i * 1_000));
  }
  mgr.recordEvent(nonFileEvent(`nfl-${minute}`, NON_FILE_KINDS[minute % NON_FILE_KINDS.length], at + 30_000));
}

function dayBytes(files: Map<string, string>, date: string): { bytes: number; lines: number; events: number } {
  const content = files.get(date) ?? '';
  const lines = content === '' ? 0 : content.split('\n').length - 1;
  const events = content.split('"record":"event"').length - 1;
  return { bytes: Buffer.byteLength(content, 'utf8'), lines, events };
}

async function benchSteady(): Promise<void> {
  const { port, files } = memoryPort();
  let wall = Date.UTC(2026, 10, 18, 0, 0, 0);
  let mono = 0;
  const mgr = manager(
    port,
    () => wall,
    () => mono,
  );
  await mgr.start(false);
  const date = '2026-11-18';
  const t0 = performance.now();
  for (let minute = 0; minute < DAY_MINUTES; minute++) {
    const at = wall;
    if (minute < ACTIVE_MINUTES) emitActiveMinute(mgr, minute, at);
    else emitLightMinute(mgr, minute, at);
    wall += 60_000;
    mono += 60_000;
    await mgr.tick();
    if (minute === ACTIVE_MINUTES - 1) {
      const { bytes, lines } = dayBytes(files, date);
      console.log(`[steady] 8h mark:  ${(bytes / MiB).toFixed(2)} MiB / ${lines} lines`);
    }
  }
  await mgr.stop();
  const { bytes, lines, events } = dayBytes(files, date);
  // The last tick crosses midnight, so the simulated day is `yesterday`.
  const day = mgr.timelineSnapshots().yesterday;
  console.log(`[steady] 24h mark: ${(bytes / MiB).toFixed(2)} MiB / ${lines} lines (${events} event records)`);
  console.log(
    `[steady] day summary totalEvents=${day?.totalEvents ?? 0} fileActivityDirs=${Object.keys(day?.fileActivity ?? {}).length} ` +
      `truncatedAtLimit=${day?.truncatedAtLimit === true} wallMs=${(performance.now() - t0).toFixed(1)}`,
  );
}

async function benchFlush(): Promise<void> {
  const { port, files } = memoryPort();
  let wall = Date.UTC(2026, 10, 18, 9, 0, 0);
  let mono = 0;
  const mgr = manager(
    port,
    () => wall,
    () => mono,
  );
  await mgr.start(false);
  for (let i = 0; i < FLUSH_BUCKETS; i++) {
    mgr.recordEvent(fileActivity(`b-${i}`, `/work/flush-dir-${i}-${'d'.repeat(40)}`, wall + (i % 1_000)));
  }
  wall += 61_000;
  mono += 61_000;

  const gaps: number[] = [];
  let last = performance.now();
  let sampling = true;
  const pump = (): void => {
    if (!sampling) return;
    const now = performance.now();
    gaps.push(now - last);
    last = now;
    setImmediate(pump);
  };
  setImmediate(pump);
  const t0 = performance.now();
  await mgr.tick();
  const tickTotalMs = performance.now() - t0;
  sampling = false;

  const sorted = [...gaps].sort((a, b) => a - b);
  const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
  const maxGap = sorted[sorted.length - 1] ?? 0;
  const { bytes, lines } = dayBytes(files, '2026-11-18');
  const persisted = (files.get('2026-11-18') ?? '').split('"kind":"file.activity"').length - 1;
  const today = mgr.timelineSnapshots().today;
  console.log(
    `[flush] buckets=${FLUSH_BUCKETS} persisted=${persisted} summaryDirs=${Object.keys(today?.fileActivity ?? {}).length}`,
  );
  console.log(
    `[flush] tickTotalMs=${tickTotalMs.toFixed(1)} maxLoopGapMs=${maxGap.toFixed(2)} p95GapMs=${p95.toFixed(2)} fileBytes=${(bytes / MiB).toFixed(2)} MiB / ${lines} lines`,
  );
  await mgr.stop();
}

const scenario = process.argv[2] ?? 'all';
if (scenario === 'steady' || scenario === 'all') await benchSteady();
if (scenario === 'flush' || scenario === 'all') await benchFlush();
