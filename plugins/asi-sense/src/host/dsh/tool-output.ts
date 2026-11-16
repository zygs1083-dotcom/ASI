import { isRemoteJsonValue } from '@deepseek-ai/dsh-typert-protocol';
import type { createSenseRuntime } from '../runtime/index.ts';
import type { JsonValue } from './wire-types.ts';

const MAX_BYTES = 32_768;

function json(value: unknown): JsonValue {
  const text = JSON.stringify(value, (_key, item: unknown) => {
    if (
      (typeof item === 'number' && (!Number.isFinite(item) || Object.is(item, -0))) ||
      typeof item === 'function' ||
      typeof item === 'symbol' ||
      typeof item === 'bigint'
    ) {
      throw new TypeError('tool result contains non-JSON data');
    }
    return item;
  });
  if (text === undefined) throw new TypeError('tool result contains no JSON value');
  const parsed: unknown = JSON.parse(text);
  if (!isRemoteJsonValue(parsed)) throw new TypeError('tool result is not lossless JSON');
  return parsed as JsonValue;
}

function ages(value: JsonValue, now: number): JsonValue {
  if (Array.isArray(value)) return value.map((item) => ages(item, now));
  if (value === null || typeof value !== 'object') return value;
  const entries = Object.fromEntries(Object.entries(value).map(([key, child]) => [key, ages(child, now)]));
  if (
    typeof entries.observedAt === 'number' &&
    typeof entries.ttlMs === 'number' &&
    typeof entries.status === 'string' &&
    Object.hasOwn(entries, 'value') &&
    Object.hasOwn(entries, 'source')
  ) {
    entries.ageMs = Math.max(0, now - entries.observedAt);
  }
  return entries;
}

export function modelOutput(value: unknown, now?: number): JsonValue {
  const normalized = json(value);
  const result = now === undefined ? normalized : ages(normalized, now);
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') <= MAX_BYTES) return result;
  return {
    truncated: true,
    message: 'Result exceeds the size limit. Request a smaller section or inspect the current foreground application.',
  };
}

type Runtime = Pick<ReturnType<typeof createSenseRuntime>, 'tools' | 'events' | 'rules'>;

export function environmentDetail(runtime: Runtime, app?: string, window?: string): JsonValue {
  const snapshot = runtime.tools.envState();
  if (!('env' in snapshot) || !('observation' in snapshot)) throw new TypeError('full sense state unavailable');
  const { env, observation } = snapshot;
  const front = env.frontApp.value;
  const title = env.focusedWindow.value?.title;
  const matchesApp = front === null ? null : app === undefined || app === front.name || app === front.bundleId;
  const matchesWindow = window === undefined ? true : title === undefined ? null : title === window;
  const available = matchesApp === true && matchesWindow === true;
  const mismatch = matchesApp === false || matchesWindow === false;
  const events = available
    ? runtime
        .events()
        .filter((event) => event.kind.startsWith('app.') || event.kind.startsWith('window.'))
        .slice(-20)
        .map(({ kind, at, subject, level, source }) => ({ kind, at, subject, level, source }))
    : [];
  return modelOutput({
    current: available,
    match: mismatch ? 'not-current' : available ? 'current' : 'unknown',
    app: mismatch ? null : env.frontApp,
    window: mismatch ? null : env.focusedWindow,
    pid: { value: null, status: 'unknown' },
    windowCount: { value: null, status: 'unknown' },
    recentEvents: events,
    sources: observation.sources,
    guidance: '如需查看窗口内容，请使用当前会话可用的 computer-use 工具（需经其授权流程）',
  });
}
