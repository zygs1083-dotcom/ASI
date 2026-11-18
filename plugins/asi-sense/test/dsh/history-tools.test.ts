import { EventEmitter } from 'node:events';
import { hostname } from 'node:os';
import { PassThrough } from 'node:stream';
import { ToolArgsError, type ToolRunContext } from '@deepseek-ai/dsh-tools';
import { describe, expect, it, vi } from 'vitest';
import { createSenseTools } from '../../src/host/dsh/tools.ts';
import { createSenseRuntime, type DailySummary, type HistoryStoragePort } from '../../src/host/runtime/index.ts';

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
    expect(fileEv.subject).toBe('secrets.env');
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
    for (let i = 0; i < 120; i++) {
      bigLines.push(
        JSON.stringify({
          record: 'event',
          id: `big-${i}`,
          kind: 'source.status',
          subject: 'history',
          reason: `synthetic-reason-${i}-${'x'.repeat(300)}`,
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
    expect(isoLimited.total).toBe(123);
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
});
