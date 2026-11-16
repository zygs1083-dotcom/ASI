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
  if (s.kind === 'app.activated') {
    main = `front-app: ${esc(str(s.data.name) || s.subject)}`;
    const prev = str(s.data.previousName);
    if (prev) main += ` (was: ${esc(prev)})`;
  } else if (WINDOW_KINDS.has(s.kind)) {
    if (!includeTitles) return [];
    main = `window: ${esc(str(s.data.title))}`;
  } else if (s.kind === 'file.changed') {
    const path = str(s.data.path) || s.subject;
    main = `file: ${esc(path)} saved${ch.count > 1 ? ` ×${ch.count}` : ''}`;
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
  } else if (s.kind === 'body.rate' || s.kind === 'body.anomaly' || s.kind === 'file.burst') {
    main = `${esc(s.kind)}: ${esc(s.subject)}`;
    if (typeof s.data.ruleId === 'string') main += ` ruleId=${esc(s.data.ruleId)}`;
    if (typeof s.data.severity === 'string') main += ` ${esc(s.data.severity)}`;
    for (const key of ['value', 'slope', 'delta', 'etaToFloorMs', 'created', 'modified', 'deleted']) {
      const value = s.data[key];
      if (typeof value === 'number' && Number.isFinite(value)) main += ` ${key}=${value}`;
    }
    if (s.data.externalDeletionExceeded === true) main += ' externalDeletionExceeded=true';
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
  const lines = [`<env-update since="${esc(hhmmss(update.since))}" source="asi-sense">`];
  for (const ch of changes) lines.push(...changeLines(ch, includeTitles, options.includeJobCommands ?? true));
  if (update.suppressed > 0) lines.push(`suppressed: ${update.suppressed}`);
  if ((update.alreadyInjected ?? 0) > 0) lines.push(`另有 ${update.alreadyInjected} 条已在上一步注入`);
  lines.push('</env-update>');
  return lines.join('\n');
}
