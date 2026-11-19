import { randomUUID } from 'node:crypto';
import os from 'node:os';
import type { EnvUpdate } from '@asi/sense-types';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { freezeMessage, MessageId, type UserMessage } from '@deepseek-ai/dsh-llm';
import { isSessionContext } from '../attention/buckets.ts';
import { DeliveryFailure } from '../attention/drain.ts';
import { homeAliasRevision, isHomeRoot } from '../attention/path.ts';
import type { DeliveryIntent } from '../attention/pipeline.ts';
import { BODY_THRESHOLDS } from '../attention/thresholds.ts';
import { formatEnvUpdate, resolveBurstDeletions } from '../delivery/format.ts';
import { isAnomalousAwayMetric } from '../runtime/away.ts';
import { redactCredentials } from './credential-scan.ts';
import { DELIVERABLE_KINDS } from './kinds.ts';
import { modelActivityName, modelAppName, modelLabel, modelText, modelTitle, sourceIdentifier } from './tool-output.ts';

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    environment: { kind: 'environment' };
  }
}

export { DELIVERABLE_KINDS, modelActivityName };

/** Masks a `files` entry that resolves to the user's home root, keeping subdirectory names intact. */
export function modelFileEntry(directory: string | undefined, item: string): string {
  if (item === '~') return '~';
  const dir = directory?.trim();
  if (dir) {
    const separator = dir.endsWith('/') || dir.endsWith('\\') ? '' : '/';
    if (isHomeRoot(`${dir}${separator}${item}`)) return '~';
  }
  return modelActivityName(item, false);
}

function metric(value: unknown): string {
  if (typeof value !== 'string') return 'body';
  if (value.startsWith('disk:')) return `disk:${modelActivityName(value.slice(5), true)}`;
  return [
    'cpu',
    'memory',
    'disk',
    'battery',
    'context',
    'network',
    'network.rx',
    'network.tx',
    'thermal',
    'rss',
  ].includes(value)
    ? value
    : 'body';
}

const AWAY_METRIC_NAMES: ReadonlySet<string> = new Set([
  'cpu',
  'load1',
  'load5',
  'load15',
  'memory',
  'swap',
  'disk',
  'battery',
]);
const AWAY_UNITS: ReadonlySet<string> = new Set(['ratio', 'load', 'bytes', 'percent']);
const AWAY_ANOMALIES: ReadonlySet<string> = new Set([
  'alerts',
  'metric-warning',
  'metric-growth',
  'failed-jobs',
  'external-deletion',
]);
const AWAY_FAILED_KINDS: ReadonlySet<string> = new Set(['job.failed', 'job.exited', 'process.exited']);

const HOMOGLYPH_SLASH_TEST_RE = /[\u2215\u2044\u29f8\u2571\u29f5\u29f9\u2216\u2572\ufe68\uff0f\uff3c]/;

function isSpaceCode(code: number): boolean {
  return (
    code === 32 ||
    (code >= 9 && code <= 13) ||
    code === 0x00a0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000
  );
}

function isAsciiLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isForwardSlashOrHomoglyph(code: number): boolean {
  return code === 47 || code === 0x2215 || code === 0x2044 || code === 0x29f8 || code === 0x2571 || code === 0xff0f;
}

function isBackslashOrHomoglyph(code: number): boolean {
  return (
    code === 92 ||
    code === 0x29f5 ||
    code === 0x29f9 ||
    code === 0x2216 ||
    code === 0x2572 ||
    code === 0xfe68 ||
    code === 0xff3c
  );
}

function isSlashOrBackslash(code: number): boolean {
  return isForwardSlashOrHomoglyph(code) || isBackslashOrHomoglyph(code);
}

function isPathPrefixBoundary(code: number): boolean {
  if (isSpaceCode(code)) return true;
  switch (code) {
    case 39:
    case 34:
    case 96:
    case 40:
    case 91:
    case 123:
    case 60:
    case 44:
    case 59:
    case 58:
    case 61:
    case 0x2018:
    case 0x201c:
    case 0xff08:
    case 0x300c:
    case 0x300e:
    case 0x3010:
    case 0x3008:
    case 0x300a:
    case 0xff1a:
    case 0xff0c:
    case 0x3001:
    case 0xff1b:
    case 0xff1d:
      return true;
    default:
      return false;
  }
}

function isPathHardStop(code: number, stopOnColon: boolean): boolean {
  if (isSpaceCode(code)) return true;
  if (stopOnColon && (code === 58 || code === 0xff1a)) return true;
  switch (code) {
    case 39:
    case 34:
    case 96:
    case 44:
    case 59:
    case 60:
    case 62:
    case 0x2018:
    case 0x2019:
    case 0x201c:
    case 0x201d:
    case 0x3001:
    case 0x3002:
    case 0xff0c:
    case 0xff1b:
    case 0xff09:
    case 0x300d:
    case 0x300f:
    case 0x3011:
    case 0x3009:
    case 0x300b:
      return true;
    default:
      return false;
  }
}

function scanTokenEnd(value: string, start: number, stopOnColon: boolean): { end: number; sawSlash: boolean } {
  const len = value.length;
  let j = start;
  let openParen = 0;
  let openBracket = 0;
  let openBrace = 0;
  let sawSlash = false;
  while (j < len) {
    const code = value.charCodeAt(j);
    if (code === 40) {
      openParen++;
      j++;
      continue;
    }
    if (code === 41) {
      if (openParen === 0) break;
      openParen--;
      j++;
      continue;
    }
    if (code === 91) {
      openBracket++;
      j++;
      continue;
    }
    if (code === 93) {
      if (openBracket === 0) break;
      openBracket--;
      j++;
      continue;
    }
    if (code === 123) {
      openBrace++;
      j++;
      continue;
    }
    if (code === 125) {
      if (openBrace === 0) break;
      openBrace--;
      j++;
      continue;
    }
    if (isPathHardStop(code, stopOnColon)) break;
    if (isSlashOrBackslash(code)) sawSlash = true;
    j++;
  }
  return { end: j, sawSlash };
}

function scanPathTokens(value: string): { text: string; singlePath: boolean } {
  const len = value.length;
  if (!len || (!value.includes('/') && !value.includes('\\') && !HOMOGLYPH_SLASH_TEST_RE.test(value))) {
    return { text: value, singlePath: false };
  }
  const parts: string[] = [];
  let cursor = 0;
  let i = 0;
  let tokenCount = 0;
  let firstStart = -1;
  let firstEnd = -1;
  while (i < len) {
    if (i > 0 && !isPathPrefixBoundary(value.charCodeAt(i - 1))) {
      i++;
      continue;
    }
    const code = value.charCodeAt(i);
    if (
      i > 0 &&
      (value.charCodeAt(i - 1) === 58 || value.charCodeAt(i - 1) === 0xff1a) &&
      isForwardSlashOrHomoglyph(code) &&
      i + 1 < len &&
      isForwardSlashOrHomoglyph(value.charCodeAt(i + 1))
    ) {
      i = scanTokenEnd(value, i + 2, false).end;
      continue;
    }
    let prefixLen = 0;
    let singleBackslash = false;
    if (isForwardSlashOrHomoglyph(code)) {
      prefixLen = 1;
    } else if (isBackslashOrHomoglyph(code)) {
      if (i + 1 < len && isBackslashOrHomoglyph(value.charCodeAt(i + 1))) {
        prefixLen = 2;
      } else {
        prefixLen = 1;
        singleBackslash = true;
      }
    } else if ((code === 126 || code === 0xff5e) && i + 1 < len && isSlashOrBackslash(value.charCodeAt(i + 1))) {
      prefixLen = 2;
    } else if (
      isAsciiLetter(code) &&
      i + 2 < len &&
      (value.charCodeAt(i + 1) === 58 || value.charCodeAt(i + 1) === 0xff1a) &&
      isSlashOrBackslash(value.charCodeAt(i + 2))
    ) {
      prefixLen = 3;
    }
    if (prefixLen === 0) {
      i++;
      continue;
    }
    const { end: scanEnd, sawSlash } = scanTokenEnd(value, i + prefixLen, true);
    if (singleBackslash && !sawSlash) {
      i++;
      continue;
    }
    let end = scanEnd;
    while (end > i + prefixLen) {
      const c = value.charCodeAt(end - 1);
      if (c === 33 || c === 63) {
        end--;
        continue;
      }
      if (c === 46) {
        const prev = value.charCodeAt(end - 2);
        if (isSlashOrBackslash(prev)) break;
        if (prev === 46 && end - 3 >= i && isSlashOrBackslash(value.charCodeAt(end - 3))) break;
        end--;
        continue;
      }
      break;
    }
    if (i > cursor) parts.push(value.slice(cursor, i));
    parts.push(modelActivityName(value.slice(i, end), true));
    if (tokenCount === 0) {
      firstStart = i;
      firstEnd = end;
    }
    tokenCount++;
    cursor = end;
    i = end;
  }
  if (cursor === 0) return { text: value, singlePath: false };
  if (cursor < len) parts.push(value.slice(cursor));
  return {
    text: parts.join(''),
    singlePath: tokenCount === 1 && firstStart === 0 && firstEnd === len,
  };
}

/**
 * Linear-time scanner that replaces embedded POSIX (`/…`), tilde (`~/…`),
 * Windows (`X:\…` / `X:/…`), and UNC (`\\…`) absolute path tokens via
 * `modelActivityName(token, true)` while preserving surrounding delimiters.
 */
export function replacePathTokens(value: string): string {
  return scanPathTokens(value).text;
}

const MAX_REASON_CACHE = 256;
const MAX_CACHED_REASON_LENGTH = 2048;
const reasonCache = new Map<string, string>();
let reasonCacheHostname: string | undefined;
let reasonCacheHomeKey: string | undefined;
let lastReasonKey: string | undefined;
let lastReasonVal = '';

export function sanitizeReason(
  value: string,
  hostname = os.hostname(),
  homeKey = `${homeAliasRevision()}\u0000${os.homedir()}`,
): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (hostname !== reasonCacheHostname || homeKey !== reasonCacheHomeKey) {
    reasonCache.clear();
    reasonCacheHostname = hostname;
    reasonCacheHomeKey = homeKey;
    lastReasonKey = undefined;
  } else if (trimmed === lastReasonKey) {
    return lastReasonVal;
  }
  const cached = reasonCache.get(trimmed);
  if (cached !== undefined) {
    reasonCache.delete(trimmed);
    reasonCache.set(trimmed, cached);
    lastReasonKey = trimmed;
    lastReasonVal = cached;
    return cached;
  }
  const replaced = scanPathTokens(trimmed);
  const sanitized = replaced.singlePath ? replaced.text : modelText(replaced.text, hostname) || '[redacted]';
  if (trimmed.length <= MAX_CACHED_REASON_LENGTH) {
    if (reasonCache.size >= MAX_REASON_CACHE) {
      const oldest = reasonCache.keys().next().value;
      if (oldest !== undefined) reasonCache.delete(oldest);
    }
    reasonCache.set(trimmed, sanitized);
    lastReasonKey = trimmed;
    lastReasonVal = sanitized;
  }
  return sanitized;
}

const KNOWN_SOURCE_STATUSES: ReadonlySet<string> = new Set([
  'ok',
  'stale',
  'denied',
  'unsupported',
  'unavailable',
  'unknown',
  'error',
  'degraded',
  'partial-denied',
  'disabled',
  'running',
]);

function sanitizeSourceStatus(value: unknown, getHostLower: () => string): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (KNOWN_SOURCE_STATUSES.has(trimmed)) {
    const hostLower = getHostLower();
    if (!hostLower || !trimmed.includes(hostLower)) return trimmed;
  }
  return modelLabel(trimmed);
}

const APP_PATH_LIKE_RE = /^(?:~?[/\\]|[A-Za-z]:[/\\])|[/\\].*[/\\]|[/\\][^/\\]+\.app$/i;
const CTRL_CHARS_RE = /\p{Cc}/gu;

function fallbackAppSubject(rawInput: string): string {
  const raw = redactCredentials(rawInput);
  if (!raw.includes('/') && !raw.includes('\\')) return modelAppName(raw);
  const trimmed = raw.replace(CTRL_CHARS_RE, '').replace(/[/\\]+$/, '');
  if (!trimmed) return '';
  if (isHomeRoot(trimmed)) return '~';
  const lastSlash = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  const base = lastSlash >= 0 ? trimmed.slice(lastSlash + 1) : trimmed;
  if (!base || /^[A-Za-z]:$/.test(base) || !base.trim()) return '';
  return modelAppName(base);
}

function projectAppNameField(rawInput: string): string {
  const raw = redactCredentials(rawInput);
  return APP_PATH_LIKE_RE.test(raw) ? fallbackAppSubject(raw) : modelAppName(raw);
}

function pickSanitizedReasons(
  source: Record<string, unknown>,
  hostname: string,
  homeKey: string,
): { reason?: string; error?: string } {
  const out: { reason?: string; error?: string } = {};
  if (typeof source.reason === 'string' && source.reason.trim()) {
    out.reason = sanitizeReason(source.reason, hostname, homeKey);
  }
  if (typeof source.error === 'string' && source.error.trim()) {
    out.error = sanitizeReason(source.error, hostname, homeKey);
  }
  return out;
}

const MAX_AWAY_PROJECTION_BYTES = 2048;
const PLACEHOLDER_TOKENS = ['<host>', '[host]', '[endpoint]', '[path]', '[redacted]', '[long]'];

function truncateUtf8Safe(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  if (maxBytes <= 0) return '';
  if (maxBytes <= 3) return '.'.repeat(maxBytes);
  const limit = maxBytes - 3;
  let bytes = 0;
  let i = 0;
  while (i < value.length) {
    const cp = value.codePointAt(i) ?? 0;
    const charLen = cp > 0xffff ? 2 : 1;
    const utf8Len = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (bytes + utf8Len > limit) break;
    bytes += utf8Len;
    i += charLen;
  }
  let head = value.slice(0, i);
  const openBracket = head.lastIndexOf('[');
  if (openBracket >= 0 && head.indexOf(']', openBracket) === -1) {
    if (PLACEHOLDER_TOKENS.some((tok) => tok.startsWith(head.slice(openBracket)))) {
      head = head.slice(0, openBracket).trimEnd();
    }
  }
  return `${head}...`;
}

function shrinkReasons(item: Record<string, unknown>, maxReasonBytes: number): Record<string, unknown> {
  if (maxReasonBytes <= 0) {
    const { reason: _r, error: _e, ...rest } = item;
    return rest;
  }
  const out = { ...item };
  if (typeof out.reason === 'string') out.reason = truncateUtf8Safe(out.reason, maxReasonBytes);
  if (typeof out.error === 'string') out.error = truncateUtf8Safe(out.error, maxReasonBytes);
  return out;
}

type AwayAlertItem = { metric: string; severity: 'warn' | 'critical'; count: number; reason?: string; error?: string };
type AwayFailedItem = { id: string; kind: string; exitCode?: number; reason?: string; error?: string };
type AwayBurstItem = { directory: string; deleted: number; reason?: string; error?: string };
type AwayMetricItem = {
  metric: string;
  unit: string;
  start: number;
  end: number;
  min?: number;
  max?: number;
  ratioStart?: number;
  ratioMin?: number;
};

function isCriticalAwayMetric(trend: AwayMetricItem): boolean {
  if (trend.metric !== 'disk' && trend.metric !== 'battery') return false;
  if (!isAnomalousAwayMetric(trend)) return false;
  const threshold = BODY_THRESHOLDS[trend.metric];
  return trend.ratioMin !== undefined && trend.ratioMin < threshold.critical;
}

function projectAwaySummaryData(
  rawData: Record<string, unknown>,
  fitsBudget: (candidate: Record<string, unknown>) => boolean,
  hostname: string,
  homeKey: string,
): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const key of [
    'awayFrom',
    'returnAt',
    'durationMs',
    'sleepMs',
    'lockMs',
    'inactiveMs',
    'alertCount',
    'failedCount',
    'deletedCount',
    'anomalyCount',
    'omitted',
  ]) {
    const value = rawData[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) data[key] = value;
  }
  Object.assign(data, pickSanitizedReasons(rawData, hostname, homeKey));
  data.hasAnomaly = rawData.hasAnomaly === true;
  if (Array.isArray(rawData.anomalies)) {
    const anomalies = rawData.anomalies
      .filter((item): item is string => typeof item === 'string' && AWAY_ANOMALIES.has(item))
      .slice(0, 8);
    if (anomalies.length > 0) data.anomalies = anomalies;
  }

  const alerts: AwayAlertItem[] = Array.isArray(rawData.alerts)
    ? rawData.alerts
        .flatMap((item: unknown): AwayAlertItem[] => {
          if (!item || typeof item !== 'object') return [];
          const source = item as Record<string, unknown>;
          const { metric: rawMetric, severity, count } = source;
          if (typeof rawMetric !== 'string' || typeof severity !== 'string') return [];
          if (severity !== 'warn' && severity !== 'critical') return [];
          const safeMetric = metric(rawMetric);
          const safeCount =
            typeof count === 'number' && Number.isFinite(count) && count >= 0 ? Math.max(1, Math.round(count)) : 1;
          return [
            {
              metric: safeMetric,
              severity,
              count: safeCount,
              ...pickSanitizedReasons(source, hostname, homeKey),
            },
          ];
        })
        .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'critical' ? -1 : 1))
    : [];
  const criticalAlerts = alerts.filter((item) => item.severity === 'critical');
  const warnAlerts = alerts.filter((item) => item.severity === 'warn');

  const rawMetrics: AwayMetricItem[] = Array.isArray(rawData.metrics)
    ? rawData.metrics.flatMap((item: unknown): AwayMetricItem[] => {
        if (!item || typeof item !== 'object') return [];
        const source = item as Record<string, unknown>;
        const name = source.metric;
        if (typeof name !== 'string' || !AWAY_METRIC_NAMES.has(name)) return [];
        const unit = typeof source.unit === 'string' && AWAY_UNITS.has(source.unit) ? source.unit : undefined;
        const numbers: Record<string, number> = {};
        for (const key of ['start', 'end', 'min', 'max', 'ratioStart', 'ratioMin']) {
          const value = source[key];
          if (typeof value === 'number' && Number.isFinite(value) && value >= 0) numbers[key] = value;
        }
        if (!unit || numbers.start === undefined || numbers.end === undefined) return [];
        return [{ metric: name, unit, start: numbers.start, end: numbers.end, ...numbers }];
      })
    : [];
  const criticalMetrics: AwayMetricItem[] = [];
  const warnMetrics: AwayMetricItem[] = [];
  const normalMetrics: AwayMetricItem[] = [];
  for (const item of rawMetrics) {
    if (isCriticalAwayMetric(item)) criticalMetrics.push(item);
    else if (isAnomalousAwayMetric(item)) warnMetrics.push(item);
    else normalMetrics.push(item);
  }
  const metrics = [...criticalMetrics, ...warnMetrics, ...normalMetrics];

  const failed: AwayFailedItem[] = Array.isArray(rawData.failed)
    ? rawData.failed.flatMap((item: unknown): AwayFailedItem[] => {
        if (!item || typeof item !== 'object') return [];
        const source = item as Record<string, unknown>;
        const kind = source.kind;
        if (typeof kind !== 'string' || !AWAY_FAILED_KINDS.has(kind)) return [];
        const rawId = typeof source.id === 'string' && source.id.trim() ? source.id : 'job';
        const id = sanitizeReason(rawId, hostname, homeKey) || 'job';
        return [
          {
            id,
            kind,
            ...(typeof source.exitCode === 'number' && Number.isFinite(source.exitCode)
              ? { exitCode: source.exitCode }
              : {}),
            ...pickSanitizedReasons(source, hostname, homeKey),
          },
        ];
      })
    : [];

  const bursts: AwayBurstItem[] = Array.isArray(rawData.bursts)
    ? rawData.bursts.flatMap((item: unknown): AwayBurstItem[] => {
        if (!item || typeof item !== 'object') return [];
        const source = item as Record<string, unknown>;
        const rawDir = typeof source.directory === 'string' ? source.directory : '';
        const deleted =
          typeof source.deleted === 'number' && Number.isFinite(source.deleted) && source.deleted >= 0
            ? source.deleted
            : 0;
        return [
          {
            directory: modelActivityName(rawDir, true),
            deleted: Math.max(0, Math.round(deleted)),
            ...pickSanitizedReasons(source, hostname, homeKey),
          },
        ];
      })
    : [];

  const failedTotal =
    typeof data.failedCount === 'number' ? Math.max(failed.length, Math.round(data.failedCount)) : failed.length;
  const upstreamOmitted =
    typeof data.omitted === 'number'
      ? Math.round(data.omitted)
      : failedTotal > failed.length
        ? failedTotal - failed.length
        : 0;
  const computedAnomalyCount =
    alerts.length + failedTotal + bursts.length + criticalMetrics.length + warnMetrics.length;
  data.anomalyCount =
    typeof data.anomalyCount === 'number'
      ? Math.max(Math.round(data.anomalyCount), computedAnomalyCount)
      : computedAnomalyCount;
  if (upstreamOmitted > 0) data.omitted = upstreamOmitted;
  else delete data.omitted;

  const fullCandidate: Record<string, unknown> = {
    ...data,
    ...(alerts.length > 0 ? { alerts } : {}),
    ...(metrics.length > 0 ? { metrics } : {}),
    ...(failed.length > 0 ? { failed } : {}),
    ...(bursts.length > 0 ? { bursts } : {}),
  };
  if (fitsBudget(fullCandidate)) return fullCandidate;

  const shrinkAlerts = (list: AwayAlertItem[], fieldBytes: number, reasonBytes: number): AwayAlertItem[] =>
    list.map((a) => ({
      ...(shrinkReasons(a, reasonBytes) as AwayAlertItem),
      metric: truncateUtf8Safe(a.metric, fieldBytes),
    }));
  const shrinkFailed = (list: AwayFailedItem[], fieldBytes: number, reasonBytes: number): AwayFailedItem[] =>
    list.map((f) => ({
      ...(shrinkReasons(f, reasonBytes) as AwayFailedItem),
      id: truncateUtf8Safe(f.id, fieldBytes) || 'job',
    }));
  const shrinkBursts = (list: AwayBurstItem[], fieldBytes: number, reasonBytes: number): AwayBurstItem[] =>
    list.map((b) => ({
      ...(shrinkReasons(b, reasonBytes) as AwayBurstItem),
      directory: truncateUtf8Safe(b.directory, fieldBytes),
    }));

  const sAlerts = shrinkAlerts(alerts, 160, 96);
  const sFailed = shrinkFailed(failed, 160, 96);
  const sBursts = shrinkBursts(bursts, 160, 96);
  const shrunkFull: Record<string, unknown> = {
    ...shrinkReasons(data, 160),
    ...(sAlerts.length > 0 ? { alerts: sAlerts } : {}),
    ...(metrics.length > 0 ? { metrics } : {}),
    ...(sFailed.length > 0 ? { failed: sFailed } : {}),
    ...(sBursts.length > 0 ? { bursts: sBursts } : {}),
  };
  if (fitsBudget(shrunkFull)) return shrunkFull;

  // Strip all reasons/errors from base and entries before dropping any entry.
  const base = shrinkReasons(data, 0);
  let keptCriticalAlerts = shrinkAlerts(criticalAlerts, 160, 0);
  let keptWarnAlerts = shrinkAlerts(warnAlerts, 160, 0);
  const keptCriticalMetrics = [...criticalMetrics];
  const keptWarnMetrics = [...warnMetrics];
  const keptNormalMetrics = [...normalMetrics];
  const keptFailed = shrinkFailed(failed, 160, 0);
  let keptBursts = shrinkBursts(bursts, 160, 0);
  const totalRawItems = alerts.length + failed.length + bursts.length + metrics.length;

  const buildCandidate = (): Record<string, unknown> => {
    const nextAlerts = [...keptCriticalAlerts, ...keptWarnAlerts];
    const nextMetrics = [...keptCriticalMetrics, ...keptWarnMetrics, ...keptNormalMetrics];
    const candidate: Record<string, unknown> = { ...base };
    if (nextAlerts.length > 0) candidate.alerts = nextAlerts;
    if (nextMetrics.length > 0) candidate.metrics = nextMetrics;
    if (keptFailed.length > 0) candidate.failed = keptFailed;
    if (keptBursts.length > 0) candidate.bursts = keptBursts;
    const keptTotal = nextAlerts.length + nextMetrics.length + keptFailed.length + keptBursts.length;
    const totalOmitted = upstreamOmitted + (totalRawItems - keptTotal);
    if (totalOmitted > 0) candidate.omitted = totalOmitted;
    else delete candidate.omitted;
    return candidate;
  };

  const noReasonCandidate = buildCandidate();
  if (fitsBudget(noReasonCandidate)) return noReasonCandidate;

  const dropTailUntilFits = (list: unknown[]): boolean => {
    while (list.length > 0) {
      list.pop();
      if (fitsBudget(buildCandidate())) return true;
    }
    return false;
  };

  // Priority (dropped last -> first):
  // critical alerts > critical metrics > external deletion bursts > warn alerts > warn metrics > failed jobs > normal metrics
  const dropOrder: Array<() => boolean> = [
    () => dropTailUntilFits(keptNormalMetrics),
    () => dropTailUntilFits(keptFailed),
    () => dropTailUntilFits(keptWarnMetrics),
    () => {
      keptCriticalAlerts = shrinkAlerts(keptCriticalAlerts, 64, 0);
      keptWarnAlerts = shrinkAlerts(keptWarnAlerts, 64, 0);
      keptBursts = shrinkBursts(keptBursts, 64, 0);
      return fitsBudget(buildCandidate());
    },
    () => dropTailUntilFits(keptWarnAlerts),
    () => dropTailUntilFits(keptBursts),
    () => dropTailUntilFits(keptCriticalMetrics),
    () => dropTailUntilFits(keptCriticalAlerts),
  ];
  for (const step of dropOrder) {
    if (step()) return buildCandidate();
  }

  const minimal = buildCandidate();
  if (fitsBudget(minimal)) return minimal;
  delete minimal.anomalies;
  return minimal;
}

const SYSTEM_SIGNAL_KINDS: ReadonlySet<string> = new Set([
  'system.sleep',
  'system.wake',
  'screen.locked',
  'screen.unlocked',
  'session.active',
  'session.inactive',
]);

export function modelUpdate(update: EnvUpdate): EnvUpdate {
  let suppressed = update.suppressed;
  const changes: EnvUpdate['changes'] = [];
  let cachedHostname: string | undefined;
  let cachedHostLower: string | undefined;
  let cachedHomeKey: string | undefined;
  const getHostname = (): string => (cachedHostname ??= os.hostname());
  const getHostLower = (): string => (cachedHostLower ??= getHostname().toLowerCase());
  const getHomeKey = (): string => (cachedHomeKey ??= `${homeAliasRevision()}\u0000${os.homedir()}`);
  for (const { signal, count, level, ruleId } of update.changes) {
    if (!DELIVERABLE_KINDS.has(signal.kind)) {
      suppressed += count > 0 ? count : 1;
      continue;
    }
    const data: typeof signal.data = {};
    let subject = 'observation';
    if (typeof signal.data.feedbackAvailable === 'boolean') {
      data.feedbackAvailable = signal.data.feedbackAvailable && /^[\w.:-]+$/.test(signal.id);
    }
    if (signal.kind === 'app.activated' || signal.kind === 'app.launched' || signal.kind === 'app.terminated') {
      const fallbackName =
        (typeof signal.data.name === 'string' && signal.data.name.trim()
          ? projectAppNameField(signal.data.name)
          : fallbackAppSubject(
              typeof signal.data.bundleId === 'string' && signal.data.bundleId.trim()
                ? signal.data.bundleId
                : signal.subject,
            )) || 'app';
      subject = fallbackName;
      if (typeof signal.data.name === 'string') {
        const maskedName = projectAppNameField(signal.data.name);
        data.name = signal.kind === 'app.activated' ? maskedName : maskedName || fallbackName;
      } else {
        data.name = fallbackName;
      }
      if (typeof signal.data.previousName === 'string') {
        data.previousName = projectAppNameField(signal.data.previousName);
      }
    } else if (signal.kind === 'window.focused' || signal.kind === 'window.title-changed') {
      subject =
        fallbackAppSubject(
          typeof signal.data.bundleId === 'string' && signal.data.bundleId.trim()
            ? signal.data.bundleId
            : signal.subject,
        ) || 'window';
      data.title = typeof signal.data.title === 'string' ? modelTitle(signal.data.title, getHostname()) : '';
    } else if (signal.kind === 'source.status') {
      const srcId = sourceIdentifier(signal.source.id || signal.subject || 'source');
      subject = srcId;
      data.source = srcId;
      data.status = sanitizeSourceStatus(signal.data.status, getHostLower) ?? 'unknown';
      const rawPath =
        typeof signal.data.path === 'string' && signal.data.path.trim()
          ? signal.data.path.trim()
          : srcId === 'files-global-denied' && typeof signal.subject === 'string' && signal.subject.trim()
            ? signal.subject.trim()
            : '';
      if (rawPath && rawPath !== srcId) data.path = modelActivityName(rawPath, true);
      const rawReason =
        typeof signal.data.reason === 'string' && signal.data.reason.trim()
          ? signal.data.reason
          : typeof signal.data.lastFailure === 'string' && signal.data.lastFailure.trim()
            ? signal.data.lastFailure
            : '';
      if (rawReason) data.reason = sanitizeReason(rawReason, getHostname(), getHomeKey());
      if (typeof signal.data.error === 'string' && signal.data.error.trim()) {
        data.error = sanitizeReason(signal.data.error, getHostname(), getHomeKey());
      }
      if (typeof signal.data.restarts === 'number' && Number.isFinite(signal.data.restarts)) {
        data.restarts = signal.data.restarts;
      }
    } else if (signal.kind === 'source.error') {
      const srcId = sourceIdentifier(signal.source.id || signal.subject || 'source');
      subject = srcId;
      data.source = srcId;
      const rawError =
        typeof signal.data.error === 'string' && signal.data.error.trim()
          ? signal.data.error
          : typeof signal.data.category === 'string' && signal.data.category.trim()
            ? signal.data.category
            : typeof signal.data.reason === 'string' && signal.data.reason.trim()
              ? signal.data.reason
              : 'error';
      data.error = sanitizeReason(rawError, getHostname(), getHomeKey());
      const status = sanitizeSourceStatus(signal.data.status, getHostLower);
      if (status) data.status = status;
      if (typeof signal.data.reason === 'string' && signal.data.reason.trim()) {
        data.reason = sanitizeReason(signal.data.reason, getHostname(), getHomeKey());
      }
      if (typeof signal.data.dropped === 'number' && Number.isFinite(signal.data.dropped)) {
        data.dropped = signal.data.dropped;
      }
    } else if (SYSTEM_SIGNAL_KINDS.has(signal.kind)) {
      subject = signal.kind.startsWith('screen.')
        ? 'screen'
        : signal.kind.startsWith('session.')
          ? 'session'
          : 'system';
      const rawAt = typeof signal.data.at === 'number' && Number.isFinite(signal.data.at) ? signal.data.at : signal.at;
      data.at = rawAt;
      if (
        typeof signal.data.durationMs === 'number' &&
        Number.isFinite(signal.data.durationMs) &&
        signal.data.durationMs >= 0
      ) {
        data.durationMs = signal.data.durationMs;
      }
    } else if (signal.kind === 'away.summary') {
      subject = 'away';
      const prefix = { ...data };
      const projectedAway = projectAwaySummaryData(
        signal.data,
        (candidate) =>
          Buffer.byteLength(
            JSON.stringify({
              since: update.since,
              at: update.at,
              suppressed,
              ...(update.alreadyInjected !== undefined ? { alreadyInjected: update.alreadyInjected } : {}),
              changes: [
                {
                  count,
                  level,
                  signal: {
                    id: signal.id,
                    kind: signal.kind,
                    at: signal.at,
                    source: { id: 'asi-sense', api: 'delivery', host: 'local' },
                    subject,
                    data: { ...prefix, ...candidate },
                  },
                },
              ],
            }),
            'utf8',
          ) <= MAX_AWAY_PROJECTION_BYTES,
        getHostname(),
        getHomeKey(),
      );
      Object.assign(data, projectedAway);
    } else if (signal.kind === 'delivery.target-unavailable') {
      subject = 'delivery-target';
      data.status = 'unavailable';
    } else if (signal.kind === 'file.changed') {
      const maskedPath = modelActivityName(
        typeof signal.data.path === 'string' && signal.data.path.trim() ? signal.data.path : signal.subject,
        true,
      );
      subject = maskedPath;
      data.path = maskedPath;
      if (
        typeof signal.data.change === 'string' &&
        ['add', 'create', 'created', 'modify', 'save', 'saved', 'delete', 'deleted', 'rename', 'renamed'].includes(
          signal.data.change,
        )
      ) {
        data.change = signal.data.change;
      }
    } else if (
      signal.kind === 'job.started' ||
      signal.kind === 'job.exited' ||
      signal.kind === 'job.failed' ||
      signal.kind === 'process.started' ||
      signal.kind === 'process.exited'
    ) {
      const rawJobId =
        typeof signal.data.id === 'string' && signal.data.id.trim() ? signal.data.id : signal.subject || 'job';
      subject = modelLabel(rawJobId);
      if (subject === '[redacted]') subject = signal.kind.startsWith('process.') ? 'process' : 'job';
      if (typeof signal.data.id === 'string' && signal.data.id.trim()) data.id = modelLabel(signal.data.id);
      if (typeof signal.data.exitCode === 'number' && Number.isFinite(signal.data.exitCode))
        data.exitCode = signal.data.exitCode;
      if (typeof signal.data.durationMs === 'number' && Number.isFinite(signal.data.durationMs))
        data.durationMs = signal.data.durationMs;
      if (typeof signal.data.startedAt === 'number' && Number.isFinite(signal.data.startedAt))
        data.startedAt = signal.data.startedAt;
      if (Object.keys(data).length === 0) {
        data.status =
          signal.kind === 'job.started' || signal.kind === 'process.started'
            ? 'running'
            : signal.kind === 'job.failed'
              ? 'failed'
              : 'exited';
      }
    } else if (signal.kind === 'body.threshold') {
      subject = metric(signal.subject);
      if (['normal', 'warn', 'critical'].includes(String(signal.data.severity))) data.severity = signal.data.severity;
      if (typeof signal.data.value === 'number' && Number.isFinite(signal.data.value)) data.value = signal.data.value;
      if (Object.keys(data).length === 0) data.metric = subject;
    } else if (signal.kind === 'body.rate' || signal.kind === 'body.anomaly' || signal.kind === 'file.burst') {
      const rawMetric =
        signal.data.metric ??
        (signal.kind === 'body.anomaly' && signal.data.type === 'rebaseline-suggestion'
          ? signal.subject.replace(/^(?:rebaseline|baseline):/, '')
          : undefined);
      if (signal.kind === 'file.burst') {
        const maskedDir = modelActivityName(
          typeof signal.data.directory === 'string' && signal.data.directory.trim()
            ? signal.data.directory
            : signal.subject,
          true,
        );
        subject = maskedDir;
        data.directory = maskedDir;
      } else {
        subject = metric(rawMetric);
      }
      if (signal.kind === 'body.anomaly' && signal.data.type === 'rebaseline-suggestion') {
        data.type = 'rebaseline-suggestion';
      }
      const ruleId = signal.data.ruleId;
      if (typeof ruleId === 'string' && (/^[\w-]+$/.test(ruleId) || ruleId === 'file.burst')) data.ruleId = ruleId;
      if (['normal', 'warn', 'critical'].includes(String(signal.data.severity))) data.severity = signal.data.severity;
      for (const key of [
        'value',
        'baseline',
        'deviation',
        'slope',
        'delta',
        'etaToFloorMs',
        'timeToFloorMs',
        'windowMs',
        'created',
        'modified',
      ]) {
        const value = signal.data[key];
        if (typeof value === 'number' && Number.isFinite(value)) data[key] = value;
      }
      const { externalDeleted, agentDeleted, skipMixedDeleted } = resolveBurstDeletions(signal.data);
      if (agentDeleted !== undefined) data.agentDeleted = agentDeleted;
      if (externalDeleted !== undefined) data.externalDeleted = externalDeleted;
      if (
        typeof signal.data.deleted === 'number' &&
        Number.isFinite(signal.data.deleted) &&
        !(signal.kind === 'file.burst' && skipMixedDeleted)
      ) {
        data.deleted = signal.data.deleted;
      }
      if (signal.data.externalDeletionExceeded === true) data.externalDeletionExceeded = true;
      if (signal.kind === 'file.burst' && signal.data.rolledUp === true) data.rolledUp = true;
      if ((signal.kind === 'body.rate' || signal.kind === 'body.anomaly') && Object.keys(data).length === 0) {
        data.metric = subject;
      }
    } else if (signal.kind === 'file.activity') {
      const rawDir =
        typeof signal.data.directory === 'string' && signal.data.directory.trim()
          ? signal.data.directory
          : signal.subject;
      const maskedDir = modelActivityName(rawDir, true);
      subject = maskedDir;
      data.directory = maskedDir;
      for (const key of ['windowMs', 'created', 'modified', 'deleted', 'rolledUp']) {
        const value = signal.data[key];
        if (typeof value === 'number' && Number.isFinite(value)) data[key] = value;
      }
      if (Array.isArray(signal.data.files)) {
        const files = signal.data.files
          .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
          .slice(0, 5)
          .map((item) => modelFileEntry(rawDir, item));
        if (files.length > 0) data.files = files;
      }
      if (signal.data.degraded === true) data.degraded = true;
    }
    const summary = signal.data.jobSummary;
    if (summary && typeof summary === 'object' && !Array.isArray(summary)) {
      const { total, omitted, recent } = summary as Record<string, unknown>;
      if (
        typeof total === 'number' &&
        Number.isFinite(total) &&
        typeof omitted === 'number' &&
        Number.isFinite(omitted) &&
        Array.isArray(recent)
      ) {
        data.jobSummary = {
          total,
          omitted,
          recent: recent.slice(-20).flatMap((item: unknown) => {
            if (!item || typeof item !== 'object') return [];
            const { id, kind, count, exitCode } = item as Record<string, unknown>;
            if (typeof id !== 'string' || !id.trim() || !['job.started', 'job.exited'].includes(String(kind)))
              return [];
            return [
              {
                id: modelLabel(id),
                kind,
                count: typeof count === 'number' && Number.isFinite(count) ? count : 1,
                ...(typeof exitCode === 'number' && Number.isFinite(exitCode) ? { exitCode } : {}),
              },
            ];
          }),
        };
      }
    }
    changes.push({
      count,
      level,
      ...(signal.kind === 'body.threshold' &&
      (subject === 'disk' || subject.startsWith('disk:')) &&
      typeof ruleId === 'string' &&
      /^[\w-]+$/.test(ruleId)
        ? { ruleId }
        : {}),
      signal: {
        id: signal.id,
        kind: signal.kind,
        at: signal.at,
        source: { id: 'asi-sense', api: 'delivery', host: 'local' },
        subject,
        data,
      },
    });
  }
  return {
    since: update.since,
    at: update.at,
    suppressed,
    alreadyInjected: update.alreadyInjected,
    changes,
  };
}

export function createDelivery(
  getAgent: (sessionId: string) => Pick<Agent, 'inject' | 'followup' | 'send'> | undefined,
  sendTitles: () => boolean,
  accepted: (sessionId: string, id: string) => Promise<boolean>,
  onSkipped?: (sessionId: string, id: string, kind: DeliveryIntent['kind']) => void | Promise<void>,
) {
  type Step = { turn: number; step: number };
  const delivered = new Map<string, Set<string>>();
  const staged = new Map<string, Map<string, { intent: DeliveryIntent; step?: Step; returned: boolean }>>();
  const steps = new Map<string, Step>();
  const inflight = new Map<string, Promise<void>>();
  const render = (intent: DeliveryIntent): string => {
    const projected = modelUpdate(intent.update);
    const opts = {
      includeWindowTitles: sendTitles(),
      includeJobCommands: false,
    };
    if (intent.update.changes.length > 0) {
      if (projected.changes.length === 0) return '';
      if (!formatEnvUpdate({ ...projected, suppressed: 0, alreadyInjected: 0 }, opts)) return '';
    }
    return formatEnvUpdate(projected, opts);
  };
  const message = (id: string, text: string): UserMessage =>
    freezeMessage({
      id: MessageId(id),
      role: 'user',
      source: { kind: 'environment' },
      content: [
        {
          type: 'text',
          text,
        },
      ],
    });
  const recordFor = (sessionId: string, id: string): void => {
    const ids = delivered.get(sessionId) ?? new Set<string>();
    ids.add(id);
    const oldest = ids.values().next().value;
    if (ids.size > 1024 && oldest !== undefined) ids.delete(oldest);
    delivered.set(sessionId, ids);
  };
  const perform = async (
    sessionId: string,
    intent: DeliveryIntent,
    id: string,
    isCurrent?: () => boolean,
  ): Promise<void> => {
    const agent = getAgent(sessionId);
    if (!agent) throw new Error('delivery session unavailable');
    const previous = delivered.get(sessionId);
    if (previous?.has(id) || (await accepted(sessionId, id))) return;
    if (intent.kind !== 'inject' && isCurrent && !isCurrent()) throw new DeliveryFailure('deferred');
    if (getAgent(sessionId) !== agent) throw new Error('delivery session changed');
    if (intent.kind === 'inject') {
      const pending = staged.get(sessionId) ?? new Map();
      if (pending.get(id)?.returned) return;
      pending.set(id, { intent: structuredClone(intent), step: steps.get(sessionId), returned: false });
      staged.set(sessionId, pending);
      return;
    }
    const text = render(intent);
    if (!text) {
      recordFor(sessionId, id);
      await onSkipped?.(sessionId, id, intent.kind);
      return;
    }
    try {
      const input = message(id, text);
      if (intent.kind === 'send') agent.send(input, intent.target, intent.wakeup);
      else agent.followup(input);
    } catch (error) {
      let wasAccepted: boolean;
      try {
        if (getAgent(sessionId) !== agent) throw new Error('delivery session changed');
        wasAccepted = await accepted(sessionId, id);
        if (getAgent(sessionId) !== agent) throw new Error('delivery session changed');
      } catch {
        throw new DeliveryFailure('unknown', 0, error);
      }
      if (!wasAccepted) throw error;
    }
    recordFor(sessionId, id);
  };
  const deliver = async (sessionId: string, intent: DeliveryIntent, isCurrent?: () => boolean): Promise<void> => {
    if (sessionId !== intent.sessionId) throw new Error('delivery session mismatch');
    const id = `asi-sense:${intent.deliveryId ?? randomUUID()}`;
    const key = JSON.stringify([sessionId, id]);
    const prior = inflight.get(key);
    if (prior) return prior;
    const work = perform(sessionId, intent, id, isCurrent);
    inflight.set(key, work);
    try {
      await work;
    } finally {
      if (inflight.get(key) === work) inflight.delete(key);
    }
  };
  return Object.assign(deliver, {
    async messages(sessionId: string, isActive?: () => boolean): Promise<UserMessage[]> {
      const pending = staged.get(sessionId);
      if (!pending) return [];
      const messages: UserMessage[] = [];
      for (const [id, entry] of pending) {
        const wasAccepted = await accepted(sessionId, id);
        if (isActive && !isActive()) break;
        if (pending.get(id) !== entry) continue;
        if (wasAccepted) pending.delete(id);
        else if (!entry.returned) {
          const text = render(entry.intent);
          if (!text) {
            pending.delete(id);
            recordFor(sessionId, id);
            await onSkipped?.(sessionId, id, entry.intent.kind);
          } else {
            messages.push(message(id, text));
          }
        }
      }
      if (!pending.size && staged.get(sessionId) === pending) staged.delete(sessionId);
      return messages;
    },
    acknowledge(sessionId: string, id: string): void {
      const pending = staged.get(sessionId);
      pending?.delete(id);
      if (pending?.size === 0) staged.delete(sessionId);
    },
    clear(sessionId: string): void {
      staged.delete(sessionId);
      delivered.delete(sessionId);
      steps.delete(sessionId);
    },
    select(sessionId: string | undefined): void {
      for (const [session, pending] of staged) {
        if (session === sessionId) continue;
        for (const [id, entry] of pending) {
          const owned = entry.intent.update.changes.some(
            ({ signal }) => isSessionContext(signal) || (signal.source.id === 'dsh' && signal.kind.startsWith('job.')),
          );
          if (!owned && !entry.returned && (!entry.step || steps.get(session) !== entry.step)) pending.delete(id);
        }
        if (!pending.size) staged.delete(session);
      }
    },
    begin(sessionId: string, step: Step): void {
      steps.set(sessionId, step);
    },
    finish(sessionId: string, step: Step, messages?: UserMessage[]): void {
      const pending = staged.get(sessionId);
      for (const [id, entry] of pending ?? []) {
        if (messages?.some((message) => message.id === id)) {
          entry.step = step;
          entry.returned = true;
        } else if (!messages && entry.step === step) pending?.delete(id);
      }
      if (pending?.size === 0) staged.delete(sessionId);
      if (steps.get(sessionId) === step) steps.delete(sessionId);
    },
    end(sessionId: string, position?: { turn: number; step?: number }): boolean {
      const pending = staged.get(sessionId);
      let discarded = false;
      for (const [id, entry] of pending ?? []) {
        if (
          entry.returned &&
          (!position ||
            (entry.step?.turn === position.turn && (position.step === undefined || entry.step.step === position.step)))
        ) {
          pending?.delete(id);
          discarded = true;
        }
      }
      if (pending?.size === 0) staged.delete(sessionId);
      return discarded;
    },
    protected(sessionId: string, id: string): boolean {
      const entry = staged.get(sessionId)?.get(`asi-sense:${id}`);
      return !!entry && (entry.returned || (!!entry.step && steps.get(sessionId) === entry.step));
    },
  });
}
