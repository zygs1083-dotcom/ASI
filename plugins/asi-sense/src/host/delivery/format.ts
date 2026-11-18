import type { EnvChange, EnvUpdate, Signal } from '@asi/sense-types';

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
  return typeof v === 'string' ? v : '';
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
    if (typeof total === 'number' && typeof omitted === 'number' && Array.isArray(recent)) {
      return [
        `jobs: ${total} events`,
        ...recent.flatMap((item: unknown) => {
          if (!item || typeof item !== 'object') return [];
          const { id, kind, count, exitCode } = item as Record<string, unknown>;
          if (typeof id !== 'string' || !['job.exited', 'job.started'].includes(String(kind))) return [];
          return [
            `job: \`${esc(id)}\` ${kind === 'job.exited' ? 'exited' : 'started'}${typeof exitCode === 'number' ? ` ${exitCode}` : ''}${typeof count === 'number' && count > 1 ? ` ×${count}` : ''}`,
          ];
        }),
        ...(omitted > 0 ? [`另有 ${omitted} 个未列出`] : []),
      ];
    }
  }
  if (s.kind === 'app.activated') {
    main = `front-app: ${esc(typeof s.data.name === 'string' ? s.data.name : s.subject)}`;
    const prev = str(s.data.previousName);
    if (prev) main += ` (was: ${esc(prev)})`;
  } else if (WINDOW_KINDS.has(s.kind)) {
    if (!includeTitles) return [];
    main = `window: ${esc(str(s.data.title))}`;
  } else if (s.kind === 'file.changed') {
    const path = str(s.data.path) || s.subject;
    main = `file: ${esc(path)} ${fileVerb(s.data.change)}${ch.count > 1 ? ` ×${ch.count}` : ''}`;
  } else if (s.kind === 'job.started') {
    main = `job: \`${esc(str(s.data.id) || s.subject)}\` started`;
  } else if (s.kind === 'job.exited' || s.kind === 'process.exited') {
    const label = s.kind === 'job.exited' ? 'job' : 'process';
    const cmd = includeJobCommands ? str(s.data.command) || s.subject : str(s.data.id) || label;
    main = `${label}: \`${esc(cmd)}\` exited`;
    if (typeof s.data.exitCode === 'number') main += ` ${s.data.exitCode}`;
    const dur = durationMs(s);
    if (dur !== undefined) main += ` after ${Math.round(dur / 1000)}s`;
  } else if (s.kind === 'body.threshold') {
    main = `body: ${esc(s.subject)} ${esc(str(s.data.severity) || '?')}`;
    const v = s.data.value;
    if (typeof v === 'number' && Number.isFinite(v)) main += ` ${v}`;
    else if (typeof v === 'string') main += ` ${esc(v)}`;
  } else if (s.kind === 'body.anomaly' && s.data.type === 'rebaseline-suggestion') {
    const target = str(s.data.metric) || s.subject.replace(/^(?:rebaseline|baseline):/, '') || s.subject;
    main = `建议重新基线：${esc(target)}`;
  } else if (s.kind === 'body.rate' || s.kind === 'body.anomaly' || s.kind === 'file.burst') {
    const directory =
      s.kind === 'file.burst' && typeof s.data?.directory === 'string' && s.data.directory.trim()
        ? s.data.directory
        : '';
    const head = s.kind === 'file.burst' ? directory || str(s.subject) || '[path]' : str(s.subject);
    main = `${esc(s.kind)}: ${esc(head)}`;
    if (s.kind !== 'file.burst' && typeof s.data.metric === 'string' && s.data.metric && s.data.metric !== s.subject) {
      main += ` metric=${esc(s.data.metric)}`;
    }
    if (typeof s.data.ruleId === 'string') main += ` ruleId=${esc(s.data.ruleId)}`;
    if (typeof s.data.severity === 'string') main += ` ${esc(s.data.severity)}`;
    const etaKey =
      typeof s.data.etaToFloorMs === 'number' && Number.isFinite(s.data.etaToFloorMs)
        ? 'etaToFloorMs'
        : 'timeToFloorMs';
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
      const value = s.data[key];
      if (typeof value === 'number' && Number.isFinite(value)) {
        main += key === 'deviation' ? ` ${key}=${value}σ` : ` ${key}=${value}`;
      }
    }
    if (s.data.externalDeletionExceeded === true) main += ' externalDeletionExceeded=true';
  } else if (s.kind === 'file.activity') {
    const directory = typeof s.data?.directory === 'string' && s.data.directory.trim() ? s.data.directory : '';
    const head = directory || str(s.subject) || '[path]';
    main = `file.activity: ${esc(head)}`;
    for (const key of ['windowMs', 'created', 'modified', 'deleted']) {
      const value = s.data?.[key];
      if (typeof value === 'number' && Number.isFinite(value)) {
        main += ` ${key}=${value}`;
      }
    }
    if (Array.isArray(s.data?.files)) {
      const files = s.data.files
        .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        .slice(0, 5)
        .map((item) => esc(item));
      if (files.length > 0) main += ` files=[${files.join(', ')}]`;
    }
    if (s.data?.degraded === true) main += ' degraded=true';
  } else if (s.kind === 'fact.updated') {
    // Internal seam: a focused-window fact update still carries a title —
    // hide it entirely when titles are disabled.
    if (!includeTitles && s.data.path === 'env.focusedWindow') return [];
    main = `${esc(s.kind)}: ${esc(str(s.data.path) || s.subject)}`;
  } else {
    // Generic fallback: kind + subject only — never dumps arbitrary data.
    main = `${esc(s.kind)}: ${esc(s.subject)}`;
  }
  if (ch.ruleId) main += ` [rule: ${esc(ch.ruleId)} → ${ch.level}]`;
  if (typeof s.data.feedbackAvailable === 'boolean' && s.data.type !== 'rebaseline-suggestion') {
    const bytes = Buffer.from(s.id, 'utf8');
    const available =
      s.data.feedbackAvailable && bytes.length > 0 && bytes.length <= 256 && bytes.toString('utf8') === s.id;
    main += available
      ? ` alertId="${bytes.toString('base64url')}" feedbackAvailable="true"`
      : ' feedbackAvailable="false"';
  }
  const lines = [main];
  if (ch.note) lines.push(`note: ${esc(ch.note)}`);
  return lines;
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
  const changes = [...update.changes].sort((a, b) => a.signal.at - b.signal.at || (a.signal.id < b.signal.id ? -1 : 1));
  const body: string[] = [];
  for (const ch of changes) body.push(...changeLines(ch, includeTitles, options.includeJobCommands ?? true));
  if (update.suppressed > 0) body.push(`suppressed: ${update.suppressed}`);
  if ((update.alreadyInjected ?? 0) > 0) body.push(`另有 ${update.alreadyInjected} 条已在上一步注入`);
  if (body.length === 0) return '';
  return [`<env-update since="${esc(hhmmss(update.since))}" source="asi-sense">`, ...body, '</env-update>'].join('\n');
}
