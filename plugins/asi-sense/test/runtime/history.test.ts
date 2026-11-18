import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { PassThrough } from 'node:stream';
import type { Body, Signal, WatchRule } from '@asi/sense-types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileHistoryStoragePort } from '../../src/host/dsh/history-storage.ts';
import { RuntimeAttention } from '../../src/host/runtime/attention.ts';
import { FactExpiry } from '../../src/host/runtime/expiry.ts';
import {
  addDays,
  createDailySummaryAccumulator,
  type DailySummary,
  HistoryManager,
  LocalCalendar,
  MAX_DAILY_EVENT_BYTES,
  type MonthlySummary,
  parseDailySummary,
  parseHistoryLines,
  parseMonthlySummary,
  summarizeDay,
  synthesizeMonth,
} from '../../src/host/runtime/history/index.ts';
import {
  type AgentEvent,
  createSenseRuntime,
  type DshPort,
  type FileChange,
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
      globalFileWatch: { disableInTests: true },
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

    await vi.waitFor(async () => expect(await port.readDaily('2026-12-03')).toBeDefined(), {
      timeout: 5_000,
      interval: 10,
    });
    expect(await port.readDaily('2026-12-02')).toBeUndefined();
    expect(await port.readDaily(keep400Date)).toBeDefined();
    expect(await port.readDaily(delete401Date)).toBeUndefined();

    await h.runtime.stop();
  }, 15_000);

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
    expect(await port.listEventDates()).toEqual(['2026-11-12']);
    const afterClear = parseHistoryLines((await port.readEvents('2026-11-12')) ?? '');
    expect(afterClear.events).toEqual([]);
    expect(afterClear.lifecycle).toEqual([{ record: 'lifecycle', state: 'active', at: now, boot: true }]);
    expect(await port.listDailyDates()).toEqual([]);
    expect(await port.listMonthlyMonths()).toEqual([]);
    expect(await h.runtime.tools.envHistory({})).toMatchObject({ available: true, total: 0, events: [] });

    await h.runtime.stop();
  });

  const histEvent = (id: string, at: number) => ({
    id,
    kind: 'app.activated',
    subject: 'CodeForge',
    level: 'wake' as const,
    at,
    source: { id: 'helper', api: 'ax', host: 'local' },
  });
  const mockPort = (opts: { clearAll?: () => Promise<void>; listMonthlyMonths?: () => Promise<string[]> } = {}) => {
    const events = new Map<string, string>();
    const port: HistoryStoragePort = {
      eventFileSize: async (date) => Buffer.byteLength(events.get(date) ?? '', 'utf8'),
      appendEvent: async (date, line) => {
        events.set(date, (events.get(date) ?? '') + line);
      },
      readEvents: async (date) => events.get(date),
      listEventDates: async () => [...events.keys()],
      deleteEventDate: async (date) => {
        events.delete(date);
      },
      readDaily: async () => undefined,
      writeDaily: async () => {},
      listDailyDates: async () => [],
      deleteDailyDate: async () => {},
      readMonthly: async () => undefined,
      writeMonthly: async () => {},
      listMonthlyMonths: opts.listMonthlyMonths ?? (async () => []),
      clearAll:
        opts.clearAll ??
        (async () => {
          events.clear();
        }),
    };
    return { port, events };
  };
  const managerFor = (port: HistoryStoragePort, wall: () => number) =>
    new HistoryManager({
      port,
      clock: { wall, mono: () => 1_000 },
      isPaused: () => false,
      titlesAllowed: () => false,
      restoreEntries: () => {},
      clearMemoryEntries: () => {},
      emitSourceError: () => {},
      emitSourceOk: () => {},
      timeZone: 'UTC',
    });

  it('keeps events recorded while clear() awaits port.clearAll() in the today summary (#2)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { port, events } = mockPort({
      clearAll: async () => {
        events.clear();
        await gate;
      },
    });
    let wall = Date.UTC(2026, 10, 18, 9, 0, 0);
    const mgr = managerFor(port, () => wall);
    await mgr.start(false);

    const clearing = mgr.clear();
    await new Promise((resolve) => setTimeout(resolve, 5));
    wall += 10_000;
    mgr.recordEvent(histEvent('ev-during-clear', wall));
    release();
    await clearing;
    await mgr.query({});

    expect(mgr.timelineSnapshots().today?.totalEvents).toBe(1);
    expect(events.get('2026-11-18') ?? '').toContain('ev-during-clear');
    await mgr.stop();
  });

  it('keeps today summary usable after port.clearAll() fails and a later clear still works (#2)', async () => {
    let failOnce = true;
    const { port, events } = mockPort({
      clearAll: async () => {
        if (failOnce) {
          failOnce = false;
          throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        }
        events.clear();
      },
    });
    let wall = Date.UTC(2026, 10, 18, 9, 0, 0);
    const mgr = managerFor(port, () => wall);
    await mgr.start(false);
    mgr.recordEvent(histEvent('e1', wall + 1_000));
    await mgr.query({});
    expect(mgr.timelineSnapshots().today?.totalEvents).toBe(1);

    await expect(mgr.clear()).rejects.toThrow('EACCES');
    wall += 60_000;
    mgr.recordEvent(histEvent('e2', wall));
    await mgr.query({});
    // e1 is rebuilt from the day's raw events on disk, e2 is replayed from the
    // buffer recorded while the failed clear was in flight.
    expect(mgr.timelineSnapshots().today?.totalEvents).toBe(2);

    await expect(mgr.clear()).resolves.toBeUndefined();
    await mgr.query({});
    expect(mgr.timelineSnapshots().today?.totalEvents ?? 0).toBe(0);
    await mgr.stop();
  });

  it('rebuilds the today summary from on-disk events after clearAll() fails (#2)', async () => {
    const { port, events } = mockPort({
      clearAll: async () => {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      },
    });
    let wall = Date.UTC(2026, 10, 18, 9, 0, 0);
    const mgr = managerFor(port, () => wall);
    await mgr.start(false);
    mgr.recordEvent(histEvent('pre-1', wall + 1_000));
    mgr.recordEvent(histEvent('pre-2', wall + 2_000));
    await mgr.query({});
    expect(mgr.timelineSnapshots().today?.totalEvents).toBe(2);
    expect((events.get('2026-11-18') ?? '').match(/"id":"pre-/g)).toHaveLength(2);

    const clearing = mgr.clear().then(
      () => undefined,
      (error: unknown) => error,
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    wall += 60_000;
    mgr.recordEvent(histEvent('during-clear', wall));
    const failure = await clearing;
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('EACCES');
    await mgr.query({});

    expect(mgr.timelineSnapshots().today?.totalEvents).toBe(3);
    expect(events.get('2026-11-18') ?? '').toContain('during-clear');
    await mgr.stop();
  });

  it('surfaces month-listing directory errors so the UI can retry instead of showing an empty list (#6)', async () => {
    let fails = true;
    const { port } = mockPort({
      listMonthlyMonths: async () => {
        if (fails) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
        return ['2026-10'];
      },
    });
    const mgr = managerFor(port, () => Date.UTC(2026, 10, 18, 9, 0, 0));
    await mgr.start(false);

    await expect(mgr.listCompletedMonths()).rejects.toThrow('EACCES');
    fails = false;
    await expect(mgr.listCompletedMonths()).resolves.toEqual(['2026-10']);
    await mgr.stop();
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

  it('hardens permissions on start and skips symlinks, colliding dirs, FIFOs, and invalid dates with one source.error (#3, #6)', async () => {
    const dir = await makeTempDir();
    const eventsDir = join(dir, 'history', 'events');
    const dailyDir = join(dir, 'history', 'daily');
    await mkdir(eventsDir, { recursive: true, mode: 0o755 });
    await mkdir(dailyDir, { recursive: true, mode: 0o755 });
    await chmod(join(dir, 'history'), 0o755);
    await chmod(eventsDir, 0o755);
    await chmod(dailyDir, 0o755);

    const victim = join(dir, 'outside-secret.txt');
    await writeFile(victim, 'OUTSIDE\n', { mode: 0o644 });
    await symlink(victim, join(eventsDir, '2026-11-16.jsonl'));
    await mkdir(join(eventsDir, '2026-11-15.jsonl'));
    execFileSync('mkfifo', [join(eventsDir, '2026-11-14.jsonl')]);
    await writeFile(join(eventsDir, '2026-02-30.jsonl'), '{"record":"event","id":"bad-date"}\n', { mode: 0o644 });
    await writeFile(
      join(eventsDir, '2026-11-17.jsonl'),
      `${JSON.stringify({
        record: 'event',
        id: 'valid-ev',
        kind: 'app.activated',
        subject: 'Notes',
        level: 'record',
        at: Date.UTC(2026, 10, 17, 12, 0, 0),
        source: { id: 'helper', api: 'nsworkspace', host: 'local' },
      })}\n`,
      { mode: 0o644 },
    );

    const port = new FileHistoryStoragePort(dir);
    const h = createRuntimeHarness({ nowMs: Date.UTC(2026, 10, 18, 10, 0, 0), history: port, timeZone: 'UTC' });
    await h.runtime.start();

    expect((await stat(eventsDir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(eventsDir, '2026-11-17.jsonl'))).mode & 0o777).toBe(0o600);
    expect(
      h.runtime
        .events()
        .filter((e) => e.restored)
        .map((e) => e.id),
    ).toEqual(['valid-ev']);
    await vi.waitFor(async () => expect(await port.readDaily('2026-11-17')).toBeDefined(), {
      timeout: 5_000,
      interval: 10,
    });

    const errorsBeforeQuery = h.runtime.events().filter((e) => e.kind === 'source.error');
    expect(errorsBeforeQuery).toHaveLength(4);
    expect(errorsBeforeQuery.map((e) => e.reason)).toContain('invalid-history-date');
    expect(errorsBeforeQuery.filter((e) => e.reason === 'history-unsafe-entry')).toHaveLength(3);

    // Querying does not crash or emit duplicate errors for the same skipped unsafe files
    const q = await h.runtime.tools.envHistory({});
    expect(q).toMatchObject({ available: true });
    expect(q.events.some((e) => e.id === 'valid-ev')).toBe(true);
    expect(q.events.some((e) => e.id === 'bad-date')).toBe(false);
    const qApps = await h.runtime.tools.envHistory({ kinds: ['app.activated'] });
    expect(qApps.events.map((e) => e.id)).toEqual(['valid-ev']);
    expect(h.runtime.events().filter((e) => e.kind === 'source.error')).toHaveLength(4);

    await h.runtime.stop();
  });

  it('streams 20 MB single-day & 30x5 MB history within perf/RSS budgets and restores 200 entries from newest day first (#4)', async () => {
    // 1) Restore 200 entries reads only newest day when newest has >= 200 events
    const restoreDir = await makeTempDir();
    const restorePortBase = new FileHistoryStoragePort(restoreDir);
    const now = Date.UTC(2026, 10, 18, 12, 0, 0);
    for (const [date, count, dayMs] of [
      ['2026-11-17', 200, Date.UTC(2026, 10, 17, 10, 0, 0)],
      ['2026-11-18', 210, now - 10_000],
    ] as const) {
      const lines = Array.from({ length: count }, (_, i) =>
        JSON.stringify({
          record: 'event',
          id: `${date}-${i}`,
          kind: 'app.activated',
          subject: 'App',
          level: 'record',
          at: dayMs + i,
          source: { id: 'helper', api: 'nsworkspace', host: 'local' },
        }),
      );
      await restorePortBase.appendEvent(date, `${lines.join('\n')}\n`);
    }
    // Pre-write daily for 2026-11-17 so backfill doesn't read 2026-11-17
    await restorePortBase.writeDaily(
      '2026-11-17',
      JSON.stringify(
        summarizeDay('2026-11-17', { events: [], lifecycle: [] }, new LocalCalendar('UTC').dayBounds('2026-11-17')),
      ),
    );
    const descSpy = vi.fn((d: string) => restorePortBase.readEventLinesDesc(d));
    const spiedPort: HistoryStoragePort = {
      eventFileSize: (d) => restorePortBase.eventFileSize(d),
      appendEvent: (d, l) => restorePortBase.appendEvent(d, l),
      readEvents: (d) => restorePortBase.readEvents(d),
      readEventLines: (d) => restorePortBase.readEventLines(d),
      readEventLinesDesc: descSpy,
      listEventDates: () => restorePortBase.listEventDates(),
      deleteEventDate: (d) => restorePortBase.deleteEventDate(d),
      readDaily: (d) => restorePortBase.readDaily(d),
      writeDaily: (d, j) => restorePortBase.writeDaily(d, j),
      listDailyDates: () => restorePortBase.listDailyDates(),
      deleteDailyDate: (d) => restorePortBase.deleteDailyDate(d),
      readMonthly: (m) => restorePortBase.readMonthly(m),
      writeMonthly: (m, j) => restorePortBase.writeMonthly(m, j),
      listMonthlyMonths: () => restorePortBase.listMonthlyMonths(),
      harden: () => restorePortBase.harden(),
      clearAll: () => restorePortBase.clearAll(),
    };
    const hRestore = createRuntimeHarness({ nowMs: now, history: spiedPort, timeZone: 'UTC', withHelper: true });
    await hRestore.runtime.start();
    expect(descSpy).toHaveBeenCalledTimes(1);
    expect(descSpy).toHaveBeenCalledWith('2026-11-18');
    expect(hRestore.runtime.events()).toHaveLength(200);
    expect(hRestore.runtime.events()[0]?.id).toBe('2026-11-18-10');
    await hRestore.runtime.stop();

    // 2) When newest day has < 200 events, falls back to previous day for remaining slots
    const twoDayDir = await makeTempDir();
    const twoDayPort = new FileHistoryStoragePort(twoDayDir);
    await twoDayPort.appendEvent(
      '2026-11-17',
      `${Array.from({ length: 180 }, (_, i) =>
        JSON.stringify({
          record: 'event',
          id: `d1-${i}`,
          kind: 'app.activated',
          subject: 'App',
          level: 'record',
          at: Date.UTC(2026, 10, 17, 10, 0, 0) + i,
          source: { id: 'helper', api: 'nsworkspace', host: 'local' },
        }),
      ).join('\n')}\n`,
    );
    await twoDayPort.appendEvent(
      '2026-11-18',
      `${Array.from({ length: 50 }, (_, i) =>
        JSON.stringify({
          record: 'event',
          id: `d2-${i}`,
          kind: 'app.activated',
          subject: 'App',
          level: 'record',
          at: now - 1_000 + i,
          source: { id: 'helper', api: 'nsworkspace', host: 'local' },
        }),
      ).join('\n')}\n`,
    );
    const hTwo = createRuntimeHarness({ nowMs: now, history: twoDayPort, timeZone: 'UTC', withHelper: true });
    await hTwo.runtime.start();
    expect(hTwo.runtime.events()).toHaveLength(200);
    expect(hTwo.runtime.events()[0]?.id).toBe('d1-30');
    expect(hTwo.runtime.events()[199]?.id).toBe('d2-49');
    await hTwo.runtime.stop();

    // 3) Real 20 MB single day + 30x5 MB cold start & query budget
    const perfDir = await makeTempDir();
    await mkdir(join(perfDir, 'history', 'events'), { recursive: true, mode: 0o700 });
    const row = (i: number) =>
      `${JSON.stringify({
        record: 'event',
        id: `perf-${i}`,
        kind: i % 2 === 0 ? 'app.activated' : 'window.focused',
        subject: 'EditorApp',
        title: `Document-${i} /Users/tester/workspace/project/src/file-${i}.ts`,
        level: 'record',
        at: now - 3_600_000 + i,
        source: { id: 'helper', api: 'nsworkspace', host: 'local' },
      })}\n`;
    const chunks: string[] = [];
    let bytes = 0;
    let idx = 0;
    while (bytes < 20 * 1024 * 1024) {
      const l = row(idx++);
      chunks.push(l);
      bytes += Buffer.byteLength(l, 'utf8');
    }
    const day20mb = chunks.join('');
    chunks.length = 0;
    await writeFile(join(perfDir, 'history', 'events', '2026-11-18.jsonl'), day20mb, { mode: 0o600 });

    const slice5mb = day20mb.slice(0, day20mb.indexOf('\n', 5 * 1024 * 1024) + 1);
    chunks.length = 0;
    const port20 = new FileHistoryStoragePort(perfDir);
    const rss0 = process.memoryUsage().rss;
    const h20 = createRuntimeHarness({ nowMs: now + 1_000, history: port20, timeZone: 'UTC' });
    await h20.runtime.start();
    const tq0 = performance.now();
    const res20 = await h20.runtime.tools.envHistory({ limit: 50 });
    const query20Ms = performance.now() - tq0;
    const rssDeltaMb = (process.memoryUsage().rss - rss0) / 1_048_576;
    expect(res20.events).toHaveLength(50);
    expect(res20.truncated).toBe(true);
    expect(query20Ms).toBeLessThan(150);
    expect(rssDeltaMb).toBeLessThan(50);
    await h20.runtime.stop();

    const dir30 = await makeTempDir();
    await mkdir(join(dir30, 'history', 'events'), { recursive: true, mode: 0o700 });
    for (let d = 0; d < 30; d++) {
      await writeFile(join(dir30, 'history', 'events', `${addDays('2026-11-18', -d)}.jsonl`), slice5mb, {
        mode: 0o600,
      });
    }
    const port30 = new FileHistoryStoragePort(dir30);
    const h30 = createRuntimeHarness({ nowMs: now + 2_000, history: port30, timeZone: 'UTC' });
    const ts0 = performance.now();
    await h30.runtime.start();
    const start30Ms = performance.now() - ts0;
    const tq30 = performance.now();
    const res30 = await h30.runtime.tools.envHistory({ limit: 50 });
    const query30Ms = performance.now() - tq30;
    expect(start30Ms).toBeLessThan(1_000);
    expect(query30Ms).toBeLessThan(500);
    expect(res30.events).toHaveLength(50);
    await h30.runtime.stop();
  }, 30_000);

  it('re-seeds lifecycle on clearHistory(), resets 20 MB cap, and leaves no restored entries on concurrent start() (#5)', async () => {
    // 1) Lifecycle continuity + daily cap reset after clearHistory()
    const dir1 = await makeTempDir();
    const port1 = new FileHistoryStoragePort(dir1);
    let wall = Date.UTC(2026, 10, 18, 10, 0, 0);
    let mono = 1_000;
    const h1 = createRuntimeHarness({ nowMs: wall, history: port1, timeZone: 'UTC' });
    await h1.runtime.start();
    await h1.runtime.clearHistory();
    wall += 180_000;
    mono += 180_000;
    h1.setTime(wall, mono);
    await h1.runtime.stop();

    const parsed = parseHistoryLines((await port1.readEvents('2026-11-18')) ?? '');
    expect(parsed.lifecycle).toHaveLength(2);
    const daily = summarizeDay('2026-11-18', parsed, new LocalCalendar('UTC').dayBounds('2026-11-18'));
    expect(daily.coverage.observedMs).toBe(180_000);

    // Resets 20 MB daily cap after clearHistory()
    const mgrDir = await makeTempDir();
    const mgrPort = new FileHistoryStoragePort(mgrDir);
    let capWall = Date.UTC(2026, 10, 18, 10, 0, 0);
    const capMgr = new HistoryManager({
      port: mgrPort,
      clock: { wall: () => capWall, mono: () => capWall },
      isPaused: () => false,
      titlesAllowed: () => true,
      restoreEntries: () => {},
      clearMemoryEntries: () => {},
      emitSourceError: () => {},
      emitSourceOk: () => {},
      timeZone: 'UTC',
      maxDailyBytes: 256,
    });
    await capMgr.start(false);
    capMgr.recordEvent({
      id: 'over-cap',
      kind: 'app.activated',
      subject: 'A'.repeat(240),
      level: 'record',
      at: capWall + 100,
      source: { id: 'helper', api: 'nsworkspace', host: 'local' },
    });
    await capMgr.query({});
    expect((await mgrPort.readEvents('2026-11-18')) ?? '').not.toContain('over-cap');
    await capMgr.clear();
    capWall += 1_000;
    capMgr.recordEvent({
      id: 'after-clear',
      kind: 'app.activated',
      subject: 'Ok',
      level: 'record',
      at: capWall,
      source: { id: 'helper', api: 'nsworkspace', host: 'local' },
    });
    await capMgr.query({});
    expect((await mgrPort.readEvents('2026-11-18')) ?? '').toContain('after-clear');
    await capMgr.stop();

    // 2) Concurrent start() + clearHistory() leaves zero restored entries
    const dir2 = await makeTempDir();
    const basePort = new FileHistoryStoragePort(dir2);
    await basePort.appendEvent(
      '2026-11-17',
      `${JSON.stringify({
        record: 'event',
        id: 'stale-1',
        kind: 'app.activated',
        subject: 'StaleApp',
        level: 'record',
        at: Date.UTC(2026, 10, 17, 10, 0, 0),
        source: { id: 'helper', api: 'nsworkspace', host: 'local' },
      })}\n`,
    );
    let releaseList!: () => void;
    const listGate = new Promise<void>((r) => {
      releaseList = r;
    });
    let listStartedResolve!: () => void;
    const listStarted = new Promise<void>((r) => {
      listStartedResolve = r;
    });
    const slowPort: HistoryStoragePort = {
      eventFileSize: (d) => basePort.eventFileSize(d),
      appendEvent: (d, l) => basePort.appendEvent(d, l),
      readEvents: (d) => basePort.readEvents(d),
      readEventLines: (d) => basePort.readEventLines(d),
      readEventLinesDesc: (d) => basePort.readEventLinesDesc(d),
      listEventDates: async () => {
        listStartedResolve();
        await listGate;
        return basePort.listEventDates();
      },
      deleteEventDate: (d) => basePort.deleteEventDate(d),
      readDaily: (d) => basePort.readDaily(d),
      writeDaily: (d, j) => basePort.writeDaily(d, j),
      listDailyDates: () => basePort.listDailyDates(),
      deleteDailyDate: (d) => basePort.deleteDailyDate(d),
      readMonthly: (m) => basePort.readMonthly(m),
      writeMonthly: (m, j) => basePort.writeMonthly(m, j),
      listMonthlyMonths: () => basePort.listMonthlyMonths(),
      clearAll: () => basePort.clearAll(),
    };
    const h2 = createRuntimeHarness({ nowMs: Date.UTC(2026, 10, 18, 10, 0, 0), history: slowPort, timeZone: 'UTC' });
    const startP = h2.runtime.start();
    await listStarted;
    const clearP = h2.runtime.clearHistory();
    releaseList();
    await Promise.all([startP, clearP]);
    expect(h2.runtime.events().filter((e) => e.restored)).toEqual([]);
    expect((await h2.runtime.tools.envHistory({})).events.filter((e) => e.id === 'stale-1')).toEqual([]);
    await h2.runtime.stop();
  });

  it('handles clock rollback across midnight, unterminated trailing line, early patch, 20MB truncatedAtLimit backfill, and rollover write failure (#7, #8)', async () => {
    // 1) Clock rollback across midnight + same-day rollback + multi-day jump
    const dir1 = await makeTempDir();
    const port1 = new FileHistoryStoragePort(dir1);
    const h1 = createRuntimeHarness({ nowMs: Date.UTC(2026, 10, 18, 0, 1, 0), history: port1, timeZone: 'UTC' });
    await h1.runtime.start();

    h1.setTime(Date.UTC(2026, 10, 17, 23, 55, 0), 10_000);
    await h1.emitJob({
      type: 'started',
      id: 'j-before-midnight',
      sessionId: 's1',
      at: Date.UTC(2026, 10, 17, 23, 55, 0),
    });

    // Same-day rollback before moving forward across midnight
    h1.setTime(Date.UTC(2026, 10, 17, 23, 50, 0), 15_000);
    await h1.emitJob({
      type: 'started',
      id: 'j-same-day-back',
      sessionId: 's1',
      at: Date.UTC(2026, 10, 17, 23, 50, 0),
    });

    h1.setTime(Date.UTC(2026, 10, 18, 0, 5, 0), 615_000);
    await h1.emitJob({ type: 'started', id: 'j-after-midnight', sessionId: 's1', at: Date.UTC(2026, 10, 18, 0, 5, 0) });

    await h1.runtime.tools.envHistory({});
    expect(await port1.readEvents('2026-11-17')).toContain('j-before-midnight');
    expect(await port1.readDaily('2026-11-17')).toBeDefined();

    // Multi-day forward jump
    h1.setTime(Date.UTC(2026, 10, 21, 10, 0, 0), 10_000_000);
    await h1.emitJob({ type: 'started', id: 'j-jump', sessionId: 's1', at: Date.UTC(2026, 10, 21, 10, 0, 0) });
    await h1.runtime.tools.envHistory({});
    expect(await port1.readDaily('2026-11-18')).toBeDefined();
    await h1.runtime.stop();

    // 2) Unterminated trailing line + corrupt JSON + patch appearing before event
    const dir2 = await makeTempDir();
    await mkdir(join(dir2, 'history', 'events'), { recursive: true, mode: 0o700 });
    await writeFile(
      join(dir2, 'history', 'events', '2026-11-18.jsonl'),
      [
        JSON.stringify({ record: 'patch', id: 'ev-later', level: 'wake', reason: 'early-ignored' }),
        '{not-valid-json',
        JSON.stringify({
          record: 'event',
          id: 'ev-later',
          kind: 'app.activated',
          subject: 'App',
          level: 'record',
          at: Date.UTC(2026, 10, 18, 9, 0, 0),
          source: { id: 'helper', api: 'nsworkspace', host: 'local' },
        }),
        '{"record":"event","id":"partial"',
      ].join('\n'),
      { mode: 0o600 },
    );
    const port2 = new FileHistoryStoragePort(dir2);
    const h2 = createRuntimeHarness({ nowMs: Date.UTC(2026, 10, 18, 10, 0, 0), history: port2, timeZone: 'UTC' });
    await h2.runtime.start();
    h2.advance(60_000);
    await h2.runtime.stop();

    const parsed2 = parseHistoryLines((await port2.readEvents('2026-11-18')) ?? '');
    expect(parsed2.lifecycle.map((l) => ({ state: l.state, boot: l.boot }))).toEqual([
      { state: 'active', boot: true },
      { state: 'stopped', boot: undefined },
    ]);
    expect(parsed2.events.find((e) => e.id === 'ev-later')?.level).toBe('record');

    // 3) Backfill preserves truncatedAtLimit when eventFileSize >= maxDailyBytes (#8)
    const dir3 = await makeTempDir();
    const basePort3 = new FileHistoryStoragePort(dir3);
    const day1 = '2026-11-18';
    await basePort3.appendEvent(
      day1,
      `${JSON.stringify({
        record: 'event',
        id: 'e1',
        kind: 'app.activated',
        subject: 'Editor',
        level: 'record',
        at: Date.UTC(2026, 10, 18, 12, 0, 0),
        source: { id: 'helper', api: 'nsworkspace', host: 'local' },
      })}\n`,
    );
    let daily1: string | undefined;
    const capBackfillPort: HistoryStoragePort = {
      eventFileSize: async (d) => (d === day1 ? MAX_DAILY_EVENT_BYTES : 0),
      appendEvent: (d, l) => basePort3.appendEvent(d, l),
      readEvents: (d) => basePort3.readEvents(d),
      listEventDates: async () => [day1],
      deleteEventDate: (d) => basePort3.deleteEventDate(d),
      readDaily: async (d) => (d === day1 ? daily1 : undefined),
      writeDaily: async (d, j) => {
        if (d === day1) daily1 = j;
      },
      listDailyDates: async () => (daily1 ? [day1] : []),
      deleteDailyDate: async () => {},
      readMonthly: async () => undefined,
      writeMonthly: async () => {},
      listMonthlyMonths: async () => [],
      clearAll: async () => {},
    };
    const h3 = createRuntimeHarness({
      nowMs: Date.UTC(2026, 10, 19, 9, 0, 0),
      history: capBackfillPort,
      timeZone: 'UTC',
    });
    await h3.runtime.start();
    await vi.waitFor(() => expect(daily1).toBeDefined(), { timeout: 5_000, interval: 10 });
    expect((JSON.parse(daily1 ?? '{}') as DailySummary).truncatedAtLimit).toBe(true);
    await h3.runtime.stop();

    // 4) Rollover writeDaily failure emits source.error (#8)
    const failRollPort: HistoryStoragePort = {
      eventFileSize: async () => 0,
      appendEvent: async () => {},
      readEvents: async (d) =>
        d === day1
          ? '{"record":"event","id":"x","kind":"app.activated","subject":"A","level":"record","at":1,"source":{"id":"h","api":"a","host":"l"}}\n'
          : undefined,
      listEventDates: async () => [day1],
      deleteEventDate: async () => {},
      readDaily: async () => undefined,
      writeDaily: async () => {
        throw new Error('EACCES');
      },
      listDailyDates: async () => [],
      deleteDailyDate: async () => {},
      readMonthly: async () => undefined,
      writeMonthly: async () => {},
      listMonthlyMonths: async () => [],
      clearAll: async () => {},
    };
    const h4 = createRuntimeHarness({
      nowMs: Date.UTC(2026, 10, 18, 23, 59, 0),
      history: failRollPort,
      timeZone: 'UTC',
    });
    await h4.runtime.start();
    h4.setTime(Date.UTC(2026, 10, 19, 0, 1, 0), 121_000);
    await h4.emitJob({ type: 'started', id: 'roll-trigger', at: Date.UTC(2026, 10, 19, 0, 1, 0) });
    await h4.runtime.tools.envHistory({});
    expect(
      h4.runtime.events().filter((e) => e.kind === 'source.error' && e.reason === 'history-write-failed'),
    ).toHaveLength(1);
    await h4.runtime.stop();
  });

  it('guarantees full non-reentry across preStep, wake budget, FileBurstDetector, and frontApp; runs timer heartbeats & crash truncation; generates monthly once', async () => {
    // 1) Full non-reentry: preStep, wake budget (3/10m), file.burst, frontApp
    const dir1 = await makeTempDir();
    const port1 = new FileHistoryStoragePort(dir1);
    const t0 = Date.UTC(2026, 10, 17, 12, 0, 0);
    await port1.appendEvent(
      '2026-11-17',
      [
        ...Array.from({ length: 5 }, (_, i) =>
          JSON.stringify({
            record: 'event',
            id: `old-wake-${i}`,
            kind: 'job.exited',
            subject: `old-job-${i}`,
            level: 'wake',
            ruleId: 'wake-job',
            at: t0 + i * 1_000,
            source: { id: 'dsh', api: 'events', host: 'local' },
          }),
        ),
        JSON.stringify({
          record: 'event',
          id: 'old-ctx',
          kind: 'file.changed',
          subject: '/tmp/watched/a.ts',
          level: 'context',
          at: t0 + 6_000,
          source: { id: 'files', api: 'watch', host: 'local' },
        }),
        JSON.stringify({
          record: 'event',
          id: 'old-app',
          kind: 'app.activated',
          subject: 'OldFrontApp',
          level: 'record',
          at: t0 + 7_000,
          source: { id: 'helper.frontApp', api: 'nsworkspace', host: 'local' },
        }),
      ].join('\n') + '\n',
    );

    let wallMs = Date.UTC(2026, 10, 18, 9, 0, 0);
    let monoMs = 1_000;
    const delivered: Array<{ kind: string; ids: string[] }> = [];
    let agentCb!: (ev: AgentEvent) => Promise<void>;
    let jobCb!: (ev: JobEvent) => Promise<void>;
    const rules: WatchRule[] = [
      { id: 'wake-job', match: { kind: 'job.exited' }, level: 'wake', createdBy: 'user', approved: true },
      {
        id: 'ctx-file',
        match: { kind: 'file.changed', subject: '/tmp/watched/**' },
        level: 'context',
        createdBy: 'user',
        approved: true,
      },
    ];
    const rt = createSenseRuntime(
      {
        clock: { wall: () => wallMs, mono: () => monoMs },
        history: port1,
        storage: { load: async () => undefined, save: async () => {} },
        dsh: {
          onAgentEvent: (cb) => {
            agentCb = cb;
            return () => {};
          },
          onTool: () => () => {},
          onJob: (cb) => {
            jobCb = cb;
            return () => {};
          },
          deliver: async (_sid, intent) => {
            delivered.push({ kind: intent.kind, ids: intent.update.changes.map((c) => c.signal.id) });
          },
          tokenSnapshot: async () => undefined,
        },
        helper: { spawn: () => undefined },
        probe: { create: () => ({ onSample: () => () => {}, start: () => {}, stop: async () => {} }) },
        files: { watch: () => ({ close: () => {} }) },
      },
      { platform: 'linux', timeZone: 'UTC', intervalMs: 600_000, rules },
    );
    await rt.start();
    expect(rt.events().filter((e) => e.restored)).toHaveLength(7);
    expect(rt.state().env.frontApp.value).toBeNull();
    await agentCb({ type: 'created', sessionId: 's1' });
    await agentCb({ type: 'pre-step', sessionId: 's1' });
    await agentCb({ type: 'post-step', sessionId: 's1' });
    expect(delivered).toEqual([]);
    expect(rt.events().some((e) => e.kind === 'file.burst')).toBe(false);

    for (let i = 0; i < 3; i++) {
      monoMs += 65_000;
      wallMs += 65_000;
      await jobCb({ type: 'started', id: `live-job-${i}`, sessionId: 's1', at: wallMs });
      await jobCb({ type: 'exited', id: `live-job-${i}`, sessionId: 's1', exitCode: 1, at: wallMs + 100 });
      monoMs += 3_000;
      wallMs += 3_000;
      await agentCb({ type: 'pre-step', sessionId: 's1' });
      await agentCb({ type: 'post-step', sessionId: 's1' });
    }
    expect(delivered).toHaveLength(3);
    await rt.stop();

    // 2) Timer-driven 5-min heartbeat (active + paused) & crash truncation + live monthly rollover generated once
    vi.useFakeTimers();
    const dir2 = await makeTempDir();
    const port2 = new FileHistoryStoragePort(dir2);
    let w2 = Date.UTC(2026, 9, 31, 23, 45, 0);
    let m2 = 1_000;
    let jobCb2!: (ev: JobEvent) => Promise<void>;
    const rtCrash = createSenseRuntime(
      {
        clock: { wall: () => w2, mono: () => m2 },
        history: port2,
        storage: { load: async () => undefined, save: async () => {} },
        dsh: {
          onAgentEvent: () => () => {},
          onTool: () => () => {},
          onJob: (cb) => {
            jobCb2 = cb;
            return () => {};
          },
          deliver: async () => {},
          tokenSnapshot: async () => undefined,
        },
        helper: { spawn: () => undefined },
        probe: { create: () => ({ onSample: () => () => {}, start: () => {}, stop: async () => {} }) },
        files: { watch: () => ({ close: () => {} }) },
      },
      { platform: 'linux', timeZone: 'UTC', intervalMs: 600_000 },
    );
    await rtCrash.start();
    // 5-min timer heartbeat (active)
    w2 += 300_000;
    m2 += 300_000;
    await vi.advanceTimersByTimeAsync(300_000);
    // Pause and 5-min timer heartbeat (paused)
    await rtCrash.actions.pause(true);
    w2 += 300_000;
    m2 += 300_000;
    await vi.advanceTimersByTimeAsync(300_000);
    await rtCrash.tools.envHistory({});
    const crashLines = parseHistoryLines((await port2.readEvents('2026-10-31')) ?? '');
    expect(crashLines.lifecycle.filter((l) => l.state === 'heartbeat')).toEqual([
      expect.objectContaining({ state: 'heartbeat', paused: false }),
      expect.objectContaining({ state: 'heartbeat', paused: true }),
    ]);

    // Simulate crash by clearing timers without calling rtCrash.stop(); restart next morning -> truncates at last heartbeat!
    vi.clearAllTimers();
    let wNext = Date.UTC(2026, 10, 1, 8, 0, 0);
    let mNext = 1_000;
    let jobCb3!: (ev: JobEvent) => Promise<void>;
    const rtNext = createSenseRuntime(
      {
        clock: { wall: () => wNext, mono: () => mNext },
        history: port2,
        storage: { load: async () => undefined, save: async () => {} },
        dsh: {
          onAgentEvent: () => () => {},
          onTool: () => () => {},
          onJob: (cb) => {
            jobCb3 = cb;
            return () => {};
          },
          deliver: async () => {},
          tokenSnapshot: async () => undefined,
        },
        helper: { spawn: () => undefined },
        probe: { create: () => ({ onSample: () => () => {}, start: () => {}, stop: async () => {} }) },
        files: { watch: () => ({ close: () => {} }) },
      },
      { platform: 'linux', timeZone: 'UTC', intervalMs: 600_000 },
    );
    await rtNext.start();
    for (let i = 0; i < 40 && !(await port2.readMonthly('2026-10')); i++) {
      await vi.advanceTimersByTimeAsync(50);
    }
    const octDaily = JSON.parse((await port2.readDaily('2026-10-31')) ?? '{}') as DailySummary;
    expect(octDaily.coverage.observedMs).toBe(300_000);
    expect(octDaily.coverage.pausedMs).toBe(300_000);

    const octMonthly1 = JSON.parse((await port2.readMonthly('2026-10')) ?? '{}') as MonthlySummary;
    expect(octMonthly1.generatedAt).toBe(Date.UTC(2026, 10, 1, 8, 0, 0));

    // Roll over across next day -> monthly/2026-10.json is NOT overwritten (same generatedAt)
    wNext = Date.UTC(2026, 10, 2, 0, 0, 5);
    mNext += 86_400_000;
    await jobCb3({ type: 'started', id: 'nov-2', at: wNext });
    await rtNext.tools.envHistory({});
    const octMonthly2 = JSON.parse((await port2.readMonthly('2026-10')) ?? '{}') as MonthlySummary;
    expect(octMonthly2.generatedAt).toBe(octMonthly1.generatedAt);
    await rtNext.stop();
    expect(jobCb2).toBeDefined();
  });

  it('persists signals from real BodySource and FileSource into history and daily summaries', async () => {
    const dir = await makeTempDir();
    const port = new FileHistoryStoragePort(dir);
    let wall = Date.UTC(2026, 10, 10, 10, 0, 0);
    let mono = 1_000;
    let probeCb!: (body: Body) => void;
    let fileCb!: (ev: FileChange) => void;
    const diskBody = (free: number): Body => ({
      cpu: {
        value: { usage: 0.1, perCore: [0.1], load1: 0.1, load5: 0.1, load15: 0.1 },
        status: 'ok',
        source: { id: 'body', api: 'probe', host: 'local' },
        observedAt: wall,
        ttlMs: 10_000,
      },
      memory: {
        value: { total: 1000, used: 200, pressure: 'normal', swapUsed: 0 },
        status: 'ok',
        source: { id: 'body', api: 'probe', host: 'local' },
        observedAt: wall,
        ttlMs: 10_000,
      },
      disks: {
        kind: 'disks',
        value: [{ mount: '/Volumes/Work', total: 1000, free, status: 'ok', observedAt: wall, ttlMs: 10_000 }],
        status: 'ok',
        source: { id: 'body', api: 'probe', host: 'local' },
        observedAt: wall,
        ttlMs: 10_000,
      },
      battery: {
        value: null,
        status: 'unavailable',
        source: { id: 'body', api: 'probe', host: 'local' },
        observedAt: wall,
        ttlMs: 10_000,
      },
      thermal: {
        value: 'nominal',
        status: 'ok',
        source: { id: 'body', api: 'probe', host: 'local' },
        observedAt: wall,
        ttlMs: 10_000,
      },
      network: {
        value: { online: true, rxBps: 0, txBps: 0 },
        status: 'ok',
        source: { id: 'body', api: 'probe', host: 'local' },
        observedAt: wall,
        ttlMs: 10_000,
      },
      harnessProcess: {
        value: { rss: 100, cpu: 0.1, uptimeSec: 10 },
        status: 'ok',
        source: { id: 'body', api: 'probe', host: 'local' },
        observedAt: wall,
        ttlMs: 10_000,
      },
      tokens: {
        value: null,
        status: 'unavailable',
        source: { id: 'tokens', api: 'dsh', host: 'local' },
        observedAt: wall,
        ttlMs: 10_000,
      },
    });

    const rt = createSenseRuntime(
      {
        clock: { wall: () => wall, mono: () => mono },
        history: port,
        storage: { load: async () => undefined, save: async () => {} },
        dsh: {
          onAgentEvent: () => () => {},
          onTool: () => () => {},
          onJob: () => () => {},
          deliver: async () => {},
          tokenSnapshot: async () => undefined,
        },
        helper: { spawn: () => undefined },
        probe: {
          create: () => ({
            onSample: (cb) => {
              probeCb = cb;
              return () => {};
            },
            start: () => {},
            stop: async () => {},
          }),
        },
        files: {
          watch: (_p, cb) => {
            fileCb = cb;
            return { close: () => {} };
          },
        },
      },
      {
        platform: 'linux',
        timeZone: 'UTC',
        intervalMs: 600_000,
        rules: [
          {
            id: 'watch-src',
            match: { kind: 'file.changed', subject: '/tmp/proj/**' },
            level: 'context',
            createdBy: 'user',
            approved: true,
          },
        ],
      },
    );
    await rt.start();
    probeCb(diskBody(800));
    wall += 2_000;
    mono += 2_000;
    probeCb(diskBody(50)); // < 10% triggers body.threshold warn on disk:/Volumes/Work
    fileCb({ path: '/tmp/proj/index.ts', change: 'modify', at: wall });
    await vi.waitFor(
      () =>
        expect(
          rt.events().some((e) => e.kind === 'body.threshold') && rt.events().some((e) => e.kind === 'file.changed'),
        ).toBe(true),
      { timeout: 2_000, interval: 10 },
    );
    await rt.stop();

    const parsed = parseHistoryLines((await port.readEvents('2026-11-10')) ?? '');
    expect(parsed.events.some((e) => e.kind === 'body.threshold' && e.subject === 'disk:/Volumes/Work')).toBe(true);
    expect(parsed.events.some((e) => e.kind === 'body.rate' && e.detail?.metric === 'disk:/Volumes/Work')).toBe(true);
    expect(parsed.events.some((e) => e.kind === 'file.changed' && e.subject === '/tmp/proj/index.ts')).toBe(true);
    const summary = summarizeDay('2026-11-10', parsed, new LocalCalendar('UTC').dayBounds('2026-11-10'));
    expect(summary.bodyAnomalies.threshold).toBe(1);
    expect(summary.bodyAnomalies.rate).toBe(1);
    expect(summary.bodyAnomalies.byMetric['disk:Work']).toBe(2);
  });

  it('prevents stale pendingBackfill from clearHistory() race (#1), keeps pending on writeDaily failure (#4), and handles delayed midnight events (nit #4)', async () => {
    // 1) clearHistory() during startupMaintenance readDaily() drops stale pendingBackfill and allows later monthly synthesis (#1)
    const dir1 = await makeTempDir();
    const base1 = new FileHistoryStoragePort(dir1);
    await base1.appendEvent(
      '2026-10-24',
      `${JSON.stringify({ record: 'event', id: 'oct-24', kind: 'app.activated', subject: 'App', level: 'record', at: Date.UTC(2026, 9, 24, 10, 0, 0), source: { id: 'helper', api: 'nsworkspace', host: 'local' } })}\n`,
    );
    await base1.writeDaily(
      '2026-10-24',
      JSON.stringify(
        summarizeDay('2026-10-24', { events: [], lifecycle: [] }, new LocalCalendar('UTC').dayBounds('2026-10-24')),
      ),
    );
    await base1.appendEvent(
      '2026-10-25',
      `${JSON.stringify({ record: 'event', id: 'oct-25', kind: 'app.activated', subject: 'App', level: 'record', at: Date.UTC(2026, 9, 25, 10, 0, 0), source: { id: 'helper', api: 'nsworkspace', host: 'local' } })}\n`,
    );
    await base1.appendEvent(
      '2026-11-17',
      `${JSON.stringify({ record: 'event', id: 'nov-17', kind: 'app.activated', subject: 'App', level: 'record', at: Date.UTC(2026, 10, 17, 10, 0, 0), source: { id: 'helper', api: 'nsworkspace', host: 'local' } })}\n`,
    );

    let readDailyEntered!: () => void;
    const onReadDaily = new Promise<void>((r) => {
      readDailyEntered = r;
    });
    let releaseReadDaily!: () => void;
    const readDailyGate = new Promise<void>((r) => {
      releaseReadDaily = r;
    });
    const gatedPort1: HistoryStoragePort = {
      eventFileSize: (d) => base1.eventFileSize(d),
      appendEvent: (d, l) => base1.appendEvent(d, l),
      readEvents: (d) => base1.readEvents(d),
      readEventLines: (d) => base1.readEventLines(d),
      readEventLinesDesc: (d) => base1.readEventLinesDesc(d),
      listEventDates: () => base1.listEventDates(),
      deleteEventDate: (d) => base1.deleteEventDate(d),
      readDaily: async (d) => {
        if (d === '2026-10-24') {
          readDailyEntered();
          await readDailyGate;
        }
        return base1.readDaily(d);
      },
      writeDaily: (d, j) => base1.writeDaily(d, j),
      listDailyDates: () => base1.listDailyDates(),
      deleteDailyDate: (d) => base1.deleteDailyDate(d),
      readMonthly: (m) => base1.readMonthly(m),
      writeMonthly: (m, j) => base1.writeMonthly(m, j),
      listMonthlyMonths: () => base1.listMonthlyMonths(),
      harden: () => base1.harden(),
      clearAll: () => base1.clearAll(),
    };

    let wall1 = Date.UTC(2026, 10, 18, 10, 0, 0);
    let mono1 = 1_000;
    let jobCb1!: (ev: JobEvent) => Promise<void>;
    const rt1 = createSenseRuntime(
      {
        clock: { wall: () => wall1, mono: () => mono1 },
        history: gatedPort1,
        storage: { load: async () => undefined, save: async () => {} },
        dsh: {
          onAgentEvent: () => () => {},
          onTool: () => () => {},
          onJob: (cb) => {
            jobCb1 = cb;
            return () => {};
          },
          deliver: async () => {},
          tokenSnapshot: async () => undefined,
        },
        helper: { spawn: () => undefined },
        probe: { create: () => ({ onSample: () => () => {}, start: () => {}, stop: async () => {} }) },
        files: { watch: () => ({ close: () => {} }) },
      },
      { platform: 'linux', timeZone: 'UTC', intervalMs: 600_000 },
    );

    const startP = rt1.start();
    await onReadDaily;
    const clearP = rt1.clearHistory();
    releaseReadDaily();
    await Promise.all([startP, clearP]);

    const octAfterClear = await rt1.tools.envSummary({ month: '2026-10' });
    expect(octAfterClear.available).toBe(false);
    expect(octAfterClear.partial).toBeUndefined();

    await jobCb1({ type: 'started', id: 'nov-live', at: wall1 + 1_000 });
    wall1 = Date.UTC(2026, 11, 1, 0, 1, 0);
    mono1 += 13 * 86_400_000;
    await jobCb1({ type: 'started', id: 'dec-live', at: wall1 });
    await rt1.tools.envHistory({});
    const novMonthly = await base1.readMonthly('2026-11');
    expect(novMonthly).toBeDefined();
    expect((JSON.parse(novMonthly ?? '{}') as MonthlySummary).month).toBe('2026-11');
    await rt1.stop();

    // 2) Transient and permanent writeDaily failures in runBackfillStep keep pendingBackfill intact (#4)
    const dir4 = await makeTempDir();
    await mkdir(join(dir4, 'history', 'events'), { recursive: true, mode: 0o700 });
    const sampleLines = `${Array.from({ length: 200 }, (_, i) =>
      JSON.stringify({
        record: 'event',
        id: `bf-${i}`,
        kind: 'app.activated',
        subject: 'Editor',
        level: 'record',
        at: Date.UTC(2026, 9, 25, 10, 0, 0) + i * 100,
        source: { id: 'helper', api: 'nsworkspace', host: 'local' },
      }),
    ).join('\n')}\n`;
    await writeFile(join(dir4, 'history', 'events', '2026-10-25.jsonl'), sampleLines, { mode: 0o600 });
    await writeFile(join(dir4, 'history', 'events', '2026-10-26.jsonl'), sampleLines, { mode: 0o600 });

    const base4 = new FileHistoryStoragePort(dir4);
    let failFirst = true;
    const transientPort: HistoryStoragePort = {
      eventFileSize: (d) => base4.eventFileSize(d),
      appendEvent: (d, l) => base4.appendEvent(d, l),
      readEvents: (d) => base4.readEvents(d),
      readEventLines: (d) => base4.readEventLines(d),
      readEventLinesDesc: (d) => base4.readEventLinesDesc(d),
      listEventDates: () => base4.listEventDates(),
      deleteEventDate: (d) => base4.deleteEventDate(d),
      readDaily: (d) => base4.readDaily(d),
      writeDaily: async (d, j) => {
        if (failFirst && d === '2026-10-25') {
          failFirst = false;
          throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        }
        return base4.writeDaily(d, j);
      },
      listDailyDates: () => base4.listDailyDates(),
      deleteDailyDate: (d) => base4.deleteDailyDate(d),
      readMonthly: (m) => base4.readMonthly(m),
      writeMonthly: (m, j) => base4.writeMonthly(m, j),
      listMonthlyMonths: () => base4.listMonthlyMonths(),
      harden: () => base4.harden(),
      clearAll: () => base4.clearAll(),
    };
    const hTransient = createRuntimeHarness({
      nowMs: Date.UTC(2026, 10, 5, 10, 0, 0),
      history: transientPort,
      timeZone: 'UTC',
    });
    await hTransient.runtime.start();
    const before = await hTransient.runtime.tools.envSummary({ month: '2026-10' });
    expect(before.available).toBe(true);
    expect(before.partial).toBe(true);
    if (before.available) {
      expect(before.pendingDays).toEqual(['2026-10-25', '2026-10-26']);
      expect(typeof before.note).toBe('string');
    }
    await vi.waitFor(async () => expect(await base4.readMonthly('2026-10')).toBeDefined(), {
      timeout: 3_000,
      interval: 20,
    });
    const after = await hTransient.runtime.tools.envSummary({ month: '2026-10' });
    expect(after.partial).toBeUndefined();
    const monthly = JSON.parse((await base4.readMonthly('2026-10')) ?? '{}') as MonthlySummary;
    expect(monthly.includedDays).toEqual(['2026-10-25', '2026-10-26']);
    await hTransient.runtime.stop();

    // Permanent failure for one day keeps partial:true + pendingDays and never persists an incomplete monthly file
    const dirPerm = await makeTempDir();
    await mkdir(join(dirPerm, 'history', 'events'), { recursive: true, mode: 0o700 });
    await writeFile(join(dirPerm, 'history', 'events', '2026-10-25.jsonl'), sampleLines, { mode: 0o600 });
    await writeFile(join(dirPerm, 'history', 'events', '2026-10-26.jsonl'), sampleLines, { mode: 0o600 });
    const basePerm = new FileHistoryStoragePort(dirPerm);
    let attempts25 = 0;
    const permPort: HistoryStoragePort = {
      ...basePerm,
      eventFileSize: (d) => basePerm.eventFileSize(d),
      appendEvent: (d, l) => basePerm.appendEvent(d, l),
      readEvents: (d) => basePerm.readEvents(d),
      readEventLines: (d) => basePerm.readEventLines(d),
      readEventLinesDesc: (d) => basePerm.readEventLinesDesc(d),
      listEventDates: () => basePerm.listEventDates(),
      deleteEventDate: (d) => basePerm.deleteEventDate(d),
      readDaily: (d) => basePerm.readDaily(d),
      writeDaily: async (d, j) => {
        if (d === '2026-10-25') {
          attempts25++;
          throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        }
        return basePerm.writeDaily(d, j);
      },
      listDailyDates: () => basePerm.listDailyDates(),
      deleteDailyDate: (d) => basePerm.deleteDailyDate(d),
      readMonthly: (m) => basePerm.readMonthly(m),
      writeMonthly: (m, j) => basePerm.writeMonthly(m, j),
      listMonthlyMonths: () => basePerm.listMonthlyMonths(),
      harden: () => basePerm.harden(),
      clearAll: () => basePerm.clearAll(),
    };
    const hPerm = createRuntimeHarness({ nowMs: Date.UTC(2026, 10, 5, 10, 0, 0), history: permPort, timeZone: 'UTC' });
    await hPerm.runtime.start();
    await vi.waitFor(async () => expect(await basePerm.readDaily('2026-10-26')).toBeDefined(), {
      timeout: 3_000,
      interval: 20,
    });
    await vi.waitFor(() => expect(attempts25).toBe(3), { timeout: 3_000, interval: 20 });
    const permSummary = await hPerm.runtime.tools.envSummary({ month: '2026-10' });
    expect(permSummary.available).toBe(true);
    expect(permSummary.partial).toBe(true);
    if (permSummary.available) {
      expect(permSummary.pendingDays).toEqual(['2026-10-25']);
      expect(permSummary.summary.coveredDays).toBe(1);
    }
    expect(await basePerm.readMonthly('2026-10')).toBeUndefined();
    await hPerm.runtime.stop();

    // 3) Delayed event at 23:59:59 enqueued right after midnight is included in yesterday's rollover daily summary (nit #4)
    const dirMidnight = await makeTempDir();
    const portMidnight = new FileHistoryStoragePort(dirMidnight);
    const hMidnight = createRuntimeHarness({
      nowMs: Date.UTC(2026, 10, 10, 23, 59, 0),
      history: portMidnight,
      timeZone: 'UTC',
    });
    await hMidnight.runtime.start();
    hMidnight.setTime(Date.UTC(2026, 10, 11, 0, 0, 1), 62_000);
    await hMidnight.emitJob({
      type: 'started',
      id: 'late-yesterday-job',
      at: Date.UTC(2026, 10, 10, 23, 59, 59),
    });
    await hMidnight.runtime.tools.envHistory({});
    const nov10Daily = JSON.parse((await portMidnight.readDaily('2026-11-10')) ?? '{}') as DailySummary;
    expect(nov10Daily.totalEvents).toBeGreaterThanOrEqual(1);
    expect(await portMidnight.readEvents('2026-11-10')).toContain('late-yesterday-job');
    await hMidnight.runtime.stop();
  });

  it('streams daily summaries in background with accumulator parity and <100ms start() / <50MB RSS on 5MB day (#3)', async () => {
    // 1) Exact parity between createDailySummaryAccumulator and summarizeDay(parseHistoryLines(...))
    const dstCal = new LocalCalendar('America/New_York');
    const dstDate = '2026-03-08';
    const dstBounds = dstCal.dayBounds(dstDate);
    const rawLines = [
      JSON.stringify({ record: 'lifecycle', state: 'active', at: dstBounds.startMs + 60_000, boot: true }),
      JSON.stringify({
        record: 'event',
        id: 'app-1',
        kind: 'app.activated',
        subject: 'Alpha',
        level: 'record',
        at: dstBounds.startMs + 120_000,
        source: { id: 'helper', api: 'nsworkspace', host: 'local' },
      }),
      JSON.stringify({
        record: 'event',
        id: 'dup-1',
        kind: 'file.activity',
        subject: '/tmp/a',
        level: 'context',
        ruleId: 'r-file',
        at: dstBounds.startMs + 180_000,
        detail: { directory: '/tmp/a', created: 5, modified: 1, deleted: 0 },
        source: { id: 'files', api: 'watch', host: 'local' },
      }),
      JSON.stringify({
        record: 'event',
        id: 'dup-1',
        kind: 'file.burst',
        subject: '/tmp/b',
        level: 'record',
        ruleId: 'r-burst',
        at: dstBounds.startMs + 150_000, // out-of-order + overwrite file.activity -> file.burst
        detail: { directory: '/tmp/b', created: 1, modified: 2, deleted: 3, externalDeletionExceeded: true },
        source: { id: 'files', api: 'watch', host: 'local' },
      }),
      JSON.stringify({
        record: 'event',
        id: 'b-1',
        kind: 'body.rate',
        subject: 'rate:disk-drop:disk:/Volumes/Work',
        level: 'record',
        at: dstBounds.startMs + 200_000,
        detail: { metric: 'disk:/Volumes/Work', severity: 'critical' },
        source: { id: 'body', api: 'probe', host: 'local' },
      }),
      JSON.stringify({
        record: 'patch',
        id: 'b-1',
        level: 'wake',
        reason: 'wake-budget',
      }),
      JSON.stringify({
        record: 'event',
        id: 'app-ctrl',
        kind: 'app.activated',
        subject: '\u0001\u0002',
        level: 'record',
        at: dstBounds.startMs + 250_000,
        source: { id: 'helper', api: 'nsworkspace', host: 'local' },
      }),
      JSON.stringify({
        record: 'event',
        id: 'app-empty',
        kind: 'app.activated',
        subject: '',
        level: 'record',
        at: dstBounds.startMs + 260_000,
        source: { id: 'helper', api: 'nsworkspace', host: 'local' },
      }),
      JSON.stringify({ record: 'lifecycle', state: 'active', at: dstBounds.startMs + 400_000, boot: true }),
      JSON.stringify({ record: 'lifecycle', state: 'stopped', at: dstBounds.startMs + 500_000 }),
    ].join('\n');

    const acc = createDailySummaryAccumulator(dstDate, dstBounds, { isRunningAtEnd: false, truncatedAtLimit: true });
    for (const line of rawLines.split('\n')) acc.feed(line);
    expect(acc.finish()).toEqual(
      summarizeDay(dstDate, parseHistoryLines(rawLines), dstBounds, { isRunningAtEnd: false, truncatedAtLimit: true }),
    );

    // 2) U1-scale 5MB single-day missing summary: start() stays non-blocking relative to a 5MB stream-parse baseline and streaming backfill stays <50MB RSS
    const dir5 = await makeTempDir();
    await mkdir(join(dir5, 'history', 'events'), { recursive: true, mode: 0o700 });
    const baseWall = Date.UTC(2026, 10, 17, 12, 0, 0);
    const chunks: string[] = [];
    let bytes = 0;
    let count = 0;
    while (bytes < 5 * 1024 * 1024) {
      const line = `${JSON.stringify({
        record: 'event',
        id: `s5-${count}`,
        kind: count % 2 === 0 ? 'app.activated' : 'window.focused',
        subject: 'EditorApp',
        title: `Document-${count} /Users/tester/workspace/project/src/file-${count}.ts`,
        level: 'record',
        at: baseWall + count,
        source: { id: 'helper', api: 'nsworkspace', host: 'local' },
      })}\n`;
      chunks.push(line);
      bytes += Buffer.byteLength(line, 'utf8');
      count++;
    }
    await writeFile(join(dir5, 'history', 'events', '2026-11-17.jsonl'), chunks.join(''), { mode: 0o600 });
    chunks.length = 0;

    const port5 = new FileHistoryStoragePort(dir5);
    const utcBounds = new LocalCalendar('UTC').dayBounds('2026-11-17');
    const refAcc = createDailySummaryAccumulator('2026-11-17', utcBounds, {
      isRunningAtEnd: false,
      truncatedAtLimit: false,
    });
    const refT0 = performance.now();
    for await (const line of port5.readEventLines('2026-11-17')) {
      refAcc.feed(line);
    }
    const refSummary = refAcc.finish();
    const ref5MbMs = Math.max(1, performance.now() - refT0);
    expect(refSummary.totalEvents).toBe(count);

    const createMgr5 = () =>
      new HistoryManager({
        port: port5,
        clock: { wall: () => Date.UTC(2026, 10, 18, 12, 0, 0), mono: () => 1_000 },
        isPaused: () => false,
        titlesAllowed: () => true,
        restoreEntries: () => {},
        clearMemoryEntries: () => {},
        emitSourceError: () => {},
        emitSourceOk: () => {},
        timeZone: 'UTC',
      });

    const startTimes: number[] = [];
    for (let run = 0; run < 2; run++) {
      const probe = createMgr5();
      const t0 = performance.now();
      await probe.start(false);
      startTimes.push(performance.now() - t0);
      try {
        expect(await port5.readDaily('2026-11-17')).toBeUndefined();
      } finally {
        await probe.stop();
        await rm(join(dir5, 'history', 'events', '2026-11-18.jsonl'), { force: true });
        await rm(join(dir5, 'history', 'daily', '2026-11-17.json'), { force: true });
        await rm(join(dir5, 'history', 'monthly', '2026-11.json'), { force: true });
      }
    }

    const mgr5 = createMgr5();
    const rss0 = process.memoryUsage().rss;
    const t0 = performance.now();
    await mgr5.start(false);
    startTimes.push(performance.now() - t0);
    try {
      expect(Math.min(...startTimes)).toBeLessThanOrEqual(ref5MbMs * 0.4);
      expect(await port5.readDaily('2026-11-17')).toBeUndefined();

      let peakRss = process.memoryUsage().rss;
      await vi.waitFor(
        async () => {
          peakRss = Math.max(peakRss, process.memoryUsage().rss);
          expect(await port5.readDaily('2026-11-17')).toBeDefined();
        },
        { timeout: 15_000, interval: 20 },
      );
      const rssDeltaMb = (peakRss - rss0) / 1_048_576;
      const daily5 = JSON.parse((await port5.readDaily('2026-11-17')) ?? '{}') as DailySummary;
      expect(daily5.totalEvents).toBe(count);
      expect(rssDeltaMb).toBeLessThan(50);
    } finally {
      await mgr5.stop();
    }
  }, 20_000);

  it('aggregates sleepCount/sleepDurationMs/lockDurationMs/firstWakeAt/lastSleepAt across accumulator parity, cross-day, DST, and extensions', () => {
    const nyCal = new LocalCalendar('America/New_York');

    // 1) Accumulator parity across duplicate-id overwrite, duplicate sleep, missing wake, and clock rollback.
    const normalDate = '2026-11-18';
    const normalBounds = nyCal.dayBounds(normalDate);
    const s1 = normalBounds.startMs + 3_600_000;
    const w1 = s1 + 7_200_000;
    const dupS1 = normalBounds.startMs + 12_000_000;
    const dupS2 = normalBounds.startMs + 13_000_000;
    const dupW = dupS2 + 1_800_000;
    const lock1 = normalBounds.startMs + 15_000_000;
    const unlock1 = lock1 + 900_000;
    const rollbackSleep = normalBounds.startMs + 20_000_000;
    const rollbackWake = normalBounds.startMs + 19_000_000;
    const missingWakeSleep = normalBounds.startMs + 22_000_000;

    const lines = [
      JSON.stringify({
        record: 'event',
        id: 's1',
        kind: 'system.sleep',
        subject: 'system',
        level: 'record',
        at: s1,
        detail: { at: s1 },
        source: { id: 'helper', api: 'ndjson', host: 'local' },
      }),
      // Duplicate id 'w1' overwrites earlier wake duration cleanly
      JSON.stringify({
        record: 'event',
        id: 'w1',
        kind: 'system.wake',
        subject: 'system',
        level: 'record',
        at: w1 - 1_000,
        detail: { at: w1 - 1_000, durationMs: 1_000 },
        source: { id: 'helper', api: 'ndjson', host: 'local' },
      }),
      JSON.stringify({
        record: 'event',
        id: 'w1',
        kind: 'system.wake',
        subject: 'system',
        level: 'record',
        at: w1,
        detail: { at: w1, durationMs: 7_200_000 },
        source: { id: 'helper', api: 'ndjson', host: 'local' },
      }),
      JSON.stringify({
        record: 'event',
        id: 'ds1',
        kind: 'system.sleep',
        subject: 'system',
        level: 'record',
        at: dupS1,
        detail: { at: dupS1 },
        source: { id: 'helper', api: 'ndjson', host: 'local' },
      }),
      JSON.stringify({
        record: 'event',
        id: 'ds2',
        kind: 'system.sleep',
        subject: 'system',
        level: 'record',
        at: dupS2,
        detail: { at: dupS2 },
        source: { id: 'helper', api: 'ndjson', host: 'local' },
      }),
      JSON.stringify({
        record: 'event',
        id: 'dw',
        kind: 'system.wake',
        subject: 'system',
        level: 'record',
        at: dupW,
        detail: { at: dupW, durationMs: 1_800_000 },
        source: { id: 'helper', api: 'ndjson', host: 'local' },
      }),
      JSON.stringify({
        record: 'event',
        id: 'l1',
        kind: 'screen.locked',
        subject: 'screen',
        level: 'record',
        at: lock1,
        detail: { at: lock1 },
        source: { id: 'helper', api: 'ndjson', host: 'local' },
      }),
      JSON.stringify({
        record: 'event',
        id: 'u1',
        kind: 'screen.unlocked',
        subject: 'screen',
        level: 'record',
        at: unlock1,
        detail: { at: unlock1, durationMs: 900_000 },
        source: { id: 'helper', api: 'ndjson', host: 'local' },
      }),
      JSON.stringify({
        record: 'event',
        id: 'rb-s',
        kind: 'system.sleep',
        subject: 'system',
        level: 'record',
        at: rollbackSleep,
        detail: { at: rollbackSleep },
        source: { id: 'helper', api: 'ndjson', host: 'local' },
      }),
      JSON.stringify({
        record: 'event',
        id: 'rb-w',
        kind: 'system.wake',
        subject: 'system',
        level: 'record',
        at: rollbackWake,
        detail: { at: rollbackWake },
        source: { id: 'helper', api: 'ndjson', host: 'local' },
      }),
      JSON.stringify({
        record: 'event',
        id: 'mw-s',
        kind: 'system.sleep',
        subject: 'system',
        level: 'record',
        at: missingWakeSleep,
        detail: { at: missingWakeSleep },
        source: { id: 'helper', api: 'ndjson', host: 'local' },
      }),
    ].join('\n');

    const acc = createDailySummaryAccumulator(normalDate, normalBounds);
    for (const line of lines.split('\n')) acc.feed(line);
    const accSummary = acc.finish();
    const daySummary = summarizeDay(normalDate, parseHistoryLines(lines), normalBounds);
    expect(accSummary).toEqual(daySummary);
    expect(daySummary.system).toEqual({
      // s1->w1 (1), ds1->ds2->dw (2), rb-s + mw-s without intervening wake after rb-w sorted before rb-s (3)
      sleepCount: 3,
      sleepDurationMs: 7_200_000 + 1_800_000,
      lockDurationMs: 900_000,
      firstWakeAt: w1,
      lastSleepAt: missingWakeSleep,
    });

    // 2) Cross-day sleep (23:00 Day 1 -> 07:00 Day 2) and lock across local midnight
    const d1Date = '2026-11-16';
    const d2Date = '2026-11-17';
    const d1Bounds = nyCal.dayBounds(d1Date);
    const d2Bounds = nyCal.dayBounds(d2Date);
    const d1SleepAt = d1Bounds.endMs - 3_600_000;
    const d2WakeAt = d2Bounds.startMs + 7 * 3_600_000;
    const d1Summary = summarizeDay(
      d1Date,
      {
        events: [
          {
            id: 'c1',
            kind: 'system.sleep',
            subject: 'system',
            level: 'record',
            at: d1SleepAt,
            source: { id: 'helper', api: 'ndjson', host: 'local' },
          },
        ],
        lifecycle: [],
      },
      d1Bounds,
    );
    const d2Summary = summarizeDay(
      d2Date,
      {
        events: [
          {
            id: 'c2',
            kind: 'system.wake',
            subject: 'system',
            level: 'record',
            at: d2WakeAt,
            detail: { at: d2WakeAt, durationMs: 8 * 3_600_000 },
            source: { id: 'helper', api: 'ndjson', host: 'local' },
          },
          {
            id: 'c3',
            kind: 'screen.unlocked',
            subject: 'screen',
            level: 'record',
            at: d2Bounds.startMs + 1_800_000,
            detail: { at: d2Bounds.startMs + 1_800_000, durationMs: 3_600_000 },
            source: { id: 'helper', api: 'ndjson', host: 'local' },
          },
        ],
        lifecycle: [],
      },
      d2Bounds,
    );
    expect(d1Summary.system).toEqual({
      sleepCount: 1,
      sleepDurationMs: 0,
      lockDurationMs: 0,
      lastSleepAt: d1SleepAt,
    });
    expect(d2Summary.system).toEqual({
      sleepCount: 0,
      sleepDurationMs: 7 * 3_600_000,
      lockDurationMs: 1_800_000,
      firstWakeAt: d2WakeAt,
    });

    const monthly = synthesizeMonth('2026-11', [d1Summary, d2Summary], d2Bounds.endMs);
    expect(monthly.system).toEqual({
      sleepCount: 1,
      sleepDurationMs: 7 * 3_600_000,
      lockDurationMs: 1_800_000,
      firstWakeAt: d2WakeAt,
      lastSleepAt: d1SleepAt,
    });

    // 3) DST transitions (23h spring-forward and 25h fall-back in America/New_York)
    const springBounds = nyCal.dayBounds('2026-03-08'); // 23h
    const springSleep = springBounds.startMs + 3_600_000; // 01:00 EST
    const springWake = springBounds.startMs + 6 * 3_600_000; // 08:00 EDT (5 real hours elapsed)
    const springSummary = summarizeDay(
      '2026-03-08',
      {
        events: [
          {
            id: 'sp-s',
            kind: 'system.sleep',
            subject: 'system',
            level: 'record',
            at: springSleep,
            source: { id: 'helper', api: 'ndjson', host: 'local' },
          },
          {
            id: 'sp-w',
            kind: 'system.wake',
            subject: 'system',
            level: 'record',
            at: springWake,
            detail: { at: springWake, durationMs: 5 * 3_600_000 },
            source: { id: 'helper', api: 'ndjson', host: 'local' },
          },
        ],
        lifecycle: [],
      },
      springBounds,
    );
    expect(springSummary.system).toEqual({
      sleepCount: 1,
      sleepDurationMs: 5 * 3_600_000,
      lockDurationMs: 0,
      firstWakeAt: springWake,
      lastSleepAt: springSleep,
    });

    const fallBounds = nyCal.dayBounds('2026-11-01'); // 25h
    const fallSleep = fallBounds.startMs + 1_800_000; // 00:30 EDT
    const fallWake = fallBounds.startMs + 24.5 * 3_600_000; // 23:30 EST (24 real hours elapsed)
    const fallSummary = summarizeDay(
      '2026-11-01',
      {
        events: [
          {
            id: 'fl-s',
            kind: 'system.sleep',
            subject: 'system',
            level: 'record',
            at: fallSleep,
            source: { id: 'helper', api: 'ndjson', host: 'local' },
          },
          {
            id: 'fl-w',
            kind: 'system.wake',
            subject: 'system',
            level: 'record',
            at: fallWake,
            detail: { at: fallWake, durationMs: 24 * 3_600_000 },
            source: { id: 'helper', api: 'ndjson', host: 'local' },
          },
        ],
        lifecycle: [],
      },
      fallBounds,
    );
    expect(fallSummary.system).toEqual({
      sleepCount: 1,
      sleepDurationMs: 24 * 3_600_000,
      lockDurationMs: 0,
      firstWakeAt: fallWake,
      lastSleepAt: fallSleep,
    });
    expect(fallSummary.system!.sleepDurationMs).toBeLessThanOrEqual(fallBounds.durationMs);

    // 4) Extensibility and backwards compatibility in parseDailySummary / parseMonthlySummary
    const legacyRaw = JSON.stringify({ ...daySummary, system: undefined });
    expect(parseDailySummary(legacyRaw)).toBeDefined();
    const extendedRaw = JSON.stringify({
      ...daySummary,
      extensions: { metricBucketsVersion: 1 },
      envMetrics: { bucketMs: 300_000, buckets: [] },
    });
    const parsedExtended = parseDailySummary(extendedRaw) as DailySummary & { envMetrics?: unknown };
    expect(parsedExtended.extensions).toEqual({ metricBucketsVersion: 1 });
    expect(parsedExtended.envMetrics).toEqual({ bucketMs: 300_000, buckets: [] });

    const monthlyExtended = parseMonthlySummary(
      JSON.stringify({ ...monthly, extensions: { custom: true }, sliceB: 42 }),
    ) as MonthlySummary & { sliceB?: unknown };
    expect(monthlyExtended.extensions).toEqual({ custom: true });
    expect(monthlyExtended.sliceB).toBe(42);
  });
});
