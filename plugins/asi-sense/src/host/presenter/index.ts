import type { MetricKey } from '@asi/sense-ui/model';
import type { Clock } from '../runtime/index.ts';
import { createHistory } from './history.ts';
import { projectInsights } from './insights.ts';
import {
  type PresenterModel,
  projectEvents,
  projectRules,
  projectState,
  projectTuning,
  type Runtime,
} from './project.ts';
import { createTimeline } from './time.ts';
import { createTimelineProjector } from './timeline.ts';

type Waiter = (value: IteratorResult<PresenterModel>) => void;
interface Subscriber {
  initial: boolean;
  closed: boolean;
  queued?: PresenterModel;
  waiting: Waiter[];
}

function share<T>(previous: T | undefined, next: T): T {
  if (Object.is(previous, next)) return next;
  if (!previous || !next || typeof previous !== 'object' || typeof next !== 'object') return next;
  if (Array.isArray(previous) !== Array.isArray(next)) return next;
  const old = previous as Record<string, unknown>;
  const value = next as Record<string, unknown>;
  const keys = Object.keys(value);
  let changed = keys.length !== Object.keys(old).length;
  const entries = keys.map((key) => {
    const item = share(old[key], value[key]);
    if (!Object.hasOwn(old, key) || !Object.is(item, old[key])) changed = true;
    return [key, item] as const;
  });
  if (!changed) return previous;
  return (Array.isArray(next) ? entries.map(([, item]) => item) : Object.fromEntries(entries)) as T;
}

export function createPresenter(
  runtime: Runtime,
  options: {
    clock: Clock;
    sampleIntervalsMs?: Partial<Record<MetricKey, number>>;
  },
) {
  const { clock } = options;
  const intervals = Object.fromEntries(
    Object.entries(options.sampleIntervalsMs ?? {}).map(([key, value]) => [
      key,
      value !== undefined && Number.isFinite(value) && value > 0 ? Math.max(1_000, value) : value,
    ]),
  ) as Partial<Record<MetricKey, number>>;
  const history = createHistory(intervals);
  const timeline = createTimeline(runtime, clock);
  const projectPanelTimeline = createTimelineProjector();
  const subscribers = new Set<Subscriber>();
  let cached: PresenterModel | undefined;
  let published: PresenterModel | undefined;
  let lastEmission = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let dirty = false;

  function snapshot(): PresenterModel {
    if (closed && cached) return cached;
    const now = timeline.at(clock.mono());
    const state = projectState(timeline.state());
    history.record(state.self.body, now, clock.mono());
    const samples = history.snapshot(clock.mono());
    const entries = runtime.events();
    const settings = runtime.rules.settings();
    const { insights, learning } = projectInsights(runtime, samples, clock, intervals, state.self.body, timeline.at);
    const memFact = state.self.body.memory;
    const fallbackMemoryTotal = memFact.status === 'ok' ? memFact.value?.total : undefined;
    const panelTimeline = projectPanelTimeline(runtime, entries, now, fallbackMemoryTotal);
    const next: PresenterModel = {
      target: runtime.target(),
      state,
      history: samples,
      insights,
      learning,
      tuning: projectTuning(runtime, timeline.stable),
      events: projectEvents(entries, settings.sendTitles, timeline.at, (at) => timeline.stable(`event:${at}`, at)),
      rules: projectRules(runtime, timeline.stable),
      ...settings,
      now,
      sampleIntervalsMs: intervals,
      ...(panelTimeline ? { timeline: panelTimeline } : {}),
    };
    cached = cached
      ? {
          ...next,
          state: share(cached.state, next.state),
          events: share(cached.events, next.events),
          rules: share(cached.rules, next.rules),
          history: next.history,
          insights: share(cached.insights, next.insights),
          learning: share(cached.learning, next.learning),
          tuning: share(cached.tuning, next.tuning),
        }
      : next;
    return cached;
  }

  function emit() {
    timer = undefined;
    if (closed || !subscribers.size) return;
    const remaining = 500 - (clock.mono() - lastEmission);
    if (remaining > 0) {
      timer = setTimeout(emit, remaining);
      timer.unref?.();
      return;
    }
    published = snapshot();
    dirty = false;
    lastEmission = clock.mono();
    for (const subscriber of subscribers) {
      const resolve = subscriber.waiting.shift();
      if (resolve) resolve({ value: published, done: false });
      else subscriber.queued = published;
    }
  }
  function schedule() {
    if (closed) return;
    for (const entry of runtime.body.tuner.logs) timeline.stable(`tuning:${entry.id}`, entry.at);
    dirty = true;
    if (!subscribers.size || timer) return;
    timer = setTimeout(emit, Math.max(0, 500 - (clock.mono() - lastEmission)));
    timer.unref?.();
  }
  const offState = runtime.subscribe(() => {
    history.record(timeline.state().self.body, timeline.at(clock.mono()), clock.mono());
  });
  const offChange = runtime.onChange(schedule);
  snapshot();

  function finish(subscriber: Subscriber): IteratorResult<PresenterModel> {
    if (!subscriber.closed) {
      subscriber.closed = true;
      subscribers.delete(subscriber);
      for (const resolve of subscriber.waiting.splice(0)) resolve({ value: undefined, done: true });
      if (!subscribers.size && timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    }
    return { value: undefined, done: true };
  }
  function frames(): AsyncIterable<PresenterModel> {
    return {
      [Symbol.asyncIterator]() {
        const subscriber: Subscriber = { initial: true, closed, waiting: [] };
        if (!closed) {
          if (!subscribers.size) {
            if (!published || clock.mono() - lastEmission >= 500) {
              published = snapshot();
              lastEmission = clock.mono();
              dirty = false;
            }
          }
          subscribers.add(subscriber);
          if (dirty) schedule();
        }
        return {
          next(): Promise<IteratorResult<PresenterModel>> {
            if (subscriber.closed) return Promise.resolve({ value: undefined, done: true });
            if (subscriber.initial) {
              subscriber.initial = false;
              const frame = subscriber.queued ?? published;
              subscriber.queued = undefined;
              if (frame) return Promise.resolve({ value: frame, done: false });
            }
            if (subscriber.queued) {
              const frame = subscriber.queued;
              subscriber.queued = undefined;
              return Promise.resolve({ value: frame, done: false });
            }
            return new Promise((resolve) => subscriber.waiting.push(resolve));
          },
          return: () => Promise.resolve(finish(subscriber)),
        };
      },
    };
  }
  function close(): void {
    if (closed) return;
    closed = true;
    offState();
    offChange();
    if (timer) clearTimeout(timer);
    timer = undefined;
    for (const subscriber of [...subscribers]) finish(subscriber);
  }
  return { frames, snapshot, close };
}
