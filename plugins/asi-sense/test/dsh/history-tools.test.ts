import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, hostname, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { ToolArgsError, type ToolRunContext } from '@deepseek-ai/dsh-tools';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDelivery } from '../../src/host/dsh/deliver.ts';
import { KNOWN_EVENT_KINDS, modelHistory, modelSummary } from '../../src/host/dsh/history-output.ts';
import { FileHistoryStoragePort } from '../../src/host/dsh/history-storage.ts';
import { createSenseTools } from '../../src/host/dsh/tools.ts';
import {
  createSenseRuntime,
  type DailySummary,
  type FileChange,
  type HistoryStoragePort,
} from '../../src/host/runtime/index.ts';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'asi-hist-tools-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function createMemoryHistoryPort(): HistoryStoragePort {
  const events = new Map<string, string>();
  const daily = new Map<string, string>();
  const monthly = new Map<string, string>();
  return {
    async eventFileSize(date) {
      return Buffer.byteLength(events.get(date) ?? '', 'utf8');
    },
    async appendEvent(date, line) {
      events.set(date, (events.get(date) ?? '') + line);
    },
    async readEvents(date) {
      return events.get(date);
    },
    async listEventDates() {
      return [...events.keys()].sort();
    },
    async deleteEventDate(date) {
      events.delete(date);
    },
    async readDaily(date) {
      return daily.get(date);
    },
    async writeDaily(date, json) {
      daily.set(date, json);
    },
    async listDailyDates() {
      return [...daily.keys()].sort();
    },
    async deleteDailyDate(date) {
      daily.delete(date);
    },
    async readMonthly(month) {
      return monthly.get(month);
    },
    async writeMonthly(month, json) {
      monthly.set(month, json);
    },
    async listMonthlyMonths() {
      return [...monthly.keys()].sort();
    },
    async clearAll() {
      events.clear();
      daily.clear();
      monthly.clear();
    },
  };
}

function makeExec(): ToolRunContext {
  return {
    tool: 'env_history',
    callId: 'call-1',
    rootCallId: 'call-1',
    token: {} as ToolRunContext['token'],
    arguments: {},
    signal: new AbortController().signal,
    agent: { id: 'agent-test', mode: 'primary' },
    deferContext: vi.fn(),
    concludesTurn: vi.fn(),
  } as unknown as ToolRunContext;
}

function createRuntimeHarness(nowMs: number, history: HistoryStoragePort, withHelper = false) {
  let currentNow = nowMs;
  const saved = new Map<string, string>();
  let helperOut: PassThrough | undefined;

  const runtime = createSenseRuntime(
    {
      clock: { wall: () => currentNow, mono: () => currentNow },
      history,
      storage: {
        load: async (key) => saved.get(key),
        save: async (key, json) => {
          saved.set(key, json);
        },
      },
      dsh: {
        listSessions: async () => [{ id: 's1', title: 'Synthetic', updatedAt: currentNow, running: true }],
        onAgentEvent: () => () => {},
        onTool: () => () => {},
        onJob: () => () => {},
        deliver: async () => {},
        tokenSnapshot: async () => undefined,
      },
      helper: {
        spawn: () => {
          if (!withHelper) return undefined;
          let gen = 0;
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
          child.stdin.on('data', (chunk) => {
            for (const raw of chunk.toString('utf8').split('\n').filter(Boolean)) {
              const req = JSON.parse(raw) as { id?: string; enabled?: boolean; cmd?: string };
              if (req.cmd === 'titles' && typeof req.id === 'string' && typeof req.enabled === 'boolean') {
                child.stdout.write(
                  `${JSON.stringify({
                    v: 1,
                    type: 'titles.ack',
                    session: 'fixture-session',
                    id: req.id,
                    enabled: req.enabled,
                    gen: ++gen,
                    at: currentNow,
                  })}\n`,
                );
              } else if (req.cmd === 'snapshot') {
                const currentFront = runtime.state().env.frontApp.value;
                child.stdout.write(
                  `${JSON.stringify({
                    v: 1,
                    type: 'snapshot',
                    at: currentNow,
                    permissions: { accessibility: 'granted' },
                    ...(currentFront ? { frontApp: currentFront } : {}),
                  })}\n`,
                );
              }
            }
          });
          helperOut = child.stdout;
          child.stdout.write(
            `${JSON.stringify({
              v: 1,
              type: 'hello',
              at: currentNow,
              version: '0.1.0',
              pid: 4242,
              session: 'fixture-session',
              permissions: { accessibility: 'granted' },
            })}\n`,
          );
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
      timeZone: 'UTC',
      intervalMs: 600_000,
      globalFileWatch: { disableInTests: true },
    },
  );

  return {
    runtime,
    setNow: (ms: number) => {
      currentNow = ms;
    },
    emitHelper: async (line: Record<string, unknown>) => {
      await vi.waitFor(() => expect(helperOut).toBeDefined(), { timeout: 2_000, interval: 5 });
      helperOut?.write(`${JSON.stringify({ v: 1, ...line })}\n`);
    },
  };
}

describe('env_detail, env_history, and env_summary tools', () => {
  it('preserves sanitized app subject in env_detail and hides window subject when titles are disabled', async () => {
    const startMs = Date.UTC(2026, 10, 10, 12, 0, 0);
    const history = createMemoryHistoryPort();
    const h = createRuntimeHarness(startMs, history, true);
    await h.runtime.start();
    await vi.waitFor(
      () => expect(h.runtime.events().some((e) => e.source.id === 'helper' && e.reason === 'ready')).toBe(true),
      { timeout: 2_000, interval: 5 },
    );

    h.setNow(startMs + 1_000);
    await h.emitHelper({
      type: 'app.activated',
      at: startMs + 1_000,
      name: 'SyntaxEditor',
      bundleId: 'com.example.Editor',
      pid: 100,
    });
    h.setNow(startMs + 2_000);
    await h.emitHelper({
      type: 'window.focused',
      at: startMs + 2_000,
      title: 'https://token@10.0.0.5:8080/Users/tester/secret.md',
      bundleId: 'com.example.Editor',
      pid: 100,
      window: 1,
    });

    await vi.waitFor(
      () =>
        expect(
          h.runtime.events().map((e) => ({ kind: e.kind, subject: e.subject, source: e.source.id })),
        ).toContainEqual(expect.objectContaining({ kind: 'window.focused' })),
      {
        timeout: 1_500,
        interval: 50,
      },
    );

    const tools = createSenseTools(h.runtime, () => startMs + 3_000);
    const envDetail = tools.find((tool) => tool.name === 'env_detail');
    expect(envDetail).toBeDefined();

    const visibleDetail = (await envDetail?.execute({}, makeExec())) as {
      recentEvents: Array<{ kind: string; subject: string }>;
    };
    expect(visibleDetail.recentEvents).toEqual([
      expect.objectContaining({ kind: 'app.activated', subject: 'SyntaxEditor' }),
      expect.objectContaining({ kind: 'window.focused', subject: 'SyntaxEditor' }),
    ]);

    await h.runtime.actions.setSendTitles(false);
    const hiddenDetail = (await envDetail?.execute({}, makeExec())) as {
      recentEvents: Array<{ kind: string; subject: string }>;
    };
    expect(hiddenDetail.recentEvents).toEqual([
      expect.objectContaining({ kind: 'app.activated', subject: 'SyntaxEditor' }),
      expect.objectContaining({ kind: 'window.focused', subject: '' }),
    ]);

    await h.runtime.stop();
  });

  it('enforces env_history argument boundaries, redaction, size truncation, and title toggle', async () => {
    const now = Date.UTC(2026, 10, 15, 14, 0, 0);
    const history = createMemoryHistoryPort();
    const localHost = hostname();

    const seededLines = [
      JSON.stringify({
        record: 'event',
        id: 'app-new',
        kind: 'app.activated',
        subject: 'CanvasApp',
        bundleId: 'com.example.Canvas',
        level: 'record',
        at: now - 1_000,
        source: { id: 'helper.frontApp', api: 'nsworkspace', host: localHost },
      }),
      JSON.stringify({
        record: 'event',
        id: 'win-new',
        kind: 'window.focused',
        subject: 'CanvasApp',
        bundleId: 'com.example.Canvas',
        title: `https://secret.invalid/token alice@example.com /home/tester/notes.txt ${localHost}`,
        level: 'context',
        ruleId: 'watch.window',
        reason: 'rule-matched',
        at: now - 500,
        source: { id: 'helper.focusedWindow', api: 'ax', host: localHost },
      }),
      JSON.stringify({
        record: 'event',
        id: 'file-ev',
        kind: 'file.changed',
        subject: '/home/tester/private-repo/secrets.env',
        level: 'record',
        at: now - 2_000,
        source: { id: 'files:/home/tester/private-repo', api: 'watch', host: localHost },
        detail: { directory: '/home/tester/private-repo' },
      }),
    ];
    await history.appendEvent('2026-11-15', `${seededLines.join('\n')}\n`);

    const h = createRuntimeHarness(now, history, true);
    await h.runtime.start();
    await vi.waitFor(
      () => expect(h.runtime.events().some((e) => e.source.id === 'helper' && e.reason === 'ready')).toBe(true),
      { timeout: 2_000, interval: 5 },
    );

    const tools = createSenseTools(h.runtime, () => now);
    const envHistory = tools.find((tool) => tool.name === 'env_history');
    if (!envHistory) throw new Error('missing env_history tool');

    await expect(envHistory.execute({}, { ...makeExec(), agent: undefined })).rejects.toThrow();
    await expect(envHistory.execute({ limit: 0 }, makeExec())).rejects.toThrow(ToolArgsError);
    await expect(envHistory.execute({ limit: -3 }, makeExec())).rejects.toThrow(ToolArgsError);
    await expect(envHistory.execute({ limit: 1.5 }, makeExec())).rejects.toThrow(ToolArgsError);
    await expect(envHistory.execute({ from: now, to: now - 10 }, makeExec())).rejects.toThrow(ToolArgsError);
    await expect(envHistory.execute({ from: 'not-a-date' }, makeExec())).rejects.toThrow(ToolArgsError);

    // Clamps range > 30 days and limit > 200 without throwing (to=now-100 excludes helper startup signal at now)
    const overRange = (await envHistory.execute(
      { from: now - 45 * 86_400_000, to: now - 100, limit: 250 },
      makeExec(),
    )) as Record<string, unknown>;
    expect(overRange.rangeClamped).toBe(true);
    expect(typeof overRange.note).toBe('string');
    expect(overRange.limit).toBe(200);
    expect(overRange.truncated).toBe(true);
    expect(overRange.total).toBe(3);

    const events = overRange.events as Array<Record<string, unknown>>;
    expect(events.map((e) => e.id)).toEqual(['win-new', 'app-new', 'file-ev']);
    const winEv = events[0];
    expect(winEv.subject).toBe('CanvasApp');
    expect(String(winEv.title)).not.toContain('secret.invalid');
    expect(String(winEv.title)).not.toContain('alice@example.com');
    expect(String(winEv.title)).not.toContain('/home/tester/');
    if (localHost.length > 0) expect(String(winEv.title)).not.toContain(localHost);

    const fileEv = events[2];
    // `.env` is not in tool-output.ts `SAFE_FILE_EXTENSIONS`, so modelPath redacts `secrets.env` to `[path]`.
    expect(fileEv.subject).toBe('[path]');
    expect(JSON.stringify(fileEv)).not.toContain('/home/tester/private-repo');
    expect(String((fileEv.source as { id: string }).id)).toMatch(/^files:r-[a-f0-9]{8}$/);
    expect((fileEv.source as Record<string, unknown>).host).toBeUndefined();

    // App filter matches bundleId locally
    const byBundle = (await envHistory.execute({ app: 'com.example.Canvas' }, makeExec())) as {
      events: Array<{ id: string }>;
    };
    expect(byBundle.events.map((e) => e.id)).toEqual(['win-new', 'app-new']);

    // Title toggle disabled hides window title, blanks subject, and prevents app filter leakage
    await h.runtime.actions.setSendTitles(false);
    const noTitles = (await envHistory.execute({ app: 'CanvasApp' }, makeExec())) as {
      titlesAllowed: boolean;
      events: Array<Record<string, unknown>>;
    };
    expect(noTitles.titlesAllowed).toBe(false);
    expect(noTitles.events.map((e) => e.id)).toEqual(['app-new']);

    const allNoTitles = (await envHistory.execute({ kinds: ['window.focused'] }, makeExec())) as {
      events: Array<Record<string, unknown>>;
    };
    expect(allNoTitles.events[0].subject).toBe('');
    expect(allNoTitles.events[0].title).toBeUndefined();
    expect(allNoTitles.events[0].reason).toBeUndefined();
    expect(allNoTitles.events[0].ruleId).toBeUndefined();

    // Size cap (> 32 KiB) trims oldest events cleanly while preserving newest events
    const bigLines: string[] = [];
    const fillerSummary = Array.from({ length: 45 }, () => 'entry').join(' ');
    for (let i = 0; i < 120; i++) {
      bigLines.push(
        JSON.stringify({
          record: 'event',
          id: `big-${i}`,
          kind: 'source.status',
          subject: 'history',
          reason: `synthetic-reason-${i}-${'x'.repeat(300)}`,
          detail: { summary: fillerSummary },
          level: 'record',
          at: now - 10_000 + i,
          source: { id: 'files:/tmp/synthetic-root', api: 'watch', host: 'local' },
        }),
      );
    }
    await history.appendEvent('2026-11-15', `${bigLines.join('\n')}\n`);
    // Default limit = 50 and ISO date-time bounds work cleanly
    const isoLimited = (await envHistory.execute(
      { from: new Date(now - 10_000).toISOString(), to: new Date(now - 100).toISOString() },
      makeExec(),
    )) as { limit: number; total: number; truncated: boolean; events: Array<{ id: string }> };
    expect(isoLimited.limit).toBe(50);
    expect(isoLimited.total).toBe(50);
    expect(isoLimited.truncated).toBe(true);
    expect(isoLimited.events).toHaveLength(50);

    const sized = (await envHistory.execute({ limit: 200 }, makeExec())) as {
      truncated: boolean;
      events: Array<{ id: string }>;
    };
    expect(sized.truncated).toBe(true);
    expect(sized.events.length).toBeGreaterThan(0);
    expect(sized.events.length).toBeLessThan(123);
    expect(Buffer.byteLength(JSON.stringify(sized), 'utf8')).toBeLessThanOrEqual(32_768);

    await h.runtime.stop();
  });

  it('validates env_summary month bounds and redacts synthesized monthly output', async () => {
    const now = Date.UTC(2026, 10, 5, 10, 0, 0);
    const history = createMemoryHistoryPort();
    const dailySample: DailySummary = {
      version: 1,
      date: '2026-10-03',
      dayStartMs: Date.UTC(2026, 9, 3),
      dayEndMs: Date.UTC(2026, 9, 4),
      dayDurationMs: 86_400_000,
      apps: { 'Notes\u0000': { foregroundMs: 120_000, switches: 2 } },
      appSwitches: 2,
      deliveries: {
        wake: 1,
        context: 2,
        suppressed: 0,
        byRule: { 'rule/unsafe': { wake: 1, context: 0, suppressed: 0 } },
      },
      fileBursts: { '/Users/tester/secret-proj': { events: 1, created: 4, modified: 1, deleted: 2 } },
      fileActivity: { '/home/tester/work-dir': { events: 2, created: 3, modified: 5, deleted: 0 } },
      bodyAnomalies: { total: 1, threshold: 1, rate: 0, anomaly: 0, byMetric: { memory: 1 } },
      coverage: { observedMs: 120_000, pausedMs: 0, notRunningMs: 86_280_000 },
      totalEvents: 5,
    };
    await history.writeDaily('2026-10-03', JSON.stringify(dailySample));

    const h = createRuntimeHarness(now, history, true);
    await h.runtime.start();
    await vi.waitFor(
      () => expect(h.runtime.events().some((e) => e.source.id === 'helper' && e.reason === 'ready')).toBe(true),
      { timeout: 2_000, interval: 5 },
    );

    const tools = createSenseTools(h.runtime, () => now);
    const envSummary = tools.find((tool) => tool.name === 'env_summary');
    if (!envSummary) throw new Error('missing env_summary tool');

    await expect(envSummary.execute({ month: '2026-13' }, makeExec())).rejects.toThrow(ToolArgsError);

    // Defaults to previous month (2026-10)
    const oct = (await envSummary.execute({}, makeExec())) as {
      available: boolean;
      summary: {
        month: string;
        daysInMonth: number;
        coveredDays: number;
        missingDays: string[];
        apps: Record<string, { foregroundMs: number }>;
        deliveries: { byRule: Record<string, unknown> };
        fileBursts: Record<string, unknown>;
        fileActivity: Record<string, unknown>;
      };
    };
    expect(oct.available).toBe(true);
    expect(oct.summary.month).toBe('2026-10');
    expect(oct.summary.daysInMonth).toBe(31);
    expect(oct.summary.coveredDays).toBe(1);
    expect(oct.summary.missingDays).toHaveLength(30);
    expect(oct.summary.apps.Notes).toEqual({ foregroundMs: 120_000, switches: 2 });
    expect(oct.summary.deliveries.byRule['[redacted]']).toBeDefined();
    expect(oct.summary.fileBursts['secret-proj']).toBeDefined();
    expect(oct.summary.fileActivity['work-dir']).toBeDefined();
    expect(JSON.stringify(oct)).not.toContain('/Users/tester');
    expect(JSON.stringify(oct)).not.toContain('/home/tester');

    const currentMonth = (await envSummary.execute({ month: '2026-11' }, makeExec())) as {
      available: boolean;
      reason: string;
    };
    expect(currentMonth.available).toBe(false);
    expect(currentMonth.reason).toContain('after the month ends');

    const missingMonth = (await envSummary.execute({ month: '2026-08' }, makeExec())) as {
      available: boolean;
      reason: string;
    };
    expect(missingMonth.available).toBe(false);
    expect(missingMonth.reason).toContain('No history data found');

    await h.runtime.stop();
  });

  it('re-checks titlesAllowed after disk IO and aligns Linux and unready-helper with sendTitles (#1)', async () => {
    const now = Date.UTC(2026, 10, 18, 10, 0, 0);
    const base = createMemoryHistoryPort();
    await base.appendEvent(
      '2026-11-18',
      [
        JSON.stringify({
          record: 'event',
          id: 'app-1',
          kind: 'app.activated',
          subject: 'Notes',
          level: 'record',
          at: now - 2_000,
          source: { id: 'helper.frontApp', api: 'nsworkspace', host: 'local' },
        }),
        JSON.stringify({
          record: 'event',
          id: 'w-1',
          kind: 'window.focused',
          subject: 'Notes',
          title: 'Top Secret Merger Plan',
          level: 'record',
          at: now - 1_000,
          source: { id: 'helper.focusedWindow', api: 'ax', host: 'local' },
        }),
      ].join('\n') + '\n',
    );

    let readEntered!: () => void;
    const onReadEntered = new Promise<void>((r) => {
      readEntered = r;
    });
    let releaseRead!: () => void;
    const readGate = new Promise<void>((r) => {
      releaseRead = r;
    });
    let intercept = false;
    const gatedPort: HistoryStoragePort = {
      ...base,
      readEvents: async (d) => {
        if (intercept) {
          intercept = false;
          readEntered();
          await readGate;
        }
        return base.readEvents(d);
      },
    };

    const hMac = createRuntimeHarness(now, gatedPort, true);
    await hMac.runtime.start();
    const envHistoryMac = createSenseTools(hMac.runtime, () => now).find((t) => t.name === 'env_history')!;

    // Helper hasn't even completed hello/titles.ack yet, yet sendTitles=true matches env_state!
    const preReadyOut = (await envHistoryMac.execute({ kinds: ['window.focused'] }, makeExec())) as {
      titlesAllowed: boolean;
      events: Array<{ title?: string }>;
    };
    expect(preReadyOut.titlesAllowed).toBe(true);
    expect(preReadyOut.events[0]?.title).toBe('Top Secret Merger Plan');

    // Race setSendTitles(false) while env_history is awaiting disk read (both plain and with app filter)
    intercept = true;
    const raceP = envHistoryMac.execute({ app: 'Notes' }, makeExec());
    await onReadEntered;
    const toggleP = hMac.runtime.actions.setSendTitles(false);
    releaseRead();
    const [raceOut] = (await Promise.all([raceP, toggleP])) as [
      { titlesAllowed: boolean; events: Array<{ id: string; kind: string; title?: string }> },
      void,
    ];
    expect(hMac.runtime.rules.settings().sendTitles).toBe(false);
    expect(raceOut.titlesAllowed).toBe(false);
    expect(raceOut.events.map((e) => e.id)).toEqual(['app-1']);

    await hMac.runtime.stop();

    // Linux (no helper) with sendTitles=true returns window titles identically to env_state
    const hLinux = createRuntimeHarness(now, base, false);
    await hLinux.runtime.start();
    const linuxOut = (await createSenseTools(hLinux.runtime, () => now)
      .find((t) => t.name === 'env_history')!
      .execute({ kinds: ['window.focused'] }, makeExec())) as {
      titlesAllowed: boolean;
      events: Array<{ title?: string }>;
    };
    expect(hLinux.runtime.rules.settings().sendTitles).toBe(true);
    expect(linuxOut.titlesAllowed).toBe(true);
    expect(linuxOut.events[0]?.title).toBe('Top Secret Merger Plan');
    await hLinux.runtime.stop();
  });

  it('redacts job.*/process.* to executable basename, disk:<mount> to mount basename, and blocks unsafe identifiers (#2)', async () => {
    const now = Date.UTC(2026, 10, 18, 10, 0, 0);
    const history = createMemoryHistoryPort();
    let jobCb:
      | ((ev: {
          type: 'started' | 'exited';
          id: string;
          command?: string;
          exitCode?: number;
          at?: number;
        }) => Promise<void>)
      | undefined;
    const rt = createSenseRuntime(
      {
        clock: { wall: () => now, mono: () => 1_000 },
        history,
        storage: { load: async () => undefined, save: async () => {} },
        dsh: {
          onAgentEvent: () => () => {},
          onTool: () => () => {},
          onJob: (cb) => {
            jobCb = cb as typeof jobCb;
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
    await rt.start();
    await jobCb?.({ type: 'exited', id: 'job-1', command: 'ssh prod_bastion_secret', exitCode: 1, at: now });
    await rt.tools.envHistory({});
    const rawDisk = await history.readEvents('2026-11-18');
    expect(rawDisk).toContain('ssh prod_bastion_secret');

    const envHistory = createSenseTools(rt, () => now).find((t) => t.name === 'env_history')!;
    const jobOut = (await envHistory.execute({ kinds: ['job.exited'] }, makeExec())) as {
      events: Array<{ kind: string; subject: string }>;
    };
    expect(jobOut.events).toEqual([expect.objectContaining({ kind: 'job.exited', subject: 'ssh' })]);
    await rt.stop();

    const projected = modelHistory({
      available: true,
      from: 1_000,
      to: 2_000,
      limit: 50,
      total: 4,
      truncated: false,
      titlesAllowed: true,
      events: [
        {
          id: 'proc-1',
          kind: 'process.exited',
          subject: 'API_KEY=secret /usr/local/bin/psql postgres://admin:s3cr3t@10.0.0.5:5432/prod_db -c "SELECT 1"',
          level: 'wake',
          ruleId: 'corp-db.internal:5432',
          at: 1_800,
          source: { id: '10.0.0.5', api: 'user@host', host: 'local' },
        },
        {
          id: 'job-quoted',
          kind: 'job.started',
          subject: '"/Applications/Secret App.app/Contents/MacOS/MyRunner" --token=xyz',
          level: 'context',
          ruleId: 'host.1',
          at: 1_700,
          source: { id: 'a/b', api: 'a\\b', host: 'local' },
        },
        {
          id: 'body:disk:/Volumes/Corp Secret/Drive:1500:warn',
          kind: 'body.threshold',
          subject: 'disk:/Volumes/Corp Secret/Drive',
          level: 'context',
          at: 1_500,
          source: { id: 'body', api: 'probe', host: 'local' },
          detail: {
            severity: 'warn',
            value: 0.05,
            metric: 'disk:/Volumes/Corp Secret/Drive',
            ruleId: 'corp-db.internal',
          },
        },
        {
          id: 'rate-1',
          kind: 'body.rate',
          subject: 'rate:disk-drop:disk:/',
          level: 'context',
          at: 1_300,
          source: { id: 'body', api: 'probe', host: 'local' },
          detail: { metric: 'disk:/', severity: 'warn' },
        },
      ],
    }) as { events: Array<Record<string, unknown>> };
    const serialized = JSON.stringify(projected);
    expect(serialized).not.toContain('s3cr3t');
    expect(serialized).not.toContain('prod_db');
    expect(serialized).not.toContain('API_KEY');
    expect(serialized).not.toContain('10.0.0.5');
    expect(serialized).not.toContain('corp-db.internal');
    expect(serialized).not.toContain('Corp Secret');
    expect(serialized).not.toContain('--token=xyz');
    expect(serialized).not.toContain('host.1');
    expect(serialized).not.toContain('user@host');

    expect(projected.events[0]).toMatchObject({
      subject: 'psql',
      ruleId: '[redacted]',
      source: { id: '[redacted]', api: '[redacted]' },
    });
    expect(projected.events[1]).toMatchObject({
      subject: 'MyRunner',
      ruleId: '[redacted]',
      source: { id: '[redacted]', api: '[redacted]' },
    });
    expect(projected.events[2]).toMatchObject({
      id: 'body:disk:Drive:1500:warn',
      subject: 'disk:Drive',
      detail: { metric: 'disk:Drive', ruleId: '[redacted]' },
    });
    expect(projected.events[3]).toMatchObject({
      subject: 'rate:disk-drop:disk:[path]',
      detail: { metric: 'disk:[path]' },
    });

    const sumOut = modelSummary({
      available: true,
      summary: {
        version: 1,
        month: '2026-10',
        daysInMonth: 31,
        coveredDays: 1,
        missingDays: [],
        includedDays: ['2026-10-01'],
        apps: {},
        appSwitches: 0,
        deliveries: {
          wake: 1,
          context: 0,
          suppressed: 0,
          byRule: {
            '10.0.0.5:8080': { wake: 1, context: 0, suppressed: 0 },
            'r-wake': { wake: 2, context: 0, suppressed: 0 },
          },
        },
        fileBursts: {},
        fileActivity: {},
        bodyAnomalies: {
          total: 3,
          threshold: 3,
          rate: 0,
          anomaly: 0,
          byMetric: { 'disk:[path]': 1, 'db.internal:5432': 1, 'disk:/Volumes/Corp Secret/Drive': 1 },
        },
        coverage: { totalDayMs: 86_400_000, observedMs: 1_000, pausedMs: 0, notRunningMs: 86_399_000 },
        totalEvents: 1,
        generatedAt: 1_000,
      },
    }) as {
      summary: { deliveries: { byRule: Record<string, unknown> }; bodyAnomalies: { byMetric: Record<string, number> } };
    };
    expect(sumOut.summary.deliveries.byRule['[redacted]']).toBeDefined();
    expect(sumOut.summary.deliveries.byRule['r-wake']).toBeDefined();
    expect(sumOut.summary.bodyAnomalies.byMetric).toEqual({
      'disk:[path]': 1,
      '[redacted]': 1,
      'disk:Drive': 1,
    });
  });

  it('handles multi-day queries, date bounds, exact limit=200, early-stop across days, invalid ISO dates (#10), and corrupt JSON (#6)', async () => {
    const now = Date.UTC(2026, 10, 15, 12, 0, 0);
    const base = createMemoryHistoryPort();
    for (const [date, at, id] of [
      ['2026-10-31', Date.UTC(2026, 9, 31, 23, 0, 0), 'oct-last'],
      ['2026-11-01', Date.UTC(2026, 10, 1, 1, 0, 0), 'nov-first'],
      ['2026-11-12', Date.UTC(2026, 10, 12, 11, 0, 0), 'nov-12-early'],
      ['2026-11-12', Date.UTC(2026, 10, 12, 12, 0, 0), 'nov-12'],
    ] as const) {
      await base.appendEvent(
        date,
        `${JSON.stringify({
          record: 'event',
          id,
          kind: 'app.activated',
          subject: 'App',
          level: 'record',
          at,
          source: { id: 'helper', api: 'nsworkspace', host: 'local' },
        })}\n`,
      );
    }
    const readSpy = vi.fn((d: string) => base.readEvents(d));
    const spiedPort: HistoryStoragePort = { ...base, readEvents: readSpy };

    const h = createRuntimeHarness(now, spiedPort, false);
    await h.runtime.start();
    // Wait for background backfill of 2026-10-31 and 2026-11-12 before injecting corrupt monthly fixtures below.
    await vi.waitFor(async () => expect(await base.readDaily('2026-11-12')).toBeDefined(), {
      timeout: 3_000,
      interval: 10,
    });
    const tools = createSenseTools(h.runtime, () => now);
    const envHistory = tools.find((t) => t.name === 'env_history')!;
    const envSummary = tools.find((t) => t.name === 'env_summary')!;

    // Invalid ISO calendar date rejected (#10) + negative/NaN bounds rejected
    await expect(envHistory.execute({ from: '2026-02-30T10:00:00Z' }, makeExec())).rejects.toThrow(ToolArgsError);
    await expect(envHistory.execute({ from: -1 }, makeExec())).rejects.toThrow(ToolArgsError);
    await expect(envHistory.execute({ to: Number.NaN }, makeExec())).rejects.toThrow(ToolArgsError);

    // Cross-month query returns newest-to-oldest
    const cross = (await envHistory.execute({ from: '2026-10-31', to: '2026-11-02' }, makeExec())) as {
      events: Array<{ id: string }>;
    };
    expect(cross.events.map((e) => e.id)).toEqual(['nov-first', 'oct-last']);

    // Early-stop: limit=1 stops on newest matching day without reading older days
    readSpy.mockClear();
    const one = (await envHistory.execute({ from: '2026-10-31', to: '2026-11-12', limit: 1 }, makeExec())) as {
      events: Array<{ id: string }>;
      truncated: boolean;
    };
    expect(one.events.map((e) => e.id)).toEqual(['nov-12']);
    expect(one.truncated).toBe(true);
    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(readSpy).toHaveBeenCalledWith('2026-11-12');

    // Exact 200 events with limit=200 has truncated=false; adding 1 more yields truncated=true
    const lines200 = Array.from({ length: 200 }, (_, i) =>
      JSON.stringify({
        record: 'event',
        id: `e200-${i}`,
        kind: 'app.activated',
        subject: 'A',
        level: 'record',
        at: Date.UTC(2026, 10, 14, 0, 0, 0) + i * 10,
        source: { id: 'helper', api: 'nsworkspace', host: 'local' },
      }),
    );
    await base.appendEvent('2026-11-14', `${lines200.join('\n')}\n`);
    const exact200 = (await envHistory.execute({ from: '2026-11-14', to: '2026-11-14', limit: 200 }, makeExec())) as {
      events: Array<{ id: string }>;
      truncated: boolean;
      total: number;
    };
    expect(exact200.events).toHaveLength(200);
    expect(exact200.total).toBe(200);
    expect(exact200.truncated).toBe(false);

    // Pre-existing current-month monthly JSON is NOT returned prematurely (#10 nit)
    await base.writeMonthly(
      '2026-11',
      JSON.stringify({
        version: 1,
        month: '2026-11',
        daysInMonth: 30,
        coveredDays: 1,
        missingDays: [],
        includedDays: [],
        apps: {},
        appSwitches: 0,
        deliveries: { wake: 0, context: 0, suppressed: 0, byRule: {} },
        fileBursts: {},
        fileActivity: {},
        bodyAnomalies: { total: 0, threshold: 0, rate: 0, anomaly: 0, byMetric: {} },
        coverage: { totalDayMs: 86_400_000, observedMs: 0, pausedMs: 0, notRunningMs: 86_400_000 },
        totalEvents: 0,
        generatedAt: 1,
      }),
    );
    expect(await envSummary.execute({ month: '2026-11' }, makeExec())).toMatchObject({ available: false });

    // Half-corrupt daily & monthly summaries do not crash modelSummary (#6)
    await base.writeMonthly('2026-10', JSON.stringify({ version: 1, month: '2026-10' }));
    await base.writeMonthly('2026-08', JSON.stringify({ version: 1, month: '2026-08' }));
    await base.writeDaily(
      '2026-09-10',
      JSON.stringify({
        version: 1,
        date: '2026-09-10',
        coverage: {},
        deliveries: {},
        bodyAnomalies: {},
        fileBursts: { d: null },
      }),
    );
    const octAfterCorrupt = modelSummary(await h.runtime.tools.envSummary({ month: '2026-10' })) as {
      available: boolean;
    };
    expect(octAfterCorrupt.available).toBe(true);
    const augAfterCorrupt = modelSummary(await h.runtime.tools.envSummary({ month: '2026-08' })) as {
      available: boolean;
    };
    expect(augAfterCorrupt.available).toBe(false);
    const sepAfterCorrupt = modelSummary(await h.runtime.tools.envSummary({ month: '2026-09' })) as {
      available: boolean;
    };
    expect(sepAfterCorrupt.available).toBe(false);
    expect(
      h.runtime.events().filter((e) => e.kind === 'source.error' && e.reason === 'corrupt-monthly-summary'),
    ).toHaveLength(2);
    expect(
      h.runtime.events().filter((e) => e.kind === 'source.error' && e.reason === 'corrupt-daily-summary'),
    ).toHaveLength(1);

    await h.runtime.stop();

    // Leap year Feb (29 days) & Jan default prevMonth (2027-01 -> 2026-12)
    const janNow = Date.UTC(2027, 0, 5, 10, 0, 0);
    const janPort = createMemoryHistoryPort();
    await janPort.appendEvent(
      '2026-12-15',
      `${JSON.stringify({ record: 'event', id: 'dec', kind: 'app.activated', subject: 'App', level: 'record', at: Date.UTC(2026, 11, 15, 12, 0, 0), source: { id: 'helper', api: 'nsworkspace', host: 'local' } })}\n`,
    );
    await janPort.appendEvent(
      '2024-02-29',
      `${JSON.stringify({ record: 'event', id: 'leap', kind: 'app.activated', subject: 'App', level: 'record', at: Date.UTC(2024, 1, 29, 12, 0, 0), source: { id: 'helper', api: 'nsworkspace', host: 'local' } })}\n`,
    );
    const hJan = createRuntimeHarness(janNow, janPort, false);
    await hJan.runtime.start();
    const janTools = createSenseTools(hJan.runtime, () => janNow);
    const janSummaryTool = janTools.find((t) => t.name === 'env_summary')!;
    const decDefault = (await janSummaryTool.execute({}, makeExec())) as {
      available: boolean;
      summary: { month: string };
    };
    expect(decDefault).toMatchObject({ available: true, summary: { month: '2026-12' } });
    // Leap month synthesized from direct daily summary
    const leapDaily: DailySummary = {
      version: 1,
      date: '2024-02-29',
      dayStartMs: Date.UTC(2024, 1, 29),
      dayEndMs: Date.UTC(2024, 2, 1),
      dayDurationMs: 86_400_000,
      apps: {},
      appSwitches: 0,
      deliveries: { wake: 0, context: 0, suppressed: 0, byRule: {} },
      fileBursts: {},
      fileActivity: {},
      bodyAnomalies: { total: 0, threshold: 0, rate: 0, anomaly: 0, byMetric: {} },
      coverage: { observedMs: 0, pausedMs: 0, notRunningMs: 86_400_000 },
      totalEvents: 0,
    };
    await janPort.writeDaily('2024-02-29', JSON.stringify(leapDaily));
    const febLeap = (await janSummaryTool.execute({ month: '2024-02' }, makeExec())) as {
      available: boolean;
      summary: { daysInMonth: number };
    };
    expect(febLeap).toMatchObject({ available: true, summary: { daysInMonth: 29 } });
    await hJan.runtime.stop();
  });

  it('marks env_summary partial:true during background cold-start backfill and clears once complete (#4)', async () => {
    const dir = await makeTempDir();
    const eventsDir = join(dir, 'history', 'events');
    await mkdir(eventsDir, { recursive: true, mode: 0o700 });
    const baseWall = Date.UTC(2026, 10, 5, 10, 0, 0);

    // Build ~320 KiB per day across 3 October days (> 512 KiB total -> defers to background backfill)
    const lines: string[] = [];
    for (let i = 0; i < 1600; i++) {
      lines.push(
        JSON.stringify({
          record: 'event',
          id: `bg-${i}`,
          kind: 'app.activated',
          subject: 'EditorApp',
          level: 'record',
          at: Date.UTC(2026, 9, 25, 10, 0, 0) + i * 100,
          source: { id: 'helper', api: 'nsworkspace', host: 'local' },
        }),
      );
    }
    const payload = `${lines.join('\n')}\n`;
    for (const date of ['2026-10-25', '2026-10-26', '2026-10-27']) {
      await writeFile(join(eventsDir, `${date}.jsonl`), payload, { mode: 0o600 });
    }

    const port = new FileHistoryStoragePort(dir);
    const h = createRuntimeHarness(baseWall, port, false);
    await h.runtime.start();

    const envSummary = createSenseTools(h.runtime, () => baseWall).find((t) => t.name === 'env_summary')!;
    const partialRes = (await envSummary.execute({}, makeExec())) as {
      available: boolean;
      partial?: boolean;
      pendingDays?: string[];
      note?: string;
      summary: { partial?: boolean; month: string };
    };
    expect(partialRes.available).toBe(true);
    expect(partialRes.partial).toBe(true);
    expect(partialRes.pendingDays).toEqual(['2026-10-25', '2026-10-26', '2026-10-27']);
    expect(typeof partialRes.note).toBe('string');
    expect(partialRes.note?.length).toBeGreaterThan(0);
    expect(partialRes.summary.partial).toBe(true);
    expect(partialRes.summary.month).toBe('2026-10');
    // Must not prematurely persist monthly/2026-10.json while partial
    expect(await port.readMonthly('2026-10')).toBeUndefined();

    // Wait for background backfill to finish, then confirm partial flag is gone and monthly JSON is persisted
    await vi.waitFor(async () => expect(await port.readMonthly('2026-10')).toBeDefined(), {
      timeout: 5_000,
      interval: 20,
    });
    const fullRes = (await envSummary.execute({}, makeExec())) as {
      available: boolean;
      partial?: boolean;
      pendingDays?: string[];
      note?: string;
      summary: { partial?: boolean; coveredDays: number };
    };
    expect(fullRes.available).toBe(true);
    expect(fullRes.partial).toBeUndefined();
    expect(fullRes.pendingDays).toBeUndefined();
    expect(fullRes.note).toBeUndefined();
    expect(fullRes.summary.partial).toBeUndefined();
    expect(fullRes.summary.coveredDays).toBe(3);

    await h.runtime.stop();
  });

  it('whitelists command subjects across quoted/escaped env prefixes, wrappers, and domains; truncates oversized fileActivity; queries across TZ shift (#2, #5, #6)', async () => {
    // 1) Whitelist command subject parsing (including all review #2 cases + wrapper nesting + app path nit)
    const cmdSamples = [
      ['API_KEY="sk_live_secret_987654" /usr/bin/curl https://api.corp.internal', 'curl'],
      ['PROXY="https://secret-corp.internal" curl', 'curl'],
      ["DB_PASS='hunter2_secret' psql -h 10.0.0.5", 'psql'],
      ['MY_VAL=foo\\ secret_token /usr/bin/ssh prod', 'ssh'],
      [
        'sudo -E -u dbadmin env DB_PASS="secret" nohup time -p exec -a runner /usr/local/bin/python3.12 -m app',
        'python3.12',
      ],
      ['timeout -s KILL 30s nice -n 10 /usr/bin/node server.js', 'node'],
      ['env -i -u SECRET_VAR -C /Users/alice/secret build.sh', 'build.sh'],
      ['"C:\\Program Files\\MyApp\\runner.exe" --secret=123', 'runner.exe'],
      ['secret-corp.internal --flag', '[command]'],
      ['api.corp.internal', '[command]'],
      ['evil.com', '[command]'],
      ['10.0.0.5', '[command]'],
      ['https://secret-corp.internal/bin', '[command]'],
      ['API_KEY="only_assignment"', '[command]'],
      ['sudo --unknown-flag secret_arg /usr/bin/id', '[command]'],
      ['$(SECRET_CMD) /usr/bin/id', '[command]'],
    ] as const;

    const cmdEvents = cmdSamples.map(([subject], idx) => ({
      id: `cmd-${idx}`,
      kind: idx % 2 === 0 ? 'job.exited' : 'process.exited',
      subject,
      level: 'record' as const,
      at: 1_000 + idx,
      source: { id: 'dsh', api: 'events', host: 'local' },
    }));
    const cmdProjected = modelHistory({
      available: true,
      from: 1_000,
      to: 2_000,
      limit: 50,
      total: cmdEvents.length,
      truncated: false,
      titlesAllowed: true,
      events: [
        ...cmdEvents,
        {
          id: 'app-path',
          kind: 'app.activated',
          subject: '/Users/alice/Corp Secret/MyTool.app',
          level: 'record',
          at: 1_999,
          source: { id: 'helper', api: 'nsworkspace', host: 'local' },
        },
      ],
    }) as { events: Array<{ id: string; subject: string }> };

    for (let idx = 0; idx < cmdSamples.length; idx++) {
      expect(cmdProjected.events[idx]?.subject).toBe(cmdSamples[idx][1]);
    }
    expect(cmdProjected.events.at(-1)?.subject).toBe('MyTool.app');
    const serializedCmd = JSON.stringify(cmdProjected);
    for (const secret of [
      'sk_live_secret_987654',
      'secret-corp.internal',
      'hunter2_secret',
      'secret_token',
      'dbadmin',
      'SECRET_VAR',
      'evil.com',
      '10.0.0.5',
      'Corp Secret',
    ]) {
      expect(serializedCmd).not.toContain(secret);
    }

    // 2) modelSummary truncates oversized fileActivity instead of whole-payload fallback (#5)
    const fileActivity: Record<string, { events: number; created: number; modified: number; deleted: number }> = {};
    for (let i = 0; i < 600; i++) {
      fileActivity[`project-directory-with-moderate-name-${i}`] = {
        events: 10 + i,
        created: 2,
        modified: 7,
        deleted: 1,
      };
    }
    const bigSummary = modelSummary({
      available: true,
      summary: {
        version: 1,
        month: '2026-10',
        daysInMonth: 31,
        coveredDays: 30,
        missingDays: ['2026-10-31'],
        includedDays: [],
        apps: { '/Users/alice/Corp Secret/MyTool.app': { foregroundMs: 1_000, switches: 1 } },
        appSwitches: 1,
        deliveries: { wake: 0, context: 0, suppressed: 0, byRule: {} },
        fileBursts: {},
        fileActivity,
        bodyAnomalies: { total: 0, threshold: 0, rate: 0, anomaly: 0, byMetric: {} },
        coverage: {
          totalDayMs: 30 * 86_400_000,
          observedMs: 100_000,
          pausedMs: 0,
          notRunningMs: 30 * 86_400_000 - 100_000,
        },
        totalEvents: 6_000,
        generatedAt: 1_000,
      },
    }) as {
      available: boolean;
      fileActivityTruncated?: boolean;
      note?: string;
      summary: {
        month: string;
        apps: Record<string, unknown>;
        fileActivity: Record<string, unknown>;
      };
    };
    expect(bigSummary.available).toBe(true);
    expect(bigSummary.fileActivityTruncated).toBe(true);
    expect(bigSummary.note).toContain('fileActivity');
    expect(bigSummary.summary.month).toBe('2026-10');
    expect(bigSummary.summary.apps['MyTool.app']).toBeDefined();
    expect(JSON.stringify(bigSummary)).not.toContain('Corp Secret');
    const keptFaKeys = Object.keys(bigSummary.summary.fileActivity);
    expect(keptFaKeys.length).toBeGreaterThan(0);
    expect(keptFaKeys.length).toBeLessThan(600);
    expect(keptFaKeys[0]).toBe('project-directory-with-moderate-name-599');
    expect(Buffer.byteLength(JSON.stringify(bigSummary), 'utf8')).toBeLessThanOrEqual(32_768);

    // 3) Westward TZ shift across midnight still finds prior-day UTC-equivalent files (#6)
    const origTz = process.env.TZ;
    const tzDir = await makeTempDir();
    try {
      process.env.TZ = 'Asia/Tokyo';
      const tzPort = new FileHistoryStoragePort(tzDir);
      let tzWall = Date.UTC(2026, 10, 17, 17, 0, 0);
      let tzMono = 1_000;
      let tzJobCb!: (ev: { type: 'started' | 'exited'; id: string; at?: number }) => Promise<void>;
      const rtTz = createSenseRuntime(
        {
          clock: { wall: () => tzWall, mono: () => tzMono },
          history: tzPort,
          storage: { load: async () => undefined, save: async () => {} },
          dsh: {
            onAgentEvent: () => () => {},
            onTool: () => () => {},
            onJob: (cb) => {
              tzJobCb = cb as typeof tzJobCb;
              return () => {};
            },
            deliver: async () => {},
            tokenSnapshot: async () => undefined,
          },
          helper: { spawn: () => undefined },
          probe: { create: () => ({ onSample: () => () => {}, start: () => {}, stop: async () => {} }) },
          files: { watch: () => ({ close: () => {} }) },
        },
        { platform: 'linux', intervalMs: 600_000, globalFileWatch: { disableInTests: true } },
      );
      await rtTz.start();
      await tzJobCb({ type: 'started', id: 'tokyo-job', at: tzWall + 1_000 });
      await rtTz.tools.envHistory({});
      process.env.TZ = 'America/Los_Angeles';
      tzWall += 600_000;
      tzMono += 600_000;
      await tzJobCb({ type: 'started', id: 'la-job', at: tzWall });
      const defQ = await rtTz.tools.envHistory({});
      const nov17Q = await rtTz.tools.envHistory({ from: '2026-11-17', to: '2026-11-17' });
      expect(await tzPort.listEventDates()).toEqual(['2026-11-17', '2026-11-18']);
      expect(defQ.events.map((e) => e.subject)).toEqual(['la-job', 'tokyo-job', 'helper']);
      expect(nov17Q.events.map((e) => e.subject)).toEqual(['la-job', 'tokyo-job', 'helper']);
      await rtTz.stop();
    } finally {
      if (origTz === undefined) delete process.env.TZ;
      else process.env.TZ = origTz;
      await rm(tzDir, { recursive: true, force: true });
    }
  });

  it('persists file.activity locally, summarizes into daily/monthly fileActivity, and routes file.* paths through modelActivityName/modelPath', async () => {
    const dir = await makeTempDir();
    const port = new FileHistoryStoragePort(dir);
    let wallMs = Date.UTC(2026, 9, 15, 23, 59, 0);
    let monoMs = 1_000;
    let watchCb: ((event: FileChange) => void) | undefined;
    const saved = new Map<string, string>();

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    try {
      const rt = createSenseRuntime(
        {
          clock: { wall: () => wallMs, mono: () => monoMs },
          history: port,
          storage: {
            load: async (key) => saved.get(key),
            save: async (key, json) => {
              saved.set(key, json);
            },
          },
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
            watch: (root, cb) => {
              if (root === '/') watchCb = cb;
              return { close: () => {} };
            },
          },
        },
        {
          platform: 'darwin',
          timeZone: 'UTC',
          intervalMs: 600_000,
          globalFileWatch: {
            root: '/',
            windowMs: 5_000,
            homedir: '/Users/alice',
            dataDirs: [dir],
          },
        },
      );
      await rt.start();
      expect(watchCb).toBeDefined();

      // Emit file changes across project subdir, user home root, and path containing email + IP:port.
      // The foreign home is under /Users (not /home) because macOS maps /home into /System, which is a
      // default file exclusion; /Users keeps the redaction assertions portable across platforms.
      watchCb?.({ path: '/Users/alice/secret-workspace/app.ts', change: 'add', at: wallMs + 100 });
      watchCb?.({ path: '/Users/alice/secret-workspace/notes.md', change: 'modify', at: wallMs + 200 });
      watchCb?.({ path: '/Users/alice/.bashrc', change: 'modify', at: wallMs + 300 });
      watchCb?.({
        path: '/users/bob-dev/alice@corp.com-192.168.1.50:5432/leak.log',
        change: 'delete',
        at: wallMs + 400,
      });

      wallMs += 5_000;
      monoMs += 5_000;
      await vi.advanceTimersByTimeAsync(5_000);

      const tools = createSenseTools(rt, () => wallMs);
      const envHistory = tools.find((t) => t.name === 'env_history');
      if (!envHistory) throw new Error('missing env_history tool');

      const histRes = (await envHistory.execute({ kinds: ['file.activity'] }, makeExec())) as {
        events: Array<{
          kind: string;
          subject: string;
          detail?: {
            directory?: string;
            created?: number;
            modified?: number;
            deleted?: number;
            files?: string[];
          };
        }>;
      };

      // Local event log keeps full local paths on disk (case-folded on darwin)
      const rawEvents = (await port.readEvents('2026-10-15')) ?? '';
      expect(rawEvents).toContain('/users/alice/secret-workspace');
      expect(rawEvents).toContain('"subject":"/users/alice"');
      expect(rawEvents).toContain('.bashrc');
      expect(rawEvents).toContain('/users/bob-dev/alice@corp.com-192.168.1.50:5432');

      // Model-facing env_history output masks home root, strips directory prefixes, and redacts email/IP
      expect(histRes.events).toHaveLength(3);
      const bySubject = new Map(histRes.events.map((ev) => [ev.subject, ev]));
      expect(bySubject.get('secret-workspace')?.detail).toMatchObject({
        directory: 'secret-workspace',
        created: 1,
        modified: 1,
        deleted: 0,
        files: ['app.ts', 'notes.md'],
      });
      expect(bySubject.get('~')?.detail).toMatchObject({
        directory: '~',
        created: 0,
        modified: 1,
        deleted: 0,
        // Dotfiles are hidden metadata under the whitelist projection, so the name becomes [path].
        files: ['[path]'],
      });
      // Endpoint-like directory (email + IP:port) is fully redacted to [path] now.
      expect(bySubject.get('[path]')?.detail).toMatchObject({
        directory: '[path]',
        created: 0,
        modified: 0,
        deleted: 1,
        files: ['leak.log'],
      });
      const histSerialized = JSON.stringify(histRes);
      for (const secret of ['/Users/alice', '/users/bob-dev', 'alice', 'bob-dev', '192.168.1.50', '5432']) {
        expect(histSerialized).not.toContain(secret);
      }

      // Cross midnight to generate 2026-10-15 daily summary
      wallMs = Date.UTC(2026, 9, 16, 0, 1, 0);
      monoMs += 120_000;
      await vi.advanceTimersByTimeAsync(120_000);
      await rt.tools.envHistory({});

      const dailyRaw = await port.readDaily('2026-10-15');
      expect(dailyRaw).toBeDefined();
      const daily = JSON.parse(dailyRaw ?? '{}') as DailySummary;
      expect(daily.fileActivity['secret-workspace']).toEqual({ events: 1, created: 1, modified: 1, deleted: 0 });
      expect(daily.fileActivity['~']).toEqual({ events: 1, created: 0, modified: 1, deleted: 0 });
      expect(daily.fileActivity['alice@corp.com-192.168.1.50:5432']).toEqual({
        events: 1,
        created: 0,
        modified: 0,
        deleted: 1,
      });

      await rt.stop();

      // Next month runtime queries env_summary and routes fileActivity/fileBursts through modelActivityName/modelPath
      const novWall = Date.UTC(2026, 10, 2, 10, 0, 0);
      const rtNov = createSenseRuntime(
        {
          clock: { wall: () => novWall, mono: () => 1_000 },
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
          probe: { create: () => ({ onSample: () => () => {}, start: () => {}, stop: async () => {} }) },
          files: { watch: () => ({ close: () => {} }) },
        },
        { platform: 'linux', timeZone: 'UTC', intervalMs: 600_000 },
      );
      await rtNov.start();
      const envSummary = createSenseTools(rtNov, () => novWall).find((t) => t.name === 'env_summary');
      if (!envSummary) throw new Error('missing env_summary tool');
      const octSum = (await envSummary.execute({ month: '2026-10' }, makeExec())) as {
        available: boolean;
        summary: {
          fileActivity: Record<string, { events: number; created: number; modified: number; deleted: number }>;
        };
      };
      expect(octSum.available).toBe(true);
      expect(octSum.summary.fileActivity['secret-workspace']).toEqual({
        events: 1,
        created: 1,
        modified: 1,
        deleted: 0,
      });
      expect(octSum.summary.fileActivity['~']).toEqual({ events: 1, created: 0, modified: 1, deleted: 0 });
      expect(octSum.summary.fileActivity['[path]']).toEqual({ events: 1, created: 0, modified: 0, deleted: 1 });
      const sumSerialized = JSON.stringify(octSum);
      for (const secret of ['/Users/alice', '/users/bob-dev', 'alice', 'bob-dev', '192.168.1.50', '5432']) {
        expect(sumSerialized).not.toContain(secret);
      }
      await rtNov.stop();
    } finally {
      vi.useRealTimers();
    }

    // Direct projection check for file.* variants including os.homedir(), long names, and blank tokens
    const localHome = homedir();
    const directHist = modelHistory({
      available: true,
      from: 1_000,
      to: 2_000,
      limit: 50,
      total: 2,
      truncated: false,
      titlesAllowed: true,
      events: [
        {
          id: 'fa-home',
          kind: 'file.activity',
          subject: localHome,
          level: 'record',
          at: 1_500,
          source: { id: 'files-global', api: 'watch', host: 'local' },
          detail: {
            directory: localHome,
            created: 1,
            modified: 0,
            deleted: 0,
            files: ['/Users/alice/alice@example.com.log', `${'Z'.repeat(600)}.txt`, '/   '],
          },
        },
        {
          id: 'fb-home',
          kind: 'file.burst',
          subject: '/users/bob-dev',
          level: 'wake',
          at: 1_600,
          source: { id: 'files-global', api: 'watch', host: 'local' },
          detail: { directory: '/users/bob-dev', deleted: 60 },
        },
      ],
    }) as { events: Array<{ subject: string; detail?: { directory?: string; files?: string[] } }> };
    expect(directHist.events[0]).toMatchObject({
      subject: '~',
      detail: {
        directory: '~',
        // Strict whitelist projection redacts email-like, overlong, and blank path tokens to [path].
        files: ['[path]', '[path]', '[path]'],
      },
    });
    expect(directHist.events[1]).toMatchObject({
      subject: '~',
      detail: { directory: '~' },
    });
    expect(JSON.stringify(directHist)).not.toContain('alice');
    expect(JSON.stringify(directHist)).not.toContain('bob-dev');
    if (localHome !== '/') {
      const homeBase = localHome.replaceAll('\\', '/').replace(/\/+$/, '').split('/').at(-1);
      if (homeBase && homeBase !== '~') expect(JSON.stringify(directHist)).not.toContain(homeBase);
    }

    const directSum = modelSummary({
      available: true,
      summary: {
        version: 1,
        month: '2026-10',
        daysInMonth: 31,
        coveredDays: 1,
        missingDays: [],
        includedDays: ['2026-10-01'],
        apps: {},
        appSwitches: 0,
        deliveries: { wake: 0, context: 0, suppressed: 0, byRule: {} },
        fileBursts: { '/Users/alice': { events: 1, created: 0, modified: 0, deleted: 55 } },
        fileActivity: { '/users/bob-dev': { events: 2, created: 1, modified: 2, deleted: 0 } },
        bodyAnomalies: { total: 0, threshold: 0, rate: 0, anomaly: 0, byMetric: {} },
        coverage: { totalDayMs: 86_400_000, observedMs: 1_000, pausedMs: 0, notRunningMs: 86_399_000 },
        totalEvents: 3,
        generatedAt: 1_000,
      },
    }) as { summary: { fileBursts: Record<string, unknown>; fileActivity: Record<string, unknown> } };
    expect(directSum.summary.fileBursts['~']).toBeDefined();
    expect(directSum.summary.fileActivity['~']).toBeDefined();
    expect(JSON.stringify(directSum)).not.toContain('alice');
    expect(JSON.stringify(directSum)).not.toContain('bob-dev');

    // Architecture check: history-output.ts routes file.* paths through modelActivityName/modelPath
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(here, '../../src/host/dsh/history-output.ts'), 'utf8');
    expect(src).toContain('modelActivityName(');
    expect(src).toContain("entry.kind.startsWith('file.')");
    expect(src).toContain('projectRecord(s.fileBursts, (key) => modelActivityName(');
    expect(src).toContain('projectRecord(s.fileActivity, (key) => modelActivityName(');
  });

  it('masks a global-watch event whose own path is the user home root', async () => {
    const dir = await makeTempDir();
    const port = new FileHistoryStoragePort(dir);
    let wallMs = Date.UTC(2026, 10, 18, 12, 0, 0);
    let monoMs = 1_000;
    let watchCb: ((event: FileChange) => void) | undefined;
    const saved = new Map<string, string>();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    try {
      const rt = createSenseRuntime(
        {
          clock: { wall: () => wallMs, mono: () => monoMs },
          history: port,
          storage: {
            load: async (key) => saved.get(key),
            save: async (key, json) => {
              saved.set(key, json);
            },
          },
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
            watch: (root, cb) => {
              if (root === '/') watchCb = cb;
              return { close: () => {} };
            },
          },
        },
        {
          platform: 'darwin',
          timeZone: 'UTC',
          intervalMs: 600_000,
          globalFileWatch: { root: '/', windowMs: 30, homedir: '/Users/alice', dataDirs: [dir] },
        },
      );
      await rt.start();
      expect(watchCb).toBeDefined();

      // The watched path is the home root itself, not a child: the bucket directory is '/users',
      // so only the `files` basename could leak the account name.
      watchCb?.({ path: '/Users/alice', change: 'modify', at: wallMs });
      wallMs += 100;
      monoMs += 100;
      await vi.advanceTimersByTimeAsync(100);

      const envHistory = createSenseTools(rt, () => wallMs).find((tool) => tool.name === 'env_history');
      if (!envHistory) throw new Error('missing env_history tool');
      const hist = (await envHistory.execute({ kinds: ['file.activity'] }, makeExec())) as {
        events: Array<{ kind: string; subject: string; detail?: { directory?: string; files?: string[] } }>;
      };
      expect(hist.events).toHaveLength(1);
      expect(hist.events[0].detail).toMatchObject({ directory: 'users', files: ['~'] });
      expect(JSON.stringify(hist)).not.toContain('alice');

      const send = vi.fn();
      const agent = { send, followup: vi.fn(), inject: vi.fn() };
      const deliver = createDelivery(
        () => agent,
        () => true,
        async () => false,
      );
      const event = rt.events().find((entry) => entry.kind === 'file.activity');
      if (!event) throw new Error('missing file.activity event');
      await deliver('s1', {
        kind: 'send',
        target: 'user',
        wakeup: false,
        sessionId: 's1',
        deliveryId: 'home-root',
        update: {
          since: wallMs,
          suppressed: 0,
          summary: 'synthetic',
          changes: [
            {
              level: 'context',
              signal: {
                id: event.id,
                kind: event.kind,
                at: event.at,
                source: event.source,
                subject: event.subject,
                cause: 'unknown',
                data: event.detail ?? {},
              },
            },
          ],
        },
      } as never);
      expect(send).toHaveBeenCalledTimes(1);
      const deliveredText = JSON.stringify(send.mock.calls);
      expect(deliveredText).not.toContain('alice');
      expect(deliveredText).toContain('~');
      await rt.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('outputs only known event kinds from env_history and preserves strict system identifiers without modelText redaction', async () => {
    const now = Date.UTC(2026, 10, 18, 12, 0, 0);
    let currentWall = now;
    const history = createMemoryHistoryPort();
    let jobCb:
      | ((ev: {
          type: 'started' | 'exited';
          id: string;
          command?: string;
          exitCode?: number;
          at?: number;
        }) => Promise<void>)
      | undefined;
    let fileCb: ((ev: { path: string; change: 'add' | 'modify' | 'delete'; at?: number }) => void) | undefined;
    const saved = new Map<string, string>();
    let helperOut: PassThrough | undefined;

    const rt = createSenseRuntime(
      {
        clock: { wall: () => currentWall, mono: () => 1_000 },
        history,
        storage: {
          load: async (key) => saved.get(key),
          save: async (key, json) => {
            saved.set(key, json);
          },
        },
        dsh: {
          listSessions: async () => [{ id: 's1', title: 'Synthetic', updatedAt: now, running: true }],
          onAgentEvent: () => () => {},
          onTool: () => () => {},
          onJob: (cb) => {
            jobCb = cb as typeof jobCb;
            return () => {};
          },
          deliver: async () => {},
          tokenSnapshot: async () => undefined,
        },
        helper: {
          spawn: () => {
            let gen = 0;
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
            child.stdin.on('data', (chunk) => {
              for (const raw of chunk.toString('utf8').split('\n').filter(Boolean)) {
                const req = JSON.parse(raw) as { id?: string; enabled?: boolean; cmd?: string };
                if (req.cmd === 'titles' && typeof req.id === 'string' && typeof req.enabled === 'boolean') {
                  child.stdout.write(
                    `${JSON.stringify({
                      v: 1,
                      type: 'titles.ack',
                      session: 'fixture-session',
                      id: req.id,
                      enabled: req.enabled,
                      gen: ++gen,
                      at: now,
                    })}\n`,
                  );
                } else if (req.cmd === 'snapshot') {
                  child.stdout.write(
                    `${JSON.stringify({
                      v: 1,
                      type: 'snapshot',
                      at: now,
                      permissions: { accessibility: 'granted' },
                    })}\n`,
                  );
                }
              }
            });
            helperOut = child.stdout;
            child.stdout.write(
              `${JSON.stringify({
                v: 1,
                type: 'hello',
                at: now,
                version: '0.1.0',
                pid: 4242,
                session: 'fixture-session',
                permissions: { accessibility: 'granted' },
              })}\n`,
            );
            return child as never;
          },
        },
        probe: { create: () => ({ onSample: () => () => {}, start: () => {}, stop: async () => {} }) },
        files: {
          watch: (_path, cb) => {
            fileCb = cb;
            return { close: () => {} };
          },
        },
      },
      { platform: 'darwin', helperPath: '/synthetic/asi-helper', timeZone: 'UTC', intervalMs: 600_000 },
    );

    await rt.start();
    await vi.waitFor(() => expect(helperOut).toBeDefined(), { timeout: 2_000, interval: 5 });
    await vi.waitFor(
      () => expect(rt.events().some((e) => e.source.id === 'helper' && e.reason === 'ready')).toBe(true),
      { timeout: 2_000, interval: 5 },
    );

    await rt.tools.envWatch({
      action: 'add',
      rule: { id: 'watch-src', match: { kind: 'file.changed', subject: '/tmp/watched/**' }, level: 'context' },
    });
    await vi.waitFor(() => expect(fileCb).toBeDefined(), { timeout: 2_000, interval: 5 });

    currentWall = now + 700;
    helperOut?.write(
      `${JSON.stringify({ v: 1, type: 'app.activated', at: now + 100, name: 'CodeApp', bundleId: 'com.example.Code', pid: 10 })}\n`,
    );
    helperOut?.write(
      `${JSON.stringify({ v: 1, type: 'window.focused', at: now + 200, title: 'README.md', bundleId: 'com.example.Code', pid: 10, window: 1 })}\n`,
    );
    helperOut?.write(
      `${JSON.stringify({ v: 1, type: 'window.title', at: now + 300, title: 'index.ts', bundleId: 'com.example.Code', pid: 10, window: 1 })}\n`,
    );
    helperOut?.write(
      `${JSON.stringify({ v: 1, type: 'error', at: now + 400, code: 'output_overflow', dropped: 7 })}\n`,
    );
    fileCb?.({ path: '/tmp/watched/main.ts', change: 'modify', at: now + 500 });
    await jobCb?.({ type: 'started', id: 'j-1', command: '"/Applications/MyTool.app" --flag', at: now + 600 });
    await jobCb?.({ type: 'exited', id: 'j-1', command: '/usr/bin/python3.12 -m app', exitCode: 1, at: now + 700 });

    await vi.waitFor(
      () =>
        expect(rt.events().map((e) => e.kind)).toEqual(
          expect.arrayContaining([
            'source.status',
            'app.activated',
            'window.focused',
            'window.title-changed',
            'source.error',
            'file.changed',
            'job.started',
            'job.exited',
          ]),
        ),
      { timeout: 2_000, interval: 5 },
    );

    currentWall = now + 1_000;
    const envHistory = createSenseTools(rt, () => currentWall).find((t) => t.name === 'env_history');
    if (!envHistory) throw new Error('missing env_history tool');
    const out = (await envHistory.execute({ limit: 200 }, makeExec())) as {
      events: Array<{
        id: string;
        kind: string;
        subject: string;
        reason?: string;
        source: { id: string; api: string };
      }>;
    };

    expect(out.events.length).toBeGreaterThanOrEqual(7);
    for (const ev of out.events) {
      expect(KNOWN_EVENT_KINDS.has(ev.kind), `unexpected kind: ${ev.kind}`).toBe(true);
      expect(ev.id).not.toBe('[host]');
      expect(ev.id).not.toBe('<host>');
    }
    expect(out.events.map((e) => e.kind)).toEqual(
      expect.arrayContaining([
        'source.status',
        'app.activated',
        'window.focused',
        'window.title-changed',
        'source.error',
        'file.changed',
        'job.started',
        'job.exited',
      ]),
    );
    expect(out.events.find((e) => e.kind === 'job.started')?.subject).toBe('MyTool.app');
    expect(out.events.find((e) => e.kind === 'job.exited')?.subject).toBe('python3.12');
    expect(out.events.find((e) => e.kind === 'source.error')?.reason).toBe('output_overflow (dropped=7)');

    await rt.stop();

    // Direct projection: system fields use strict identifier validation without modelText/modelTitle,
    // while invalid/secret system fields and untrusted command basenames are redacted.
    const uuidId = '550e8400-e29b-41d4-a716-446655440000:12';
    const hash64 = 'a'.repeat(64);
    const strictCheck = modelHistory({
      available: true,
      from: 1_000,
      to: 2_000,
      limit: 50,
      total: 6,
      truncated: false,
      titlesAllowed: true,
      events: [
        {
          id: uuidId,
          kind: 'delivery-unknown',
          subject: 'delivery',
          level: 'context',
          reason: 'pending-evicted:1',
          cause: 'agent',
          ruleId: 'r-delivery',
          at: 1_500,
          source: { id: 'helper.thermal', api: 'history', host: 'local' },
        },
        {
          id: `body.rate:${hash64}`,
          kind: 'body.rate',
          subject: 'rate:disk-drop:disk:/',
          level: 'wake',
          reason: 'wake-budget',
          cause: 'unknown',
          ruleId: 'disk-drop',
          at: 1_400,
          source: { id: 'body', api: 'probe', host: 'local' },
        },
        {
          id: 'body:disk:/:1300:warn',
          kind: 'body.threshold',
          subject: 'disk:/',
          level: 'context',
          at: 1_300,
          source: { id: 'body', api: 'probe', host: 'local' },
        },
        {
          id: 'evil.host.internal:5432',
          kind: 'secret host/kind' as never,
          subject: 'evil.com',
          level: 'invalid-level' as never,
          reason: 'secret.corp.internal',
          cause: 'invalid-cause' as never,
          ruleId: 'secret.corp.internal',
          at: 1_200,
          source: { id: 'secret.corp.internal', api: 'user@host', host: 'local' },
        },
        {
          id: 'cmd-app-bad',
          kind: 'job.exited',
          subject: 'host.1',
          level: 'record',
          at: 1_100,
          source: { id: 'dsh', api: 'events', host: 'local' },
        },
        {
          id: 'cmd-app-dot-bad',
          kind: 'job.exited',
          subject: 'evil.com.app',
          level: 'record',
          at: 1_050,
          source: { id: 'dsh', api: 'events', host: 'local' },
        },
      ],
    }) as { events: Array<Record<string, unknown>> };

    expect(strictCheck.events[0]).toMatchObject({
      id: uuidId,
      kind: 'delivery-unknown',
      level: 'context',
      reason: 'pending-evicted:1',
      cause: 'agent',
      ruleId: 'r-delivery',
      source: { id: 'helper.thermal', api: 'history' },
    });
    expect(strictCheck.events[1]).toMatchObject({
      id: `body.rate:${hash64}`,
      kind: 'body.rate',
      subject: 'rate:disk-drop:disk:[path]',
      reason: 'wake-budget',
      ruleId: 'disk-drop',
    });
    expect(strictCheck.events[2]).toMatchObject({
      id: 'body:disk:[path]:1300:warn',
      subject: 'disk:[path]',
    });
    expect(strictCheck.events[3]).toMatchObject({
      id: '[redacted]',
      kind: '[redacted]',
      level: '[redacted]',
      reason: '[redacted]',
      cause: '[redacted]',
      ruleId: '[redacted]',
      source: { id: '[redacted]', api: '[redacted]' },
    });
    expect(strictCheck.events[4]).toMatchObject({
      subject: '[command]',
    });
    expect(strictCheck.events[5]).toMatchObject({
      subject: '[command]',
    });
    expect(JSON.stringify(strictCheck)).not.toContain('secret.corp.internal');
    expect(JSON.stringify(strictCheck)).not.toContain('evil.host.internal');
    expect(JSON.stringify(strictCheck)).not.toContain('evil.com');
  });
});
