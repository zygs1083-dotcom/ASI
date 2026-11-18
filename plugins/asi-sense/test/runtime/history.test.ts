import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { Signal, WatchRule } from '@asi/sense-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileHistoryStoragePort } from '../../src/host/dsh/history-storage.ts';
import { RuntimeAttention } from '../../src/host/runtime/attention.ts';
import { FactExpiry } from '../../src/host/runtime/expiry.ts';
import {
  addDays,
  type DailySummary,
  HistoryManager,
  LocalCalendar,
  MAX_DAILY_EVENT_BYTES,
  type MonthlySummary,
  parseHistoryLines,
  summarizeDay,
} from '../../src/host/runtime/history/index.ts';
import {
  createSenseRuntime,
  type DshPort,
  type HistoryStoragePort,
  type JobEvent,
} from '../../src/host/runtime/index.ts';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'asi-hist-runtime-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function createRuntimeHarness(opts: {
  nowMs: number;
  history?: HistoryStoragePort;
  timeZone?: string;
  rules?: WatchRule[];
  deliver?: DshPort['deliver'];
  withHelper?: boolean;
}) {
  let wallMs = opts.nowMs;
  let monoMs = 1_000;
  let helperOut: PassThrough | undefined;
  let jobCb: ((event: JobEvent) => Promise<void>) | undefined;
  const saved = new Map<string, string>();
  const delivered: string[] = [];
  const withHelper = opts.withHelper ?? false;

  const deliver: DshPort['deliver'] =
    opts.deliver ??
    (async (_sessionId, intent) => {
      for (const change of intent.update.changes) {
        delivered.push(change.signal.id);
      }
    });

  const runtime = createSenseRuntime(
    {
      clock: { wall: () => wallMs, mono: () => monoMs },
      history: opts.history,
      storage: {
        load: async (key) => saved.get(key),
        save: async (key, json) => {
          saved.set(key, json);
        },
      },
      dsh: {
        listSessions: async () => [{ id: 's1', title: 'Synthetic', updatedAt: wallMs, running: true }],
        onAgentEvent: () => () => {},
        onTool: () => () => {},
        onJob: (cb) => {
          jobCb = cb;
          return () => {};
        },
        deliver,
        tokenSnapshot: async () => undefined,
      },
      helper: {
        spawn: () => {
          if (!withHelper) return undefined;
          const child = new EventEmitter() as EventEmitter & {
            stdin: PassThrough;
            stdout: PassThrough;
            stderr: PassThrough;
            pid: number;
            killed: boolean;
            kill: () => boolean;
          };
          child.stdin = new PassThrough();
          child.stdout = new PassThrough();
          child.stderr = new PassThrough();
          child.pid = 4242;
          child.killed = false;
          child.kill = () => {
            child.killed = true;
            child.stdout.end();
            child.stderr.end();
            child.emit('exit', 0, null);
            child.emit('close', 0, null);
            return true;
          };
          helperOut = child.stdout;
          return child as never;
        },
      },
      probe: {
        create: () => ({
          onSample: () => () => {},
          start: () => {},
          stop: async () => {},
        }),
      },
      files: {
        watch: () => ({ close: () => {} }),
      },
    },
    {
      platform: withHelper ? 'darwin' : 'linux',
      ...(withHelper ? { helperPath: '/synthetic/asi-helper' } : {}),
      timeZone: opts.timeZone ?? 'UTC',
      intervalMs: 600_000,
      rules: opts.rules,
    },
  );

  return {
    runtime,
    delivered,
    setTime(wall: number, mono?: number) {
      wallMs = wall;
      if (mono !== undefined) monoMs = mono;
    },
    advance(deltaMs: number) {
      wallMs += deltaMs;
      monoMs += deltaMs;
    },
    async emitHelper(line: Record<string, unknown>) {
      helperOut?.write(`${JSON.stringify({ v: 1, ...line })}\n`);
    },
    async emitJob(event: JobEvent) {
      await jobCb?.(event);
    },
  };
}

describe('runtime history persistence, rollups, retention, and recovery', () => {
  it('persists events by local calendar date, prunes >30d files, and restores <=200 entries with restored=true and zero re-entry', async () => {
    const dir = await makeTempDir();
    const port = new FileHistoryStoragePort(dir);
    // 2026-11-10 23:30 UTC is 2026-11-11 07:30 in Asia/Shanghai -> must route to local date 2026-11-11!
    const startWall = Date.UTC(2026, 10, 10, 23, 30, 0);
    const localToday = '2026-11-11';

    // Seed expired >30d and borderline 30d event files
    await port.appendEvent(
      addDays(localToday, -45),
      `${JSON.stringify({ record: 'event', id: 'old-45', kind: 'app.activated', subject: 'OldApp', level: 'record', at: startWall - 45 * 86_400_000, source: { id: 'helper', api: 'nsworkspace', host: 'local' } })}\n`,
    );
    await port.appendEvent(
      addDays(localToday, -31),
      `${JSON.stringify({ record: 'event', id: 'old-31', kind: 'app.activated', subject: 'OldApp', level: 'record', at: startWall - 31 * 86_400_000, source: { id: 'helper', api: 'nsworkspace', host: 'local' } })}\n`,
    );
    const kept30Date = addDays(localToday, -30);
    await port.appendEvent(
      kept30Date,
      `${JSON.stringify({ record: 'event', id: 'keep-30', kind: 'app.activated', subject: 'KeepApp', level: 'record', at: startWall - 30 * 86_400_000, source: { id: 'helper', api: 'nsworkspace', host: 'local' } })}\n`,
    );

    // Seed 230 recent events yesterday; newest 200 should be restored cleanly.
    const seededYesterday: string[] = [];
    for (let i = 0; i < 230; i++) {
      seededYesterday.push(
        JSON.stringify({
          record: 'event',
          id: `seed-${i}`,
          kind: 'app.activated',
          subject: `App${i % 3}`,
          level: i === 225 ? 'record' : 'wake',
          at: startWall - (300 - i) * 1_000,
          source: { id: 'helper.frontApp', api: 'nsworkspace', host: 'local' },
          feedbackAvailable: i === 225,
        }),
      );
    }
    seededYesterday.push(JSON.stringify({ record: 'patch', id: 'seed-225', level: 'wake', reason: 'delivered' }));
    await port.appendEvent(addDays(localToday, -1), `${seededYesterday.join('\n')}\n`);

    const deliver = vi.fn(async () => {});
    const rules: WatchRule[] = [
      { id: 'wake-app', match: { kind: 'app.activated' }, level: 'wake', createdBy: 'user', approved: true },
    ];
    const h = createRuntimeHarness({
      nowMs: startWall,
      history: port,
      timeZone: 'Asia/Shanghai',
      rules,
      deliver,
      withHelper: true,
    });
    await h.runtime.start();

    // 31d & 45d pruned, 30d & -1d kept
    const datesAfterStart = await port.listEventDates();
    expect(datesAfterStart).toContain(kept30Date);
    expect(datesAfterStart).toContain(addDays(localToday, -1));
    expect(datesAfterStart).toContain(localToday);
    expect(datesAfterStart).not.toContain(addDays(localToday, -31));
    expect(datesAfterStart).not.toContain(addDays(localToday, -45));

    // Restored buffer has newest 200 entries with restored=true, patched fields kept, zero deliveries triggered
    const restoredEvents = h.runtime.events();
    expect(restoredEvents).toHaveLength(200);
    expect(restoredEvents[0].id).toBe('seed-30');
    expect(restoredEvents[199].id).toBe('seed-229');
    expect(restoredEvents.every((ev) => ev.restored === true)).toBe(true);
    expect(restoredEvents.find((ev) => ev.id === 'seed-225')).toMatchObject({ level: 'wake', reason: 'delivered' });
    expect(deliver).not.toHaveBeenCalled();

    // Now send helper hello + live app.activated -> routes to Asia/Shanghai local date (2026-11-11), not UTC (2026-11-10)
    await h.emitHelper({
      type: 'hello',
      at: startWall + 2_000,
      version: '0.1.0',
      pid: 4242,
      session: 'fixture-session',
      permissions: { accessibility: 'granted' },
    });
    await h.emitHelper({
      type: 'app.activated',
      at: startWall + 5_000,
      name: 'StudioApp',
      bundleId: 'com.example.Studio',
      pid: 99,
    });
    await vi.waitFor(() => expect(h.runtime.events().some((ev) => ev.subject === 'StudioApp')).toBe(true), {
      timeout: 2_000,
      interval: 5,
    });
    expect(h.runtime.events()).toHaveLength(200);
    expect(h.runtime.events().at(-1)?.restored).toBeUndefined();

    await h.runtime.stop();
    const todayRaw = await port.readEvents(localToday);
    const yesterdayRaw = await port.readEvents(addDays(localToday, -1));
    expect(todayRaw).toContain('StudioApp');
    expect(yesterdayRaw).not.toContain('StudioApp');
  });

  it('caps single-day log growth at 20 MB, emits one source.error without recursion, and resumes next day', async () => {
    const startWall = Date.UTC(2026, 10, 12, 10, 0, 0);
    let simulatedSizeDay1 = MAX_DAILY_EVENT_BYTES - 80;
    let simulatedSizeDay2 = 0;
    const appended: Array<{ date: string; line: string }> = [];

    const cappedPort: HistoryStoragePort = {
      async eventFileSize(date) {
        return date === '2026-11-12' ? simulatedSizeDay1 : simulatedSizeDay2;
      },
      async appendEvent(date, line) {
        appended.push({ date, line });
        const bytes = Buffer.byteLength(line, 'utf8');
        if (date === '2026-11-12') simulatedSizeDay1 += bytes;
        else simulatedSizeDay2 += bytes;
      },
      async readEvents() {
        return undefined;
      },
      async listEventDates() {
        return ['2026-11-12'];
      },
      async deleteEventDate() {},
      async readDaily() {
        return undefined;
      },
      async writeDaily() {},
      async listDailyDates() {
        return [];
      },
      async deleteDailyDate() {},
      async readMonthly() {
        return undefined;
      },
      async writeMonthly() {},
      async listMonthlyMonths() {
        return [];
      },
      async clearAll() {},
    };

    const h = createRuntimeHarness({ nowMs: startWall, history: cappedPort, timeZone: 'UTC' });
    await h.runtime.start();

    for (let i = 0; i < 4; i++) {
      await h.emitJob({
        type: 'started',
        id: `big-${i}-${'x'.repeat(60)}`,
        sessionId: 's1',
        command: 'echo synthetic',
        at: startWall + (i + 1) * 1_000,
      });
    }
    await vi.waitFor(
      () =>
        expect(
          h.runtime
            .events()
            .filter(
              (e) =>
                e.kind === 'source.error' && e.source.id === 'history' && e.reason?.includes('daily-limit-exceeded'),
            ),
        ).toHaveLength(1),
      { timeout: 2_000, interval: 5 },
    );
    await h.runtime.tools.envHistory({});
    expect(simulatedSizeDay1).toBeLessThanOrEqual(MAX_DAILY_EVENT_BYTES);

    // Move to next day: wait for async StateStore acceptance into memory before flushing history queue
    const nextDayMs = Date.UTC(2026, 10, 13, 0, 5, 0);
    h.setTime(nextDayMs, 50_000);
    await h.emitJob({
      type: 'started',
      id: 'next-day-job',
      sessionId: 's1',
      command: 'echo next-day',
      at: nextDayMs,
    });
    await vi.waitFor(
      () => {
        const list = h.runtime.events().map((e) => ({ id: e.id, kind: e.kind, subject: e.subject, at: e.at }));
        expect(list).toContainEqual(expect.objectContaining({ subject: 'echo next-day' }));
      },
      { timeout: 1_500, interval: 50 },
    );
    await h.runtime.tools.envHistory({});
    expect(appended.some((item) => item.date === '2026-11-13' && item.line.includes('echo next-day'))).toBe(true);

    await h.runtime.stop();
  });

  it('degrades cleanly on disk write failure without interrupting sensing, and recovers when writes succeed', async () => {
    const dir = await makeTempDir();
    const basePort = new FileHistoryStoragePort(dir);
    let failWrites = true;
    const port: HistoryStoragePort = {
      eventFileSize: (d) => basePort.eventFileSize(d),
      appendEvent: async (date, line) => {
        if (failWrites) throw Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' });
        return basePort.appendEvent(date, line);
      },
      readEvents: (d) => basePort.readEvents(d),
      listEventDates: () => basePort.listEventDates(),
      deleteEventDate: (d) => basePort.deleteEventDate(d),
      readDaily: (d) => basePort.readDaily(d),
      writeDaily: (d, json) => basePort.writeDaily(d, json),
      listDailyDates: () => basePort.listDailyDates(),
      deleteDailyDate: (d) => basePort.deleteDailyDate(d),
      readMonthly: (m) => basePort.readMonthly(m),
      writeMonthly: (m, json) => basePort.writeMonthly(m, json),
      listMonthlyMonths: () => basePort.listMonthlyMonths(),
      clearAll: () => basePort.clearAll(),
    };

    const startWall = Date.UTC(2026, 10, 12, 9, 0, 0);
    const h = createRuntimeHarness({ nowMs: startWall, history: port, timeZone: 'UTC' });
    await h.runtime.start();

    await h.emitJob({ type: 'started', id: 'job-fail-1', sessionId: 's1', at: startWall + 1_000 });
    await h.emitJob({ type: 'started', id: 'job-fail-2', sessionId: 's1', at: startWall + 2_000 });
    await vi.waitFor(
      () =>
        expect(h.runtime.events().filter((e) => e.kind === 'source.error' && e.source.id === 'history')).toHaveLength(
          1,
        ),
      { timeout: 2_000, interval: 5 },
    );
    expect(h.runtime.events().some((e) => e.subject === 'job-fail-1')).toBe(true);
    expect(h.runtime.events().some((e) => e.subject === 'job-fail-2')).toBe(true);

    // Restore writes -> emits source.status ok and persists subsequent events
    failWrites = false;
    await h.emitJob({ type: 'started', id: 'job-ok-3', sessionId: 's1', at: startWall + 3_000 });
    await vi.waitFor(
      () => expect(h.runtime.events().some((e) => e.kind === 'source.status' && e.source.id === 'history')).toBe(true),
      { timeout: 2_000, interval: 5 },
    );
    await h.runtime.tools.envHistory({});
    const saved = await basePort.readEvents('2026-11-12');
    expect(saved).toContain('job-ok-3');

    failWrites = true;
    await expect(h.runtime.stop()).resolves.toBeUndefined();
  });

  it('generates midnight daily summary with app duration, pauses, deliveries, file.burst, file.activity, body anomalies, and crash gap truncation', async () => {
    vi.useFakeTimers();
    const dir = await makeTempDir();
    const port = new FileHistoryStoragePort(dir);
    const dayStart = Date.UTC(2026, 10, 10, 0, 0, 0);
    let wallMs = Date.UTC(2026, 10, 10, 22, 0, 0);
    let monoMs = 1_000;
    let paused = false;

    const expiry = new FactExpiry({ wall: () => wallMs, mono: () => monoMs });
    const dsh: DshPort = {
      onAgentEvent: () => () => {},
      onTool: () => () => {},
      onJob: () => () => {},
      deliver: async () => {},
      tokenSnapshot: async () => undefined,
    };
    const rules: WatchRule[] = [
      { id: 'r-wake', match: { kind: 'file.burst' }, level: 'wake', createdBy: 'user', approved: true },
      { id: 'r-ctx', match: { kind: 'body.threshold' }, level: 'context', createdBy: 'user', approved: true },
    ];

    let attentionRef: RuntimeAttention | undefined;
    const history = new HistoryManager({
      port,
      clock: { wall: () => wallMs, mono: () => monoMs },
      isPaused: () => paused,
      titlesAllowed: () => true,
      restoreEntries: (entries) => attentionRef?.restoreEntries(entries),
      clearMemoryEntries: () => attentionRef?.clearEvents(),
      emitSourceError: () => {},
      emitSourceOk: () => {},
      timeZone: 'UTC',
    });
    const attention = new RuntimeAttention(
      { wall: () => wallMs, mono: () => monoMs },
      dsh,
      () => rules,
      () => {},
      () => true,
      () => {},
      expiry,
      undefined,
      undefined,
      history,
    );
    attentionRef = attention;
    attention.create('s1');
    await attention.setTarget('s1');
    await history.start(false);

    // 22:00 -> 22:30 AlphaEditor active (30m)
    await attention.accept({
      id: 'app-alpha',
      kind: 'app.activated',
      at: wallMs,
      source: { id: 'helper.frontApp', api: 'nsworkspace', host: 'local' },
      subject: 'com.example.Alpha',
      data: { name: 'AlphaEditor', bundleId: 'com.example.Alpha' },
    });

    // 22:30 -> 23:00 Paused (30m)
    wallMs += 30 * 60_000;
    monoMs += 30 * 60_000;
    paused = true;
    history.setPaused(true, wallMs);

    // 23:00 -> 24:00 Resumed & BetaTerm active (60m until midnight)
    wallMs += 30 * 60_000;
    monoMs += 30 * 60_000;
    paused = false;
    history.setPaused(false, wallMs);
    await attention.accept({
      id: 'app-beta',
      kind: 'app.activated',
      at: wallMs,
      source: { id: 'helper.frontApp', api: 'nsworkspace', host: 'local' },
      subject: 'com.example.Beta',
      data: { name: 'BetaTerm', bundleId: 'com.example.Beta' },
    });

    const evAt = wallMs + 30 * 60_000;
    wallMs = evAt;
    monoMs += 30 * 60_000;
    const sampleSignals: Signal[] = [
      {
        id: 'burst-1',
        kind: 'file.burst',
        at: evAt,
        source: { id: 'files', api: 'watch', host: 'local' },
        subject: '/Users/dev/project-x',
        data: {
          directory: '/Users/dev/project-x',
          created: 4,
          modified: 2,
          deleted: 1,
          externalDeletionExceeded: true,
        },
      },
      {
        id: 'act-1',
        kind: 'file.activity',
        at: evAt + 1_000,
        source: { id: 'files', api: 'watch', host: 'local' },
        subject: '/Users/dev/project-x',
        data: { dir: '/Users/dev/project-x', created: 3, modified: 5, deleted: 2 },
      },
      {
        id: 'thresh-warn',
        kind: 'body.threshold',
        at: evAt + 2_000,
        source: { id: 'body', api: 'probe', host: 'local' },
        subject: 'memory',
        data: { severity: 'warn', value: 0.85 },
      },
      {
        id: 'thresh-normal',
        kind: 'body.threshold',
        at: evAt + 3_000,
        source: { id: 'body', api: 'probe', host: 'local' },
        subject: 'memory',
        data: { severity: 'normal', value: 0.5 },
      },
      {
        id: 'rate-crit',
        kind: 'body.rate',
        at: evAt + 4_000,
        source: { id: 'body', api: 'probe', host: 'local' },
        subject: 'rate:disk-drop:disk:/tmp/vol-a',
        data: { metric: 'disk:/tmp/vol-a', severity: 'critical', slope: -10, delta: -200, windowMs: 60_000 },
      },
      {
        id: 'anom-warn',
        kind: 'body.anomaly',
        at: evAt + 5_000,
        source: { id: 'body', api: 'probe', host: 'local' },
        subject: 'anomaly:cpu',
        data: {
          type: 'anomaly',
          metric: 'cpu',
          severity: 'warn',
          value: 3,
          baseline: 1,
          deviation: 2,
          k: 3,
          confidence: 'high',
          dates: 5,
        },
      },
      {
        id: 'rebaseline:cpu',
        kind: 'body.anomaly',
        at: evAt + 6_000,
        source: { id: 'body', api: 'probe', host: 'local' },
        subject: 'rebaseline:cpu',
        data: {
          type: 'rebaseline-suggestion',
          metric: 'cpu',
          severity: 'warn',
          value: 3,
          baseline: 1,
          deviation: 2,
          k: 3,
          confidence: 'high',
          dates: 5,
        },
      },
    ];
    for (const sig of sampleSignals) await attention.accept(sig);
    // Persist user feedback on a live alert so patch durability is also covered in daily/restore flow
    attention.feedback('thresh-warn', 'useful');
    monoMs += 5_000;
    await attention.flush();

    // Emit 23:55:00 heartbeat so rollover sees continuous runtime at midnight (within 10m gap)
    wallMs = dayStart + 86_400_000 - 300_000;
    monoMs += 25 * 60_000;
    await history.tick();

    wallMs = dayStart + 86_400_000 + 5_000;
    monoMs += 305_000;
    await history.tick();
    await history.stop();
    await attention.stop();

    const parsedDay1 = parseHistoryLines((await port.readEvents('2026-11-10')) ?? '');
    expect(parsedDay1.events.find((e) => e.id === 'thresh-warn')?.feedback).toBe('useful');

    const dailyRaw = await port.readDaily('2026-11-10');
    expect(dailyRaw).toBeDefined();
    const daily = JSON.parse(dailyRaw ?? '') as DailySummary;

    expect(daily.apps.AlphaEditor).toEqual({ foregroundMs: 30 * 60_000, switches: 1 });
    expect(daily.apps.BetaTerm).toEqual({ foregroundMs: 60 * 60_000, switches: 1 });
    expect(daily.appSwitches).toBe(2);
    expect(daily.coverage.observedMs).toBe(90 * 60_000);
    expect(daily.coverage.pausedMs).toBe(30 * 60_000);
    expect(daily.coverage.notRunningMs).toBe(22 * 3_600_000);
    expect(daily.coverage.observedMs + daily.coverage.pausedMs + daily.coverage.notRunningMs).toBe(86_400_000);

    expect(daily.fileBursts['project-x']).toEqual({
      events: 1,
      created: 4,
      modified: 2,
      deleted: 1,
      externalDeletionExceeded: 1,
    });
    expect(daily.fileActivity['project-x']).toEqual({
      events: 1,
      created: 3,
      modified: 5,
      deleted: 2,
    });
    expect(daily.bodyAnomalies).toEqual({
      total: 3,
      threshold: 1,
      rate: 1,
      anomaly: 1,
      byMetric: {
        memory: 1,
        'disk:vol-a': 1,
        cpu: 1,
      },
    });
    expect(daily.deliveries.wake).toBe(1);
    expect(daily.deliveries.byRule['r-wake']?.wake).toBe(1);
    expect(daily.deliveries.context).toBe(2);
    expect(daily.deliveries.byRule['r-ctx']?.context).toBe(2);

    const day2Parsed = parseHistoryLines((await port.readEvents('2026-11-11')) ?? '');
    expect(day2Parsed.lifecycle[0]).toMatchObject({ state: 'active', at: dayStart + 86_400_000, app: 'BetaTerm' });

    const crashBounds = new LocalCalendar('UTC').dayBounds('2026-11-14');
    const crashParsed = parseHistoryLines(
      [
        JSON.stringify({ record: 'lifecycle', state: 'active', at: crashBounds.startMs + 9 * 3_600_000, boot: true }),
        JSON.stringify({
          record: 'lifecycle',
          state: 'heartbeat',
          at: crashBounds.startMs + 9 * 3_600_000 + 300_000,
          paused: false,
        }),
        JSON.stringify({ record: 'lifecycle', state: 'active', at: crashBounds.startMs + 11 * 3_600_000, boot: true }),
        JSON.stringify({ record: 'lifecycle', state: 'stopped', at: crashBounds.startMs + 12 * 3_600_000 }),
      ].join('\n'),
    );
    const crashSummary = summarizeDay('2026-11-14', crashParsed, crashBounds);
    expect(crashSummary.coverage.observedMs).toBe(65 * 60_000);
    expect(crashSummary.coverage.notRunningMs).toBe(24 * 3_600_000 - 65 * 60_000);
  });

  it('backfills missing dailies on startup only when raw events exist, prunes >400d dailies, and synthesizes 31-day month from dailies even when raw events expired', async () => {
    const dir = await makeTempDir();
    const port = new FileHistoryStoragePort(dir);
    const now = Date.UTC(2026, 11, 5, 10, 0, 0);

    const octBoundsCalendar = new LocalCalendar('UTC');
    for (let day = 1; day <= 31; day++) {
      if (day === 15) continue;
      const date = `2026-10-${String(day).padStart(2, '0')}`;
      const bounds = octBoundsCalendar.dayBounds(date);
      const summary: DailySummary = {
        version: 1,
        date,
        dayStartMs: bounds.startMs,
        dayEndMs: bounds.endMs,
        dayDurationMs: bounds.durationMs,
        apps: { Notes: { foregroundMs: 10_000, switches: 1 } },
        appSwitches: 1,
        deliveries: { wake: 1, context: 0, suppressed: 0, byRule: { r1: { wake: 1, context: 0, suppressed: 0 } } },
        fileBursts: {},
        fileActivity: {},
        bodyAnomalies: { total: 0, threshold: 0, rate: 0, anomaly: 0, byMetric: {} },
        coverage: { observedMs: 10_000, pausedMs: 0, notRunningMs: bounds.durationMs - 10_000 },
        totalEvents: 1,
      };
      await port.writeDaily(date, JSON.stringify(summary));
    }

    await port.appendEvent(
      '2026-12-03',
      `${JSON.stringify({ record: 'event', id: 'dec-1', kind: 'app.activated', subject: 'Reader', level: 'record', at: Date.UTC(2026, 11, 3, 12, 0, 0), source: { id: 'helper', api: 'nsworkspace', host: 'local' } })}\n`,
    );

    const keep400Date = addDays('2026-12-05', -400);
    const delete401Date = addDays('2026-12-05', -401);
    await port.writeDaily(
      keep400Date,
      JSON.stringify(
        summarizeDay(keep400Date, { events: [], lifecycle: [] }, octBoundsCalendar.dayBounds(keep400Date)),
      ),
    );
    await port.writeDaily(
      delete401Date,
      JSON.stringify(
        summarizeDay(delete401Date, { events: [], lifecycle: [] }, octBoundsCalendar.dayBounds(delete401Date)),
      ),
    );

    const h = createRuntimeHarness({ nowMs: now, history: port, timeZone: 'UTC' });
    await h.runtime.start();

    const octRaw = await port.readMonthly('2026-10');
    expect(octRaw).toBeDefined();
    const oct = JSON.parse(octRaw ?? '') as MonthlySummary;
    expect(oct.daysInMonth).toBe(31);
    expect(oct.coveredDays).toBe(30);
    expect(oct.missingDays).toEqual(['2026-10-15']);
    expect(oct.apps.Notes).toEqual({ foregroundMs: 300_000, switches: 30 });
    expect(oct.coverage.observedMs).toBe(300_000);

    expect(await port.readDaily('2026-12-03')).toBeDefined();
    expect(await port.readDaily('2026-12-02')).toBeUndefined();
    expect(await port.readDaily(keep400Date)).toBeDefined();
    expect(await port.readDaily(delete401Date)).toBeUndefined();

    await h.runtime.stop();
  });

  it('handles 23h spring-forward and 25h fall-back DST local days accurately', async () => {
    const cal = new LocalCalendar('America/New_York');
    const springBounds = cal.dayBounds('2026-03-08');
    const fallBounds = cal.dayBounds('2026-11-01');
    expect(springBounds.durationMs).toBe(23 * 3_600_000);
    expect(fallBounds.durationMs).toBe(25 * 3_600_000);

    // Test 23h spring-forward midnight rollover through real createSenseRuntime with fake timers (no vi.waitFor!)
    vi.useFakeTimers();
    const dir = await makeTempDir();
    const port = new FileHistoryStoragePort(dir);
    const h = createRuntimeHarness({
      nowMs: springBounds.startMs + 1_000,
      history: port,
      timeZone: 'America/New_York',
      withHelper: true,
    });
    await h.runtime.start();
    await h.emitHelper({
      type: 'hello',
      at: springBounds.startMs + 1_000,
      version: '0.1.0',
      pid: 4242,
      session: 'fixture-session',
      permissions: { accessibility: 'granted' },
    });
    h.setTime(springBounds.startMs + 60_000, 60_000);
    await h.emitHelper({
      type: 'app.activated',
      at: springBounds.startMs + 60_000,
      name: 'DstEditor',
      bundleId: 'com.example.Dst',
      pid: 77,
    });
    await h.emitJob({
      type: 'started',
      id: 'dst-start-ping',
      sessionId: 's1',
      at: springBounds.startMs + 60_000,
    });
    // Advance fake timers briefly so PassThrough nextTick + async store callbacks settle
    await vi.advanceTimersByTimeAsync(50);

    // Advance across the 23h DST day close to midnight, emit heartbeat ping, then cross midnight
    h.setTime(springBounds.endMs - 60_000, 23 * 3_600_000);
    await h.emitJob({
      type: 'started',
      id: 'dst-end-ping',
      sessionId: 's1',
      at: springBounds.endMs - 60_000,
    });
    await vi.advanceTimersByTimeAsync(50);

    h.setTime(springBounds.endMs + 2_000, 23 * 3_600_000 + 62_000);
    await vi.advanceTimersByTimeAsync(5_000);
    await h.runtime.tools.envHistory({});

    const springDaily = JSON.parse((await port.readDaily('2026-03-08')) ?? '') as DailySummary;
    expect(springDaily.dayDurationMs).toBe(23 * 3_600_000);
    expect(springDaily.apps).toHaveProperty('DstEditor');
    expect(springDaily.apps.DstEditor.foregroundMs).toBe(23 * 3_600_000 - 60_000);
    expect(springDaily.coverage.observedMs).toBe(23 * 3_600_000 - 1_000);
    expect(springDaily.coverage.notRunningMs).toBe(1_000);
    await h.runtime.stop();

    const fallParsed = parseHistoryLines(
      [
        JSON.stringify({ record: 'lifecycle', state: 'active', at: fallBounds.startMs, boot: true }),
        JSON.stringify({
          record: 'event',
          id: 'f1',
          kind: 'app.activated',
          subject: 'FallApp',
          level: 'record',
          at: fallBounds.startMs,
          source: { id: 'helper', api: 'nsworkspace', host: 'local' },
        }),
        JSON.stringify({ record: 'lifecycle', state: 'stopped', at: fallBounds.endMs }),
      ].join('\n'),
    );
    const fallDaily = summarizeDay('2026-11-01', fallParsed, fallBounds);
    expect(fallDaily.dayDurationMs).toBe(25 * 3_600_000);
    expect(fallDaily.apps.FallApp.foregroundMs).toBe(25 * 3_600_000);
    expect(fallDaily.coverage.observedMs).toBe(25 * 3_600_000);
  });

  it('clears disk files, memory ring buffer, and today summary state via clearHistory()', async () => {
    const dir = await makeTempDir();
    const port = new FileHistoryStoragePort(dir);
    const now = Date.UTC(2026, 10, 12, 10, 0, 0);
    await port.writeDaily(
      '2026-11-11',
      JSON.stringify(
        summarizeDay('2026-11-11', { events: [], lifecycle: [] }, new LocalCalendar('UTC').dayBounds('2026-11-11')),
      ),
    );
    await port.writeMonthly('2026-10', JSON.stringify({ version: 1, month: '2026-10' }));

    const h = createRuntimeHarness({ nowMs: now, history: port, timeZone: 'UTC' });
    await h.runtime.start();
    await h.emitJob({ type: 'started', id: 'to-clear', sessionId: 's1', at: now + 1_000 });
    await vi.waitFor(() => expect(h.runtime.events().some((e) => e.subject === 'to-clear')).toBe(true), {
      timeout: 2_000,
      interval: 5,
    });

    await h.runtime.clearHistory();
    expect(h.runtime.events()).toEqual([]);
    expect(await port.listEventDates()).toEqual([]);
    expect(await port.listDailyDates()).toEqual([]);
    expect(await port.listMonthlyMonths()).toEqual([]);
    expect(await h.runtime.tools.envHistory({})).toMatchObject({ available: true, total: 0, events: [] });

    await h.runtime.stop();
  });

  it('runs safely when ports.history is omitted', async () => {
    vi.useFakeTimers();
    const now = Date.UTC(2026, 10, 12, 10, 0, 0);
    const h = createRuntimeHarness({ nowMs: now });
    await h.runtime.start();
    await h.emitJob({ type: 'started', id: 'no-port', sessionId: 's1', at: now + 1_000 });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(h.runtime.events().some((e) => e.subject === 'no-port')).toBe(true);
    expect(await h.runtime.tools.envHistory({})).toMatchObject({ available: false });
    expect(await h.runtime.tools.envSummary({})).toMatchObject({ available: false });
    await expect(h.runtime.clearHistory()).resolves.toBeUndefined();
    await h.runtime.stop();
    expect(vi.getTimerCount()).toBe(0);

    const mgr = new HistoryManager({
      clock: { wall: () => now, mono: () => 0 },
      isPaused: () => false,
      titlesAllowed: () => true,
      restoreEntries: () => {},
      clearMemoryEntries: () => {},
      emitSourceError: () => {},
      emitSourceOk: () => {},
    });
    await mgr.start(false);
    await mgr.stop();
  });
});
