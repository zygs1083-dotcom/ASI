import { expect, it, vi } from 'vitest';
import { RateEvaluator } from '../../src/host/body/rate.ts';
import { projectEvents } from '../../src/host/presenter/project.ts';
import { RuntimeAttention } from '../../src/host/runtime/attention.ts';
import { FactExpiry } from '../../src/host/runtime/expiry.ts';
import { ctxBody, freshSample as sample } from '../body/helpers.ts';

it.each([-3_600_000, 3_600_000])(
  'anchors rate events to evaluation even when the wall clock jumps %i ms before acceptance',
  async (jump) => {
    const start = 1_700_000_000_000;
    const evaluator = new RateEvaluator([
      { id: 'context-eta', metric: 'context', windowMs: 300_000, direction: 'down', maxEtaMs: 600_000, floor: 0 },
    ]);
    const previous = {
      ...sample(ctxBody(10_000, 9_385), start, undefined, 0),
      rateTimes: { context: { mono: 0, wall: start } },
    };
    const next = {
      ...sample(ctxBody(10_000, 9_395), start + 10_000, undefined, 10_000),
      rateTimes: { context: { mono: 10_000, wall: start + 10_000 } },
      evaluatedAt: { mono: 20_000, wall: start + 20_000 },
    };
    const signal = evaluator.evaluate(previous, next, {}).signals[0];
    expect(signal?.data.timeToFloorMs).toBe(595_000);
    if (!signal) throw new Error('missing rate signal');
    const clock = { wall: () => start + 20_500 + jump, mono: () => 20_500 };
    const attention = new RuntimeAttention(
      clock,
      {
        deliver: async () => {},
        onAgentEvent: () => () => {},
        onTool: () => () => {},
        onJob: () => () => {},
        tokenSnapshot: async () => undefined,
      },
      () => [],
      () => {},
      () => true,
      vi.fn(),
      new FactExpiry(clock),
    );
    await attention.accept(signal);
    const [entry] = attention.events();
    expect(entry.mono).toBe(20_000);
    const [event] = projectEvents(
      [entry],
      true,
      (mono) => start + mono,
      (wall) => wall,
    );
    expect(event.signal).toMatchObject({ at: start + 20_000, data: { evidenceAt: start + 10_000 } });
    expect(event.detail).toMatchObject({ timeToFloorMs: 595_000 });

    const { evaluationMono: _evaluationMono, ...legacyData } = signal.data;
    await attention.accept({ ...signal, id: 'legacy', data: legacyData });
    const legacy = attention.events().find((item) => item.id === 'legacy');
    const legacyMono = 20_500 - Math.max(0, clock.wall() - signal.at);
    expect(legacy?.mono).toBe(legacyMono);
    if (!legacy) throw new Error('missing legacy event');
    const [oldEvent, oldEntry] = projectEvents(
      [legacy, { ...legacy, mono: undefined }],
      true,
      (mono) => start + mono,
      (wall) => wall + 123,
    );
    expect(oldEvent.signal.at).toBe(start + legacyMono);
    expect(oldEntry.signal.at).toBe(legacy.at + 123);
    await attention.stop();
  },
);

it.each([
  ['context', 'tokens'],
  ['rss', 'processRss'],
  ['network.rx', 'networkRx'],
  ['network.tx', 'networkTx'],
  ['disk:/', 'disk:/'],
  ['unknown', 'unknown'],
])('projects natural event metric %s as UI key %s', (metric, key) => {
  const [rate, anomaly] = projectEvents(
    [
      {
        id: 'event',
        kind: 'body.rate',
        subject: 'rate',
        level: 'record',
        at: 100,
        source: { id: 'test', api: 'test', host: 'local' },
        detail: { metric, windowMs: 10_000, delta: 1 },
      },
      {
        id: 'anomaly',
        kind: 'body.anomaly',
        subject: 'baseline',
        level: 'record',
        at: 100,
        source: { id: 'test', api: 'test', host: 'local' },
        detail: { metric, value: 10, baseline: 5, deviation: 5 },
      },
    ],
    true,
    (mono) => mono,
    (wall) => wall,
  );
  expect(rate.detail).toMatchObject({ kind: 'body.rate', metric: key });
  expect(anomaly.detail).toMatchObject({ kind: 'body.anomaly', metric: key });
});

it('redacts old and new window events when title sharing is disabled', async () => {
  let titles = true;
  const attention = new RuntimeAttention(
    { wall: () => 100, mono: () => 0 },
    {
      deliver: async () => {},
      onAgentEvent: () => () => {},
      onTool: () => () => {},
      onJob: () => () => {},
      tokenSnapshot: async () => undefined,
    },
    () => [],
    () => {},
    () => titles,
    vi.fn(),
    new FactExpiry({ mono: () => 0 }),
  );
  await attention.accept({
    id: 'a',
    kind: 'window.focused',
    subject: 'synthetic-title',
    at: 100,
    source: { id: 'test', api: 'test', host: 'local' },
    data: { title: 'synthetic-title', another: 'synthetic-title' },
  });
  expect(attention.events()[0]?.subject).toBe('synthetic-title');
  titles = false;
  expect(JSON.stringify(attention.events())).not.toContain('synthetic-title');
});
