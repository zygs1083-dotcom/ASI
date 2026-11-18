import { createHash } from 'node:crypto';
import path from 'node:path';
import type { SourceRef } from '@asi/sense-types';
import type {
  DailyDirectoryStats,
  HistoryQueryResult,
  PersistedEventEntry,
  SummaryQueryResult,
} from '../runtime/ports.ts';
import { modelAppName, modelOutput, modelPath, modelText, modelTitle } from './tool-output.ts';
import type { JsonValue } from './wire-types.ts';

const SAFE_IDENTIFIERS = new Set([
  'accessibility',
  'other',
  'helper',
  'helper.ax',
  'helper.window',
  'helper.frontApp',
  'helper.focusedWindow',
  'helper.thermal',
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
  'unknown',
  'nsworkspace',
  'ax',
  'network.rx',
  'network.tx',
  'file.burst',
  'file.activity',
  'body.threshold',
  'body.rate',
  'body.anomaly',
  'delivery.target-unavailable',
]);

const KNOWN_EVENT_KINDS = new Set([
  'app.activated',
  'app.launched',
  'app.terminated',
  'window.focused',
  'window.title-changed',
  'file.changed',
  'file.burst',
  'file.activity',
  'job.started',
  'job.exited',
  'job.failed',
  'process.exited',
  'source.status',
  'source.error',
  'body.threshold',
  'body.rate',
  'body.anomaly',
  'fact.updated',
  'delivery.target-unavailable',
]);

function safeIdentifier(value: string): string {
  if (SAFE_IDENTIFIERS.has(value)) return value;
  return /^[\w-]+$/.test(value) ? modelText(value) : '[redacted]';
}

function projectPathBase(value: string): string {
  return modelTitle(modelPath(value));
}

function projectDiskMount(mount: string): string {
  const trimmed = mount.trim();
  if (!trimmed || trimmed === '[path]') return '[path]';
  return projectPathBase(trimmed);
}

function projectDiskMetric(value: string): string {
  return `disk:${projectDiskMount(value.slice('disk:'.length))}`;
}

function projectMetric(value: string): string {
  if (value.startsWith('disk:')) return projectDiskMetric(value);
  return safeIdentifier(value);
}

function extractExecutableToken(raw: string): string | undefined {
  let i = 0;
  const len = raw.length;
  while (i < len) {
    while (i < len && /\s/.test(raw[i])) i++;
    if (i >= len) return undefined;
    let token = '';
    let wasQuoted = false;
    while (i < len && !/\s/.test(raw[i])) {
      const ch = raw[i];
      if (ch === '"' || ch === "'") {
        wasQuoted = true;
        const quote = ch;
        i++;
        while (i < len && raw[i] !== quote) {
          if (raw[i] === '\\' && quote === '"' && i + 1 < len && (raw[i + 1] === '"' || raw[i + 1] === '\\')) {
            i++;
          }
          token += raw[i++];
        }
        if (i < len && raw[i] === quote) i++;
      } else {
        token += ch;
        i++;
      }
    }
    if (!wasQuoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      continue;
    }
    return token;
  }
  return undefined;
}

function projectCommandSubject(subject: string): string {
  const trimmed = subject.trim();
  if (!trimmed) return '';
  const token = extractExecutableToken(trimmed);
  if (!token) return '[redacted]';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token)) return '[redacted]';
  const normalized = token.replaceAll('\\', '/').replace(/\/+$/, '');
  const base = path.posix.basename(normalized);
  if (!base) return '[path]';
  return modelTitle(base);
}

function projectBodySubject(subject: string): string {
  if (subject.startsWith('disk:')) return projectDiskMetric(subject);
  if (subject.startsWith('rate:')) {
    const diskIdx = subject.indexOf(':disk:', 4);
    if (diskIdx >= 0) {
      const rulePart = safeIdentifier(subject.slice('rate:'.length, diskIdx));
      return `rate:${rulePart}:${projectDiskMetric(subject.slice(diskIdx + 1))}`;
    }
    return `rate:${safeIdentifier(subject.slice('rate:'.length))}`;
  }
  if (subject.startsWith('baseline:')) {
    return `baseline:${safeIdentifier(subject.slice('baseline:'.length))}`;
  }
  if (subject.startsWith('rebaseline:')) {
    return `rebaseline:${projectMetric(subject.slice('rebaseline:'.length))}`;
  }
  return projectMetric(subject);
}

function projectEventId(id: string): string {
  const replaced = id.replace(/disk:([^:]+)/g, (_match, mount: string) => `disk:${projectDiskMount(mount)}`);
  if (/[\\/ @]|^[a-z][a-z0-9+.-]*:\/\//i.test(replaced)) {
    return `id:r-${createHash('sha256').update(id).digest('hex').slice(0, 8)}`;
  }
  return replaced;
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
    if (key === 'directory' || key === 'dir') out[key] = projectPathBase(value);
    else if (key === 'metric') out[key] = projectMetric(value);
    else if (key === 'ruleId' || key === 'type' || key === 'severity' || key === 'direction' || key === 'confidence') {
      out[key] = safeIdentifier(value);
    } else out[key] = modelText(value);
  }
  return out;
}

function projectSubject(entry: PersistedEventEntry): string {
  if (entry.kind.startsWith('app.') || entry.kind.startsWith('window')) {
    return modelAppName(entry.subject);
  }
  if (entry.kind.startsWith('file.')) {
    return projectPathBase(entry.subject);
  }
  if (entry.kind.startsWith('job.') || entry.kind.startsWith('process.')) {
    return projectCommandSubject(entry.subject);
  }
  if (entry.kind.startsWith('body.')) {
    return projectBodySubject(entry.subject);
  }
  if (entry.kind === 'source.status' || entry.kind === 'source.error') {
    if (entry.subject.startsWith('files:')) {
      return `files:r-${createHash('sha256').update(entry.subject.slice('files:'.length)).digest('hex').slice(0, 8)}`;
    }
    return safeIdentifier(entry.subject);
  }
  return modelText(entry.subject);
}

function projectEvent(entry: PersistedEventEntry, titlesAllowed: boolean): Record<string, unknown> {
  const isWindow = entry.kind.startsWith('window');
  const safeId = projectEventId(entry.id);
  const safeKind = KNOWN_EVENT_KINDS.has(entry.kind) ? entry.kind : safeIdentifier(entry.kind);
  if (isWindow && !titlesAllowed) {
    return {
      id: safeId,
      kind: safeKind,
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
    id: safeId,
    kind: safeKind,
    subject: projectSubject(entry),
    level: entry.level,
    at: entry.at,
    // `modelOutput` applies `modelTitle` once via `minimize` on `.title` paths.
    ...(isWindow && entry.title !== undefined ? { title: entry.title } : {}),
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
  const partial = result.partial || s.partial;
  return modelOutput({
    available: true,
    ...(partial ? { partial: true } : {}),
    summary: {
      ...s,
      ...(partial ? { partial: true } : {}),
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
      fileBursts: projectRecord(s.fileBursts, projectPathBase, mergeDirStats),
      fileActivity: projectRecord(s.fileActivity, projectPathBase, mergeDirStats),
      bodyAnomalies: {
        ...s.bodyAnomalies,
        byMetric: projectRecord(s.bodyAnomalies.byMetric, projectMetric, (a, b) => a + b),
      },
    },
  });
}
