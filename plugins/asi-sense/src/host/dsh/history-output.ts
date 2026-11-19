import { createHash } from 'node:crypto';
import path from 'node:path';
import type { SourceRef } from '@asi/sense-types';
import { isHomeRoot } from '../attention/path.ts';
import type {
  DailyDirectoryStats,
  HistoryQueryResult,
  PersistedEventEntry,
  SummaryQueryResult,
} from '../runtime/ports.ts';
import { modelActivityName, modelFileEntry } from './deliver.ts';
import { KNOWN_EVENT_KINDS } from './kinds.ts';
import { modelAppName, modelOutput, modelPath, modelProjectedOutput, modelText, modelTitle } from './tool-output.ts';
import type { JsonValue } from './wire-types.ts';

export { KNOWN_EVENT_KINDS };

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
  'files-global',
  'files-global-denied',
  'watch',
  'system',
  'screen',
  'session',
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
  'delivery-unknown',
]);

const VALID_LEVELS = new Set(['record', 'context', 'wake']);
const VALID_CAUSES = new Set(['agent', 'user', 'unknown']);
const VALID_FEEDBACK = new Set(['useful', 'noise']);
const STRICT_WORD_ID_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$/;
const STRICT_COLON_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$/;
const HELPER_DROPPED_REASON_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63} \(dropped=\d{1,12}\)$/;
const HASHED_SIGNAL_ID_RE = /^(?:body\.rate|file\.burst):[A-Za-z0-9_-]{1,100}$/;
const CUSTOM_EVENT_KIND_RE = /^[a-z]+(?:\.[a-z-]+)+$/;

function safeIdentifier(value: string): string {
  if (SAFE_IDENTIFIERS.has(value)) return value;
  return STRICT_WORD_ID_RE.test(value) ? value : '[redacted]';
}

function safeEventKind(kind: string): string {
  if (KNOWN_EVENT_KINDS.has(kind)) return kind;
  return kind.length <= 128 && CUSTOM_EVENT_KIND_RE.test(kind) ? kind : '[redacted]';
}

function safeEventLevel(level: string): string {
  return VALID_LEVELS.has(level) ? level : '[redacted]';
}

function safeEventCause(cause: string): string {
  return VALID_CAUSES.has(cause) ? cause : '[redacted]';
}

function safeFeedback(feedback: string): string {
  return VALID_FEEDBACK.has(feedback) ? feedback : '[redacted]';
}

function safeReason(reason: string): string {
  return STRICT_COLON_ID_RE.test(reason) || HELPER_DROPPED_REASON_RE.test(reason) ? reason : '[redacted]';
}

function projectPathBase(value: string): string {
  if (isHomeRoot(value)) return '~';
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

const COMMAND_BASENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
const SAFE_COMMAND_NAME_RE = /^[A-Za-z][A-Za-z0-9+_-]*(?:\d+(?:\.\d+){0,2})?$/;
const SAFE_APP_BUNDLE_COMMAND_RE = /^[A-Za-z][A-Za-z0-9+_-]*\.app$/;
const VERSIONED_COMMAND_RE = /^[A-Za-z][A-Za-z0-9_+-]*\d+(?:\.\d+){1,2}$/;
const EXECUTABLE_EXTENSIONS = new Set([
  'sh',
  'bash',
  'zsh',
  'fish',
  'ksh',
  'csh',
  'dash',
  'py',
  'pyw',
  'rb',
  'pl',
  'pm',
  'php',
  'lua',
  'tcl',
  'js',
  'mjs',
  'cjs',
  'ts',
  'mts',
  'cts',
  'jsx',
  'tsx',
  'exe',
  'bat',
  'cmd',
  'ps1',
  'psm1',
  'vbs',
  'wsf',
  'bin',
  'out',
  'run',
  'jar',
  'awk',
  'expect',
  'scpt',
  'applescript',
]);
const PARTIAL_SUMMARY_NOTE =
  'Monthly summary is partial because daily backfill for some days is still pending or failed; retry later for complete data.';

interface WrapperSpec {
  noArgFlags: Set<string>;
  argFlags: Set<string>;
  consumesDurationPositional?: boolean;
  allowsNumericDash?: boolean;
}

const WRAPPER_SPECS: Record<string, WrapperSpec> = {
  env: {
    noArgFlags: new Set(['i', '0', 'v', '--ignore-environment', '--null', '--debug', '--help', '--version']),
    argFlags: new Set([
      'u',
      'C',
      'S',
      'P',
      '--unset',
      '--chdir',
      '--split-string',
      '--default-signal',
      '--ignore-signal',
      '--block-signal',
    ]),
  },
  sudo: {
    noArgFlags: new Set([
      'A',
      'b',
      'E',
      'H',
      'i',
      'K',
      'k',
      'l',
      'n',
      'P',
      'S',
      's',
      'v',
      'V',
      '--askpass',
      '--background',
      '--bell',
      '--edit',
      '--help',
      '--interactive',
      '--kill',
      '--list',
      '--login',
      '--non-interactive',
      '--preserve-env',
      '--remove-timestamp',
      '--reset-timestamp',
      '--shell',
      '--stdin',
      '--validate',
      '--version',
    ]),
    argFlags: new Set([
      'a',
      'C',
      'c',
      'D',
      'g',
      'h',
      'p',
      'R',
      'r',
      't',
      'T',
      'U',
      'u',
      '--auth-type',
      '--chdir',
      '--chroot',
      '--close-from',
      '--command-timeout',
      '--group',
      '--host',
      '--other-user',
      '--preserve-env',
      '--prompt',
      '--role',
      '--type',
      '--user',
    ]),
  },
  nohup: {
    noArgFlags: new Set(['--help', '--version']),
    argFlags: new Set(),
  },
  exec: {
    noArgFlags: new Set(['c', 'l']),
    argFlags: new Set(['a']),
  },
  time: {
    noArgFlags: new Set(['p', 'l', 'h', 'v', 'q', 'a', 'P', '--verbose', '--quiet', '--append', '--portability']),
    argFlags: new Set(['f', 'o', '--format', '--output']),
  },
  command: {
    noArgFlags: new Set(['p', 'v', 'V']),
    argFlags: new Set(),
  },
  nice: {
    noArgFlags: new Set(['--help', '--version']),
    argFlags: new Set(['n', '--adjustment']),
    allowsNumericDash: true,
  },
  timeout: {
    noArgFlags: new Set(['v', '--preserve-status', '--foreground', '--verbose', '--help', '--version']),
    argFlags: new Set(['k', 's', '--kill-after', '--signal']),
    consumesDurationPositional: true,
  },
  stdbuf: {
    noArgFlags: new Set(['--help', '--version']),
    argFlags: new Set(['i', 'o', 'e', '--input', '--output', '--error']),
  },
};

interface CommandToken {
  value: string;
  isEnvAssign: boolean;
}

function tokenizeCommandPrefix(raw: string): CommandToken[] {
  const tokens: CommandToken[] = [];
  let i = 0;
  const len = raw.length;
  while (i < len && tokens.length < 128) {
    while (i < len && /\s/.test(raw[i])) i++;
    if (i >= len) break;
    let value = '';
    let sawQuoteOrEscapeBeforeEq = false;
    let eqAt = -1;
    const windowsDrive = /^[A-Za-z]:\\/.test(raw.slice(i));
    while (i < len && !/\s/.test(raw[i])) {
      const ch = raw[i];
      if (ch === '"' || ch === "'") {
        if (eqAt < 0) sawQuoteOrEscapeBeforeEq = true;
        const quote = ch;
        i++;
        while (i < len && raw[i] !== quote) {
          if (raw[i] === '\\' && quote === '"' && i + 1 < len && (raw[i + 1] === '"' || raw[i + 1] === '\\')) {
            i++;
          }
          value += raw[i++];
        }
        if (i < len && raw[i] === quote) i++;
      } else if (ch === '\\' && !windowsDrive) {
        if (eqAt < 0) sawQuoteOrEscapeBeforeEq = true;
        i++;
        if (i < len) value += raw[i++];
      } else {
        if (ch === '=' && eqAt < 0) eqAt = value.length;
        value += ch;
        i++;
      }
    }
    const isEnvAssign = eqAt > 0 && !sawQuoteOrEscapeBeforeEq && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value.slice(0, eqAt));
    tokens.push({ value, isEnvAssign });
  }
  return tokens;
}

function wrapperNameForToken(token: string): string | undefined {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token)) return undefined;
  const normalized = token.replaceAll('\\', '/').replace(/\/+$/, '');
  const base = path.posix.basename(normalized);
  return Object.hasOwn(WRAPPER_SPECS, base) ? base : undefined;
}

function consumeWrapperOptions(
  tokens: readonly CommandToken[],
  startIndex: number,
  spec: WrapperSpec,
): number | undefined {
  let idx = startIndex;
  while (idx < tokens.length) {
    const tok = tokens[idx];
    if (tok.isEnvAssign) return idx;
    const v = tok.value;
    if (v === '--') {
      idx++;
      break;
    }
    if (!v.startsWith('-') || v === '-') {
      break;
    }
    if (spec.allowsNumericDash && /^-\d+$/.test(v)) {
      idx++;
      continue;
    }
    if (v.startsWith('--')) {
      const eq = v.indexOf('=');
      if (eq >= 0) {
        const flag = v.slice(0, eq);
        if (!spec.argFlags.has(flag) && !spec.noArgFlags.has(flag)) return undefined;
        idx++;
        continue;
      }
      if (spec.argFlags.has(v)) {
        idx += 2;
        if (idx > tokens.length) return undefined;
        continue;
      }
      if (spec.noArgFlags.has(v)) {
        idx++;
        continue;
      }
      return undefined;
    }
    // Short options cluster (e.g. -iu VAR, -uVAR)
    let nextIdx = idx + 1;
    for (let k = 1; k < v.length; k++) {
      const flag = v[k];
      if (spec.argFlags.has(flag)) {
        if (k + 1 >= v.length) {
          if (idx + 1 >= tokens.length) return undefined;
          nextIdx = idx + 2;
        }
        break;
      }
      if (!spec.noArgFlags.has(flag)) return undefined;
    }
    idx = nextIdx;
  }
  if (spec.consumesDurationPositional) {
    if (idx >= tokens.length || tokens[idx].isEnvAssign) return undefined;
    idx++;
  }
  return idx < tokens.length ? idx : undefined;
}

function extractExecutableToken(raw: string): string | undefined {
  const tokens = tokenizeCommandPrefix(raw);
  let idx = 0;
  while (idx < tokens.length) {
    const tok = tokens[idx];
    if (tok.isEnvAssign) {
      idx++;
      continue;
    }
    const wrapperName = wrapperNameForToken(tok.value);
    if (wrapperName) {
      if (idx + 1 >= tokens.length) return tok.value;
      const nextIdx = consumeWrapperOptions(tokens, idx + 1, WRAPPER_SPECS[wrapperName]);
      if (nextIdx === undefined) return undefined;
      idx = nextIdx;
      continue;
    }
    return tok.value;
  }
  return undefined;
}

function isSafeCommandBasename(base: string): boolean {
  if (!COMMAND_BASENAME_RE.test(base)) return false;
  if (!/[A-Za-z]/.test(base)) return false;
  if (!base.includes('.')) return true;
  if (SAFE_COMMAND_NAME_RE.test(base) || VERSIONED_COMMAND_RE.test(base)) return true;
  if (SAFE_APP_BUNDLE_COMMAND_RE.test(base)) return true;
  const parts = base.split('.');
  if (parts.length !== 2 || !parts[0] || !/[A-Za-z]/.test(parts[0])) return false;
  return EXECUTABLE_EXTENSIONS.has(parts[1].toLowerCase());
}

function projectCommandSubject(subject: string): string {
  const trimmed = subject.trim();
  if (!trimmed) return '';
  const token = extractExecutableToken(trimmed);
  if (!token) return '[command]';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token)) return '[command]';
  if (token.includes(':') && !/^[A-Za-z]:[/\\]/.test(token)) return '[command]';
  const normalized = token.replaceAll('\\', '/').replace(/\/+$/, '');
  const base = path.posix.basename(normalized);
  if (!base || !isSafeCommandBasename(base)) return '[command]';
  return base;
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
  if (HASHED_SIGNAL_ID_RE.test(id)) return id;
  let diskError = false;
  const replaced = id.replace(/disk:([^:]+)/g, (_match, mount: string) => {
    const safeMount = projectDiskMount(mount);
    if (!safeMount || safeMount.includes(':')) diskError = true;
    return `disk:${safeMount}`;
  });
  if (diskError || replaced.length > 256) return '[redacted]';
  const template = id.replace(/disk:([^:]+)/g, 'disk:mount');
  return STRICT_COLON_ID_RE.test(template) ? replaced : '[redacted]';
}

function projectSource(source: SourceRef): { id: string; api: string } {
  const id = source.id.startsWith('files:')
    ? `files:r-${createHash('sha256').update(source.id.slice('files:'.length)).digest('hex').slice(0, 8)}`
    : safeIdentifier(source.id);
  return { id, api: safeIdentifier(source.api) };
}

function projectDetail(
  detail: Record<string, string | number | boolean | string[]> | undefined,
): Record<string, string | number | boolean | string[]> | undefined {
  if (!detail) return undefined;
  const rawDirectory =
    typeof detail.directory === 'string' ? detail.directory : typeof detail.dir === 'string' ? detail.dir : undefined;
  const out: Record<string, string | number | boolean | string[]> = {};
  for (const [key, value] of Object.entries(detail)) {
    if (Array.isArray(value)) {
      if (key === 'files') {
        const files = value
          .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
          .slice(0, 5)
          .map((item) => modelFileEntry(rawDirectory, item));
        if (files.length > 0) out[key] = files;
      } else {
        const items = value.filter((item): item is string => typeof item === 'string').map((item) => modelText(item));
        if (items.length > 0) out[key] = items;
      }
      continue;
    }
    if (typeof value !== 'string') {
      out[key] = value;
      continue;
    }
    if (key === 'directory' || key === 'dir') out[key] = modelActivityName(value, true);
    else if (key === 'metric') out[key] = projectMetric(value);
    else if (key === 'ruleId' || key === 'type' || key === 'severity' || key === 'direction' || key === 'confidence') {
      out[key] = safeIdentifier(value);
    } else out[key] = modelText(value);
  }
  return out;
}

function projectAppSubject(value: string): string {
  const cleaned = modelAppName(value);
  if (
    /^(?:~?[/\\]|[A-Za-z]:[/\\])/.test(cleaned) ||
    /[/\\].*[/\\]/.test(cleaned) ||
    /[/\\][^/\\]+\.app$/i.test(cleaned)
  ) {
    const normalized = cleaned.replaceAll('\\', '/').replace(/\/+$/, '');
    const base = path.posix.basename(normalized);
    if (base) return modelAppName(base);
  }
  return cleaned;
}

function projectSubject(entry: PersistedEventEntry): string {
  if (entry.kind.startsWith('app.') || entry.kind.startsWith('window')) {
    return projectAppSubject(entry.subject);
  }
  if (entry.kind.startsWith('file.')) {
    return modelActivityName(entry.subject, true);
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
  if (entry.kind.startsWith('system.') || entry.kind.startsWith('screen.') || entry.kind.startsWith('session.')) {
    return safeIdentifier(entry.subject);
  }
  return modelText(entry.subject);
}

function projectEvent(entry: PersistedEventEntry, titlesAllowed: boolean): Record<string, unknown> {
  const isWindow = entry.kind.startsWith('window');
  const safeId = projectEventId(entry.id);
  const safeKind = safeEventKind(entry.kind);
  const safeLevel = safeEventLevel(entry.level);
  if (isWindow && !titlesAllowed) {
    return {
      id: safeId,
      kind: safeKind,
      subject: '',
      level: safeLevel,
      at: entry.at,
      ...(entry.cause !== undefined ? { cause: safeEventCause(entry.cause) } : {}),
      source: projectSource(entry.source),
      ...(entry.feedback !== undefined ? { feedback: safeFeedback(entry.feedback) } : {}),
    };
  }
  const detail = projectDetail(entry.detail);
  return {
    id: safeId,
    kind: safeKind,
    subject: projectSubject(entry),
    level: safeLevel,
    at: entry.at,
    // `modelProjectedOutput` applies `modelTitle` once via `minimize` on `.title` paths.
    ...(isWindow && entry.title !== undefined ? { title: entry.title } : {}),
    ...(entry.reason !== undefined ? { reason: safeReason(entry.reason) } : {}),
    ...(entry.ruleId !== undefined ? { ruleId: safeIdentifier(entry.ruleId) } : {}),
    ...(entry.cause !== undefined ? { cause: safeEventCause(entry.cause) } : {}),
    ...(entry.restarts !== undefined ? { restarts: entry.restarts } : {}),
    source: projectSource(entry.source),
    ...(detail !== undefined ? { detail } : {}),
    ...(entry.currentEta !== undefined ? { currentEta: entry.currentEta } : {}),
    ...(entry.feedback !== undefined ? { feedback: safeFeedback(entry.feedback) } : {}),
    ...(entry.feedbackAvailable !== undefined ? { feedbackAvailable: entry.feedbackAvailable } : {}),
  };
}

const HISTORY_PREPROJECTED_PATHS = [
  'events.id',
  'events.kind',
  'events.subject',
  'events.level',
  'events.reason',
  'events.ruleId',
  'events.cause',
  'events.source.id',
  'events.source.api',
  'events.feedback',
  'events.detail.directory',
  'events.detail.dir',
  'events.detail.files',
  'events.detail.metric',
  'events.detail.ruleId',
  'events.detail.type',
  'events.detail.severity',
  'events.detail.direction',
  'events.detail.confidence',
] as const;

const SUMMARY_PREPROJECTED_DICT_PATHS = [
  'summary.apps',
  'summary.deliveries.byRule',
  'summary.fileBursts',
  'summary.fileActivity',
  'summary.bodyAnomalies.byMetric',
] as const;

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
    const candidate = modelProjectedOutput(
      {
        available: true,
        from: result.from,
        to: result.to,
        ...(result.rangeClamped ? { rangeClamped: true, note: result.note } : {}),
        limit: result.limit,
        total: result.total,
        truncated,
        titlesAllowed: result.titlesAllowed,
        events,
      },
      HISTORY_PREPROJECTED_PATHS,
    );
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

function isAvailableResult(value: JsonValue): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, 'available');
}

function sliceRecord<V>(entries: ReadonlyArray<[string, V]>, count: number): Record<string, V> {
  const out: Record<string, V> = Object.create(null);
  for (let i = 0; i < count && i < entries.length; i++) {
    const [k, v] = entries[i];
    out[k] = v;
  }
  return out;
}

function fitTopEntries<V>(
  sortedEntries: ReadonlyArray<[string, V]>,
  render: (subset: Record<string, V>, truncated: boolean) => JsonValue,
): { out: JsonValue; truncated: boolean } | undefined {
  const full = render(sliceRecord(sortedEntries, sortedEntries.length), false);
  if (isAvailableResult(full)) {
    return { out: full, truncated: false };
  }
  let lo = 0;
  let hi = sortedEntries.length - 1;
  let bestOut: JsonValue | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const candidate = render(sliceRecord(sortedEntries, mid), true);
    if (isAvailableResult(candidate)) {
      bestOut = candidate;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (bestOut === undefined) return undefined;
  return { out: bestOut, truncated: true };
}

function sortDirEntries(record: Record<string, DailyDirectoryStats>): Array<[string, DailyDirectoryStats]> {
  return Object.entries(record).sort(
    ([ak, a], [bk, b]) =>
      b.events - a.events ||
      b.created + b.modified + b.deleted - (a.created + a.modified + a.deleted) ||
      ak.localeCompare(bk),
  );
}

export function modelSummary(result: SummaryQueryResult): JsonValue {
  if (!result.available) return modelOutput(result);
  const s = result.summary;
  const partial = Boolean(result.partial || s.partial);
  const pendingDays = partial ? (result.pendingDays ?? []).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)) : undefined;
  const partialNote = partial ? (result.note ?? PARTIAL_SUMMARY_NOTE) : undefined;

  const apps = projectRecord(s.apps, projectAppSubject, (a, b) => ({
    foregroundMs: a.foregroundMs + b.foregroundMs,
    switches: a.switches + b.switches,
  }));
  const byRule = projectRecord(s.deliveries.byRule, safeIdentifier, (a, b) => ({
    wake: a.wake + b.wake,
    context: a.context + b.context,
    suppressed: a.suppressed + b.suppressed,
  }));
  const fileBursts = projectRecord(s.fileBursts, (key) => modelActivityName(key, true), mergeDirStats);
  const fileActivity = projectRecord(s.fileActivity, (key) => modelActivityName(key, true), mergeDirStats);
  const byMetric = projectRecord(s.bodyAnomalies.byMetric, projectMetric, (a, b) => a + b);

  const buildPayload = (
    fa: Record<string, DailyDirectoryStats>,
    faTruncated: boolean,
    overrides?: {
      apps?: Record<string, (typeof s.apps)[string]>;
      byRule?: Record<string, (typeof s.deliveries.byRule)[string]>;
      fileBursts?: Record<string, DailyDirectoryStats>;
      byMetric?: Record<string, number>;
      extraTruncated?: boolean;
    },
  ) => {
    const notes: string[] = [];
    if (partialNote) notes.push(partialNote);
    if (faTruncated) {
      notes.push('fileActivity was truncated to fit the output size limit; top active directories are shown.');
    }
    if (overrides?.extraTruncated) {
      notes.push('Additional summary breakdown maps were truncated to fit the output size limit.');
    }
    const note = notes.length > 0 ? notes.join(' ') : undefined;
    return {
      available: true,
      ...(partial ? { partial: true } : {}),
      ...(pendingDays && pendingDays.length > 0 ? { pendingDays } : {}),
      ...(faTruncated ? { fileActivityTruncated: true } : {}),
      ...(note ? { note } : {}),
      summary: {
        ...s,
        ...(partial ? { partial: true } : {}),
        apps: overrides?.apps ?? apps,
        deliveries: {
          ...s.deliveries,
          byRule: overrides?.byRule ?? byRule,
        },
        fileBursts: overrides?.fileBursts ?? fileBursts,
        fileActivity: fa,
        bodyAnomalies: {
          ...s.bodyAnomalies,
          byMetric: overrides?.byMetric ?? byMetric,
        },
      },
    };
  };

  const sortedFa = sortDirEntries(fileActivity);
  const faFit = fitTopEntries(sortedFa, (faSubset, faTruncated) =>
    modelProjectedOutput(buildPayload(faSubset, faTruncated), [], SUMMARY_PREPROJECTED_DICT_PATHS),
  );
  if (faFit) return faFit.out;

  const emptyFa: Record<string, DailyDirectoryStats> = Object.create(null);
  const faTruncated = sortedFa.length > 0;
  const curApps = apps;
  const curByRule = byRule;
  const curBursts = fileBursts;
  const curByMetric = byMetric;

  const burstFit = fitTopEntries(sortDirEntries(curBursts), (sub) =>
    modelProjectedOutput(
      buildPayload(emptyFa, faTruncated, {
        apps: curApps,
        byRule: curByRule,
        fileBursts: sub,
        byMetric: curByMetric,
        extraTruncated: true,
      }),
      [],
      SUMMARY_PREPROJECTED_DICT_PATHS,
    ),
  );
  if (burstFit) return burstFit.out;
  const noBursts: Record<string, DailyDirectoryStats> = Object.create(null);

  const sortedApps = Object.entries(curApps).sort(
    ([ak, a], [bk, b]) => b.foregroundMs - a.foregroundMs || b.switches - a.switches || ak.localeCompare(bk),
  );
  const appsFit = fitTopEntries(sortedApps, (sub) =>
    modelProjectedOutput(
      buildPayload(emptyFa, faTruncated, {
        apps: sub,
        byRule: curByRule,
        fileBursts: noBursts,
        byMetric: curByMetric,
        extraTruncated: true,
      }),
      [],
      SUMMARY_PREPROJECTED_DICT_PATHS,
    ),
  );
  if (appsFit) return appsFit.out;
  const noApps: Record<string, (typeof s.apps)[string]> = Object.create(null);

  const sortedRules = Object.entries(curByRule).sort(
    ([ak, a], [bk, b]) =>
      b.wake + b.context + b.suppressed - (a.wake + a.context + a.suppressed) || ak.localeCompare(bk),
  );
  const ruleFit = fitTopEntries(sortedRules, (sub) =>
    modelProjectedOutput(
      buildPayload(emptyFa, faTruncated, {
        apps: noApps,
        byRule: sub,
        fileBursts: noBursts,
        byMetric: curByMetric,
        extraTruncated: true,
      }),
      [],
      SUMMARY_PREPROJECTED_DICT_PATHS,
    ),
  );
  if (ruleFit) return ruleFit.out;
  const noRules: Record<string, (typeof s.deliveries.byRule)[string]> = Object.create(null);

  const sortedMetrics = Object.entries(curByMetric).sort(([ak, a], [bk, b]) => b - a || ak.localeCompare(bk));
  const metricFit = fitTopEntries(sortedMetrics, (sub) =>
    modelProjectedOutput(
      buildPayload(emptyFa, faTruncated, {
        apps: noApps,
        byRule: noRules,
        fileBursts: noBursts,
        byMetric: sub,
        extraTruncated: true,
      }),
      [],
      SUMMARY_PREPROJECTED_DICT_PATHS,
    ),
  );
  if (metricFit) return metricFit.out;

  return modelProjectedOutput(
    buildPayload(emptyFa, faTruncated, {
      apps: Object.create(null),
      byRule: Object.create(null),
      fileBursts: Object.create(null),
      byMetric: Object.create(null),
      extraTruncated: true,
    }),
    [],
    SUMMARY_PREPROJECTED_DICT_PATHS,
  );
}
