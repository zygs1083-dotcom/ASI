import { createHash } from 'node:crypto';
import type { SourceRef } from '@asi/sense-types';
import type {
  DailyDirectoryStats,
  HistoryQueryResult,
  PersistedEventEntry,
  SummaryQueryResult,
} from '../runtime/ports.ts';
import { modelAppName, modelLabel, modelOutput, modelPath, modelText, modelTitle } from './tool-output.ts';
import type { JsonValue } from './wire-types.ts';

const SAFE_IDENTIFIERS = new Set([
  'accessibility',
  'other',
  'helper',
  'helper.ax',
  'helper.window',
  'helper.frontApp',
  'helper.focusedWindow',
  'ndjson',
  'dsh',
  'events',
  'registry',
  'files',
  'watch',
  'body',
  'probe',
  'tokens',
  'delivery',
  'local',
  'node',
  'history',
  'storage',
]);

function safeIdentifier(value: string): string {
  if (SAFE_IDENTIFIERS.has(value)) return value;
  return /^[\w.:-]+$/.test(value) ? modelText(value) : '[redacted]';
}

function projectSource(source: SourceRef): { id: string; api: string } {
  const id = source.id.startsWith('files:')
    ? `files:r-${createHash('sha256').update(source.id.slice('files:'.length)).digest('hex').slice(0, 8)}`
    : safeIdentifier(source.id);
  return { id, api: safeIdentifier(source.api) };
}

function projectDetail(
  detail: Record<string, string | number | boolean> | undefined,
): Record<string, string | number | boolean> | undefined {
  if (!detail) return undefined;
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(detail)) {
    if (typeof value !== 'string') {
      out[key] = value;
      continue;
    }
    out[key] = key === 'directory' || key === 'dir' ? modelPath(value) : modelText(value);
  }
  return out;
}

function projectSubject(entry: PersistedEventEntry): string {
  if (entry.kind.startsWith('app.') || entry.kind.startsWith('window')) {
    return modelAppName(entry.subject);
  }
  if (entry.kind.startsWith('file.')) {
    return modelPath(entry.subject);
  }
  if (entry.kind.startsWith('job.')) {
    return modelLabel(entry.subject);
  }
  return modelText(entry.subject);
}

function projectEvent(entry: PersistedEventEntry, titlesAllowed: boolean): Record<string, unknown> {
  const isWindow = entry.kind.startsWith('window');
  if (isWindow && !titlesAllowed) {
    return {
      id: entry.id,
      kind: entry.kind,
      subject: '',
      level: entry.level,
      at: entry.at,
      ...(entry.cause !== undefined ? { cause: entry.cause } : {}),
      source: projectSource(entry.source),
      ...(entry.feedback !== undefined ? { feedback: entry.feedback } : {}),
    };
  }
  const detail = projectDetail(entry.detail);
  return {
    id: entry.id,
    kind: entry.kind,
    subject: projectSubject(entry),
    level: entry.level,
    at: entry.at,
    ...(isWindow && entry.title !== undefined ? { title: modelTitle(entry.title) } : {}),
    ...(entry.reason !== undefined ? { reason: modelText(entry.reason) } : {}),
    ...(entry.ruleId !== undefined ? { ruleId: safeIdentifier(entry.ruleId) } : {}),
    ...(entry.cause !== undefined ? { cause: entry.cause } : {}),
    ...(entry.restarts !== undefined ? { restarts: entry.restarts } : {}),
    source: projectSource(entry.source),
    ...(detail !== undefined ? { detail } : {}),
    ...(entry.currentEta !== undefined ? { currentEta: entry.currentEta } : {}),
    ...(entry.feedback !== undefined ? { feedback: entry.feedback } : {}),
    ...(entry.feedbackAvailable !== undefined ? { feedbackAvailable: entry.feedbackAvailable } : {}),
  };
}

function projectRecord<V>(
  source: Record<string, V>,
  projectKey: (key: string) => string,
  merge?: (prev: V, next: V) => V,
): Record<string, V> {
  const out: Record<string, V> = Object.create(null);
  for (const [key, value] of Object.entries(source)) {
    const safeKey = projectKey(key);
    if (Object.hasOwn(out, safeKey) && merge) {
      out[safeKey] = merge(out[safeKey], value);
      continue;
    }
    let targetKey = safeKey;
    for (let n = 2; Object.hasOwn(out, targetKey); n++) {
      targetKey = `${safeKey} (${n})`;
    }
    out[targetKey] = value;
  }
  return out;
}

function mergeDirStats(a: DailyDirectoryStats, b: DailyDirectoryStats): DailyDirectoryStats {
  const merged: DailyDirectoryStats = {
    events: a.events + b.events,
    created: a.created + b.created,
    modified: a.modified + b.modified,
    deleted: a.deleted + b.deleted,
  };
  const excessive = (a.externalDeletionExceeded ?? 0) + (b.externalDeletionExceeded ?? 0);
  if (excessive > 0) merged.externalDeletionExceeded = excessive;
  return merged;
}

export function modelHistory(result: HistoryQueryResult): JsonValue {
  if (!result.available) return modelOutput(result);
  let events = result.events.map((ev) => projectEvent(ev, result.titlesAllowed));
  let truncated = result.truncated;
  for (;;) {
    const candidate = modelOutput({
      available: true,
      from: result.from,
      to: result.to,
      ...(result.rangeClamped ? { rangeClamped: true, note: result.note } : {}),
      limit: result.limit,
      total: result.total,
      truncated,
      titlesAllowed: result.titlesAllowed,
      events,
    });
    if (
      candidate !== null &&
      typeof candidate === 'object' &&
      !Array.isArray(candidate) &&
      Object.hasOwn(candidate, 'available')
    ) {
      return candidate;
    }
    if (events.length === 0) return candidate;
    const dropCount = Math.max(1, Math.ceil(events.length * 0.25));
    events = events.slice(0, Math.max(0, events.length - dropCount));
    truncated = true;
  }
}

export function modelSummary(result: SummaryQueryResult): JsonValue {
  if (!result.available) return modelOutput(result);
  const s = result.summary;
  return modelOutput({
    available: true,
    summary: {
      ...s,
      apps: projectRecord(s.apps, modelAppName, (a, b) => ({
        foregroundMs: a.foregroundMs + b.foregroundMs,
        switches: a.switches + b.switches,
      })),
      deliveries: {
        ...s.deliveries,
        byRule: projectRecord(s.deliveries.byRule, safeIdentifier, (a, b) => ({
          wake: a.wake + b.wake,
          context: a.context + b.context,
          suppressed: a.suppressed + b.suppressed,
        })),
      },
      fileBursts: projectRecord(s.fileBursts, modelPath, mergeDirStats),
      fileActivity: projectRecord(s.fileActivity, modelPath, mergeDirStats),
      bodyAnomalies: {
        ...s.bodyAnomalies,
        byMetric: projectRecord(s.bodyAnomalies.byMetric, safeIdentifier, (a, b) => a + b),
      },
    },
  });
}
