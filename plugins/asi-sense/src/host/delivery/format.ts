import type { EnvChange, EnvUpdate, Signal } from '@asi/sense-types';
import { sanitizeForModel, sanitizeModelId, sanitizeSignalId } from '../dsh/credential-scan.ts';
import { isAnomalousAwayMetric } from '../runtime/away.ts';

/** Options for {@link formatEnvUpdate}. */
export interface FormatOptions {
  /**
   * Include window titles in output (DESIGN §4: on by default; when off the
   * whole window change is omitted — nothing else about it is serialized).
   * @default true
   */
  includeWindowTitles?: boolean;
  includeJobCommands?: boolean;
}

const WINDOW_KINDS: ReadonlySet<string> = new Set(['window.focused', 'window.title-changed']);

/** Escapes markup metacharacters and flattens control chars to a space. */
function esc(s: string): string {
  let out = '';
  for (const ch of s) {
    if (ch === '&') out += '&amp;';
    else if (ch === '<') out += '&lt;';
    else if (ch === '>') out += '&gt;';
    else if (ch === '"') out += '&quot;';
    else if (ch === "'") out += '&#39;';
    else if (ch < ' ' || ch === '\x7F') out += ' ';
    else out += ch;
  }
  return out;
}

function str(v: unknown): string {
  return typeof v === 'string' ? sanitizeForModel(v) : '';
}

function safeEsc(v: unknown): string {
  return esc(str(v));
}

function fin(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Splits `file.burst` deletions into external vs agent counts, suppressing total `deleted` when mixed. */
export function resolveBurstDeletions(data: Record<string, unknown>) {
  const agentDeleted = fin(data.agentDeleted) && data.agentDeleted >= 0 ? data.agentDeleted : undefined;
  const externalDeleted =
    fin(data.externalDeleted) && data.externalDeleted >= 0
      ? data.externalDeleted
      : fin(data.deleted) && agentDeleted !== undefined && data.deleted >= agentDeleted
        ? data.deleted - agentDeleted
        : undefined;
  return { externalDeleted, agentDeleted, skipMixedDeleted: externalDeleted !== undefined && (agentDeleted ?? 0) > 0 };
}

function fileVerb(change: unknown): 'created' | 'saved' | 'deleted' | 'renamed' {
  if (change === 'add' || change === 'create' || change === 'created') return 'created';
  if (change === 'delete' || change === 'deleted') return 'deleted';
  if (change === 'rename' || change === 'renamed') return 'renamed';
  return 'saved';
}

/** UTC HH:mm:ss — deterministic, locale- and timezone-independent. */
function hhmmss(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19);
}

function compactDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (hours > 0) return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`;
  return `${minutes}m`;
}

function percentDelta(current: number, start: number): string | undefined {
  if (!Number.isFinite(current) || !Number.isFinite(start) || start <= 0) return undefined;
  const ratio = (current - start) / start;
  return `${ratio >= 0 ? '+' : ''}${Math.round(ratio * 100)}%`;
}

const MAX_AWAY_FORMAT_BYTES = 2048;

function truncateEscapedRaw(raw: string, maxEscapedBytes: number): string {
  const escaped = esc(raw);
  if (Buffer.byteLength(escaped, 'utf8') <= maxEscapedBytes) return escaped;
  if (maxEscapedBytes <= 3) return '';
  const limit = maxEscapedBytes - 3;
  let out = '';
  let bytes = 0;
  for (const ch of raw) {
    const piece = esc(ch);
    const pieceBytes = Buffer.byteLength(piece, 'utf8');
    if (bytes + pieceBytes > limit) break;
    out += piece;
    bytes += pieceBytes;
  }
  return `${out}...`;
}

function truncateUtf8Line(line: string, maxBytes: number): string {
  if (Buffer.byteLength(line, 'utf8') <= maxBytes) return line;
  if (maxBytes <= 3) return '.'.repeat(Math.max(0, maxBytes));
  const limit = maxBytes - 3;
  let bytes = 0;
  let i = 0;
  while (i < line.length) {
    const cp = line.codePointAt(i) ?? 0;
    const charLen = cp > 0xffff ? 2 : 1;
    const utf8Len = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    if (bytes + utf8Len > limit) break;
    bytes += utf8Len;
    i += charLen;
  }
  let head = line.slice(0, i);
  // Avoid cutting inside an XML entity such as `&amp;` or `&#39;`.
  const amp = head.lastIndexOf('&');
  if (amp >= 0 && head.indexOf(';', amp) === -1) {
    head = head.slice(0, amp);
  }
  return `${head}...`;
}

function awayMetricLabel(entry: Record<string, unknown>): string | undefined {
  const name = str(entry.metric);
  if (!name) return undefined;
  const ratioMin = entry.ratioMin;
  if ((name === 'disk' || name === 'battery') && typeof ratioMin === 'number' && Number.isFinite(ratioMin)) {
    return `${name}=${Math.round(ratioMin * 100)}%`;
  }
  const start = entry.start;
  const end = entry.end;
  if (typeof start === 'number' && typeof end === 'number') {
    const delta = percentDelta(end, start);
    if (delta) return `${name}=${delta}`;
  }
  return name;
}

function durationMs(s: Signal): number | undefined {
  if (typeof s.data.durationMs === 'number' && Number.isFinite(s.data.durationMs)) {
    return s.data.durationMs;
  }
  if (typeof s.data.startedAt === 'number' && Number.isFinite(s.data.startedAt)) {
    const d = s.at - s.data.startedAt;
    return d >= 0 ? d : undefined;
  }
  return undefined;
}

function changeLines(ch: EnvChange, includeTitles: boolean, includeJobCommands: boolean): string[] {
  const s = ch.signal;
  let main: string;
  const summary = s.data.jobSummary;
  if (summary && typeof summary === 'object' && !Array.isArray(summary)) {
    const { total, omitted, recent } = summary as Record<string, unknown>;
    if (fin(total) && fin(omitted) && Array.isArray(recent)) {
      return [
        `jobs: ${total} events`,
        ...recent.flatMap((item: unknown) => {
          if (!item || typeof item !== 'object') return [];
          const { id, kind, count, exitCode } = item as Record<string, unknown>;
          if (typeof id !== 'string' || !id.trim() || !['job.exited', 'job.started'].includes(String(kind))) return [];
          return [
            `job: \`${safeEsc(id)}\` ${kind === 'job.exited' ? 'exited' : 'started'}${fin(exitCode) ? ` ${exitCode}` : ''}${fin(count) && count > 1 ? ` ×${count}` : ''}`,
          ];
        }),
        ...(omitted > 0 ? [`另有 ${omitted} 个未列出`] : []),
      ];
    }
  }
  if (s.kind === 'app.activated') {
    main = `front-app: ${safeEsc(typeof s.data.name === 'string' ? s.data.name : s.subject)}`;
    const prev = str(s.data.previousName);
    if (prev) main += ` (was: ${esc(prev)})`;
  } else if (s.kind === 'app.launched' || s.kind === 'app.terminated') {
    const verb = s.kind === 'app.launched' ? 'launched' : 'terminated';
    main = `app: ${esc(str(s.data.name) || str(s.subject))} ${verb}`;
  } else if (WINDOW_KINDS.has(s.kind)) {
    if (!includeTitles) return [];
    main = `window: ${safeEsc(s.data.title)}`;
  } else if (s.kind === 'file.changed') {
    const path = str(s.data.path) || str(s.subject);
    main = `file: ${esc(path)} ${fileVerb(s.data.change)}${ch.count > 1 ? ` ×${ch.count}` : ''}`;
  } else if (s.kind === 'job.started' || s.kind === 'process.started') {
    const label = s.kind === 'job.started' ? 'job' : 'process';
    const idText = str(s.data.id).trim() ? str(s.data.id) : str(s.subject) || label;
    main = `${label}: \`${esc(idText)}\` started`;
  } else if (s.kind === 'job.failed') {
    const idText = str(s.data.id).trim() ? str(s.data.id) : str(s.subject) || 'job';
    const cmd = includeJobCommands ? str(s.data.command) || idText : idText;
    main = `job.failed: \`${esc(cmd)}\``;
    if (typeof s.data.exitCode === 'number' && Number.isFinite(s.data.exitCode)) main += ` ${s.data.exitCode}`;
    const dur = durationMs(s);
    if (dur !== undefined) main += ` after ${Math.round(dur / 1000)}s`;
  } else if (s.kind === 'job.exited' || s.kind === 'process.exited') {
    const label = s.kind === 'job.exited' ? 'job' : 'process';
    const idText = str(s.data.id).trim() ? str(s.data.id) : label;
    const cmd = includeJobCommands ? str(s.data.command) || str(s.subject) || idText : idText;
    main = `${label}: \`${esc(cmd)}\` exited`;
    if (typeof s.data.exitCode === 'number' && Number.isFinite(s.data.exitCode)) main += ` ${s.data.exitCode}`;
    const dur = durationMs(s);
    if (dur !== undefined) main += ` after ${Math.round(dur / 1000)}s`;
  } else if (s.kind === 'body.threshold') {
    main = `body: ${safeEsc(s.subject)} ${esc(str(s.data.severity) || '?')}`;
    const v = s.data.value;
    if (typeof v === 'number' && Number.isFinite(v)) main += ` ${v}`;
    else if (typeof v === 'string') main += ` ${safeEsc(v)}`;
  } else if (s.kind === 'body.anomaly' && s.data.type === 'rebaseline-suggestion') {
    const target = str(s.data.metric) || str(s.subject).replace(/^(?:rebaseline|baseline):/, '') || str(s.subject);
    main = `建议重新基线：${esc(target)}`;
  } else if (s.kind === 'body.rate' || s.kind === 'body.anomaly' || s.kind === 'file.burst') {
    const directory = typeof s.data?.directory === 'string' && s.data.directory.trim() ? str(s.data.directory) : '';
    const head = s.kind === 'file.burst' ? directory || str(s.subject) || '[path]' : str(s.subject);
    main = `${esc(s.kind)}: ${esc(head)}`;
    const safeMetric = str(s.data.metric);
    if (s.kind !== 'file.burst' && safeMetric && safeMetric !== str(s.subject)) {
      main += ` metric=${esc(safeMetric)}`;
    }
    if (typeof s.data.ruleId === 'string') main += ` ruleId=${esc(sanitizeModelId(s.data.ruleId).value)}`;
    if (typeof s.data.severity === 'string') main += ` ${safeEsc(s.data.severity)}`;
    const etaKey =
      typeof s.data.etaToFloorMs === 'number' && Number.isFinite(s.data.etaToFloorMs)
        ? 'etaToFloorMs'
        : 'timeToFloorMs';
    const { externalDeleted: burstExt, skipMixedDeleted } =
      s.kind === 'file.burst' ? resolveBurstDeletions(s.data) : { externalDeleted: undefined, skipMixedDeleted: false };
    for (const key of [
      'value',
      'baseline',
      'deviation',
      'slope',
      'delta',
      etaKey,
      'windowMs',
      'created',
      'modified',
      'deleted',
      'externalDeleted',
      'agentDeleted',
    ]) {
      if (key === 'deleted' && skipMixedDeleted) continue;
      const value = key === 'externalDeleted' && burstExt !== undefined ? burstExt : s.data[key];
      if (typeof value === 'number' && Number.isFinite(value)) {
        main += key === 'deviation' ? ` ${key}=${value}σ` : ` ${key}=${value}`;
      }
    }
    if (s.data.externalDeletionExceeded === true) main += ' externalDeletionExceeded=true';
    if (s.kind === 'file.burst' && s.data.rolledUp === true) main += ' rolledUp=true';
  } else if (s.kind === 'file.activity') {
    const directory = typeof s.data?.directory === 'string' && s.data.directory.trim() ? str(s.data.directory) : '';
    const head = directory || str(s.subject) || '[path]';
    main = `file.activity: ${esc(head)}`;
    for (const key of ['windowMs', 'created', 'modified', 'deleted']) {
      const value = s.data?.[key];
      if (typeof value === 'number' && Number.isFinite(value)) {
        main += ` ${key}=${value}`;
      }
    }
    if (typeof s.data?.rolledUp === 'number' && Number.isFinite(s.data.rolledUp) && s.data.rolledUp > 0) {
      main += ` rolledUp=${s.data.rolledUp}`;
    }
    if (Array.isArray(s.data?.files)) {
      const files = s.data.files
        .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        .slice(0, 5)
        .map((item) => safeEsc(item));
      if (files.length > 0) main += ` files=[${files.join(', ')}]`;
    }
    if (s.data?.degraded === true) main += ' degraded=true';
  } else if (s.kind === 'source.status') {
    const src = str(s.data.source) || str(s.subject);
    main = `source.status: ${esc(src)}`;
    const status = str(s.data.status);
    if (status) main += ` status=${esc(status)}`;
    const path = str(s.data.path);
    if (path) main += ` path=${esc(path)}`;
    const reason = str(s.data.reason);
    if (reason) main += ` reason=${esc(reason)}`;
    const error = str(s.data.error);
    if (error && error !== reason) main += ` error=${esc(error)}`;
  } else if (s.kind === 'source.error') {
    const src = str(s.data.source) || str(s.subject);
    main = `source.error: ${esc(src)}`;
    const error = str(s.data.error) || str(s.data.category);
    if (error) main += ` error=${esc(error)}`;
    const status = str(s.data.status);
    if (status) main += ` status=${esc(status)}`;
    const reason = str(s.data.reason);
    if (reason && reason !== error) main += ` reason=${esc(reason)}`;
  } else if (
    s.kind === 'system.sleep' ||
    s.kind === 'system.wake' ||
    s.kind === 'screen.locked' ||
    s.kind === 'screen.unlocked' ||
    s.kind === 'session.active' ||
    s.kind === 'session.inactive'
  ) {
    const [domain, verb] = s.kind.split('.');
    main = `${esc(domain)}: ${esc(verb)}`;
    const dur = durationMs(s);
    if (dur !== undefined) main += ` after ${Math.round(dur / 1000)}s`;
  } else if (s.kind === 'away.summary') {
    const total =
      typeof s.data.durationMs === 'number' && Number.isFinite(s.data.durationMs) && s.data.durationMs >= 0
        ? s.data.durationMs
        : undefined;
    main = 'away.summary:';
    if (total !== undefined) main += ` away=${compactDuration(total)}`;
    for (const [key, label] of [
      ['sleepMs', 'sleep'],
      ['lockMs', 'lock'],
      ['inactiveMs', 'inactive'],
    ] as const) {
      const value = s.data[key];
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        main += ` ${label}=${compactDuration(value)}`;
      }
    }
    if (Array.isArray(s.data.metrics)) {
      const anomalous: Record<string, unknown>[] = [];
      const normal: Record<string, unknown>[] = [];
      for (const item of s.data.metrics) {
        if (!item || typeof item !== 'object') continue;
        const entry = item as Record<string, unknown>;
        const metricName = str(entry.metric);
        const start = typeof entry.start === 'number' && Number.isFinite(entry.start) ? entry.start : undefined;
        const end = typeof entry.end === 'number' && Number.isFinite(entry.end) ? entry.end : undefined;
        const ratioStart =
          typeof entry.ratioStart === 'number' && Number.isFinite(entry.ratioStart) ? entry.ratioStart : undefined;
        const ratioMin =
          typeof entry.ratioMin === 'number' && Number.isFinite(entry.ratioMin) ? entry.ratioMin : undefined;
        if (
          metricName &&
          start !== undefined &&
          end !== undefined &&
          isAnomalousAwayMetric({ metric: metricName, start, end, ratioStart, ratioMin })
        ) {
          anomalous.push(entry);
        } else {
          normal.push(entry);
        }
      }
      const metrics = [...anomalous, ...normal].slice(0, Math.max(3, anomalous.length)).flatMap((entry) => {
        const label = awayMetricLabel(entry);
        return label !== undefined ? [label] : [];
      });
      if (metrics.length > 0) main += ` metrics=${metrics.map((item) => esc(item)).join(',')}`;
    }
    let alerts =
      typeof s.data.alertCount === 'number' && Number.isFinite(s.data.alertCount) && s.data.alertCount >= 0
        ? Math.round(s.data.alertCount)
        : undefined;
    if (alerts === undefined && Array.isArray(s.data.alerts) && s.data.alerts.length > 0) {
      alerts = 0;
      for (const item of s.data.alerts) {
        if (!item || typeof item !== 'object') continue;
        const count = (item as Record<string, unknown>).count;
        alerts += typeof count === 'number' && Number.isFinite(count) ? count : 1;
      }
    }
    if (alerts !== undefined && alerts > 0) main += ` alerts=${alerts}`;
    const failed =
      typeof s.data.failedCount === 'number' && Number.isFinite(s.data.failedCount) && s.data.failedCount >= 0
        ? Math.round(s.data.failedCount)
        : Array.isArray(s.data.failed)
          ? s.data.failed.length
          : 0;
    if (failed > 0) main += ` failed=${failed}`;
    let deletedFromBursts = 0;
    let directory = '';
    const burstCount = Array.isArray(s.data.bursts) ? s.data.bursts.length : 0;
    if (Array.isArray(s.data.bursts)) {
      for (const item of s.data.bursts) {
        if (!item || typeof item !== 'object') continue;
        const source = item as Record<string, unknown>;
        if (typeof source.deleted === 'number' && Number.isFinite(source.deleted)) deletedFromBursts += source.deleted;
        if (!directory && typeof source.directory === 'string') directory = source.directory;
      }
    }
    const deleted =
      typeof s.data.deletedCount === 'number' && Number.isFinite(s.data.deletedCount) && s.data.deletedCount >= 0
        ? Math.round(s.data.deletedCount)
        : deletedFromBursts;
    if (deleted > 0 || burstCount > 0) {
      const safeDir = directory ? `@${truncateEscapedRaw(str(directory), 256)}` : '';
      main += ` deletes=${deleted}${safeDir}`;
    }
    if (typeof s.data.omitted === 'number' && Number.isFinite(s.data.omitted) && s.data.omitted > 0) {
      main += ` 另有 ${Math.round(s.data.omitted)} 项`;
    }
    if (s.data.hasAnomaly !== true) main += ' anomalies=none';
  } else if (s.kind === 'delivery.target-unavailable') {
    main = `delivery: ${esc(str(s.subject) || 'delivery-target')} unavailable`;
  } else if (s.kind === 'fact.updated') {
    // Internal seam: a focused-window fact update still carries a title —
    // hide it entirely when titles are disabled.
    if (!includeTitles && s.data.path === 'env.focusedWindow') return [];
    main = `${safeEsc(s.kind)}: ${esc(str(s.data.path) || str(s.subject))}`;
  } else {
    // Generic fallback: kind + subject only — never dumps arbitrary data.
    main = `${safeEsc(s.kind)}: ${safeEsc(s.subject)}`;
  }
  if (ch.ruleId) main += ` [rule: ${esc(sanitizeModelId(ch.ruleId).value)} → ${ch.level}]`;
  if (typeof s.data.feedbackAvailable === 'boolean' && s.data.type !== 'rebaseline-suggestion') {
    const safeId = sanitizeSignalId(s.id);
    const bytes = Buffer.from(safeId.value, 'utf8');
    const available =
      s.data.feedbackAvailable &&
      !safeId.redacted &&
      bytes.length > 0 &&
      bytes.length <= 256 &&
      bytes.toString('utf8') === safeId.value;
    main += available
      ? ` alertId="${bytes.toString('base64url')}" feedbackAvailable="true"`
      : ' feedbackAvailable="false"';
  }
  if (s.kind === 'away.summary') {
    const maxLineBytes = ch.note ? 1600 : 1900;
    const boundedMain = truncateUtf8Line(main, maxLineBytes);
    const lines = [boundedMain];
    if (ch.note) {
      const remainingNoteBytes = Math.max(32, 1900 - Buffer.byteLength(boundedMain, 'utf8'));
      lines.push(`note: ${truncateEscapedRaw(str(ch.note), remainingNoteBytes)}`);
    }
    return lines;
  }
  const lines = [main];
  if (ch.note) lines.push(`note: ${safeEsc(ch.note)}`);
  return lines;
}

interface RenderedChange {
  protected: boolean;
  isAway: boolean;
  lines: string[];
}

function renderEnvEnvelope(
  header: string,
  entries: readonly RenderedChange[],
  trailers: readonly string[],
  footer: string,
): string {
  const body: string[] = [];
  for (const entry of entries) body.push(...entry.lines);
  for (const line of trailers) body.push(line);
  return [header, ...body, footer].join('\n');
}

function trimProtectedLinesToBudget(
  header: string,
  entries: RenderedChange[],
  trailers: string[],
  footer: string,
): string {
  let rendered = renderEnvEnvelope(header, entries, trailers, footer);
  if (Buffer.byteLength(rendered, 'utf8') <= MAX_AWAY_FORMAT_BYTES) return rendered;

  // Drop secondary lines (e.g. notes) from non-away wake entries first, then away.summary.
  for (const dropAway of [false, true]) {
    for (const entry of entries) {
      if (entry.isAway !== dropAway || entry.lines.length <= 1) continue;
      entry.lines = [entry.lines[0] as string];
      rendered = renderEnvEnvelope(header, entries, trailers, footer);
      if (Buffer.byteLength(rendered, 'utf8') <= MAX_AWAY_FORMAT_BYTES) return rendered;
    }
  }

  // Drop trailer counters before touching primary wake / away.summary lines.
  while (trailers.length > 0) {
    trailers.pop();
    rendered = renderEnvEnvelope(header, entries, trailers, footer);
    if (Buffer.byteLength(rendered, 'utf8') <= MAX_AWAY_FORMAT_BYTES) return rendered;
  }

  // Last resort: truncate the longest primary line (non-away wake before away.summary).
  for (const allowAway of [false, true]) {
    for (;;) {
      const excess = Buffer.byteLength(rendered, 'utf8') - MAX_AWAY_FORMAT_BYTES;
      if (excess <= 0) return rendered;
      let target: { entry: RenderedChange; lineIdx: number; bytes: number } | undefined;
      for (const entry of entries) {
        if (!allowAway && entry.isAway) continue;
        for (let i = 0; i < entry.lines.length; i++) {
          const bytes = Buffer.byteLength(entry.lines[i] as string, 'utf8');
          if (!target || bytes > target.bytes) target = { entry, lineIdx: i, bytes };
        }
      }
      const floor = allowAway ? 4 : 32;
      if (!target || target.bytes <= floor) break;
      const nextMax = Math.max(floor, target.bytes - excess);
      const nextLine = truncateUtf8Line(target.entry.lines[target.lineIdx] as string, nextMax);
      if (Buffer.byteLength(nextLine, 'utf8') >= target.bytes) break;
      target.entry.lines[target.lineIdx] = nextLine;
      rendered = renderEnvEnvelope(header, entries, trailers, footer);
    }
  }

  return rendered;
}

function fitAwayBatchWithinBudget(
  header: string,
  entries: readonly RenderedChange[],
  trailers: readonly string[],
  footer: string,
): string {
  // Drop low-priority (non-wake, non-away.summary) changes from oldest to newest first.
  const active = [...entries];
  for (let i = 0; i < active.length; ) {
    if (active[i]?.protected) {
      i++;
      continue;
    }
    active.splice(i, 1);
    const rendered = renderEnvEnvelope(header, active, trailers, footer);
    if (Buffer.byteLength(rendered, 'utf8') <= MAX_AWAY_FORMAT_BYTES) return rendered;
  }
  return trimProtectedLinesToBudget(
    header,
    active.map((entry) => ({ ...entry, lines: [...entry.lines] })),
    [...trailers],
    footer,
  );
}

/**
 * Renders an EnvUpdate as the compact `<env-update>` increment (DESIGN §2.4).
 * Output is byte-deterministic for identical input: changes are sorted by
 * `signal.at` then `signal.id`, timestamps are UTC `HH:mm:ss`, all dynamic
 * text is XML-escaped and control characters are flattened so a change can
 * never spoof the envelope or span lines.
 */
export function formatEnvUpdate(update: EnvUpdate, options: FormatOptions = {}): string {
  const includeTitles = options.includeWindowTitles ?? true;
  const includeJobCommands = options.includeJobCommands ?? true;
  const changes = [...update.changes].sort((a, b) => a.signal.at - b.signal.at || (a.signal.id < b.signal.id ? -1 : 1));
  const entries: RenderedChange[] = [];
  for (const ch of changes) {
    const lines = changeLines(ch, includeTitles, includeJobCommands);
    if (lines.length === 0) continue;
    const isAway = ch.signal.kind === 'away.summary';
    entries.push({
      protected: isAway || ch.level === 'wake',
      isAway,
      lines,
    });
  }
  const trailers: string[] = [];
  if (update.suppressed > 0) trailers.push(`suppressed: ${update.suppressed}`);
  if ((update.alreadyInjected ?? 0) > 0) trailers.push(`另有 ${update.alreadyInjected} 条已在上一步注入`);
  if (entries.length === 0 && trailers.length === 0) return '';
  const header = `<env-update since="${esc(hhmmss(update.since))}" source="asi-sense">`;
  const footer = '</env-update>';
  const rendered = renderEnvEnvelope(header, entries, trailers, footer);
  if (entries.some((entry) => entry.isAway) && Buffer.byteLength(rendered, 'utf8') > MAX_AWAY_FORMAT_BYTES) {
    return fitAwayBatchWithinBudget(header, entries, trailers, footer);
  }
  return rendered;
}
