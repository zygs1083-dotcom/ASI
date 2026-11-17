import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { Fact, SenseState, WatchRule } from '@asi/sense-types';
import { isRemoteJsonValue } from '@deepseek-ai/dsh-typert-protocol';
import type { createSenseRuntime } from '../runtime/index.ts';
import type { JsonValue } from './wire-types.ts';

const MAX_BYTES = 32_768;
const MAX_TITLE_LENGTH = 512;
const PLACEHOLDERS = ['<host>', '[host]', '[endpoint]', '[path]'] as const;
const DELIMITER_RE = /[\s"'<>]+/gu;
const HAS_DELIMITER_RE = /[\s"'<>]/u;
const COMBINING_MARK_RE = /^\p{M}$/u;
const NEEDS_CLUSTER_NFC_RE = /[\p{M}\u1100-\u11ff\ud7b0-\ud7ff]/u;

const SENTINEL_HOST = '\0';
const SENTINEL_ENDPOINT = '\u0004';
const SENTINEL_PATH = '\u0005';
const ESCAPE_CHAR = '\u0001';

const TEXT_ENDPOINT_RE = /https?:\/\/[^\s"'<>]+/gi;
const TEXT_PATH_RE = /(?<![\w])(?:[A-Za-z]:\\|\/)(?:[^\s"'<>/\\]+[/\\])*[^\s"'<>/\\]*/g;

const TITLE_SCHEME_RE = /(?<![a-z\d+.-])[a-z\d+.-]+:\/\/[^\s"'<>]+/gi;
const TITLE_EMAIL_RE =
  /(?<![\p{L}\p{M}\p{N}_.+%-])[\p{L}\p{M}\p{N}_.+%-]+@(?:\[[\da-f:.]+\]|[\p{L}\p{M}\p{N}_.-]+)(?::\d+)?(?:[/\\][^\s"'<>]*)?/giu;
const TITLE_IPV6_RE =
  /\[[\da-f:.]+\](?::\d+)?(?:[/\\][^\s"'<>]*)?|(?<![\w:])(?:[\da-f]{0,4}:){2,}[\da-f]{0,4}(?![\w:])(?:[/\\][^\s"'<>]*)?/gi;
const TITLE_IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b(?:[/\\][^\s"'<>]*)?/gi;
const TITLE_HOST_PORT_RE = /(?<![\p{L}\p{M}\p{N}_.:-])[\p{L}\p{M}\p{N}_.-]+:\d+\b(?:[/\\][^\s"'<>]*)?/giu;
const TITLE_PATH_RE =
  /(?<![\p{L}\p{M}\p{N}._-])(?:[A-Za-z]:\\|\/|[\p{L}\p{M}\p{N}._-]+\/)(?:[^\s"'<>/\\]+[/\\])*[^\s"'<>/\\]*/gu;

const FIXED_IDENTIFIERS = new Set([
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
]);

function countCodePoints(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i) ?? 0;
    count++;
    i += cp > 0xffff ? 2 : 1;
  }
  return count;
}

function sliceByCodePoints(text: string, maxCodePoints: number): string {
  if (maxCodePoints <= 0) return '';
  if (text.length <= maxCodePoints) return text;
  let cps = 0;
  let i = 0;
  while (i < text.length) {
    const cp = text.codePointAt(i) ?? 0;
    if (cps + 1 > maxCodePoints) break;
    cps += 1;
    i += cp > 0xffff ? 2 : 1;
  }
  return i === text.length ? text : text.slice(0, i);
}

function truncateRedacted(text: string, limit: number): string {
  if (text.length <= limit) return text;
  let cps = 0;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '<' || ch === '[') {
      let matched: string | undefined;
      for (const token of PLACEHOLDERS) {
        if (text.startsWith(token, i)) {
          matched = token;
          break;
        }
      }
      if (matched !== undefined) {
        if (cps + matched.length > limit) break;
        cps += matched.length;
        i += matched.length;
        continue;
      }
    }
    const cp = text.codePointAt(i) ?? 0;
    if (cps + 1 > limit) break;
    cps += 1;
    i += cp > 0xffff ? 2 : 1;
  }
  return i === text.length ? text : text.slice(0, i);
}

function lastPathSegment(value: string, fallback: string): string {
  let end = value.length;
  while (end > 0 && (value[end - 1] === '/' || value[end - 1] === '\\')) end--;
  if (end === 0) return fallback;
  let start = end;
  while (start > 0 && value[start - 1] !== '/' && value[start - 1] !== '\\') start--;
  return value.slice(start, end);
}

function needsSentinelEscape(text: string): boolean {
  return (
    text.includes(SENTINEL_HOST) ||
    text.includes(ESCAPE_CHAR) ||
    text.includes(SENTINEL_ENDPOINT) ||
    text.includes(SENTINEL_PATH)
  );
}

function escapeSentinels(text: string): string {
  return text
    .replaceAll(ESCAPE_CHAR, `${ESCAPE_CHAR}\u0002`)
    .replaceAll(SENTINEL_HOST, `${ESCAPE_CHAR}\u0003`)
    .replaceAll(SENTINEL_ENDPOINT, `${ESCAPE_CHAR}\u0006`)
    .replaceAll(SENTINEL_PATH, `${ESCAPE_CHAR}\u0007`);
}

function unescapeSentinels(text: string): string {
  return text
    .replaceAll(`${ESCAPE_CHAR}\u0007`, SENTINEL_PATH)
    .replaceAll(`${ESCAPE_CHAR}\u0006`, SENTINEL_ENDPOINT)
    .replaceAll(`${ESCAPE_CHAR}\u0003`, SENTINEL_HOST)
    .replaceAll(`${ESCAPE_CHAR}\u0002`, ESCAPE_CHAR);
}

function isClusterContinuation(text: string, index: number, cp: number, len: number): boolean {
  if (index === 0) return false;
  if (cp < 0x0300 || (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0xac00 && cp <= 0xd7a3)) return false;
  if (cp >= 0x1160 && cp <= 0x11ff) return true;
  if (cp >= 0xd7b0 && cp <= 0xd7ff) return true;
  return COMBINING_MARK_RE.test(text.slice(index, index + len));
}

function sliceToClusterBound(text: string, maxClusters: number): string {
  if (text.length <= maxClusters) return text;
  const candidate = text.slice(0, maxClusters);
  if (!NEEDS_CLUSTER_NFC_RE.test(candidate) && !/[\ud800-\udfff]/.test(candidate)) {
    const nextCp = text.codePointAt(maxClusters) ?? 0;
    const nextLen = nextCp > 0xffff ? 2 : 1;
    if (!isClusterContinuation(text, maxClusters, nextCp, nextLen)) return candidate;
  }
  let clusters = 0;
  let i = 0;
  let clusterCps = 0;
  const maxSingleClusterCps = Math.max(maxClusters * 4, 8192);
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code < 0x300 || (code >= 0x4e00 && code <= 0x9fff) || (code >= 0xac00 && code <= 0xd7a3)) {
      if (i > 0 && ++clusters >= maxClusters) return text.slice(0, i);
      clusterCps = 1;
      i += 1;
      continue;
    }
    const cp = text.codePointAt(i) ?? 0;
    const len = cp > 0xffff ? 2 : 1;
    if (isClusterContinuation(text, i, cp, len)) {
      clusterCps++;
      if (clusters === 0 && clusterCps >= maxSingleClusterCps) return text.slice(0, i + len);
      i += len;
      continue;
    }
    if (i > 0 && ++clusters >= maxClusters) return text.slice(0, i);
    clusterCps = 1;
    i += len;
  }
  return text;
}

function segmentNfcClusters(text: string): { rawStarts: number[]; nfcStarts: number[]; nfc: string } {
  const normCache = new Map<string, string>();
  const rawStarts: number[] = [];
  const nfcStarts: number[] = [];
  const nfcParts: string[] = [];
  let nfcLen = 0;
  let segStart = 0;
  const pushCluster = (end: number) => {
    rawStarts.push(segStart);
    nfcStarts.push(nfcLen);
    const seg = text.slice(segStart, end);
    let norm: string;
    if (seg.length === 1 && seg.charCodeAt(0) < 0x0300) {
      norm = seg;
    } else {
      const cached = normCache.get(seg);
      if (cached !== undefined) {
        norm = cached;
      } else {
        norm = seg.normalize('NFC');
        if (normCache.size < 2048) normCache.set(seg, norm);
      }
    }
    nfcParts.push(norm);
    nfcLen += norm.length;
    segStart = end;
  };
  for (let i = 0; i < text.length; ) {
    const cp = text.codePointAt(i) ?? 0;
    const len = cp > 0xffff ? 2 : 1;
    if (!isClusterContinuation(text, i, cp, len) && i > segStart) pushCluster(i);
    i += len;
  }
  if (text.length > segStart) pushCluster(text.length);
  rawStarts.push(text.length);
  nfcStarts.push(nfcLen);
  return { rawStarts, nfcStarts, nfc: nfcParts.join('') };
}

/**
 * Replaces case-insensitive NFC-equivalent matches of `hostNfc` in `text`
 * without altering non-matching NFD sequences or splitting combining clusters.
 */
function replaceHostNfc(text: string, hostNfc: string, replacement: string, limit?: number): string {
  if (!hostNfc || !text) return text;
  const hostCps = countCodePoints(hostNfc);
  // By pigeonhole principle, any match beyond this cluster count cannot enter the final `limit`.
  const bounded =
    limit === undefined
      ? text
      : sliceToClusterBound(text, (Math.ceil(limit / replacement.length) + 1) * Math.max(hostCps, 1) + limit + hostCps);
  const hostRe = new RegExp(hostNfc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu');
  if (!NEEDS_CLUSTER_NFC_RE.test(bounded) && bounded.normalize('NFC') === bounded) {
    if (limit === undefined || bounded.length <= limit * 2) return bounded.replace(hostRe, replacement);
    let out = '';
    let last = 0;
    let outCps = 0;
    hostRe.lastIndex = 0;
    for (let match = hostRe.exec(bounded); match !== null; match = hostRe.exec(bounded)) {
      const gap = bounded.slice(last, match.index);
      out += gap + replacement;
      outCps += countCodePoints(gap) + replacement.length;
      last = match.index + match[0].length;
      if (match[0].length === 0) hostRe.lastIndex++;
      if (outCps >= limit) return out;
    }
    return last === 0 ? bounded : out + bounded.slice(last);
  }
  const { rawStarts, nfcStarts, nfc } = segmentNfcClusters(bounded);
  let out = '';
  let lastRaw = 0;
  let segCursor = 0;
  const numSegs = nfcStarts.length - 1;
  hostRe.lastIndex = 0;
  for (let match = hostRe.exec(nfc); match !== null; match = hostRe.exec(nfc)) {
    if (match[0].length === 0) {
      hostRe.lastIndex++;
      continue;
    }
    const mStart = match.index;
    const mEnd = mStart + match[0].length;
    while (segCursor < numSegs && nfcStarts[segCursor] < mStart) segCursor++;
    if (segCursor > numSegs || nfcStarts[segCursor] !== mStart) continue;
    let endCursor = segCursor;
    while (endCursor <= numSegs && nfcStarts[endCursor] < mEnd) endCursor++;
    if (endCursor > numSegs || nfcStarts[endCursor] !== mEnd) continue;
    const rawFrom = rawStarts[segCursor];
    const rawTo = rawStarts[endCursor];
    if (rawFrom < lastRaw) continue;
    out += bounded.slice(lastRaw, rawFrom) + replacement;
    lastRaw = rawTo;
    segCursor = endCursor;
  }
  return lastRaw === 0 ? bounded : out + bounded.slice(lastRaw);
}

/**
 * Replaces regex matches up to an early-stop bound once irreversible sentinel placeholders
 * already exceed `limit` code points, avoiding full-string work on 1 MB inputs.
 */
function replaceBounded(
  str: string,
  re: RegExp,
  replacer: (match: string) => string,
  limit: number,
  allowEarlyStop: boolean,
  countMatch: (replaced: string) => boolean = () => true,
): string {
  if (str.length <= 65_536 || !allowEarlyStop) {
    return str.replace(re, replacer);
  }
  const maxPlaceholders = Math.ceil(limit / 6) + 2;
  re.lastIndex = 0;
  let out = '';
  let last = 0;
  let count = 0;
  for (let match = re.exec(str); match !== null; match = re.exec(str)) {
    const replaced = replacer(match[0]);
    out += str.slice(last, match.index) + replaced;
    last = match.index + match[0].length;
    if (match[0].length === 0) re.lastIndex++;
    if (countMatch(replaced) && ++count >= maxPlaceholders) return out;
  }
  return last === 0 ? str : out + str.slice(last);
}

function nextSentinel(text: string, from: number): { index: number; code: number } {
  let best = -1;
  let code = -1;
  for (const [sentinel, value] of [
    [SENTINEL_HOST, 0],
    [SENTINEL_ENDPOINT, 4],
    [SENTINEL_PATH, 5],
  ] as const) {
    const idx = text.indexOf(sentinel, from);
    if (idx !== -1 && (best === -1 || idx < best)) {
      best = idx;
      code = value;
    }
  }
  return { index: best, code };
}

function redactPlainSegment(
  plain: string,
  escapedHost: string,
  hostPlaceholder: string,
  remaining: number,
  escaped: boolean,
): string {
  const withHost = escapedHost
    ? replaceHostNfc(plain, escapedHost, hostPlaceholder, escaped ? remaining * 2 + 24 : remaining + 12)
    : plain;
  const restored = escaped ? unescapeSentinels(withHost) : withHost;
  return sliceByCodePoints(restored, remaining + 12);
}

function expandAndRedactHost(
  text: string,
  hostNfc: string,
  hostPlaceholder: string,
  limit: number,
  escaped: boolean,
): string {
  const escapedHost = escaped ? escapeSentinels(hostNfc) : hostNfc;
  const first = nextSentinel(text, 0);
  if (first.index === -1) {
    return redactPlainSegment(text, escapedHost, hostPlaceholder, limit, escaped);
  }
  const out: string[] = [];
  let cps = 0;
  let start = 0;
  let current = first;
  while (true) {
    const end = current.index === -1 ? text.length : current.index;
    if (end > start) {
      const boundedPart = redactPlainSegment(
        text.slice(start, end),
        escapedHost,
        hostPlaceholder,
        Math.max(1, limit - cps),
        escaped,
      );
      out.push(boundedPart);
      if (current.index === -1) break;
      cps += countCodePoints(boundedPart);
      if (cps >= limit) break;
    }
    if (current.index === -1) break;
    const placeholder = current.code === 0 ? hostPlaceholder : current.code === 4 ? '[endpoint]' : '[path]';
    out.push(placeholder);
    cps += placeholder.length;
    if (cps >= limit) break;
    start = current.index + 1;
    current = nextSentinel(text, start);
  }
  return out.join('');
}

function redactTextChunk(chunk: string, hostNfc: string, limit: number): string {
  const escaped = needsSentinelEscape(chunk) || needsSentinelEscape(hostNfc);
  let r = escaped ? escapeSentinels(chunk) : chunk;
  if (r.includes('://')) r = r.replace(TEXT_ENDPOINT_RE, SENTINEL_ENDPOINT);
  if (r.includes('/') || r.includes('\\')) {
    r = replaceBounded(
      r,
      TEXT_PATH_RE,
      (match) => lastPathSegment(match, SENTINEL_PATH),
      limit,
      true,
      (seg) => seg === SENTINEL_PATH,
    );
  }
  return expandAndRedactHost(r, hostNfc, '[host]', limit, escaped);
}

function redactTitleChunk(chunk: string, hostNfc: string, limit: number): string {
  const escaped = needsSentinelEscape(chunk) || needsSentinelEscape(hostNfc);
  let r = escaped ? escapeSentinels(chunk) : chunk;
  // When no path separator exists, TITLE_PATH_RE cannot collapse earlier tokens.
  const canStopEarly = !r.includes('/') && !r.includes('\\');
  const toHost = () => SENTINEL_HOST;
  if (r.includes('://')) r = replaceBounded(r, TITLE_SCHEME_RE, toHost, limit, canStopEarly);
  if (r.includes('@')) r = replaceBounded(r, TITLE_EMAIL_RE, toHost, limit, canStopEarly);
  if (r.includes(':')) r = replaceBounded(r, TITLE_IPV6_RE, toHost, limit, canStopEarly);
  if (r.includes('.')) r = replaceBounded(r, TITLE_IPV4_RE, toHost, limit, canStopEarly);
  if (r.includes(':')) r = replaceBounded(r, TITLE_HOST_PORT_RE, toHost, limit, canStopEarly);
  if (!canStopEarly) {
    r = replaceBounded(
      r,
      TITLE_PATH_RE,
      (match) => lastPathSegment(match, SENTINEL_PATH),
      limit,
      true,
      (seg) => seg === SENTINEL_PATH,
    );
  }
  return expandAndRedactHost(r, hostNfc, '<host>', limit, escaped);
}

function projectModelString(
  value: string,
  hostname: string,
  limit: number,
  redactChunk: (chunk: string, hostNfc: string, limit: number) => string,
): string {
  if (!value) return value;
  const hostNfc = hostname ? hostname.normalize('NFC') : '';
  const batchSize = Math.max(limit * 4, 4096);
  if (value.length <= batchSize || (hostNfc && HAS_DELIMITER_RE.test(hostNfc))) {
    return truncateRedacted(redactChunk(value, hostNfc, limit), limit);
  }
  const chunks: string[] = [];
  let outCps = 0;
  let pos = 0;
  while (pos < value.length && outCps < limit) {
    const targetEnd = pos + batchSize;
    if (targetEnd >= value.length) {
      chunks.push(redactChunk(value.slice(pos), hostNfc, limit - outCps));
      break;
    }
    DELIMITER_RE.lastIndex = targetEnd;
    const match = DELIMITER_RE.exec(value);
    if (match === null) {
      chunks.push(redactChunk(value.slice(pos), hostNfc, limit - outCps));
      break;
    }
    if (match.index > pos) {
      const redacted = redactChunk(value.slice(pos, match.index), hostNfc, limit - outCps);
      chunks.push(redacted);
      outCps += countCodePoints(redacted);
      if (outCps >= limit) break;
    }
    const delim = sliceByCodePoints(match[0], limit - outCps + 12);
    chunks.push(delim);
    outCps += countCodePoints(delim);
    pos = match.index + match[0].length;
  }
  return truncateRedacted(chunks.join(''), limit);
}

export function modelText(value: string, hostname = os.hostname()): string {
  return projectModelString(value, hostname, MAX_BYTES, redactTextChunk);
}

export function modelTitle(value: string, hostname = os.hostname()): string {
  return projectModelString(value, hostname, MAX_TITLE_LENGTH, redactTitleChunk);
}

function minimize(value: JsonValue, hostname: string, path = '', appNamePaths: readonly string[] = []): JsonValue {
  if (typeof value === 'string') {
    const source = path.endsWith('.source.id') || path.endsWith('.source.api');
    if (appNamePaths.includes(path) || (source && isSourceIdentifier(value))) return value;
    return path === 'title' || path.endsWith('.title')
      ? modelTitle(value, hostname)
      : modelText(value, source && isHashedFileSource(value) ? '' : hostname);
  }
  if (Array.isArray(value)) return value.map((item) => minimize(item, hostname, path, appNamePaths));
  if (value === null || typeof value !== 'object') return value;
  const entries: Record<string, JsonValue> = Object.create(null);
  for (const [key, child] of Object.entries(value)) {
    if (key === 'host' || key === 'endpoint' || key === 'command' || key === 'userSession') continue;
    const sourceKey = path === 'sources' || path === 'observation.sources';
    const fixedKey = (sourceKey || path.endsWith('permissions.value')) && isSourceIdentifier(key);
    const base = fixedKey ? key : modelText(key, sourceKey && isHashedFileSource(key) ? '' : hostname);
    let name = base;
    for (let n = 2; Object.hasOwn(entries, name); n++) name = `${base} (${n})`;
    entries[name] = minimize(child, hostname, path ? `${path}.${key}` : key, appNamePaths);
  }
  return entries;
}

export function modelPath(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/\/+$/, '');
  return modelText(path.posix.basename(normalized) || '[path]');
}

export function modelLabel(value: string): string {
  return /^[\p{L}\p{N}_ -]+$/u.test(value) ? modelText(value) : '[redacted]';
}

export function modelAppName(value: string): string {
  return Array.from(value.replace(/\p{Cc}/gu, ''))
    .slice(0, 256)
    .join('');
}

function identifier(value: string): string {
  return /^[\w-]+$/.test(value) ? modelText(value) : '[redacted]';
}

function isSourceIdentifier(value: string): boolean {
  return FIXED_IDENTIFIERS.has(value);
}

function isHashedFileSource(value: string): boolean {
  return /^files:r-[a-f0-9]{8}$/.test(value);
}

function sourceIdentifier(value: string): string {
  if (value.startsWith('files:')) {
    const id = value.slice('files:'.length);
    return `files:r-${createHash('sha256').update(id).digest('hex').slice(0, 8)}`;
  }
  return FIXED_IDENTIFIERS.has(value) ? value : identifier(value);
}

function pick(value: object, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(
    keys.filter((key) => Object.hasOwn(value, key)).map((key) => [key, Reflect.get(value, key)]),
  );
}

function fact<T>(input: Fact<T>, project: (value: T) => unknown): object {
  return {
    value: input.value === null ? null : project(input.value),
    status: input.status,
    source: { id: sourceIdentifier(input.source.id), api: sourceIdentifier(input.source.api) },
    observedAt: input.observedAt,
    ttlMs: input.ttlMs,
  };
}

function dictionary<T>(
  values: Record<string, T>,
  key: (value: string) => string,
  project: (value: T) => unknown,
  sourceKeys = false,
) {
  const entries: Record<string, unknown> = Object.create(null);
  for (const [original, value] of Object.entries(values)) {
    const base = key(original);
    const projected = project(value);
    if (sourceKeys && base.startsWith('files:') && Object.hasOwn(entries, base)) {
      const previous = entries[base] as { lastSignalAt: number };
      const current = projected as { lastSignalAt: number };
      entries[base] = {
        status: 'unknown',
        lastSignalAt: Math.max(previous.lastSignalAt, current.lastSignalAt),
        ambiguous: true,
      };
      continue;
    }
    let name = base;
    for (let n = 2; Object.hasOwn(entries, name); n++) name = `${base} (${n})`;
    entries[name] = projected;
  }
  return entries;
}

function observations(state: SenseState['observation']) {
  return {
    sources: dictionary(state.sources, sourceIdentifier, (source) => pick(source, ['status', 'lastSignalAt']), true),
  };
}

export function modelState(state: SenseState, now: number, section?: 'self' | 'env' | 'observation'): JsonValue {
  const { self, env } = state;
  const body = self.body;
  const projected = {
    self: {
      activity: fact(self.activity, (value) => value),
      pending: fact(self.pending, (value) => pick(value, ['inbox', 'jobs'])),
      tools: fact(self.tools, (value) => value.map(identifier)),
      permissions: fact(self.permissions, (value) =>
        dictionary(
          value,
          (key) =>
            key === '辅助功能' ? 'accessibility' : key === '其他权限（DSH 未提供）' ? 'other' : identifier(key),
          (status) => status,
        ),
      ),
      body: {
        cpu: fact(body.cpu, (value) => pick(value, ['usage', 'perCore', 'load1', 'load5', 'load15'])),
        memory: fact(body.memory, (value) => pick(value, ['total', 'used', 'pressure', 'swapUsed'])),
        disks: fact(body.disks, (value) =>
          value.map((disk) => ({
            ...pick(disk, ['total', 'free', 'status', 'observedAt', 'ttlMs']),
            mount: modelPath(disk.mount),
          })),
        ),
        battery: fact(body.battery, (value) =>
          value === null ? null : pick(value, ['percent', 'charging', 'minutesLeft', 'powerState', 'estimatePending']),
        ),
        thermal: fact(body.thermal, (value) => value),
        network: fact(body.network, (value) => pick(value, ['online', 'rxBps', 'txBps'])),
        harnessProcess: fact(body.harnessProcess, (value) => pick(value, ['rss', 'cpu', 'uptimeSec'])),
        tokens: fact(body.tokens, (value) => ({
          ...pick(value, ['contextWindow', 'contextUsed', 'contextProjected', 'contextWindowSource']),
          sessionUsage: pick(value.sessionUsage, ['input', 'output', 'cacheRead', 'cacheWrite']),
          ...(value.balance
            ? { balance: { amount: value.balance.amount, currency: identifier(value.balance.currency) } }
            : {}),
        })),
      },
    },
    env: {
      where: {
        model: fact(env.where.model, (value) => ({ provider: identifier(value.provider), local: value.local })),
        harness: fact(env.where.harness, (value) => ({ os: modelLabel(value.os) })),
        observed: fact(env.where.observed, () => ({})),
        toolExec: fact(env.where.toolExec, (value) => ({ cwd: modelPath(value.cwd) })),
      },
      frontApp: fact(env.frontApp, (value) => ({ name: modelAppName(value.name) })),
      focusedWindow: fact(env.focusedWindow, (value) => ({ title: value.title })),
      activeJobs: fact(env.activeJobs, (value) =>
        value.map((job) => ({ ...pick(job, ['startedAt', 'status', 'exitCode']), id: identifier(job.id) })),
      ),
      watchedPaths: fact(env.watchedPaths, (value) =>
        dictionary(value, modelPath, (item) => pick(item, ['lastChange', 'changes'])),
      ),
    },
    observation: observations(state.observation),
  };
  return modelOutput(section ? projected[section] : projected, now, ['env.frontApp.value.name', 'frontApp.value.name']);
}

export function modelRules(rules: WatchRule[]): JsonValue {
  const kinds = new Set([
    'app.activated',
    'app.launched',
    'app.terminated',
    'window.focused',
    'window.title-changed',
    'file.changed',
    'job.started',
    'job.exited',
    'process.exited',
    'source.status',
    'source.error',
    'body.threshold',
    'body.rate',
    'body.anomaly',
    'file.burst',
    'fact.updated',
  ]);
  return modelOutput(
    rules.map((rule) => {
      const where: Record<string, unknown> = {};
      const exitCode = rule.match.where?.exitCode;
      if (typeof exitCode === 'number') where.exitCode = exitCode;
      else if (exitCode && typeof exitCode === 'object' && !Array.isArray(exitCode)) {
        where.exitCode = Object.fromEntries(
          Object.entries(exitCode).filter(
            ([operator, value]) =>
              ['==', '!=', '>', '>=', '<', '<='].includes(operator) &&
              typeof value === 'number' &&
              Number.isFinite(value),
          ),
        );
      }
      const severity = rule.match.where?.severity;
      if (typeof severity === 'string' && ['normal', 'warn', 'critical'].includes(severity)) where.severity = severity;
      const status = rule.match.where?.status;
      if (typeof status === 'string' && ['ok', 'denied', 'error', 'unavailable', 'unknown'].includes(status))
        where.status = status;
      return {
        ...pick(rule, ['level', 'createdBy', 'approved', 'expiresAt']),
        id: identifier(rule.id),
        match: {
          kind: kinds.has(rule.match.kind) ? rule.match.kind : '[redacted]',
          ...(rule.match.kind === 'file.changed' && rule.match.subject !== undefined
            ? { subject: modelPath(rule.match.subject) }
            : {}),
          ...(Object.keys(where).length ? { where } : {}),
        },
      };
    }),
  );
}

export function modelTune(value: unknown): JsonValue {
  if (!value || typeof value !== 'object') return modelOutput({});
  const result = pick(value, ['applied']);
  const change = Reflect.get(value, 'change');
  if (change && typeof change === 'object') {
    const fields = pick(change, ['at', 'by', 'operation', 'status']);
    const id = Reflect.get(change, 'id');
    if (typeof id === 'string') fields.id = identifier(id);
    const param = Reflect.get(change, 'param');
    const params = [
      'rate.disk.maxDelta',
      'rate.rss.maxRatio',
      'rate.context.maxEtaMs',
      'anomaly.cpu.sigma',
      'anomaly.memory.sigma',
      'anomaly.network.sigma',
      'file.burst.windowMs',
      'file.burst.maxChanges',
      'file.burst.maxDeleted',
      'mergeWindowMs',
      'fileMergeWindowMs',
      'deliveryLevel.body.rate',
      'deliveryLevel.body.anomaly',
      'deliveryLevel.file.burst',
      ...['disk', 'context', 'battery'].flatMap((metric) =>
        ['warn', 'critical'].map((severity) => `floor.${metric}.${severity}`),
      ),
    ];
    if (typeof param === 'string') fields.param = params.includes(param) ? param : '[redacted]';
    const reason = Reflect.get(change, 'rejectionReason');
    const reasons = [
      'nonfinite clock',
      'unknown param',
      'type mismatch',
      'nonfinite',
      'no-op',
      'not in choices',
      'out of bounds',
      'untrusted actor',
      'param locked',
      'restore pending',
      'tuning disabled: restore-failed',
      'tuning disabled: storage-failed',
      'exceeds ±50%',
      'exceeds 0.5–2 times',
      'critical exceeds warn',
      'wake requires user approval',
      'safety: cannot loosen',
      'frozen: wall clock behind saved highwater',
      'hourly change limit',
      'daily change limit',
      'global daily change limit',
      'unknown or consumed alert',
    ];
    if (typeof reason === 'string' && reasons.includes(reason)) {
      fields.rejectionReason = reason;
      result.reason = reason;
    }
    for (const key of ['from', 'to']) {
      const item = Reflect.get(change, key);
      if (
        typeof item === 'number' ||
        typeof item === 'boolean' ||
        (typeof item === 'string' && ['record', 'context', 'wake'].includes(item))
      )
        fields[key] = item;
    }
    result.change = fields;
  }
  return modelOutput(result);
}

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

export function modelOutput(value: unknown, now?: number, appNamePaths: readonly string[] = []): JsonValue {
  const normalized = minimize(json(value), os.hostname(), '', appNamePaths);
  const result = now === undefined ? normalized : ages(normalized, now);
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') <= MAX_BYTES) return result;
  return {
    truncated: true,
    message: 'Result exceeds the size limit. Request a smaller section or inspect the current foreground application.',
  };
}

type Runtime = Pick<ReturnType<typeof createSenseRuntime>, 'tools' | 'events' | 'rules'>;

export function environmentDetail(
  runtime: Runtime,
  app?: string,
  window?: string,
  sessionId?: string,
  countFresh = true,
): JsonValue {
  const snapshot = runtime.tools.envState(undefined, sessionId);
  if (!('env' in snapshot) || !('observation' in snapshot)) throw new TypeError('full sense state unavailable');
  const { env, observation } = snapshot;
  const front = env.frontApp.value;
  const axStatus = observation.sources['helper.ax']?.status;
  const countDenied = axStatus === 'denied' || axStatus === 'unsupported';
  const title = env.focusedWindow.value?.title;
  const matchesApp =
    front === null ? null : app === undefined || app === modelAppName(front.name) || app === front.bundleId;
  const matchesWindow = window === undefined ? true : title === undefined ? null : modelTitle(title) === window;
  const available = matchesApp === true && matchesWindow === true;
  const mismatch = matchesApp === false || matchesWindow === false;
  const pid =
    available && front?.pid !== undefined
      ? { value: front.pid, status: env.frontApp.status }
      : { value: null, status: 'unknown' };
  const windowCount =
    available && countDenied
      ? { value: null, status: axStatus }
      : available && countFresh && front?.windowCount !== undefined
        ? { value: front.windowCount, status: env.frontApp.status }
        : { value: null, status: 'unknown' };
  const events = available
    ? runtime
        .events()
        .filter((event) =>
          ['app.activated', 'app.launched', 'app.terminated', 'window.focused', 'window.title-changed'].includes(
            event.kind,
          ),
        )
        .slice(-20)
        .map(({ kind, at, level }) => ({ kind, at, level }))
    : [];
  return modelOutput(
    {
      current: available,
      match: mismatch ? 'not-current' : available ? 'current' : 'unknown',
      app: mismatch
        ? null
        : fact(env.frontApp, (value) => ({
            name: modelAppName(value.name),
            ...pick(value, ['pid', ...(countFresh && !countDenied ? ['windowCount'] : [])]),
          })),
      window: mismatch ? null : fact(env.focusedWindow, (value) => ({ title: value.title })),
      pid,
      windowCount,
      recentEvents: events,
      sources: observations(observation).sources,
      guidance: '如需查看窗口内容，请使用当前会话可用的 computer-use 工具（需经其授权流程）',
    },
    undefined,
    ['app.value.name'],
  );
}
