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
import { projectState } from '../../src/host/presenter/project.ts';
import { RuntimeAttention } from '../../src/host/runtime/attention.ts';
import { FactExpiry } from '../../src/host/runtime/expiry.ts';
import {
  addDays,
  createDailySummaryAccumulator,
  type DailySummary,
  HistoryManager,
  LocalCalendar,
  MAX_DAILY_CRITICAL_EVENT_BYTES,
  MAX_DAILY_EVENT_BYTES,
  MAX_DAILY_FILE_EVENT_BYTES,
  MAX_DAILY_NON_FILE_EVENT_BYTES,
  MAX_HISTORY_TOTAL_BYTES,
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
    // Warm up query path once, then compare min tail-query latency against a full 20 MB stream+parse scan
    // so the check scales with disk/CPU load while still proving 20 MB is not scanned end-to-end.
    const res20 = await h20.runtime.tools.envHistory({ limit: 50 });
    const query20Samples: number[] = [];
    for (let r = 0; r < 3; r++) {
      const tq0 = performance.now();
      const probe = await h20.runtime.tools.envHistory({ limit: 50 });
      query20Samples.push(performance.now() - tq0);
      expect(probe.events).toHaveLength(50);
    }
    const minQuery20Ms = Math.min(...query20Samples);
    const rssDeltaMb = (process.memoryUsage().rss - rss0) / 1_048_576;
    expect(res20.events).toHaveLength(50);
    expect(res20.truncated).toBe(true);
    expect(rssDeltaMb).toBeLessThan(50);
    await h20.runtime.stop();

    const refT0 = performance.now();
    let refLines = 0;
    for await (const line of port20.readEventLines('2026-11-18')) {
      JSON.parse(line);
      refLines++;
    }
    const ref20MbMs = Math.max(1, performance.now() - refT0);
    expect(refLines).toBe(idx);
    expect(minQuery20Ms).toBeLessThanOrEqual(ref20MbMs * 0.2);

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
    const res30 = await h30.runtime.tools.envHistory({ limit: 50 });
    const query30Samples: number[] = [];
    for (let r = 0; r < 3; r++) {
      const tq30 = performance.now();
      const probe = await h30.runtime.tools.envHistory({ limit: 50 });
      query30Samples.push(performance.now() - tq30);
      expect(probe.events).toHaveLength(50);
    }
    const minQuery30Ms = Math.min(...query30Samples);
    expect(start30Ms).toBeLessThanOrEqual(ref20MbMs * 1.5);
    expect(minQuery30Ms).toBeLessThanOrEqual(ref20MbMs * 0.5);
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

  it('reads mixed old and slimmed event lines with parity across env_history, today/monthly summary, event stream, and skips glued lines', async () => {
    const dirOld = await makeTempDir();
    const dirMixed = await makeTempDir();
    const tDay = Date.UTC(2026, 9, 15, 10, 0, 0);
    const tNext = Date.UTC(2026, 10, 2, 10, 0, 0);

    const oldLines = [
      JSON.stringify({ record: 'lifecycle', state: 'active', at: tDay, boot: true }),
      JSON.stringify({
        record: 'event',
        id: 'ev-1',
        kind: 'app.activated',
        subject: 'EditorApp',
        level: 'record',
        cause: 'unknown',
        at: tDay + 1_000,
        source: { id: 'helper', api: 'ndjson', host: 'local' },
      }),
      JSON.stringify({
        record: 'event',
        id: 'ev-2',
        kind: 'file.activity',
        subject: '/work/proj',
        level: 'record',
        cause: 'unknown',
        ruleId: 'file-activity',
        at: tDay + 60_000,
        source: { id: 'files-global', api: 'watch', host: 'local' },
        detail: { directory: '/work/proj', windowMs: 10_000, created: 1, modified: 2, deleted: 0 },
      }),
      JSON.stringify({
        record: 'event',
        id: 'ev-3',
        kind: 'file.burst',
        subject: '/work/proj',
        level: 'wake',
        cause: 'unknown',
        ruleId: 'file-burst',
        at: tDay + 120_000,
        source: { id: 'files-global', api: 'watch', host: 'local' },
        detail: {
          directory: '/work/proj',
          windowMs: 60_000,
          created: 0,
          modified: 0,
          deleted: 55,
          externalDeletionExceeded: true,
        },
      }),
      JSON.stringify({ record: 'lifecycle', state: 'stopped', at: tDay + 180_000 }),
    ];

    const mixedLines = [
      oldLines[0],
      // Old line
      oldLines[1],
      // Glued malformed line that must be skipped without aborting file parse
      '{"record":"event","id":"g1","kind":"app.activated","at":1}{"record":"event","id":"g2"}',
      // Slimmed file.activity line (no detail.directory, no cause:"unknown", string source)
      JSON.stringify({
        record: 'event',
        id: 'ev-2',
        kind: 'file.activity',
        subject: '/work/proj',
        level: 'record',
        ruleId: 'file-activity',
        at: tDay + 60_000,
        source: 'files-global',
        detail: { windowMs: 10_000, created: 1, modified: 2, deleted: 0 },
      }),
      // Slimmed file.burst line
      JSON.stringify({
        record: 'event',
        id: 'ev-3',
        kind: 'file.burst',
        subject: '/work/proj',
        level: 'wake',
        ruleId: 'file-burst',
        at: tDay + 120_000,
        source: 'files-global',
        detail: { windowMs: 60_000, created: 0, modified: 0, deleted: 55, externalDeletionExceeded: true },
      }),
      oldLines[4],
    ];

    await mkdir(join(dirOld, 'history', 'events'), { recursive: true, mode: 0o700 });
    await mkdir(join(dirMixed, 'history', 'events'), { recursive: true, mode: 0o700 });
    await writeFile(join(dirOld, 'history', 'events', '2026-10-15.jsonl'), `${oldLines.join('\n')}\n`, { mode: 0o600 });
    await writeFile(join(dirMixed, 'history', 'events', '2026-10-15.jsonl'), `${mixedLines.join('\n')}\n`, {
      mode: 0o600,
    });

    // Today summary + event stream parity (run on 2026-10-15)
    const hOldToday = createRuntimeHarness({
      nowMs: tDay + 200_000,
      history: new FileHistoryStoragePort(dirOld),
      timeZone: 'UTC',
    });
    const hMixedToday = createRuntimeHarness({
      nowMs: tDay + 200_000,
      history: new FileHistoryStoragePort(dirMixed),
      timeZone: 'UTC',
    });
    await hOldToday.runtime.start();
    await hMixedToday.runtime.start();

    expect(hMixedToday.runtime.events().filter((e) => e.restored)).toEqual(
      hOldToday.runtime.events().filter((e) => e.restored),
    );
    expect(hMixedToday.runtime.historySnapshot().today).toEqual(hOldToday.runtime.historySnapshot().today);
    const qOld = await hOldToday.runtime.tools.envHistory({ from: tDay, to: tDay + 180_000 });
    const qMixed = await hMixedToday.runtime.tools.envHistory({ from: tDay, to: tDay + 180_000 });
    expect(qMixed.events).toEqual(qOld.events);
    await hOldToday.runtime.stop();
    await hMixedToday.runtime.stop();

    // Monthly summary parity (run on 2026-11-02 so 2026-10 is backfilled and synthesized)
    const portOldMonth = new FileHistoryStoragePort(dirOld);
    const portMixedMonth = new FileHistoryStoragePort(dirMixed);
    const hOldMonth = createRuntimeHarness({ nowMs: tNext, history: portOldMonth, timeZone: 'UTC' });
    const hMixedMonth = createRuntimeHarness({ nowMs: tNext, history: portMixedMonth, timeZone: 'UTC' });
    await hOldMonth.runtime.start();
    await hMixedMonth.runtime.start();
    await vi.waitFor(async () => expect(await portOldMonth.readMonthly('2026-10')).toBeDefined(), {
      timeout: 5_000,
      interval: 10,
    });
    await vi.waitFor(async () => expect(await portMixedMonth.readMonthly('2026-10')).toBeDefined(), {
      timeout: 5_000,
      interval: 10,
    });
    const mOld = await hOldMonth.runtime.tools.envSummary({ month: '2026-10' });
    const mMixed = await hMixedMonth.runtime.tools.envSummary({ month: '2026-10' });
    expect(mMixed).toEqual(mOld);
    await hOldMonth.runtime.stop();
    await hMixedMonth.runtime.stop();
  });

  it('drops queued pre-clear appendRawLine when clear() runs during async eventFileSize check (#44)', async () => {
    const events = new Map<string, string>();
    let releaseSize!: () => void;
    const sizeGate = new Promise<void>((r) => {
      releaseSize = r;
    });
    let sizeEntered!: () => void;
    const onSizeEntered = new Promise<void>((r) => {
      sizeEntered = r;
    });
    let gateFirstOnly = true;
    const gatedPort: HistoryStoragePort = {
      eventFileSize: async (date) => {
        if (gateFirstOnly) {
          gateFirstOnly = false;
          sizeEntered();
          await sizeGate;
        }
        return Buffer.byteLength(events.get(date) ?? '', 'utf8');
      },
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
      listMonthlyMonths: async () => [],
      clearAll: async () => {
        events.clear();
      },
    };
    const wall = Date.UTC(2026, 10, 18, 9, 0, 0);
    const mgr = new HistoryManager({
      port: gatedPort,
      clock: { wall: () => wall, mono: () => 1_000 },
      isPaused: () => false,
      titlesAllowed: () => false,
      restoreEntries: () => {},
      clearMemoryEntries: () => {},
      emitSourceError: () => {},
      emitSourceOk: () => {},
      timeZone: 'UTC',
    });
    const startP = mgr.start(false);
    await onSizeEntered;
    mgr.recordEvent({
      id: 'pre-clear-queued',
      kind: 'app.activated',
      subject: 'StaleApp',
      level: 'record',
      at: wall + 100,
      source: { id: 'helper', api: 'ndjson', host: 'local' },
    });
    const clearP = mgr.clear();
    releaseSize();
    await Promise.all([startP, clearP]);
    expect(events.get('2026-11-18') ?? '').not.toContain('pre-clear-queued');
    expect(events.get('2026-11-18') ?? '').not.toContain('StaleApp');
    await mgr.stop();
  });

  it('shortens UUID-based IDs on disk, maps patchEvent/feedback consistently, and keeps IDs unique across same-day restarts', async () => {
    const dir = await makeTempDir();
    const port = new FileHistoryStoragePort(dir);
    const wall = Date.UTC(2026, 10, 18, 12, 0, 0);
    const mgr1 = new HistoryManager({
      port,
      clock: { wall: () => wall, mono: () => 1_000 },
      isPaused: () => false,
      titlesAllowed: () => true,
      restoreEntries: () => {},
      clearMemoryEntries: () => {},
      emitSourceError: () => {},
      emitSourceOk: () => {},
      timeZone: 'UTC',
    });
    await mgr1.start(false);
    const uuidId = '550e8400-e29b-41d4-a716-446655440000:7';
    mgr1.recordEvent({
      id: uuidId,
      kind: 'app.activated',
      subject: 'Editor',
      level: 'record',
      cause: 'unknown',
      at: wall + 1_000,
      source: { id: 'helper', api: 'ndjson', host: 'local' },
    });
    mgr1.patchEvent(uuidId, { at: wall + 1_000, level: 'context', feedback: 'useful' });
    await mgr1.stop();

    const raw = (await port.readEvents('2026-11-18')) ?? '';
    expect(raw).not.toContain('550e8400-e29b-41d4-a716-446655440000');
    expect(raw).not.toContain('"cause":"unknown"');
    expect(raw).toContain('"source":"helper"');

    const parsed1 = parseHistoryLines(raw);
    expect(parsed1.events).toHaveLength(1);
    const shortId1 = parsed1.events[0]?.id ?? '';
    expect(shortId1.length).toBeLessThanOrEqual(12);
    expect(parsed1.events[0]?.level).toBe('context');
    expect(parsed1.events[0]?.feedback).toBe('useful');
    expect(parsed1.events[0]?.source).toEqual({ id: 'helper', api: 'ndjson', host: 'local' });

    // Second session on the same day emits a distinct short ID and can still patch the restored event.
    const restored: Array<{ id: string }> = [];
    const mgr2 = new HistoryManager({
      port,
      clock: { wall: () => wall + 60_000, mono: () => 2_000 },
      isPaused: () => false,
      titlesAllowed: () => true,
      restoreEntries: (entries) => {
        restored.push(...entries);
      },
      clearMemoryEntries: () => {},
      emitSourceError: () => {},
      emitSourceOk: () => {},
      timeZone: 'UTC',
    });
    await mgr2.start(false);
    expect(restored.map((e) => e.id)).toEqual([shortId1]);
    mgr2.patchEvent(shortId1, { feedback: 'noise' });
    mgr2.recordEvent({
      id: '550e8400-e29b-41d4-a716-446655440000:1',
      kind: 'app.activated',
      subject: 'Terminal',
      level: 'record',
      cause: 'unknown',
      at: wall + 61_000,
      source: { id: 'helper', api: 'ndjson', host: 'local' },
    });
    await mgr2.stop();

    const parsed2 = parseHistoryLines((await port.readEvents('2026-11-18')) ?? '');
    expect(parsed2.events).toHaveLength(2);
    expect(parsed2.events.find((e) => e.id === shortId1)?.feedback).toBe('noise');
    expect(parsed2.events.filter((e) => e.id !== shortId1)).toHaveLength(1);
  });

  it('aggregates file.activity per (dir, cause) into 60s disk lines while keeping memory stream intact', async () => {
    const dir = await makeTempDir();
    const port = new FileHistoryStoragePort(dir);
    let wall = Date.UTC(2026, 10, 18, 12, 0, 0);
    let mono = 1_000;
    const mgr = new HistoryManager({
      port,
      clock: { wall: () => wall, mono: () => mono },
      isPaused: () => false,
      titlesAllowed: () => true,
      restoreEntries: () => {},
      clearMemoryEntries: () => {},
      emitSourceError: () => {},
      emitSourceOk: () => {},
      timeZone: 'UTC',
    });
    await mgr.start(false);

    // Emit 6 x 10s external ('unknown') edits and 2 x 10s agent edits in the same dir within 60s
    const startWall = wall;
    const startMono = mono;
    for (let i = 0; i < 6; i++) {
      wall = startWall + i * 10_000;
      mono = startMono + i * 10_000;
      mgr.recordEvent({
        id: `ext-${i}`,
        kind: 'file.activity',
        subject: '/work/proj',
        level: 'record',
        cause: 'unknown',
        at: wall,
        source: { id: 'files-global', api: 'watch', host: 'local' },
        detail: {
          directory: '/work/proj',
          windowMs: 10_000,
          created: 1,
          modified: 2,
          deleted: 0,
          ...(i === 2 ? { rolledUp: 3 } : {}),
          files: [`a${i}.ts`],
        },
      });
      if (i < 2) {
        mgr.recordEvent({
          id: `agent-${i}`,
          kind: 'file.activity',
          subject: '/work/proj',
          level: 'record',
          cause: 'agent',
          at: wall,
          source: { id: 'files-global', api: 'watch', host: 'local' },
          detail: {
            directory: '/work/proj',
            windowMs: 10_000,
            created: 0,
            modified: 1,
            deleted: 1,
            files: [`b${i}.ts`],
          },
        });
      }
    }

    // Before 60s flush: summary and query() reflect pending buckets, while disk has not written file.activity yet
    expect(mgr.timelineSnapshots().today?.fileActivity.proj).toEqual({
      events: 2,
      created: 6,
      modified: 14,
      deleted: 2,
    });
    const beforeFlushQuery = await mgr.query({ kinds: ['file.activity'] });
    expect(beforeFlushQuery.events).toHaveLength(2);
    mgr.patchEvent('ext-0', { feedback: 'useful' });
    expect((await port.readEvents('2026-11-18')) ?? '').not.toContain('"file.activity"');

    // Advance past 60s flush deadline and tick
    wall = startWall + 61_000;
    mono = startMono + 61_000;
    await mgr.tick();

    const parsed = parseHistoryLines((await port.readEvents('2026-11-18')) ?? '');
    const fileLines = parsed.events.filter((e) => e.kind === 'file.activity');
    expect(fileLines).toHaveLength(2);
    const extDisk = fileLines.find((e) => e.cause === 'unknown');
    const agentDisk = fileLines.find((e) => e.cause === 'agent');
    expect(extDisk?.detail).toMatchObject({
      directory: '/work/proj',
      windowMs: 60_000,
      created: 6,
      modified: 12,
      deleted: 0,
      rolledUp: 3,
    });
    expect(extDisk?.feedback).toBe('useful');
    expect(agentDisk?.detail).toMatchObject({
      directory: '/work/proj',
      windowMs: 60_000,
      created: 0,
      modified: 2,
      deleted: 2,
    });
    await mgr.stop();

    // End-to-end runtime check: 10s files-global cadence keeps all 10s events in runtime.events() while disk writes 1 aggregated line/min
    const rtDir = await makeTempDir();
    const rtPort = new FileHistoryStoragePort(rtDir);
    let rtWall = Date.UTC(2026, 10, 18, 14, 0, 0);
    let rtMono = 1_000;
    let watchCb: ((event: { path: string; change: 'add' | 'modify' | 'delete'; at: number }) => void) | undefined;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    try {
      const rt = createSenseRuntime(
        {
          clock: { wall: () => rtWall, mono: () => rtMono },
          history: rtPort,
          storage: { load: async () => undefined, save: async () => {} },
          dsh: {
            onAgentEvent: () => () => {},
            onTool: () => () => {},
            onJob: () => () => {},
            deliver: async () => {},
            tokenSnapshot: async () => undefined,
          },
          helper: { spawn: () => undefined },
          probe: { create: () => ({ onSample: () => () => {}, start: () => {}, stop: async () => {} }) },
          files: {
            watch: (_root, cb) => {
              watchCb = cb as typeof watchCb;
              return { close: () => {} };
            },
          },
        },
        {
          platform: 'linux',
          timeZone: 'UTC',
          intervalMs: 600_000,
          globalFileWatch: { root: '/work', windowMs: 10_000, homedir: '/home/tester', dataDirs: [rtDir] },
        },
      );
      await rt.start();
      for (let i = 0; i < 4; i++) {
        watchCb?.({ path: `/work/repo/file-${i}.ts`, change: 'modify', at: rtWall + 100 });
        rtWall += 10_000;
        rtMono += 10_000;
        await vi.advanceTimersByTimeAsync(10_000);
        await rt.tools.envHistory({});
      }
      expect(rt.events().filter((e) => e.kind === 'file.activity')).toHaveLength(4);
      rtWall += 60_000;
      rtMono += 60_000;
      await vi.advanceTimersByTimeAsync(60_000);
      await rt.tools.envHistory({});
      const rtDisk = parseHistoryLines((await rtPort.readEvents('2026-11-18')) ?? '');
      const rtActivity = rtDisk.events.filter((e) => e.kind === 'file.activity');
      expect(rtActivity).toHaveLength(1);
      expect(rtActivity[0]?.detail).toMatchObject({ directory: '/work/repo', modified: 4 });
      await rt.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('flushes pending file.activity buckets on stop() and midnight rollover', async () => {
    const dir = await makeTempDir();
    const port = new FileHistoryStoragePort(dir);
    let wall = Date.UTC(2026, 10, 18, 23, 59, 50);
    let mono = 1_000;
    const mgr = new HistoryManager({
      port,
      clock: { wall: () => wall, mono: () => mono },
      isPaused: () => false,
      titlesAllowed: () => true,
      restoreEntries: () => {},
      clearMemoryEntries: () => {},
      emitSourceError: () => {},
      emitSourceOk: () => {},
      timeZone: 'UTC',
    });
    await mgr.start(false);
    mgr.recordEvent({
      id: 'fa-rollover-1',
      kind: 'file.activity',
      subject: '/work/day1',
      level: 'record',
      cause: 'unknown',
      at: wall + 2_000,
      source: { id: 'files-global', api: 'watch', host: 'local' },
      detail: { directory: '/work/day1', windowMs: 10_000, created: 2, modified: 1, deleted: 0 },
    });

    // Cross midnight only 15s later (< 60s window): pending bucket must flush into 2026-11-18 before rollover
    wall = Date.UTC(2026, 10, 19, 0, 0, 5);
    mono += 15_000;
    await mgr.tick();

    const day1Raw = (await port.readEvents('2026-11-18')) ?? '';
    expect(day1Raw).toContain('/work/day1');
    const daily1 = JSON.parse((await port.readDaily('2026-11-18')) ?? '{}') as DailySummary;
    expect(daily1.fileActivity.day1).toEqual({ events: 1, created: 2, modified: 1, deleted: 0 });

    // Record another bucket on day 2 and call stop() immediately (< 60s): stop() must flush it before shutdown
    mgr.recordEvent({
      id: 'fa-stop-1',
      kind: 'file.activity',
      subject: '/work/day2',
      level: 'record',
      cause: 'agent',
      at: wall + 1_000,
      source: { id: 'files-global', api: 'watch', host: 'local' },
      detail: { directory: '/work/day2', windowMs: 10_000, created: 1, modified: 0, deleted: 3 },
    });
    await mgr.stop();

    const day2Raw = (await port.readEvents('2026-11-19')) ?? '';
    expect(day2Raw).toContain('/work/day2');
    const lastStopIdx = day2Raw.lastIndexOf('"stopped"');
    const day2FaIdx = day2Raw.indexOf('/work/day2');
    expect(day2FaIdx).toBeGreaterThan(-1);
    expect(day2FaIdx).toBeLessThan(lastStopIdx);
  });

  it('isolates file.* vs non-file daily budgets, always persists non-file context/wake exceptions, and enforces 30d total cap', async () => {
    expect(MAX_DAILY_FILE_EVENT_BYTES).toBe(12 * 1024 * 1024);
    expect(MAX_DAILY_NON_FILE_EVENT_BYTES).toBe(8 * 1024 * 1024);
    expect(MAX_HISTORY_TOTAL_BYTES).toBeLessThanOrEqual(600 * 1024 * 1024);

    const dir = await makeTempDir();
    const port = new FileHistoryStoragePort(dir);
    const wall = Date.UTC(2026, 10, 18, 12, 0, 0);
    const capErrors: Array<{ error: string; extra?: Record<string, unknown> }> = [];
    const mgr = new HistoryManager({
      port,
      clock: { wall: () => wall, mono: () => 1_000 },
      isPaused: () => false,
      titlesAllowed: () => true,
      restoreEntries: () => {},
      clearMemoryEntries: () => {},
      emitSourceError: (error, extra) => capErrors.push({ error, extra }),
      emitSourceOk: () => {},
      timeZone: 'UTC',
      maxFileDailyBytes: 380,
      maxNonFileDailyBytes: 360,
    });
    await mgr.start(false);

    // Push file.burst lines past the 380B file tier cap
    for (let i = 0; i < 4; i++) {
      mgr.recordEvent({
        id: `fb-${i}`,
        kind: 'file.burst',
        subject: `/work/burst-${i}-${'a'.repeat(50)}`,
        level: 'wake',
        at: wall + i * 1_000,
        source: { id: 'files-global', api: 'watch', host: 'local' },
      });
    }
    await mgr.query({});

    // file.* cap must NOT block non-file record events while non-file budget remains
    mgr.recordEvent({
      id: 'app-while-file-capped',
      kind: 'app.activated',
      subject: 'EditorApp',
      level: 'record',
      at: wall + 5_000,
      source: { id: 'helper', api: 'ndjson', host: 'local' },
    });
    // Exhaust non-file 360B cap with another oversized record event
    for (let i = 0; i < 4; i++) {
      mgr.recordEvent({
        id: `app-pad-${i}`,
        kind: 'app.activated',
        subject: `AppPad-${i}-${'b'.repeat(70)}`,
        level: 'record',
        at: wall + 6_000 + i * 1_000,
        source: { id: 'helper', api: 'ndjson', host: 'local' },
      });
    }

    // Non-file context and wake exceptions MUST still persist even when BOTH tiers are capped
    mgr.recordEvent({
      id: 'critical-ctx-1',
      kind: 'body.anomaly',
      subject: 'memory',
      level: 'context',
      at: wall + 12_000,
      source: { id: 'body', api: 'probe', host: 'local' },
    });
    mgr.recordEvent({
      id: 'critical-wake-1',
      kind: 'job.exited',
      subject: 'build-job',
      level: 'wake',
      at: wall + 13_000,
      source: { id: 'dsh', api: 'events', host: 'local' },
    });
    mgr.patchEvent('critical-ctx-1', { feedback: 'useful' });
    await mgr.stop();

    const raw = (await port.readEvents('2026-11-18')) ?? '';
    const parsed = parseHistoryLines(raw);
    const ids = parsed.events.map((e) => e.id);
    expect(ids).toContain('app-while-file-capped');
    expect(ids).toContain('critical-ctx-1');
    expect(ids).toContain('critical-wake-1');
    expect(parsed.events.find((e) => e.id === 'critical-ctx-1')?.feedback).toBe('useful');
    expect(ids).not.toContain('fb-3');
    expect(ids).not.toContain('app-pad-3');
    expect(capErrors.filter((c) => c.error === 'daily-limit-exceeded')).toHaveLength(1);

    // 30d total disk ceiling prunes oldest past days while keeping recent days + today
    const dirTotal = await makeTempDir();
    const totalPort = new FileHistoryStoragePort(dirTotal);
    await totalPort.appendEvent('2026-11-15', `${'x'.repeat(250)}\n`);
    await totalPort.appendEvent('2026-11-16', `${'y'.repeat(250)}\n`);
    await totalPort.appendEvent('2026-11-17', `${'z'.repeat(200)}\n`);
    const mgrTotal = new HistoryManager({
      port: totalPort,
      clock: { wall: () => wall, mono: () => 2_000 },
      isPaused: () => false,
      titlesAllowed: () => true,
      restoreEntries: () => {},
      clearMemoryEntries: () => {},
      emitSourceError: () => {},
      emitSourceOk: () => {},
      timeZone: 'UTC',
      maxTotalBytes: 300,
    });
    await mgrTotal.start(false);
    await mgrTotal.stop();

    const kept = (await totalPort.listEventDates()).sort();
    expect(kept).not.toContain('2026-11-15');
    expect(kept).not.toContain('2026-11-16');
    expect(kept).toContain('2026-11-17');
    expect(kept).toContain('2026-11-18');
  });

  it('keeps history daily-limit-exceeded out of model deliveries with/without session, shows sidebar text, and deduplicates across restart', async () => {
    // 1) With active session + across same-day restart
    const dirWithSess = await makeTempDir();
    const basePortWithSess = new FileHistoryStoragePort(dirWithSess);
    let wall = Date.UTC(2026, 10, 18, 12, 0, 0);
    let simulatedBytes = MAX_DAILY_EVENT_BYTES - 80;
    let capJson: string | undefined;
    const capPort: HistoryStoragePort = {
      eventFileSize: async (date) => (date === '2026-11-18' ? simulatedBytes : 0),
      appendEvent: async (date, line) => {
        if (date === '2026-11-18') simulatedBytes += Buffer.byteLength(line, 'utf8');
        await basePortWithSess.appendEvent(date, line);
      },
      readEvents: (d) => basePortWithSess.readEvents(d),
      readEventLines: (d) => basePortWithSess.readEventLines(d),
      readEventLinesDesc: (d) => basePortWithSess.readEventLinesDesc(d),
      listEventDates: () => basePortWithSess.listEventDates(),
      deleteEventDate: (d) => basePortWithSess.deleteEventDate(d),
      readDaily: (d) => basePortWithSess.readDaily(d),
      writeDaily: (d, j) => basePortWithSess.writeDaily(d, j),
      listDailyDates: () => basePortWithSess.listDailyDates(),
      deleteDailyDate: (d) => basePortWithSess.deleteDailyDate(d),
      readMonthly: (m) => basePortWithSess.readMonthly(m),
      writeMonthly: (m, j) => basePortWithSess.writeMonthly(m, j),
      listMonthlyMonths: () => basePortWithSess.listMonthlyMonths(),
      readCapState: async () => capJson,
      writeCapState: async (j) => {
        capJson = j || undefined;
      },
      clearAll: async () => {
        capJson = undefined;
        await basePortWithSess.clearAll();
      },
    };

    const deliveredWithSess: string[] = [];
    const h1 = createRuntimeHarness({
      nowMs: wall,
      history: capPort,
      timeZone: 'UTC',
      deliver: async (_sid, intent) => {
        for (const c of intent.update.changes) {
          deliveredWithSess.push(`${c.signal.kind}:${c.signal.subject}:${String(c.signal.data.error ?? '')}`);
        }
      },
    });
    await h1.runtime.start();
    for (let i = 0; i < 3; i++) {
      await h1.emitJob({
        type: 'started',
        id: `cap-sess-${i}-${'x'.repeat(60)}`,
        sessionId: 's1',
        command: 'echo test',
        at: wall + (i + 1) * 1_000,
      });
    }
    await vi.waitFor(
      () =>
        expect(
          h1.runtime.events().filter((e) => e.kind === 'source.error' && e.reason === 'daily-limit-exceeded'),
        ).toHaveLength(1),
      { timeout: 2_000, interval: 5 },
    );
    await h1.runtime.tools.envHistory({});
    // Give delivery pipeline a beat to drain any queued deliveries
    await new Promise((r) => setTimeout(r, 50));
    expect(deliveredWithSess.some((d) => d.includes('daily-limit-exceeded'))).toBe(false);
    expect(h1.runtime.events().find((e) => e.reason === 'daily-limit-exceeded')?.level).toBe('record');
    expect(projectState(h1.runtime.state()).observation.sources.history).toMatchObject({
      status: 'ok',
      capped: true,
    });
    expect(projectState(h1.runtime.state()).observation.sources.history?.error).toBeUndefined();
    await h1.runtime.stop();

    // Restart on the same date: must NOT emit a duplicate daily-limit-exceeded event or push to model
    const deliveredRestart: string[] = [];
    const h2 = createRuntimeHarness({
      nowMs: wall + 60_000,
      history: capPort,
      timeZone: 'UTC',
      deliver: async (_sid, intent) => {
        for (const c of intent.update.changes) {
          deliveredRestart.push(`${c.signal.kind}:${String(c.signal.data.error ?? '')}`);
        }
      },
    });
    await h2.runtime.start();
    expect(projectState(h2.runtime.state()).observation.sources.history).toMatchObject({
      status: 'ok',
      capped: true,
    });
    expect(projectState(h2.runtime.state()).observation.sources.history?.error).toBeUndefined();
    await h2.emitJob({
      type: 'started',
      id: `cap-sess-after-restart-${'x'.repeat(60)}`,
      sessionId: 's1',
      command: 'echo test2',
      at: wall + 61_000,
    });
    await h2.runtime.tools.envHistory({});
    await new Promise((r) => setTimeout(r, 50));
    expect(h2.runtime.events().filter((e) => !e.restored && e.reason === 'daily-limit-exceeded')).toHaveLength(0);
    expect(deliveredRestart.some((d) => d.includes('daily-limit-exceeded'))).toBe(false);
    await h2.runtime.stop();

    // 2) Without active session (pending path): must never buffer daily-limit-exceeded into pending or deliver later
    const dirNoSess = await makeTempDir();
    const baseNoSess = new FileHistoryStoragePort(dirNoSess);
    let noSessBytes = MAX_DAILY_EVENT_BYTES - 80;
    let sessionList: Array<{ id: string; title: string; updatedAt: number; running: boolean }> = [];
    let jobCb: ((ev: JobEvent) => Promise<void>) | undefined;
    const deliveredNoSess: string[] = [];
    const noSessPort: HistoryStoragePort = {
      eventFileSize: async (date) => (date === '2026-11-18' ? noSessBytes : 0),
      appendEvent: async (date, line) => {
        if (date === '2026-11-18') noSessBytes += Buffer.byteLength(line, 'utf8');
        await baseNoSess.appendEvent(date, line);
      },
      readEvents: (d) => baseNoSess.readEvents(d),
      readEventLines: (d) => baseNoSess.readEventLines(d),
      readEventLinesDesc: (d) => baseNoSess.readEventLinesDesc(d),
      listEventDates: () => baseNoSess.listEventDates(),
      deleteEventDate: (d) => baseNoSess.deleteEventDate(d),
      readDaily: (d) => baseNoSess.readDaily(d),
      writeDaily: (d, j) => baseNoSess.writeDaily(d, j),
      listDailyDates: () => baseNoSess.listDailyDates(),
      deleteDailyDate: (d) => baseNoSess.deleteDailyDate(d),
      readMonthly: (m) => baseNoSess.readMonthly(m),
      writeMonthly: (m, j) => baseNoSess.writeMonthly(m, j),
      listMonthlyMonths: () => baseNoSess.listMonthlyMonths(),
      clearAll: () => baseNoSess.clearAll(),
    };
    const rtNoSess = createSenseRuntime(
      {
        clock: { wall: () => wall, mono: () => 1_000 },
        history: noSessPort,
        storage: { load: async () => undefined, save: async () => {} },
        dsh: {
          listSessions: async () => sessionList,
          onAgentEvent: () => () => {},
          onTool: () => () => {},
          onJob: (cb) => {
            jobCb = cb;
            return () => {};
          },
          deliver: async (_sid, intent) => {
            for (const c of intent.update.changes) {
              deliveredNoSess.push(`${c.signal.kind}:${c.signal.subject}:${String(c.signal.data.error ?? '')}`);
            }
          },
          tokenSnapshot: async () => undefined,
        },
        helper: { spawn: () => undefined },
        probe: { create: () => ({ onSample: () => () => {}, start: () => {}, stop: async () => {} }) },
        files: { watch: () => ({ close: () => {} }) },
      },
      { platform: 'linux', timeZone: 'UTC', intervalMs: 600_000, globalFileWatch: { disableInTests: true } },
    );
    await rtNoSess.start();
    for (let i = 0; i < 3; i++) {
      await jobCb?.({
        type: 'started',
        id: `no-sess-job-${i}-${'z'.repeat(60)}`,
        sessionId: 'no-sess',
        command: 'echo synthetic',
        at: wall + (i + 1) * 100,
      });
    }
    await vi.waitFor(
      () =>
        expect(
          rtNoSess.events().filter((e) => e.kind === 'source.error' && e.reason === 'daily-limit-exceeded'),
        ).toHaveLength(1),
      { timeout: 2_000, interval: 5 },
    );
    expect(projectState(rtNoSess.state()).observation.sources.history).toMatchObject({
      status: 'ok',
      capped: true,
    });
    expect(projectState(rtNoSess.state()).observation.sources.history?.error).toBeUndefined();

    // Now bring a session online and deliver an event on it: daily-limit-exceeded must NEVER be pending or delivered
    sessionList = [{ id: 's-late', title: 'Late', updatedAt: wall + 1_000, running: true }];
    await jobCb?.({
      type: 'exited',
      id: 'late-job-1',
      sessionId: 's-late',
      command: 'echo done',
      exitCode: 0,
      at: wall + 1_000,
    });
    await new Promise((r) => setTimeout(r, 80));
    expect(deliveredNoSess.some((d) => d.includes('daily-limit-exceeded'))).toBe(false);
    await rtNoSess.stop();
  });

  it('B1: keeps history source ok+capped on daily-limit-exceeded so subsequent real write failures still deliver and transient emitSourceOk preserves cap notice', async () => {
    // 1) Active session: daily-limit-exceeded keeps status='ok' + capped=true; subsequent ENOSPC delivers; recovery preserves capped=true
    const dirSess = await makeTempDir();
    const baseSess = new FileHistoryStoragePort(dirSess);
    const wall = Date.UTC(2026, 10, 18, 12, 0, 0);
    let failWrites = false;
    let simulatedBytes = MAX_DAILY_EVENT_BYTES - 80;
    let sessAgentCb: ((ev: AgentEvent) => Promise<void>) | undefined;
    let sessJobCb: ((ev: JobEvent) => Promise<void>) | undefined;
    const deliveredSess: string[] = [];
    const rtSess = createSenseRuntime(
      {
        clock: { wall: () => wall, mono: () => 1_000 },
        history: {
          eventFileSize: async (d) => (d === '2026-11-18' ? simulatedBytes : 0),
          appendEvent: async (d, line) => {
            if (failWrites) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
            if (d === '2026-11-18') simulatedBytes += Buffer.byteLength(line, 'utf8');
            await baseSess.appendEvent(d, line);
          },
          readEvents: (d) => baseSess.readEvents(d),
          readEventLines: (d) => baseSess.readEventLines(d),
          readEventLinesDesc: (d) => baseSess.readEventLinesDesc(d),
          listEventDates: () => baseSess.listEventDates(),
          deleteEventDate: (d) => baseSess.deleteEventDate(d),
          readDaily: (d) => baseSess.readDaily(d),
          writeDaily: (d, j) => baseSess.writeDaily(d, j),
          listDailyDates: () => baseSess.listDailyDates(),
          deleteDailyDate: (d) => baseSess.deleteDailyDate(d),
          readMonthly: (m) => baseSess.readMonthly(m),
          writeMonthly: (m, j) => baseSess.writeMonthly(m, j),
          listMonthlyMonths: () => baseSess.listMonthlyMonths(),
          clearAll: () => baseSess.clearAll(),
        },
        storage: { load: async () => undefined, save: async () => {} },
        dsh: {
          listSessions: async () => [{ id: 's1', title: 'Active', updatedAt: wall, running: true }],
          onAgentEvent: (cb) => {
            sessAgentCb = cb;
            return () => {};
          },
          onTool: () => () => {},
          onJob: (cb) => {
            sessJobCb = cb;
            return () => {};
          },
          deliver: async (_sid, intent) => {
            for (const c of intent.update.changes) {
              deliveredSess.push(`${c.signal.kind}:${c.signal.subject}:${String(c.signal.data.error ?? '')}`);
            }
          },
          tokenSnapshot: async () => undefined,
        },
        helper: { spawn: () => undefined },
        probe: { create: () => ({ onSample: () => () => {}, start: () => {}, stop: async () => {} }) },
        files: { watch: () => ({ close: () => {} }) },
      },
      { platform: 'linux', timeZone: 'UTC', intervalMs: 600_000, globalFileWatch: { disableInTests: true } },
    );
    await rtSess.start();
    await sessAgentCb?.({ type: 'created', sessionId: 's1' });
    await sessAgentCb?.({ type: 'pre-step', sessionId: 's1' });
    await sessAgentCb?.({ type: 'post-step', sessionId: 's1' });
    for (let i = 0; i < 3; i++) {
      await sessJobCb?.({
        type: 'started',
        id: `b1-sess-${i}-${'a'.repeat(60)}`,
        sessionId: 's1',
        command: 'echo test',
        at: wall + (i + 1) * 100,
      });
    }
    await vi.waitFor(
      () =>
        expect(
          rtSess.events().filter((e) => e.kind === 'source.error' && e.reason === 'daily-limit-exceeded'),
        ).toHaveLength(1),
      { timeout: 2_000, interval: 5 },
    );
    expect(rtSess.state().observation.sources.history).toMatchObject({
      status: 'ok',
      capped: true,
    });
    expect(rtSess.state().observation.sources.history?.error).toBeUndefined();

    // Now inject real ENOSPC on critical write: MUST still be delivered to active session s1!
    failWrites = true;
    await sessJobCb?.({
      type: 'started',
      id: 'b1-fail-job',
      sessionId: 's1',
      command: 'pnpm test',
      at: wall + 1_900,
    });
    await sessJobCb?.({
      type: 'exited',
      id: 'b1-fail-job',
      sessionId: 's1',
      command: 'pnpm test',
      exitCode: 1,
      at: wall + 2_000,
    });
    await vi.waitFor(() => expect(rtSess.state().observation.sources.history?.status).toBe('unavailable'), {
      timeout: 2_000,
      interval: 10,
    });
    await sessAgentCb?.({ type: 'pre-step', sessionId: 's1' });
    await vi.waitFor(
      () => expect(deliveredSess.some((d) => d === 'source.error:history:history-write-failed')).toBe(true),
      { timeout: 3_000, interval: 10 },
    );
    expect(rtSess.state().observation.sources.history).toMatchObject({
      status: 'unavailable',
      error: 'history-write-failed',
      capped: true,
    });

    // Transient write recovery (emitSourceOk) MUST restore status='ok' WITHOUT wiping capped=true
    failWrites = false;
    await sessJobCb?.({
      type: 'started',
      id: 'b1-recover-job',
      sessionId: 's1',
      command: 'pnpm test',
      at: wall + 2_900,
    });
    await sessJobCb?.({
      type: 'exited',
      id: 'b1-recover-job',
      sessionId: 's1',
      command: 'pnpm test',
      exitCode: 0,
      at: wall + 3_000,
    });
    await vi.waitFor(() => expect(rtSess.state().observation.sources.history?.status).toBe('ok'), {
      timeout: 2_000,
      interval: 10,
    });
    expect(rtSess.state().observation.sources.history).toMatchObject({
      status: 'ok',
      capped: true,
    });
    expect(rtSess.state().observation.sources.history?.error).toBeUndefined();
    expect(deliveredSess.some((d) => d.includes('daily-limit-exceeded'))).toBe(false);
    await rtSess.stop();

    // 2) No-session pending path: daily-limit-exceeded followed by ENOSPC still queues history-write-failed into pending
    const dirNoSess = await makeTempDir();
    const baseNoSess = new FileHistoryStoragePort(dirNoSess);
    let noSessFail = false;
    let noSessBytes = MAX_DAILY_EVENT_BYTES - 80;
    let agentCb: ((ev: AgentEvent) => Promise<void>) | undefined;
    let jobCb: ((ev: JobEvent) => Promise<void>) | undefined;
    let probeCb: ((body: Body) => void) | undefined;
    const sessions: Array<{ id: string; title: string; updatedAt: number; running: boolean }> = [];
    const deliveredPending: string[] = [];
    const diskBody = (free: number, at: number): Body => {
      const src = { id: 'body', api: 'probe', host: 'local' };
      const ok = <T>(value: T) => ({ value, status: 'ok' as const, source: src, observedAt: at, ttlMs: 10_000 });
      return {
        cpu: ok({ usage: 0.1, perCore: [0.1], load1: 0.1, load5: 0.1, load15: 0.1 }),
        memory: ok({ total: 1000, used: 200, pressure: 'normal' as const, swapUsed: 0 }),
        disks: {
          kind: 'disks',
          value: [{ mount: '/Volumes/Work', total: 1000, free, status: 'ok', observedAt: at, ttlMs: 10_000 }],
          status: 'ok',
          source: src,
          observedAt: at,
          ttlMs: 10_000,
        },
        battery: { value: null, status: 'unavailable', source: src, observedAt: at, ttlMs: 10_000 },
        thermal: ok('nominal' as const),
        network: ok({ online: true, rxBps: 0, txBps: 0 }),
        harnessProcess: ok({ rss: 100, cpu: 0.1, uptimeSec: 10 }),
        tokens: {
          value: null,
          status: 'unavailable',
          source: { id: 'tokens', api: 'dsh', host: 'local' },
          observedAt: at,
          ttlMs: 10_000,
        },
      };
    };
    let noSessWall = wall;
    let noSessMono = 1_000;
    const rtNoSess = createSenseRuntime(
      {
        clock: { wall: () => noSessWall, mono: () => noSessMono },
        history: {
          eventFileSize: async (d) => (d === '2026-11-18' ? noSessBytes : 0),
          appendEvent: async (d, line) => {
            if (noSessFail) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
            if (d === '2026-11-18') noSessBytes += Buffer.byteLength(line, 'utf8');
            await baseNoSess.appendEvent(d, line);
          },
          readEvents: (d) => baseNoSess.readEvents(d),
          readEventLines: (d) => baseNoSess.readEventLines(d),
          readEventLinesDesc: (d) => baseNoSess.readEventLinesDesc(d),
          listEventDates: () => baseNoSess.listEventDates(),
          deleteEventDate: (d) => baseNoSess.deleteEventDate(d),
          readDaily: (d) => baseNoSess.readDaily(d),
          writeDaily: (d, j) => baseNoSess.writeDaily(d, j),
          listDailyDates: () => baseNoSess.listDailyDates(),
          deleteDailyDate: (d) => baseNoSess.deleteDailyDate(d),
          readMonthly: (m) => baseNoSess.readMonthly(m),
          writeMonthly: (m, j) => baseNoSess.writeMonthly(m, j),
          listMonthlyMonths: () => baseNoSess.listMonthlyMonths(),
          clearAll: () => baseNoSess.clearAll(),
        },
        storage: { load: async () => undefined, save: async () => {} },
        dsh: {
          listSessions: async () => sessions,
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
            for (const c of intent.update.changes) {
              deliveredPending.push(`${c.signal.kind}:${c.signal.subject}:${String(c.signal.data.error ?? '')}`);
            }
          },
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
        files: { watch: () => ({ close: () => {} }) },
      },
      { platform: 'linux', timeZone: 'UTC', intervalMs: 600_000, globalFileWatch: { disableInTests: true } },
    );
    await rtNoSess.start();
    probeCb?.(diskBody(800, noSessWall));
    // Hit daily limit while no session exists
    for (let i = 0; i < 2; i++) {
      await jobCb?.({
        type: 'started',
        id: `b1-nosess-${i}-${'z'.repeat(60)}`,
        sessionId: 'no-sess',
        command: 'echo synthetic',
        at: noSessWall + (i + 1) * 100,
      });
    }
    await vi.waitFor(
      () =>
        expect(
          rtNoSess.events().filter((e) => e.kind === 'source.error' && e.reason === 'daily-limit-exceeded'),
        ).toHaveLength(1),
      { timeout: 2_000, interval: 5 },
    );
    expect(rtNoSess.state().observation.sources.history).toMatchObject({ status: 'ok', capped: true });

    // Real EACCES while still no session -> must queue history-write-failed into pending
    noSessFail = true;
    noSessWall += 2_000;
    noSessMono += 2_000;
    probeCb?.(diskBody(50, noSessWall));
    await vi.waitFor(() => expect(rtNoSess.state().observation.sources.history?.status).toBe('unavailable'), {
      timeout: 2_000,
      interval: 10,
    });

    // Bring session online and preStep it -> pending history-write-failed MUST deliver!
    sessions.push({ id: 's-late', title: 'Late', updatedAt: noSessWall + 2_000, running: true });
    await agentCb?.({ type: 'created', sessionId: 's-late' });
    await agentCb?.({ type: 'pre-step', sessionId: 's-late' });
    await vi.waitFor(
      () => expect(deliveredPending.some((d) => d === 'source.error:history:history-write-failed')).toBe(true),
      { timeout: 3_000, interval: 10 },
    );
    expect(deliveredPending.some((d) => d.includes('daily-limit-exceeded'))).toBe(false);
    await rtNoSess.stop();
  });

  it('persists rollover daily summary from in-memory accumulator after cap and rebuilds mid-day restart cleanly', async () => {
    const dir = await makeTempDir();
    const port = new FileHistoryStoragePort(dir);
    let wall = Date.UTC(2026, 10, 18, 23, 50, 0);
    let mono = 1_000;
    const mgr = new HistoryManager({
      port,
      clock: { wall: () => wall, mono: () => mono },
      isPaused: () => false,
      titlesAllowed: () => true,
      restoreEntries: () => {},
      clearMemoryEntries: () => {},
      emitSourceError: () => {},
      emitSourceOk: () => {},
      timeZone: 'UTC',
      maxNonFileDailyBytes: 250,
    });
    await mgr.start(false);

    // First 1-2 events fill the 250B non-file budget on disk, remaining events still count in todayAcc
    for (let i = 0; i < 10; i++) {
      wall += 1_000;
      mono += 1_000;
      mgr.recordEvent({
        id: `ev-roll-${i}`,
        kind: 'app.activated',
        subject: `App-${i}-${'x'.repeat(40)}`,
        level: 'record',
        at: wall,
        source: { id: 'helper', api: 'ndjson', host: 'local' },
      });
    }
    await mgr.query({});

    const diskDay1 = parseHistoryLines((await port.readEvents('2026-11-18')) ?? '');
    expect(diskDay1.events.length).toBeLessThan(10);
    const todayBeforeRollover = mgr.timelineSnapshots().today;
    expect(todayBeforeRollover?.totalEvents).toBe(10);
    expect(todayBeforeRollover?.truncatedAtLimit).toBe(true);

    // Cross midnight into 2026-11-19: persisted daily/2026-11-18.json and yesterday must match in-memory count 10
    wall = Date.UTC(2026, 10, 19, 0, 1, 0);
    mono += 660_000;
    await mgr.tick();
    await mgr.stop();

    const daily1 = JSON.parse((await port.readDaily('2026-11-18')) ?? '{}') as DailySummary;
    expect(daily1.totalEvents).toBe(10);
    expect(daily1.truncatedAtLimit).toBe(true);
    expect(mgr.timelineSnapshots().yesterday?.totalEvents).toBe(10);

    // Mid-day restart after cap: rebuilds from disk (>= persisted rows) and keeps truncatedAtLimit=true
    const dirMid = await makeTempDir();
    const portMid = new FileHistoryStoragePort(dirMid);
    const wallMid = Date.UTC(2026, 10, 20, 10, 0, 0);
    const mgrMid1 = new HistoryManager({
      port: portMid,
      clock: { wall: () => wallMid, mono: () => 1_000 },
      isPaused: () => false,
      titlesAllowed: () => true,
      restoreEntries: () => {},
      clearMemoryEntries: () => {},
      emitSourceError: () => {},
      emitSourceOk: () => {},
      timeZone: 'UTC',
      maxNonFileDailyBytes: 250,
    });
    await mgrMid1.start(false);
    for (let i = 0; i < 8; i++) {
      mgrMid1.recordEvent({
        id: `mid-${i}`,
        kind: 'app.activated',
        subject: `Mid-${i}-${'y'.repeat(40)}`,
        level: 'record',
        at: wallMid + (i + 1) * 1_000,
        source: { id: 'helper', api: 'ndjson', host: 'local' },
      });
    }
    await mgrMid1.stop();
    const midDiskCount = parseHistoryLines((await portMid.readEvents('2026-11-20')) ?? '').events.length;
    expect(midDiskCount).toBeGreaterThan(0);
    expect(midDiskCount).toBeLessThan(8);

    // Restart same day 2026-11-20
    const mgrMid2 = new HistoryManager({
      port: portMid,
      clock: { wall: () => wallMid + 30_000, mono: () => 2_000 },
      isPaused: () => false,
      titlesAllowed: () => true,
      restoreEntries: () => {},
      clearMemoryEntries: () => {},
      emitSourceError: () => {},
      emitSourceOk: () => {},
      timeZone: 'UTC',
      maxNonFileDailyBytes: 250,
    });
    await mgrMid2.start(false);
    const rebuiltToday = mgrMid2.timelineSnapshots().today;
    expect(rebuiltToday?.totalEvents).toBeGreaterThanOrEqual(midDiskCount);
    expect(rebuiltToday?.truncatedAtLimit).toBe(true);
    await mgrMid2.stop();
  });

  it('B2: clear() failure rollback restores pendingActivity buffers, concurrent live buffers, and same-day cap state', async () => {
    const dirA = await makeTempDir();
    const portA = new FileHistoryStoragePort(dirA);
    let wallA = Date.UTC(2026, 10, 21, 12, 0, 0);
    let monoA = 1_000;
    const errorsA: Array<{ error: string; extra?: Record<string, unknown> }> = [];
    let injectFailA = false;
    const origClearAllA = portA.clearAll.bind(portA);
    portA.clearAll = async () => {
      if (injectFailA) {
        await Promise.resolve();
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      }
      return origClearAllA();
    };

    const mgrA = new HistoryManager({
      port: portA,
      clock: { wall: () => wallA, mono: () => monoA },
      isPaused: () => false,
      titlesAllowed: () => true,
      restoreEntries: () => {},
      clearMemoryEntries: () => {},
      emitSourceError: (error, extra) => errorsA.push({ error, extra }),
      emitSourceOk: () => {},
      timeZone: 'UTC',
      maxFileDailyBytes: 240,
    });
    await mgrA.start(false);

    for (let i = 0; i < 6; i++) {
      mgrA.recordEvent({
        id: `b2-cap-${i}`,
        kind: 'file.changed',
        subject: `/work/cap-${i}-${'z'.repeat(30)}.ts`,
        level: 'record',
        at: wallA + (i + 1) * 100,
        source: { id: 'files-global', api: 'watch', host: 'local' },
      });
    }
    await mgrA.tick();
    expect(errorsA.filter((e) => e.error === 'daily-limit-exceeded')).toHaveLength(1);
    expect(mgrA.timelineSnapshots().today?.truncatedAtLimit).toBe(true);

    // Buffer an unflushed file.activity bucket before clear() fails.
    wallA += 1_000;
    monoA += 1_000;
    mgrA.recordEvent({
      id: 'b2-pend-cap',
      kind: 'file.activity',
      subject: '/work/pending-b2',
      level: 'record',
      cause: 'unknown',
      at: wallA,
      source: { id: 'files-global', api: 'watch', host: 'local' },
      detail: { directory: '/work/pending-b2', windowMs: 10_000, created: 2, modified: 3, deleted: 1 },
    });

    injectFailA = true;
    await expect(mgrA.clear()).rejects.toThrow('EACCES');

    // Same-day cap state & pending summary must survive failed clear without re-emitting daily-limit-exceeded.
    expect(mgrA.timelineSnapshots().today?.truncatedAtLimit).toBe(true);
    expect(mgrA.timelineSnapshots().today?.fileActivity['pending-b2']).toEqual({
      events: 1,
      created: 2,
      modified: 3,
      deleted: 1,
    });

    const linesBeforeExtra = (await portA.readEvents('2026-11-21')) ?? '';
    mgrA.recordEvent({
      id: 'b2-cap-after',
      kind: 'file.changed',
      subject: `/work/cap-after-${'z'.repeat(30)}.ts`,
      level: 'record',
      at: wallA + 500,
      source: { id: 'files-global', api: 'watch', host: 'local' },
    });
    await mgrA.tick();
    expect(errorsA.filter((e) => e.error === 'daily-limit-exceeded')).toHaveLength(1);
    expect((await portA.readEvents('2026-11-21')) ?? '').toBe(linesBeforeExtra);
    await mgrA.stop();

    // Case B: uncapped pendingActivity bucket + concurrent live bucket during failed clear() flush to disk on stop().
    const dirB = await makeTempDir();
    const portB = new FileHistoryStoragePort(dirB);
    const wallB = Date.UTC(2026, 10, 21, 14, 0, 0);
    const monoB = 5_000;
    let injectFailB = false;
    const origClearAllB = portB.clearAll.bind(portB);
    let mgrB!: HistoryManager;
    portB.clearAll = async () => {
      if (injectFailB) {
        await Promise.resolve();
        mgrB.recordEvent({
          id: 'b2-live-1',
          kind: 'file.activity',
          subject: '/work/live-b2',
          level: 'record',
          cause: 'unknown',
          at: wallB + 200,
          source: { id: 'files-global', api: 'watch', host: 'local' },
          detail: { directory: '/work/live-b2', windowMs: 10_000, created: 1, modified: 0, deleted: 0 },
        });
        mgrB.recordEvent({
          id: 'b2-live-merge',
          kind: 'file.activity',
          subject: '/work/pending-b2',
          level: 'record',
          cause: 'unknown',
          at: wallB + 250,
          source: { id: 'files-global', api: 'watch', host: 'local' },
          detail: { directory: '/work/pending-b2', windowMs: 10_000, created: 0, modified: 1, deleted: 0 },
        });
        throw Object.assign(new Error('EACCES: denied'), { code: 'EACCES' });
      }
      return origClearAllB();
    };
    mgrB = new HistoryManager({
      port: portB,
      clock: { wall: () => wallB, mono: () => monoB },
      isPaused: () => false,
      titlesAllowed: () => true,
      restoreEntries: () => {},
      clearMemoryEntries: () => {},
      emitSourceError: () => {},
      emitSourceOk: () => {},
      timeZone: 'UTC',
    });
    await mgrB.start(false);
    mgrB.recordEvent({
      id: 'b2-ok-1',
      kind: 'file.activity',
      subject: '/work/pending-b2',
      level: 'record',
      cause: 'unknown',
      at: wallB,
      source: { id: 'files-global', api: 'watch', host: 'local' },
      detail: { directory: '/work/pending-b2', windowMs: 10_000, created: 2, modified: 3, deleted: 1 },
    });

    injectFailB = true;
    await expect(mgrB.clear()).rejects.toThrow('EACCES');
    expect(mgrB.timelineSnapshots().today?.fileActivity['pending-b2']).toEqual({
      events: 1,
      created: 2,
      modified: 4,
      deleted: 1,
    });
    expect(mgrB.timelineSnapshots().today?.fileActivity['live-b2']).toEqual({
      events: 1,
      created: 1,
      modified: 0,
      deleted: 0,
    });
    // Patch by pre-clear entryId must still target restored/merged pending bucket
    mgrB.patchEvent('b2-ok-1', { feedback: 'useful' });
    await mgrB.stop();

    const parsedB = parseHistoryLines((await portB.readEvents('2026-11-21')) ?? '');
    const activitiesB = parsedB.events.filter((e) => e.kind === 'file.activity');
    expect(activitiesB).toHaveLength(2);
    const mergedPend = activitiesB.find((e) => e.subject === '/work/pending-b2');
    expect(mergedPend?.detail).toMatchObject({ created: 2, modified: 4, deleted: 1 });
    expect(mergedPend?.feedback).toBe('useful');
  });

  it('F2: failed clear() rollback re-appends buckets consumed before the epoch bump but not yet persisted', async () => {
    const { port, events } = mockPort({
      clearAll: async () => {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      },
    });
    let wall = Date.UTC(2026, 10, 18, 9, 0, 0);
    const mgr = managerFor(port, () => wall);
    await mgr.start(false);

    // 20 pending buckets: the tick flush consumes the first 16-bucket slice
    // and enqueues its append, then yields before the 4-bucket remainder.
    for (let i = 0; i < 20; i++) {
      const dir = `/work/f2-d${String(i).padStart(2, '0')}`;
      mgr.recordEvent({
        id: `f2-${i}`,
        kind: 'file.activity',
        subject: dir,
        level: 'record',
        cause: 'unknown',
        at: wall + 1_000,
        source: { id: 'files-global', api: 'watch', host: 'local' },
        detail: { directory: dir, windowMs: 10_000, created: 1, modified: 0, deleted: 0 },
      });
    }
    wall += 70_000;

    // tick() suspends mid-flush at the inter-slice yield; clear() bumps the
    // epoch before the queued append runs, so the consumed slice lands in the
    // orphan buffer while the 4 untouched buckets stay in the clear snapshot.
    const tickP = mgr.tick();
    const clearP = mgr.clear();
    await expect(clearP).rejects.toThrow('EACCES');
    await tickP;

    // Re-appended orphans settle after the rollback; the restored remainder
    // buckets need one more flush.
    await mgr.query({});
    await mgr.tick();
    await mgr.query({});

    const parsed = parseHistoryLines(events.get('2026-11-18') ?? '');
    const activities = parsed.events.filter((e) => e.kind === 'file.activity');
    expect(activities).toHaveLength(20);
    expect(new Set(activities.map((e) => e.subject)).size).toBe(20);

    const fileActivity = mgr.timelineSnapshots().today?.fileActivity ?? {};
    for (let i = 0; i < 20; i++) {
      expect(fileActivity[`f2-d${String(i).padStart(2, '0')}`]).toEqual({
        events: 1,
        created: 1,
        modified: 0,
        deleted: 0,
      });
    }
    await mgr.stop();
  });

  it('B3: preserves patchEvent short-id mapping across 4096+ file.activity events, reconstructs evicted UUID ids, and emits zero orphan patches', async () => {
    const dir = await makeTempDir();
    const port = new FileHistoryStoragePort(dir);
    let wall = Date.UTC(2026, 10, 22, 9, 0, 0);
    let mono = 1_000;
    const mkMgr = () =>
      new HistoryManager({
        port,
        clock: { wall: () => wall, mono: () => mono },
        isPaused: () => false,
        titlesAllowed: () => true,
        restoreEntries: () => {},
        clearMemoryEntries: () => {},
        emitSourceError: () => {},
        emitSourceOk: () => {},
        timeZone: 'UTC',
      });

    const mgr1 = mkMgr();
    await mgr1.start(false);

    const targetUuid = '550e8400-e29b-41d4-a716-446655440001';
    const earlyId = `${targetUuid}:1`;
    mgr1.recordEvent({
      id: earlyId,
      kind: 'app.activated',
      subject: 'EarlyApp',
      level: 'record',
      at: wall,
      source: { id: 'helper', api: 'ndjson', host: 'local' },
    });

    // Overflow eventMetaById capacity (4096) with 4200 file.activity events
    const actUuid = '550e8400-e29b-41d4-a716-446655440002';
    for (let i = 0; i < 4_200; i++) {
      mgr1.recordEvent({
        id: `${actUuid}:${i + 1}`,
        kind: 'file.activity',
        subject: `/work/b3-${i % 10}`,
        level: 'record',
        cause: 'unknown',
        at: wall + (i + 1) * 10,
        source: { id: 'files-global', api: 'watch', host: 'local' },
        detail: { directory: `/work/b3-${i % 10}`, windowMs: 10_000, created: 0, modified: 1, deleted: 0 },
      });
    }

    // Delayed patch on early non-aggregated event after 4200 file.activity events
    mgr1.patchEvent(earlyId, { at: wall, level: 'context', feedback: 'useful', reason: 'delayed-feedback' });

    // Nonexistent UUID id must never emit an orphan patch on disk
    mgr1.patchEvent('99999999-9999-4999-8999-999999999999:999', { at: wall, feedback: 'noise' });

    wall += 120_000;
    mono += 120_000;
    await mgr1.stop();

    const raw = (await port.readEvents('2026-11-22')) ?? '';
    expect(raw).not.toContain(targetUuid);
    expect(raw).not.toContain('99999999-9999-4999-8999-999999999999');

    // Every patch line on disk must correspond to an existing persisted event ID (zero orphans)
    const eventIds = new Set<string>();
    const patchIds: string[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      const obj = JSON.parse(line) as { record?: string; id?: string };
      if ((obj.record === 'event' || obj.record === undefined) && typeof obj.id === 'string') {
        eventIds.add(obj.id);
      } else if (obj.record === 'patch' && typeof obj.id === 'string') {
        patchIds.push(obj.id);
      }
    }
    expect(patchIds).toHaveLength(1);
    for (const pid of patchIds) {
      expect(eventIds.has(pid)).toBe(true);
    }

    // Restart on real FileHistoryStoragePort and verify early non-aggregated patch took effect
    const mgr2 = mkMgr();
    await mgr2.start(false);
    const parsed = parseHistoryLines((await port.readEvents('2026-11-22')) ?? '');
    const earlyEv = parsed.events.find((e) => e.subject === 'EarlyApp');
    expect(earlyEv?.level).toBe('context');
    expect(earlyEv?.feedback).toBe('useful');
    expect(earlyEv?.reason).toBe('delayed-feedback');
    await mgr2.stop();

    // Also overflow non-aggregated eventMetaById (4096) via fast port and verify evicted UUID patch reconstructs cleanly
    const evEventsByDate = new Map<string, string>();
    const evPort: HistoryStoragePort = {
      eventFileSize: async (date) => Buffer.byteLength(evEventsByDate.get(date) ?? '', 'utf8'),
      appendEvent: async (date, chunk) => {
        evEventsByDate.set(date, (evEventsByDate.get(date) ?? '') + chunk);
      },
      readEvents: async (date) => evEventsByDate.get(date),
      listEventDates: async () => [...evEventsByDate.keys()],
      deleteEventDate: async (date) => {
        evEventsByDate.delete(date);
      },
      readDaily: async () => undefined,
      writeDaily: async () => {},
      listDailyDates: async () => [],
      deleteDailyDate: async () => {},
      readMonthly: async () => undefined,
      writeMonthly: async () => {},
      listMonthlyMonths: async () => [],
      clearAll: async () => {
        evEventsByDate.clear();
      },
    };
    const evWall = Date.UTC(2026, 10, 22, 14, 0, 0);
    const mkEvMgr = () =>
      new HistoryManager({
        port: evPort,
        clock: { wall: () => evWall, mono: () => 5_000 },
        isPaused: () => false,
        titlesAllowed: () => true,
        restoreEntries: () => {},
        clearMemoryEntries: () => {},
        emitSourceError: () => {},
        emitSourceOk: () => {},
        timeZone: 'UTC',
      });
    const evMgr1 = mkEvMgr();
    await evMgr1.start(false);
    const bulkUuid = '660e8400-e29b-41d4-a716-446655440003';
    for (let i = 0; i < 4_150; i++) {
      evMgr1.recordEvent({
        id: `${bulkUuid}:${i}`,
        kind: 'file.changed',
        subject: `/work/evict-${i}.ts`,
        level: 'record',
        at: evWall + i,
        source: { id: 'files-global', api: 'watch', host: 'local' },
      });
    }
    evMgr1.patchEvent(`${bulkUuid}:0`, { at: evWall, feedback: 'noise', reason: 'after-eviction' });
    await evMgr1.stop();

    const evRaw = evEventsByDate.get('2026-11-22') ?? '';
    expect(evRaw).not.toContain(bulkUuid);
    const evMgr2 = mkEvMgr();
    await evMgr2.start(false);
    const evParsed = parseHistoryLines(evEventsByDate.get('2026-11-22') ?? '');
    const evictedEv = evParsed.events.find((e) => e.subject === '/work/evict-0.ts');
    expect(evictedEv?.feedback).toBe('noise');
    expect(evictedEv?.reason).toBe('after-eviction');
    await evMgr2.stop();
  });

  it('S3: time-slices flushPendingActivity when 4096 buckets expire simultaneously and persists all buckets', async () => {
    const buildRefBatch = (n: number, tag: string) =>
      Array.from({ length: n }, (_, i) => ({
        id: `ref:${tag}:${i}`,
        kind: 'file.activity',
        subject: `/work/${tag}/d-${i}`,
        level: 'record',
        at: 1_700_000_000_000 + i,
        source: 'files-global',
        detail: { windowMs: 60_000, created: 1, modified: 2, deleted: 0 },
      }));

    // Warmup JIT and compute in-process normalized reference work (median of 3 fixed batches, no hardcoded ms).
    let sink = JSON.stringify(structuredClone(buildRefBatch(500, 'warm'))).length;
    const refSamples: number[] = [];
    for (let iter = 0; iter < 3; iter++) {
      const t0 = performance.now();
      sink += JSON.stringify(structuredClone(buildRefBatch(5_000, `b${iter}`))).length;
      refSamples.push(performance.now() - t0);
    }
    refSamples.sort((a, b) => a - b);
    const refBatchMs = Math.max(1, refSamples[1] ?? refSamples[0] ?? 1);
    expect(sink).toBeGreaterThan(0);

    const runS3Burst = async (tag: string, bucketCount: number, measure: boolean) => {
      const eventsByDate = new Map<string, string>();
      const fastPort: HistoryStoragePort = {
        eventFileSize: async (date) => Buffer.byteLength(eventsByDate.get(date) ?? '', 'utf8'),
        appendEvent: async (date, chunk) => {
          eventsByDate.set(date, (eventsByDate.get(date) ?? '') + chunk);
        },
        readEvents: async (date) => eventsByDate.get(date),
        listEventDates: async () => [...eventsByDate.keys()],
        deleteEventDate: async (date) => {
          eventsByDate.delete(date);
        },
        readDaily: async () => undefined,
        writeDaily: async () => {},
        listDailyDates: async () => [],
        deleteDailyDate: async () => {},
        readMonthly: async () => undefined,
        writeMonthly: async () => {},
        listMonthlyMonths: async () => [],
        clearAll: async () => {
          eventsByDate.clear();
        },
      };

      let wall = Date.UTC(2026, 10, 23, 12, 0, 0);
      let mono = 1_000;
      const mgr = new HistoryManager({
        port: fastPort,
        clock: { wall: () => wall, mono: () => mono },
        isPaused: () => false,
        titlesAllowed: () => true,
        restoreEntries: () => {},
        clearMemoryEntries: () => {},
        emitSourceError: () => {},
        emitSourceOk: () => {},
        timeZone: 'UTC',
      });
      await mgr.start(false);

      for (let i = 0; i < bucketCount; i++) {
        mgr.recordEvent({
          id: `${tag}-${i}`,
          kind: 'file.activity',
          subject: `/work/${tag}-${i}`,
          level: 'record',
          cause: 'unknown',
          at: wall,
          source: { id: 'files-global', api: 'watch', host: 'local' },
          detail: { directory: `/work/${tag}-${i}`, windowMs: 10_000, created: 1, modified: 1, deleted: 0 },
        });
      }

      wall += 61_000;
      mono += 61_000;
      await new Promise((r) => setImmediate(r));

      const gaps: number[] = [];
      let lastBeat = performance.now();
      let probing = measure;
      const beat = () => {
        const now = performance.now();
        gaps.push(now - lastBeat);
        lastBeat = now;
        if (probing) setImmediate(beat);
      };
      if (measure) setImmediate(beat);

      await mgr.tick();
      probing = false;

      const sorted = [...gaps].sort((a, b) => a - b);
      const p95GapMs = sorted.length > 0 ? sorted[Math.floor((sorted.length - 1) * 0.95)] : 0;
      const maxGapMs = sorted.length > 0 ? sorted[sorted.length - 1] : 0;
      const parsed = parseHistoryLines(eventsByDate.get('2026-11-23') ?? '');
      const persisted = parsed.events.filter((e) => e.kind === 'file.activity').length;
      const summaryDirs = Object.keys(mgr.timelineSnapshots().today?.fileActivity ?? {}).length;
      await mgr.stop();
      return { yields: gaps.length, p95GapMs, maxGapMs, persisted, summaryDirs };
    };

    await runS3Burst('warm', 256, false);

    const runs: Array<{ yields: number; p95GapMs: number; maxGapMs: number }> = [];
    for (let r = 0; r < 3; r++) {
      const res = await runS3Burst(`r${r}`, 4_096, true);
      expect(res.persisted).toBe(4_096);
      expect(res.summaryDirs).toBe(4_096);
      expect(res.yields).toBeGreaterThanOrEqual(40);
      expect(res.p95GapMs).toBeLessThanOrEqual(refBatchMs);
      runs.push(res);
    }
    expect(Math.min(...runs.map((r) => r.maxGapMs))).toBeLessThanOrEqual(refBatchMs);

    // Also verify full persistence through real FileHistoryStoragePort when stopping with 4096 pending buckets
    const dirDisk = await makeTempDir();
    const diskPort = new FileHistoryStoragePort(dirDisk);
    const wallDisk = Date.UTC(2026, 10, 23, 14, 0, 0);
    const monoDisk = 2_000;
    const mgrDisk = new HistoryManager({
      port: diskPort,
      clock: { wall: () => wallDisk, mono: () => monoDisk },
      isPaused: () => false,
      titlesAllowed: () => true,
      restoreEntries: () => {},
      clearMemoryEntries: () => {},
      emitSourceError: () => {},
      emitSourceOk: () => {},
      timeZone: 'UTC',
    });
    await mgrDisk.start(false);
    for (let i = 0; i < 4_096; i++) {
      mgrDisk.recordEvent({
        id: `s3d-${i}`,
        kind: 'file.activity',
        subject: `/work/disk-${i}`,
        level: 'record',
        cause: 'unknown',
        at: wallDisk,
        source: { id: 'files-global', api: 'watch', host: 'local' },
        detail: { directory: `/work/disk-${i}`, windowMs: 10_000, created: 0, modified: 1, deleted: 0 },
      });
    }
    await mgrDisk.stop();
    const diskParsed = parseHistoryLines((await diskPort.readEvents('2026-11-23')) ?? '');
    expect(diskParsed.events.filter((e) => e.kind === 'file.activity')).toHaveLength(4_096);
  });

  it('S1: enforces absolute fallback daily cap for non-file context/wake exceptions, keeps summaries, and prompts sidebar via ok+capped without model delivery', async () => {
    expect(MAX_DAILY_CRITICAL_EVENT_BYTES).toBe(32 * 1024 * 1024);
    const dir = await makeTempDir();
    const port = new FileHistoryStoragePort(dir);
    const wall = Date.UTC(2026, 10, 24, 10, 0, 0);
    const errors: Array<{ error: string; extra?: Record<string, unknown> }> = [];
    const okEvents: Array<Record<string, unknown> | undefined> = [];
    const mgr = new HistoryManager({
      port,
      clock: { wall: () => wall, mono: () => 1_000 },
      isPaused: () => false,
      titlesAllowed: () => true,
      restoreEntries: () => {},
      clearMemoryEntries: () => {},
      emitSourceError: (error, extra) => errors.push({ error, extra }),
      emitSourceOk: (extra) => okEvents.push(extra),
      timeZone: 'UTC',
      maxNonFileDailyBytes: 240,
      maxCriticalDailyBytes: 900,
    });
    await mgr.start(false);

    // Non-critical record events hit 240B soft non-file tier cap first
    for (let i = 0; i < 4; i++) {
      mgr.recordEvent({
        id: `s1-rec-${i}`,
        kind: 'app.activated',
        subject: `Rec-${i}-${'r'.repeat(50)}`,
        level: 'record',
        at: wall + (i + 1) * 100,
        source: { id: 'helper', api: 'ndjson', host: 'local' },
      });
    }
    await mgr.query({});
    expect(errors.filter((e) => e.error === 'daily-limit-exceeded')).toHaveLength(1);

    // Critical (non-file wake/context) events bypass 240B tier cap, then stop at 900B fallback ceiling
    for (let i = 0; i < 12; i++) {
      mgr.recordEvent({
        id: `s1-crit-${i}`,
        kind: 'job.exited',
        subject: `crit-${i}-${'k'.repeat(70)}`,
        level: 'wake',
        at: wall + 2_000 + i * 100,
        source: { id: 'dsh', api: 'events', host: 'local' },
      });
    }
    await mgr.query({});

    const diskSize = await port.eventFileSize('2026-11-24');
    expect(diskSize).toBeLessThanOrEqual(900);
    const parsedDisk = parseHistoryLines((await port.readEvents('2026-11-24')) ?? '');
    const critOnDisk = parsedDisk.events.filter((e) => e.id.startsWith('s1-crit-'));
    expect(critOnDisk.length).toBeGreaterThan(0);
    expect(critOnDisk.length).toBeLessThan(12);

    // Summary still counts all 4 + 12 = 16 events ("只记汇总") and marks truncatedAtLimit
    const todaySnap = mgr.timelineSnapshots().today;
    expect(todaySnap?.totalEvents).toBe(16);
    expect(todaySnap?.deliveries.wake).toBe(12);
    expect(todaySnap?.truncatedAtLimit).toBe(true);
    await mgr.stop();

    // Restart same day with cap-state.json: critical writes remain capped and cap error is not duplicated
    const mgr2 = new HistoryManager({
      port,
      clock: { wall: () => wall + 60_000, mono: () => 2_000 },
      isPaused: () => false,
      titlesAllowed: () => true,
      restoreEntries: () => {},
      clearMemoryEntries: () => {},
      emitSourceError: (error, extra) => errors.push({ error, extra }),
      emitSourceOk: (extra) => okEvents.push(extra),
      timeZone: 'UTC',
      maxNonFileDailyBytes: 240,
      maxCriticalDailyBytes: 900,
    });
    await mgr2.start(false);
    mgr2.recordEvent({
      id: 's1-crit-after-restart',
      kind: 'body.anomaly',
      subject: `crit-restart-${'k'.repeat(70)}`,
      level: 'context',
      at: wall + 61_000,
      source: { id: 'body', api: 'probe', host: 'local' },
    });
    await mgr2.stop();
    const afterRestartRaw = (await port.readEvents('2026-11-24')) ?? '';
    expect(afterRestartRaw).not.toContain('s1-crit-after-restart');

    // After soft cap was already hit, critical cap triggers at 900B cleanly.
    // Also verify pure critical stream bypassing soft cap (240B) and hitting critical cap (900B) emits tier='critical'
    const dirCritOnly = await makeTempDir();
    const portCritOnly = new FileHistoryStoragePort(dirCritOnly);
    const critErrors: Array<{ error: string; extra?: Record<string, unknown> }> = [];
    const mgrCritOnly = new HistoryManager({
      port: portCritOnly,
      clock: { wall: () => wall, mono: () => 1_000 },
      isPaused: () => false,
      titlesAllowed: () => true,
      restoreEntries: () => {},
      clearMemoryEntries: () => {},
      emitSourceError: (error, extra) => critErrors.push({ error, extra }),
      emitSourceOk: () => {},
      timeZone: 'UTC',
      maxNonFileDailyBytes: 240,
      maxCriticalDailyBytes: 700,
    });
    await mgrCritOnly.start(false);
    for (let i = 0; i < 10; i++) {
      mgrCritOnly.recordEvent({
        id: `s1-pure-${i}`,
        kind: 'body.anomaly',
        subject: `cpu-${i}-${'m'.repeat(60)}`,
        level: 'context',
        at: wall + (i + 1) * 100,
        source: { id: 'body', api: 'probe', host: 'local' },
      });
    }
    await mgrCritOnly.query({});
    expect(await portCritOnly.eventFileSize('2026-11-24')).toBeLessThanOrEqual(700);
    expect(critErrors).toEqual([
      {
        error: 'daily-limit-exceeded',
        extra: { date: '2026-11-24', tier: 'critical', maxBytes: 700 },
      },
    ]);
    expect(mgrCritOnly.timelineSnapshots().today?.totalEvents).toBe(10);
    expect(mgrCritOnly.timelineSnapshots().today?.truncatedAtLimit).toBe(true);
    await mgrCritOnly.stop();

    // End-to-end runtime check: default 32 MiB critical ceiling notifies sidebar via ok+capped without model push
    const delivered: string[] = [];
    let simBytes = MAX_DAILY_CRITICAL_EVENT_BYTES - 120;
    const rtDir = await makeTempDir();
    const baseRtPort = new FileHistoryStoragePort(rtDir);
    let rtCapJson: string | undefined;
    const rtPort: HistoryStoragePort = {
      eventFileSize: async (d) => (d === '2026-11-24' ? simBytes : baseRtPort.eventFileSize(d)),
      appendEvent: async (d, line) => {
        if (d === '2026-11-24') simBytes += Buffer.byteLength(line, 'utf8');
        return baseRtPort.appendEvent(d, line);
      },
      readEvents: (d) => baseRtPort.readEvents(d),
      readEventLines: (d) => baseRtPort.readEventLines(d),
      readEventLinesDesc: (d) => baseRtPort.readEventLinesDesc(d),
      listEventDates: () => baseRtPort.listEventDates(),
      deleteEventDate: (d) => baseRtPort.deleteEventDate(d),
      readDaily: (d) => baseRtPort.readDaily(d),
      writeDaily: (d, j) => baseRtPort.writeDaily(d, j),
      listDailyDates: () => baseRtPort.listDailyDates(),
      deleteDailyDate: (d) => baseRtPort.deleteDailyDate(d),
      readMonthly: (m) => baseRtPort.readMonthly(m),
      writeMonthly: (m, j) => baseRtPort.writeMonthly(m, j),
      listMonthlyMonths: () => baseRtPort.listMonthlyMonths(),
      readCapState: async () => rtCapJson,
      writeCapState: async (j) => {
        rtCapJson = j || undefined;
      },
      clearAll: async () => {
        rtCapJson = undefined;
        await baseRtPort.clearAll();
      },
    };
    const dayBeforeRoll = Date.UTC(2026, 10, 23, 23, 59, 50);
    const rt = createRuntimeHarness({
      nowMs: dayBeforeRoll,
      history: rtPort,
      timeZone: 'UTC',
      deliver: async (_sid, intent) => {
        for (const c of intent.update.changes) {
          delivered.push(`${c.signal.kind}:${c.signal.subject}:${String(c.signal.data.error ?? '')}`);
        }
      },
    });
    await rt.runtime.start();
    // Start active session job on day before so usageByDate for 2026-11-24 stays untouched at 32MiB - 120
    await rt.emitJob({
      type: 'started',
      id: 'rt-s1-seed',
      sessionId: 's1',
      command: `echo ${'x'.repeat(80)}`,
      at: dayBeforeRoll + 1_000,
    });
    await rt.runtime.tools.envHistory({});
    const nextDayWall = Date.UTC(2026, 10, 24, 0, 0, 10);
    rt.setTime(nextDayWall, 20_000);
    for (let i = 0; i < 4; i++) {
      await rt.emitJob({
        type: 'exited',
        id: `rt-s1-${i}`,
        sessionId: 's1',
        command: `fail-${i}-${'x'.repeat(80)}`,
        exitCode: 1,
        at: nextDayWall + i + 1,
      });
    }
    await vi.waitFor(
      () =>
        expect(
          rt.runtime.events().filter((e) => e.kind === 'source.error' && e.reason === 'daily-limit-exceeded'),
        ).toHaveLength(1),
      { timeout: 2_000, interval: 5 },
    );
    await rt.runtime.tools.envHistory({});
    await new Promise((r) => setTimeout(r, 40));
    expect(simBytes).toBeLessThanOrEqual(32 * 1024 * 1024);
    expect(delivered.some((d) => d.includes('daily-limit-exceeded'))).toBe(false);
    expect(projectState(rt.runtime.state()).observation.sources.history).toMatchObject({
      status: 'ok',
      capped: true,
    });
    await rt.runtime.stop();
  });

  it('S2: infers capped state from file bytes when cap-state.json is missing/corrupt and matches real-time truncatedAtLimit in backfill', async () => {
    const dir = await makeTempDir();
    const port = new FileHistoryStoragePort(dir);
    let wall = Date.UTC(2026, 10, 25, 10, 0, 0);

    const mgr1 = new HistoryManager({
      port,
      clock: { wall: () => wall, mono: () => 1_000 },
      isPaused: () => false,
      titlesAllowed: () => true,
      restoreEntries: () => {},
      clearMemoryEntries: () => {},
      emitSourceError: () => {},
      emitSourceOk: () => {},
      timeZone: 'UTC',
      maxFileDailyBytes: 380,
      maxNonFileDailyBytes: 500_000,
    });
    await mgr1.start(false);

    // Exhaust 380B file tier cap (stops strictly below 380B), then write >200 non-file events
    for (let i = 0; i < 4; i++) {
      mgr1.recordEvent({
        id: `s2-fb-${i}`,
        kind: 'file.burst',
        subject: `/work/burst-${i}-${'a'.repeat(50)}`,
        level: 'wake',
        at: wall + i * 100,
        source: { id: 'files-global', api: 'watch', host: 'local' },
      });
    }
    for (let i = 0; i < 210; i++) {
      mgr1.recordEvent({
        id: `s2-app-${i}`,
        kind: 'app.activated',
        subject: `App-${i}`,
        level: 'record',
        at: wall + 1_000 + i * 100,
        source: { id: 'helper', api: 'ndjson', host: 'local' },
      });
    }
    await mgr1.stop();

    // Corrupt cap-state.json and restart on the same day
    await port.writeCapState('{corrupt-cap-state');
    const errsCorrupt: string[] = [];
    const restoredCorrupt: string[] = [];
    const mgr2 = new HistoryManager({
      port,
      clock: { wall: () => wall + 30_000, mono: () => 2_000 },
      isPaused: () => false,
      titlesAllowed: () => true,
      restoreEntries: () => {},
      clearMemoryEntries: () => {},
      emitSourceError: (e) => errsCorrupt.push(e),
      restoreSourceError: (e) => restoredCorrupt.push(e),
      emitSourceOk: () => {},
      timeZone: 'UTC',
      maxFileDailyBytes: 380,
      maxNonFileDailyBytes: 500_000,
    });
    await mgr2.start(false);
    expect(restoredCorrupt).toContain('daily-limit-exceeded');
    expect(mgr2.timelineSnapshots().today?.truncatedAtLimit).toBe(true);

    // Next file.burst must stay blocked without re-emitting daily-limit-exceeded; non-file record still writes
    mgr2.recordEvent({
      id: 's2-fb-blocked',
      kind: 'file.burst',
      subject: `/work/burst-blocked-${'a'.repeat(50)}`,
      level: 'wake',
      at: wall + 31_000,
      source: { id: 'files-global', api: 'watch', host: 'local' },
    });
    mgr2.recordEvent({
      id: 's2-app-allowed',
      kind: 'app.activated',
      subject: 'AppAllowedAfterRestart',
      level: 'record',
      at: wall + 32_000,
      source: { id: 'helper', api: 'ndjson', host: 'local' },
    });
    await mgr2.stop();
    expect(errsCorrupt.filter((e) => e === 'daily-limit-exceeded')).toHaveLength(0);
    const sameDayRaw = (await port.readEvents('2026-11-25')) ?? '';
    expect(sameDayRaw).not.toContain('s2-fb-blocked');
    expect(sameDayRaw).toContain('s2-app-allowed');

    // Missing cap-state.json on a crash day (no daily summary written) + next-day backfill parity
    await port.writeCapState('');
    const restoredMissing: string[] = [];
    const mgr3 = new HistoryManager({
      port,
      clock: { wall: () => wall + 60_000, mono: () => 3_000 },
      isPaused: () => false,
      titlesAllowed: () => true,
      restoreEntries: () => {},
      clearMemoryEntries: () => {},
      emitSourceError: () => {},
      restoreSourceError: (e) => restoredMissing.push(e),
      emitSourceOk: () => {},
      timeZone: 'UTC',
      maxFileDailyBytes: 380,
      maxNonFileDailyBytes: 500_000,
    });
    await mgr3.start(false);
    expect(restoredMissing).toContain('daily-limit-exceeded');
    expect(mgr3.timelineSnapshots().today?.truncatedAtLimit).toBe(true);
    await mgr3.stop();

    // Remove daily/monthly to simulate crash before rollover; verify runBackfillStep sets truncatedAtLimit=true
    const dirCrash = await makeTempDir();
    await mkdir(join(dirCrash, 'history', 'events'), { recursive: true, mode: 0o700 });
    await writeFile(join(dirCrash, 'history', 'events', '2026-11-25.jsonl'), sameDayRaw, { mode: 0o600 });
    const crashPort = new FileHistoryStoragePort(dirCrash);
    wall = Date.UTC(2026, 10, 26, 9, 0, 0);
    const mgrBackfill = new HistoryManager({
      port: crashPort,
      clock: { wall: () => wall, mono: () => 4_000 },
      isPaused: () => false,
      titlesAllowed: () => true,
      restoreEntries: () => {},
      clearMemoryEntries: () => {},
      emitSourceError: () => {},
      emitSourceOk: () => {},
      timeZone: 'UTC',
      maxFileDailyBytes: 380,
      maxNonFileDailyBytes: 500_000,
    });
    await mgrBackfill.start(false);
    await vi.waitFor(async () => expect(await crashPort.readDaily('2026-11-25')).toBeDefined(), {
      timeout: 3_000,
      interval: 20,
    });
    const backfilled25 = JSON.parse((await crashPort.readDaily('2026-11-25')) ?? '{}') as DailySummary;
    expect(backfilled25.truncatedAtLimit).toBe(true);
    await mgrBackfill.stop();
  });

  it('S4: excludes 600MiB-pruned dates from startup backfill list and updates yesterday daily/monthly summaries on file-global 10s midnight late arrival', async () => {
    // 1) startupMaintenance backfill list must use post-prune retainedDates rather than pre-prune keptDates
    const dirPrune = await makeTempDir();
    await mkdir(join(dirPrune, 'history', 'events'), { recursive: true, mode: 0o700 });
    const makeDayLines = (at: number, tag: string) =>
      `${Array.from({ length: 2 }, (_, i) =>
        JSON.stringify({
          record: 'event',
          id: `${tag}-${i}`,
          kind: 'app.activated',
          subject: `App-${tag}-${'x'.repeat(60)}`,
          level: 'record',
          at: at + i * 1_000,
          source: 'helper',
        }),
      ).join('\n')}\n`;
    const dayOldRaw = makeDayLines(Date.UTC(2026, 9, 25, 12, 0, 0), 'd25');
    const dayKeepRaw = makeDayLines(Date.UTC(2026, 9, 26, 12, 0, 0), 'd26');
    await writeFile(join(dirPrune, 'history', 'events', '2026-10-25.jsonl'), dayOldRaw, { mode: 0o600 });
    await writeFile(join(dirPrune, 'history', 'events', '2026-10-26.jsonl'), dayKeepRaw, { mode: 0o600 });

    const portPrune = new FileHistoryStoragePort(dirPrune);
    // Write a valid daily summary for 2026-10-26 so 2026-10 has existing summary data while 2026-10-25 lacks one and is pruned.
    const parsed26 = parseHistoryLines(dayKeepRaw);
    const cal = new LocalCalendar('UTC');
    await portPrune.writeDaily(
      '2026-10-26',
      JSON.stringify(summarizeDay('2026-10-26', parsed26, cal.dayBounds('2026-10-26'))),
    );
    const pruneWall = Date.UTC(2026, 10, 15, 10, 0, 0);
    const mgrPrune = new HistoryManager({
      port: portPrune,
      clock: { wall: () => pruneWall, mono: () => 1_000 },
      isPaused: () => false,
      titlesAllowed: () => true,
      restoreEntries: () => {},
      clearMemoryEntries: () => {},
      emitSourceError: () => {},
      emitSourceOk: () => {},
      timeZone: 'UTC',
      maxTotalBytes: Buffer.byteLength(dayKeepRaw, 'utf8') + 20,
    });
    await mgrPrune.start(false);
    try {
      // Pruned 2026-10-25 must never enter pendingBackfill; completed month 2026-10 must be non-partial immediately
      expect(await portPrune.listEventDates()).toEqual(['2026-10-26', '2026-11-15']);
      const monthOct = await mgrPrune.summary({ month: '2026-10' });
      expect(monthOct.available).toBe(true);
      if (monthOct.available) {
        expect(monthOct.pendingDays ?? []).not.toContain('2026-10-25');
        expect(monthOct.partial).toBeUndefined();
      }
    } finally {
      await mgrPrune.stop();
    }

    // 2) FileGlobalSource 10s buffered event from 23:59:58 arriving after 00:00:01 rollover updates yesterday & monthly
    const rtDir = await makeTempDir();
    const rtPort = new FileHistoryStoragePort(rtDir);
    let rtWall = Date.UTC(2026, 10, 30, 23, 59, 55);
    let rtMono = 1_000;
    let watchCb: ((event: { path: string; change: 'add' | 'modify' | 'delete'; at: number }) => void) | undefined;
    let jobCb!: (ev: JobEvent) => Promise<void>;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    try {
      const rt = createSenseRuntime(
        {
          clock: { wall: () => rtWall, mono: () => rtMono },
          history: rtPort,
          storage: { load: async () => undefined, save: async () => {} },
          dsh: {
            onAgentEvent: () => () => {},
            onTool: () => () => {},
            onJob: (cb) => {
              jobCb = cb;
              return () => {};
            },
            deliver: async () => {},
            tokenSnapshot: async () => undefined,
          },
          helper: { spawn: () => undefined },
          probe: { create: () => ({ onSample: () => () => {}, start: () => {}, stop: async () => {} }) },
          files: {
            watch: (_root, cb) => {
              watchCb = cb as typeof watchCb;
              return { close: () => {} };
            },
          },
        },
        {
          platform: 'linux',
          timeZone: 'UTC',
          intervalMs: 600_000,
          globalFileWatch: { root: '/work', windowMs: 10_000, homedir: '/home/tester', dataDirs: [rtDir] },
        },
      );
      await rt.start();

      // At 23:59:58 on 2026-11-30, edit file inside FileGlobalSource 10s buffer
      rtWall = Date.UTC(2026, 10, 30, 23, 59, 58);
      rtMono = 4_000;
      watchCb?.({ path: '/work/late-proj/index.ts', change: 'modify', at: rtWall });

      // At 00:00:01 on 2026-12-01, non-file event forces midnight + month rollover before 10s window flushes
      rtWall = Date.UTC(2026, 11, 1, 0, 0, 1);
      rtMono = 7_000;
      await jobCb({ type: 'started', id: 'dec-1-job', command: 'echo dec', at: rtWall });
      await rt.tools.envHistory({});

      // Advance past FileGlobalSource 10s window (00:00:08) so buffered 23:59:58 activity emits and flushes
      rtWall = Date.UTC(2026, 11, 1, 0, 0, 9);
      rtMono = 15_000;
      await vi.advanceTimersByTimeAsync(8_000);
      await rt.tools.envHistory({});
      await rt.stop();

      const novRaw = (await rtPort.readEvents('2026-11-30')) ?? '';
      const decRaw = (await rtPort.readEvents('2026-12-01')) ?? '';
      expect(novRaw).toContain('/work/late-proj');
      expect(decRaw).not.toContain('/work/late-proj');

      const novDaily = JSON.parse((await rtPort.readDaily('2026-11-30')) ?? '{}') as DailySummary;
      expect(novDaily.fileActivity['late-proj']).toMatchObject({ events: 1, modified: 1 });
      const novMonthly = JSON.parse((await rtPort.readMonthly('2026-11')) ?? '{}') as MonthlySummary;
      expect(novMonthly.fileActivity['late-proj']).toMatchObject({ events: 1, modified: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('N1: only abbreviates source in serializeEventLine when local api matches defaultApiForSourceId', async () => {
    const dir = await makeTempDir();
    const port = new FileHistoryStoragePort(dir);
    const wall = Date.UTC(2026, 10, 27, 10, 0, 0);
    const mgr = new HistoryManager({
      port,
      clock: { wall: () => wall, mono: () => 1_000 },
      isPaused: () => false,
      titlesAllowed: () => true,
      restoreEntries: () => {},
      clearMemoryEntries: () => {},
      emitSourceError: () => {},
      emitSourceOk: () => {},
      timeZone: 'UTC',
    });
    await mgr.start(false);
    try {
      mgr.recordEvent({
        id: 'n1-default',
        kind: 'app.activated',
        subject: 'DefaultSrc',
        level: 'record',
        at: wall,
        source: { id: 'helper', api: 'ndjson', host: 'local' },
      });
      mgr.recordEvent({
        id: 'n1-custom-api',
        kind: 'app.activated',
        subject: 'CustomApiSrc',
        level: 'record',
        at: wall + 1_000,
        source: { id: 'helper', api: 'nsworkspace', host: 'local' },
      });
      mgr.recordEvent({
        id: 'n1-unknown-id',
        kind: 'app.activated',
        subject: 'CustomHostId',
        level: 'record',
        at: wall + 2_000,
        source: { id: 'custom-probe', api: 'ipc', host: 'local' },
      });
    } finally {
      await mgr.stop();
    }

    const raw = (await port.readEvents('2026-11-27')) ?? '';
    expect(raw).toContain('"source":"helper"');
    expect(raw).not.toContain('"source":"custom-probe"');

    const parsed = parseHistoryLines(raw);
    expect(parsed.events.find((e) => e.id === 'n1-default')?.source).toEqual({
      id: 'helper',
      api: 'ndjson',
      host: 'local',
    });
    expect(parsed.events.find((e) => e.id === 'n1-custom-api')?.source).toEqual({
      id: 'helper',
      api: 'nsworkspace',
      host: 'local',
    });
    expect(parsed.events.find((e) => e.id === 'n1-unknown-id')?.source).toEqual({
      id: 'custom-probe',
      api: 'ipc',
      host: 'local',
    });
  });
});
