import os from 'node:os';
import type { Body, Signal } from '@asi/sense-types';
import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES } from '../../src/host/attention/rules.ts';
import { formatEnvUpdate } from '../../src/host/delivery/format.ts';
import { modelUpdate } from '../../src/host/dsh/deliver.ts';
import { RuntimeAttention } from '../../src/host/runtime/attention.ts';
import { AWAY_GROWTH_RATIO, AwayReporter } from '../../src/host/runtime/away.ts';
import { FactExpiry } from '../../src/host/runtime/expiry.ts';
import { MetricTimeline } from '../../src/host/runtime/metrics.ts';
import type { DshPort } from '../../src/host/runtime/ports.ts';
import { f, freshSample, mkBody } from '../body/helpers.ts';
import { sig } from '../helpers.ts';

const BASE = Date.UTC(2026, 10, 18, 9, 0, 0);
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function cpuBody(usage: number): Body {
  return mkBody({ cpu: f({ usage, perCore: [usage], load1: 1, load5: 1, load15: 1 }) });
}

function sample(body: Body, at: number): Body {
  return freshSample(body, at).body;
}

function diskBody(free: number, total = 1000): Body {
  return mkBody({
    disks: {
      ...f([{ mount: '/', total, free }]),
      kind: 'disks',
    },
  });
}

interface Harness {
  attention: RuntimeAttention;
  metrics: MetricTimeline;
  summaries: Signal[];
  delivered: Parameters<DshPort['deliver']>[1][];
  history: Array<{ kind: string; level: string }>;
  send: (kind: string, at: number, data?: Record<string, unknown>, subject?: string) => Promise<void>;
  record: (body: Body, at: number) => void;
  settle: () => Promise<void>;
  flush: () => Promise<void>;
  advance: (ms: number) => void;
}

async function harness(startWall = BASE): Promise<Harness> {
  let wall = startWall;
  let mono = 1_000;
  const clock = { wall: () => wall, mono: () => mono };
  const summaries: Signal[] = [];
  const delivered: Parameters<DshPort['deliver']>[1][] = [];
  const history: Array<{ kind: string; level: string }> = [];
  const dsh: DshPort = {
    onAgentEvent: () => () => {},
    onTool: () => () => {},
    onJob: () => () => {},
    deliver: async (_session, intent) => {
      delivered.push(intent);
    },
    tokenSnapshot: async () => undefined,
  };
  const metrics = new MetricTimeline(clock, 'UTC');
  let attention: RuntimeAttention;
  const away = new AwayReporter(metrics, clock, (signal) => {
    summaries.push(signal);
    // Production wiring defers this to a microtask because the observer runs
    // inside the state store's synchronous apply callback.
    queueMicrotask(() => {
      void attention.accept(signal);
    });
  });
  attention = new RuntimeAttention(
    clock,
    dsh,
    () => [...DEFAULT_RULES],
    () => {},
    () => true,
    () => {},
    new FactExpiry(clock),
    undefined,
    undefined,
    {
      recordEvent: (entry) => history.push({ kind: entry.kind, level: entry.level }),
      patchEvent: () => {},
    },
    'linux',
    (signal) => away.observe(signal),
  );
  attention.create('s1');
  await attention.preStep('s1', false, false);
  attention.postStep('s1');
  let counter = 0;
  return {
    attention,
    metrics,
    summaries,
    delivered,
    history,
    send: async (kind, at, data = {}, subject) => {
      mono = Math.max(mono, 1_000 + (at - startWall));
      wall = at;
      const subjectFor = subject ?? (kind.startsWith('screen.') ? 'screen' : (kind.split('.')[0] ?? 'system'));
      await attention.accept(
        sig({ id: `${kind}:${at}:${counter++}`, kind, at, subject: subjectFor, data: { at, ...data } }),
      );
    },
    record: (body, at) => metrics.record(sample(body, at), at),
    settle: () => new Promise((resolve) => setTimeout(resolve, 0)),
    flush: async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      mono += 2_001;
      wall += 2_001;
      await attention.pipeline.flush();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    advance: (ms) => {
      wall += ms;
      mono += ms;
    },
  };
}

function awaySummary(h: Harness): Record<string, unknown> | undefined {
  return h.summaries.at(-1)?.data as Record<string, unknown> | undefined;
}

async function lockAway(h: Harness, from: number, to: number): Promise<void> {
  await h.send('screen.locked', from);
  await h.send('screen.unlocked', to);
}

describe('away detection', () => {
  it('takes the earliest of lock/sleep/inactive as the start and reports once on the last return', async () => {
    const h = await harness();
    h.record(cpuBody(0.1), BASE);
    await h.send('screen.locked', BASE);
    await h.send('system.sleep', BASE + 5 * MINUTE);
    await h.send('session.inactive', BASE + 10 * MINUTE);
    h.record(cpuBody(0.5), BASE + 71 * MINUTE);
    await h.send('screen.unlocked', BASE + 70 * MINUTE);
    await h.send('system.wake', BASE + 71 * MINUTE);
    await h.send('session.active', BASE + 72 * MINUTE);
    await h.settle();

    expect(h.summaries).toHaveLength(1);
    const data = awaySummary(h);
    expect(data).toMatchObject({
      awayFrom: BASE,
      returnAt: BASE + 72 * MINUTE,
      durationMs: 72 * MINUTE,
      sleepMs: 66 * MINUTE,
      lockMs: 70 * MINUTE,
      inactiveMs: 62 * MINUTE,
      hasAnomaly: true,
    });
    expect(data?.anomalies).toEqual(['metric-growth']);
    const trends = Array.isArray(data?.metrics) ? (data.metrics as Array<Record<string, unknown>>) : [];
    const growth = trends.find((metric) => metric.metric === 'cpu');
    expect(growth).toMatchObject({ start: 0.1, end: 0.5, min: 0.1, max: 0.5, unit: 'ratio' });

    await h.flush();
    const awayChanges = h.delivered.flatMap((intent) =>
      intent.update.changes.filter((change) => change.signal.kind === 'away.summary'),
    );
    expect(awayChanges).toHaveLength(1);
    expect(awayChanges[0]?.level).toBe('wake');
  });

  it('does not report away periods shorter than one hour', async () => {
    const h = await harness();
    await lockAway(h, BASE, BASE + HOUR - 1);
    await h.settle();
    expect(h.summaries).toHaveLength(0);
    expect(h.attention.events().filter((event) => event.kind === 'away.summary')).toHaveLength(0);
    expect(h.history.filter((event) => event.kind === 'away.summary')).toHaveLength(0);
  });

  it('reports an away period of exactly one hour', async () => {
    const h = await harness();
    await lockAway(h, BASE, BASE + HOUR);
    await h.settle();
    expect(h.summaries).toHaveLength(1);
    expect(awaySummary(h)?.durationMs).toBe(HOUR);
  });

  it('reports each away episode at most once', async () => {
    const h = await harness();
    await lockAway(h, BASE, BASE + 2 * HOUR);
    await h.send('screen.unlocked', BASE + 2 * HOUR + 60_000, { durationMs: 2 * HOUR });
    await h.settle();
    expect(h.summaries).toHaveLength(1);
    expect(h.attention.events().filter((event) => event.kind === 'away.summary')).toHaveLength(1);

    h.advance(3 * HOUR);
    await lockAway(h, BASE + 5 * HOUR, BASE + 7 * HOUR);
    await h.settle();
    expect(h.summaries).toHaveLength(2);
  });

  it('records a quiet away period in history without pushing it', async () => {
    const h = await harness();
    h.record(cpuBody(0.3), BASE);
    h.record(cpuBody(0.3), BASE + 90 * MINUTE);
    await lockAway(h, BASE, BASE + 90 * MINUTE);
    await h.settle();
    await h.flush();

    const data = awaySummary(h);
    expect(data).toMatchObject({ hasAnomaly: false, anomalies: [] });
    const entries = h.attention.events().filter((event) => event.kind === 'away.summary');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.level).toBe('record');
    expect(h.history.filter((entry) => entry.kind === 'away.summary')).toEqual([
      { kind: 'away.summary', level: 'record' },
    ]);
    expect(
      h.delivered.flatMap((intent) => intent.update.changes.filter((change) => change.signal.kind === 'away.summary')),
    ).toHaveLength(0);
  });

  it('triggers on each anomaly category', async () => {
    const cases: Array<{
      name: string;
      expected: string;
      run: (h: Harness) => Promise<void>;
    }> = [
      {
        name: 'warn/critical alert',
        expected: 'alerts',
        run: async (h) => {
          await h.send('body.threshold', BASE + 10 * MINUTE, { severity: 'warn', value: 0.9 }, 'memory');
        },
      },
      {
        name: 'metric crosses a warn threshold',
        expected: 'metric-warning',
        run: async (h) => {
          h.record(diskBody(500), BASE);
          h.record(diskBody(50), BASE + 50 * MINUTE);
        },
      },
      {
        name: 'metric grows by at least 20%',
        expected: 'metric-growth',
        run: async (h) => {
          h.record(cpuBody(0.1), BASE);
          h.record(cpuBody(0.1 * (1 + AWAY_GROWTH_RATIO)), BASE + 50 * MINUTE);
        },
      },
      {
        name: 'failed job',
        expected: 'failed-jobs',
        run: async (h) => {
          await h.send('job.exited', BASE + 10 * MINUTE, { exitCode: 1, id: 'synthetic-job' }, 'synthetic-job');
        },
      },
      {
        name: 'external bulk deletion',
        expected: 'external-deletion',
        run: async (h) => {
          await h.send(
            'file.burst',
            BASE + 10 * MINUTE,
            {
              directory: '/Users/alice/build',
              deleted: 120,
              externalDeleted: 120,
              externalDeletionExceeded: true,
            },
            '/Users/alice/build',
          );
        },
      },
    ];
    for (const testCase of cases) {
      const h = await harness();
      await h.send('screen.locked', BASE);
      await testCase.run(h);
      await h.send('screen.unlocked', BASE + 90 * MINUTE);
      await h.settle();
      const data = awaySummary(h);
      expect(data?.hasAnomaly, testCase.name).toBe(true);
      expect(data?.anomalies, testCase.name).toContain(testCase.expected);
      await h.flush();
      // A competing wake in the same window (a failed job) may spend the wake
      // budget, downgrading the summary to context; it is still delivered.
      await h.attention.preStep('s1');
      const awayChanges = h.delivered.flatMap((intent) =>
        intent.update.changes.filter((change) => change.signal.kind === 'away.summary'),
      );
      expect(awayChanges, testCase.name).toHaveLength(1);
      expect(awayChanges[0]?.level, testCase.name).toMatch(/^(wake|context)$/);
    }
  });

  it('stays below 2KB and leaks no path, task name or host after explicit projection', async () => {
    const h = await harness();
    h.record(
      sample(
        mkBody({
          cpu: f({ usage: 0.1, perCore: [0.1], load1: 1, load5: 2, load15: 3 }),
          memory: f({ total: 100, used: 10, pressure: 'normal', swapUsed: 0 }),
          battery: f({ percent: 90, charging: false }),
          disks: { ...f([{ mount: '/', total: 1000, free: 900 }]), kind: 'disks' },
        }),
        BASE,
      ),
      BASE,
    );
    await h.send('screen.locked', BASE);
    h.record(
      sample(
        mkBody({
          cpu: f({ usage: 0.9, perCore: [0.9], load1: 8, load5: 9, load15: 10 }),
          memory: f({ total: 100, used: 90, pressure: 'critical', swapUsed: 40 }),
          battery: f({ percent: 4, charging: false }),
          disks: { ...f([{ mount: '/', total: 1000, free: 20 }]), kind: 'disks' },
        }),
        BASE + 80 * MINUTE,
      ),
      BASE + 80 * MINUTE,
    );
    for (const metric of ['memory', 'thermal', 'context', 'battery', 'network.rx']) {
      await h.send('body.threshold', BASE + 10 * MINUTE, { severity: 'critical', value: 1 }, metric);
    }
    for (let i = 0; i < 8; i++) {
      await h.send(
        'job.exited',
        BASE + 20 * MINUTE + i,
        { exitCode: 1, id: `/Users/alice/private/task-${i}` },
        `/Users/alice/private/task-${i}`,
      );
    }
    for (let i = 0; i < 6; i++) {
      await h.send(
        'file.burst',
        BASE + 30 * MINUTE + i,
        {
          directory: `/Users/alice/secret-${i}`,
          deleted: 100 + i,
          externalDeleted: 100 + i,
          externalDeletionExceeded: true,
        },
        `/Users/alice/secret-${i}`,
      );
    }
    await h.send('screen.unlocked', BASE + 90 * MINUTE);
    await h.settle();
    const summary = h.summaries[0];
    expect(summary).toBeDefined();
    const update = modelUpdate({
      since: (summary as Signal).at - 1,
      at: (summary as Signal).at,
      changes: [{ signal: summary as Signal, count: 1, level: 'wake' }],
      suppressed: 0,
    });
    const text = formatEnvUpdate(update);
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(2048);
    expect(Buffer.byteLength(JSON.stringify(update), 'utf8')).toBeLessThanOrEqual(2048);
    expect(text).not.toContain('alice');
    expect(text).not.toContain('/Users');
    expect(text).not.toContain('private');
    expect(text).not.toContain(os.hostname());
    expect(JSON.stringify(update)).not.toContain('/Users/alice');
    const projected = update.changes[0]?.signal.data as Record<string, unknown>;
    expect(projected.hasAnomaly).toBe(true);
    expect((projected.bursts as Array<Record<string, unknown>>)[0]?.directory).toBe('secret-0');
  });

  it('triggers hasAnomaly and pushes when only a body.threshold warn occurs', async () => {
    const h = await harness();
    await h.send('screen.locked', BASE);
    await h.send('body.threshold', BASE + 10 * MINUTE, { severity: 'warn', value: 0.9 }, 'memory');
    await h.send('screen.unlocked', BASE + 70 * MINUTE);
    await h.settle();
    expect(awaySummary(h)).toMatchObject({
      hasAnomaly: true,
      anomalies: ['alerts'],
      alerts: [{ metric: 'memory', severity: 'warn', count: 1 }],
      alertCount: 1,
    });
    await h.flush();
    const pushed = h.delivered.flatMap((i) => i.update.changes.filter((c) => c.signal.kind === 'away.summary'));
    expect(pushed).toHaveLength(1);
  });

  it('triggers hasAnomaly and pushes when only a body.rate warn occurs', async () => {
    const h = await harness();
    await h.send('screen.locked', BASE);
    await h.send(
      'body.rate',
      BASE + 10 * MINUTE,
      { metric: 'rss', ruleId: 'rss-surge', severity: 'warn', slope: 1000 },
      'rate:rss-surge',
    );
    await h.send('screen.unlocked', BASE + 70 * MINUTE);
    await h.settle();
    expect(awaySummary(h)).toMatchObject({
      hasAnomaly: true,
      anomalies: ['alerts'],
      alerts: [{ metric: 'rss', severity: 'warn', count: 1 }],
      alertCount: 1,
    });
    await h.flush();
    await h.attention.preStep('s1');
    const pushed = h.delivered.flatMap((i) => i.update.changes.filter((c) => c.signal.kind === 'away.summary'));
    expect(pushed).toHaveLength(1);
  });

  it('triggers hasAnomaly and pushes when only a body.anomaly warn occurs', async () => {
    const h = await harness();
    await h.send('screen.locked', BASE);
    await h.send(
      'body.anomaly',
      BASE + 10 * MINUTE,
      { metric: 'network.rx', ruleId: 'network-rx', severity: 'warn', deviation: 4.2 },
      'baseline:network-rx',
    );
    await h.send('screen.unlocked', BASE + 70 * MINUTE);
    await h.settle();
    expect(awaySummary(h)).toMatchObject({
      hasAnomaly: true,
      anomalies: ['alerts'],
      alerts: [{ metric: 'network.rx', severity: 'warn', count: 1 }],
      alertCount: 1,
    });
    await h.flush();
    await h.attention.preStep('s1');
    const pushed = h.delivered.flatMap((i) => i.update.changes.filter((c) => c.signal.kind === 'away.summary'));
    expect(pushed).toHaveLength(1);
  });

  it('triggers hasAnomaly and pushes when only a future body.* warn occurs', async () => {
    const h = await harness();
    await h.send('screen.locked', BASE);
    await h.send(
      'body.thermal-future',
      BASE + 10 * MINUTE,
      { metric: 'thermal', severity: 'warn', value: 'serious' },
      'thermal',
    );
    await h.send('screen.unlocked', BASE + 70 * MINUTE);
    await h.settle();
    expect(awaySummary(h)).toMatchObject({
      hasAnomaly: true,
      anomalies: ['alerts'],
      alerts: [{ metric: 'thermal', severity: 'warn', count: 1 }],
      alertCount: 1,
    });
    await h.flush();
    const pushed = h.delivered.flatMap((i) => i.update.changes.filter((c) => c.signal.kind === 'away.summary'));
    expect(pushed).toHaveLength(1);
  });

  it('ignores rebaseline-suggestion and normal severity body.* signals in away.summary', async () => {
    const h = await harness();
    await h.send('screen.locked', BASE);
    await h.send(
      'body.anomaly',
      BASE + 10 * MINUTE,
      { metric: 'cpu', severity: 'warn', type: 'rebaseline-suggestion', suggestionId: 's1' },
      'rebaseline:cpu',
    );
    await h.send(
      'body.rate',
      BASE + 20 * MINUTE,
      { metric: 'rss', ruleId: 'rss-surge', severity: 'normal', slope: 0 },
      'rate:rss-surge',
    );
    await h.send('screen.unlocked', BASE + 70 * MINUTE);
    await h.settle();
    await h.flush();
    expect(awaySummary(h)).toMatchObject({ hasAnomaly: false, anomalies: [], alerts: [], alertCount: 0 });
    expect(h.delivered.flatMap((i) => i.update.changes.filter((c) => c.signal.kind === 'away.summary'))).toHaveLength(
      0,
    );
  });

  it.each([
    ['exact 5m boundary', 0],
    ['middle of bucket', 2 * MINUTE + 30_000],
    ['end of bucket', 4 * MINUTE + 59_999],
  ])(
    'does not pull in the previous bucket or report growth when away starts at %s and metrics stay flat',
    async (_label, offset) => {
      const h = await harness();
      h.record(cpuBody(0.1), BASE - 2 * MINUTE);
      h.record(cpuBody(0.5), BASE + offset);
      h.record(cpuBody(0.5), BASE + offset + 30 * MINUTE);
      h.record(cpuBody(0.5), BASE + offset + 65 * MINUTE);
      await lockAway(h, BASE + offset, BASE + offset + 70 * MINUTE);
      await h.settle();
      await h.flush();
      const data = awaySummary(h);
      expect(data).toMatchObject({ hasAnomaly: false, anomalies: [] });
      const cpuTrend = (data?.metrics as Array<Record<string, unknown>> | undefined)?.find((m) => m.metric === 'cpu');
      expect(cpuTrend).toMatchObject({ start: 0.5, end: 0.5, min: 0.5, max: 0.5 });
      expect(h.delivered.flatMap((i) => i.update.changes.filter((c) => c.signal.kind === 'away.summary'))).toHaveLength(
        0,
      );
    },
  );

  it('retains uncapped totals, anomalyCount and omitted while prioritizing critical > warn > failed > burst > metrics within 2KB', async () => {
    const h = await harness();
    h.record(
      sample(
        mkBody({
          cpu: f({ usage: 0.2, perCore: [0.2], load1: 1, load5: 1, load15: 1 }),
          disks: { ...f([{ mount: '/', total: 1000, free: 500 }]), kind: 'disks' },
        }),
        BASE,
      ),
      BASE,
    );
    await h.send('screen.locked', BASE);
    h.record(
      sample(
        mkBody({
          cpu: f({ usage: 0.2, perCore: [0.2], load1: 1, load5: 1, load15: 1 }),
          disks: { ...f([{ mount: '/', total: 1000, free: 40 }]), kind: 'disks' },
        }),
        BASE + 60 * MINUTE,
      ),
      BASE + 60 * MINUTE,
    );
    await h.send('body.threshold', BASE + 5 * MINUTE, { severity: 'warn', value: 0.85 }, 'memory');
    await h.send('body.threshold', BASE + 6 * MINUTE, { severity: 'critical', value: 'critical' }, 'thermal');
    for (let i = 0; i < 300; i++) {
      const name = `job-${i}-${'alpha beta gamma delta '.repeat(12)}`;
      await h.send('job.exited', BASE + 10 * MINUTE + i, { id: name, exitCode: 1 }, name);
    }
    for (let i = 0; i < 10; i++) {
      const dir = `/Users/alice/${'dir word '.repeat(35)}bucket-${i}`;
      await h.send(
        'file.burst',
        BASE + 20 * MINUTE + i,
        { directory: dir, deleted: 100, externalDeleted: 100, externalDeletionExceeded: true },
        dir,
      );
    }
    await h.send('screen.unlocked', BASE + 70 * MINUTE);
    await h.settle();

    const summary = h.summaries[0] as Signal;
    expect(summary.data).toMatchObject({
      alertCount: 2,
      failedCount: 300,
      deletedCount: 1000,
      anomalyCount: 313,
      omitted: 280,
    });
    const update = modelUpdate({
      since: summary.at - 1,
      at: summary.at,
      changes: [{ signal: summary, count: 1, level: 'wake' }],
      suppressed: 0,
    });
    expect(Buffer.byteLength(JSON.stringify(update), 'utf8')).toBeLessThanOrEqual(2048);
    const projected = update.changes[0]?.signal.data as Record<string, unknown>;
    expect(projected.alertCount).toBe(2);
    expect(projected.failedCount).toBe(300);
    expect(projected.deletedCount).toBe(1000);
    expect(projected.anomalyCount).toBe(313);
    expect(projected.omitted).toBeGreaterThan(280);
    const projectedAlerts = projected.alerts as Array<{ metric: string; severity: string }>;
    expect(projectedAlerts.map((a) => `${a.severity}:${a.metric}`)).toEqual(['critical:thermal', 'warn:memory']);

    const text = formatEnvUpdate(update);
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(2048);
    expect(text).toContain('alerts=2');
    expect(text).toContain('failed=300');
    expect(text).toContain('deletes=1000');
    expect(text).toContain(`另有 ${String(projected.omitted)} 项`);
  });

  it('uses monotonic clock for away duration and signal collection when wall clock rolls back 1 hour', () => {
    const T = Date.UTC(2026, 10, 18, 12, 0, 0);
    let wall = T;
    let mono = 10_000;
    const clock = { wall: () => wall, mono: () => mono };
    const emitted: Signal[] = [];
    const away = new AwayReporter(new MetricTimeline(clock, 'UTC'), clock, (s) => emitted.push(s));

    away.observe(sig({ id: 'l1', kind: 'screen.locked', at: wall, subject: 'screen', data: { at: wall } }));
    // Wall clock jumps back 1 hour, while monotonic clock advances 30 minutes.
    wall = T - HOUR + 30 * MINUTE;
    mono += 30 * MINUTE;
    away.observe(
      sig({ id: 'j1', kind: 'job.failed', at: wall, subject: 'build-task', data: { id: 'build-task', exitCode: 1 } }),
    );
    // Another 35 minutes pass on mono (total 65 minutes away); wall is still <= T + 5m.
    wall += 35 * MINUTE;
    mono += 35 * MINUTE;
    away.observe(sig({ id: 'u1', kind: 'screen.unlocked', at: wall, subject: 'screen', data: { at: wall } }));

    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.data).toMatchObject({
      awayFrom: T,
      returnAt: wall,
      durationMs: 65 * MINUTE,
      lockMs: 65 * MINUTE,
      hasAnomaly: true,
      anomalies: ['failed-jobs'],
      failedCount: 1,
    });
  });

  it('does not report away when wall jumps forward >=1h while monotonic clock elapsed <1h', () => {
    const T = Date.UTC(2026, 10, 18, 12, 0, 0);
    let wall = T;
    let mono = 10_000;
    const clock = { wall: () => wall, mono: () => mono };
    const emitted: Signal[] = [];
    const away = new AwayReporter(new MetricTimeline(clock, 'UTC'), clock, (s) => emitted.push(s));

    away.observe(sig({ id: 'l1', kind: 'screen.locked', at: wall, subject: 'screen', data: { at: wall } }));
    wall += 2 * HOUR;
    mono += 30 * MINUTE;
    away.observe(sig({ id: 'u1', kind: 'screen.unlocked', at: wall, subject: 'screen', data: { at: wall } }));

    expect(emitted).toHaveLength(0);
  });
});
