import { createHash } from 'node:crypto';
import os from 'node:os';
import type { Fact, SenseState, WatchRule } from '@asi/sense-types';
import { isRemoteJsonValue } from '@deepseek-ai/dsh-typert-protocol';
import type { createSenseRuntime } from '../runtime/index.ts';
import type { JsonValue } from './wire-types.ts';

const MAX_BYTES = 32_768;
const MAX_TITLE_LENGTH = 512;
const PLACEHOLDERS = ['<host>', '[host]', '[endpoint]', '[path]', '[redacted]'] as const;
const PLACEHOLDERS_SET = new Set<string>(PLACEHOLDERS);
const COMBINING_MARK_AT_RE = /\p{M}/uy;
const SURROGATE_RE = /[\ud800-\udfff]/;
const NON_ASCII_RE = /[\u0080-\uffff]/;
const FAST_TRUNCATE_UNSAFE_RE = /[\p{M}\u1160-\u11ff\ud7b0-\ud7ff<[]/u;
const NEEDS_CLUSTER_NFC_RE =
  /[\p{M}\u1100-\u11ff\ud7b0-\ud7ff\u00b5\u00df\u0130\u0149\u017f\u01f0\u037e\u03c2\u03d0-\u03f5\u0587\u1c80-\u1c88\u1e96-\u1e9e\u1f80-\u1ffc\u1fef\u2100-\u214f\ufb00-\ufb17\uff01-\uff5e]/u;
const CLUSTER_BOUND_LOOKAHEAD = '(?![\\p{M}\\u1160-\\u11ff\\ud7b0-\\ud7ff])';

const ZERO_WIDTH_QUICK_RE = /\u034f|[\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/;
const ZERO_WIDTH_UNCONDITIONAL_RE =
  /\u034f+|[\u00ad\u061c\u180e\u200b\u200c\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]+/g;

// Covers ASCII / \ plus every Unicode char whose NFKC or homoglyph mapping produces / or \.
const MAYBE_SLASH_RE =
  /[/\\\u00bc-\u00be\u2044\u2100\u2101\u2105\u2106\u2150-\u215f\u2189\u2215\u2216\u2571\u2572\u29f5\u29f8\u29f9\u33a7\u33a8\u33ae\u33af\u33c6\u33de\u33df\ufe68\uff0f\uff3c]/;

// Covers ASCII @ % [ ] : plus Unicode/NFKC/homoglyph equivalents.
const MAYBE_ENDPOINT_META_RE =
  /[:@%[\]\u02d0\u02f8\u0589\u05c3\u066a\u0703\u1361\u1803\u2052\u205a\u205d\u2236\u2a74\ua789\ufe13\ufe47\ufe48\ufe55\ufe6a\ufe6b\uff05\uff1a\uff20\uff3b\uff3d]/;

const SINGLE_CHAR_HOMOGLYPHS: Readonly<Record<string, string>> = {
  '\u2215': '/',
  '\u2044': '/',
  '\u29f8': '/',
  '\u2571': '/',
  '\u29f5': '\\',
  '\u29f9': '\\',
  '\u2216': '\\',
  '\u2572': '\\',
  '\u2236': ':',
  '\u02d0': ':',
  '\u02f8': ':',
  '\u0589': ':',
  '\u05c3': ':',
  '\u0703': ':',
  '\u1361': ':',
  '\u1803': ':',
  '\u205a': ':',
  '\u205d': ':',
  '\ua789': ':',
  '\u2024': '.',
  '\u2027': '.',
  '\u3002': '.',
  '\uff61': '.',
  '\u066a': '%',
  '\u2052': '%',
};

const SAFE_FILE_EXTENSIONS = new Set([
  'md',
  'txt',
  'rtf',
  'pdf',
  'csv',
  'tsv',
  'json',
  'jsonl',
  'yaml',
  'yml',
  'toml',
  'xml',
  'ini',
  'cfg',
  'conf',
  'log',
  'sql',
  'tex',
  'doc',
  'docx',
  'ppt',
  'pptx',
  'xls',
  'xlsx',
  'key',
  'pages',
  'numbers',
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'html',
  'htm',
  'css',
  'scss',
  'less',
  'vue',
  'svelte',
  'py',
  'rs',
  'go',
  'java',
  'kt',
  'swift',
  'c',
  'cpp',
  'cc',
  'h',
  'hpp',
  'rb',
  'php',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'svg',
  'webp',
  'heic',
  'mov',
  'mp4',
  'mp3',
  'wav',
  'zip',
]);

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
  if (!SURROGATE_RE.test(text)) return text.length;
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
  const candidate = text.slice(0, maxCodePoints);
  if (!SURROGATE_RE.test(candidate)) return candidate;
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
  const head = text.slice(0, limit + 1);
  if (!SURROGATE_RE.test(head) && !FAST_TRUNCATE_UNSAFE_RE.test(head)) {
    return text.slice(0, limit);
  }
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
    const firstCp = text.codePointAt(i) ?? 0;
    let end = i + (firstCp > 0xffff ? 2 : 1);
    let clusterCps = 1;
    while (end < text.length) {
      const nextCp = text.codePointAt(end) ?? 0;
      if (!isClusterContinuation(text, end, nextCp)) break;
      clusterCps += 1;
      end += nextCp > 0xffff ? 2 : 1;
      if (cps > 0 && cps + clusterCps > limit) break;
      if (cps === 0 && clusterCps >= limit) break;
    }
    if (cps + clusterCps > limit) {
      if (cps === 0) return sliceByCodePoints(text, limit);
      break;
    }
    cps += clusterCps;
    i = end;
  }
  return i === text.length ? text : text.slice(0, i);
}

function isAscii(text: string): boolean {
  return !NON_ASCII_RE.test(text);
}

function isAsciiLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

const EP_SINGLE_RE = /^\p{Extended_Pictographic}$/u;
const EP_MOD_OR_VS_RE = /^[\ufe0e\ufe0f\p{Emoji_Modifier}]$/u;

function hasEmojiBeforeOffset(str: string, offset: number): boolean {
  if (offset <= 0) return false;
  let prevStart = offset - 1;
  const prevUnit = str.charCodeAt(prevStart);
  if (prevUnit >= 0xdc00 && prevUnit <= 0xdfff && prevStart > 0) {
    const high = str.charCodeAt(prevStart - 1);
    if (high >= 0xd800 && high <= 0xdbff) prevStart--;
  }
  const prevCh = str.slice(prevStart, offset);
  if (EP_SINGLE_RE.test(prevCh)) return true;
  if (!EP_MOD_OR_VS_RE.test(prevCh) || prevStart <= 0) return false;
  let baseStart = prevStart - 1;
  const baseUnit = str.charCodeAt(baseStart);
  if (baseUnit >= 0xdc00 && baseUnit <= 0xdfff && baseStart > 0) {
    const high = str.charCodeAt(baseStart - 1);
    if (high >= 0xd800 && high <= 0xdbff) baseStart--;
  }
  return EP_SINGLE_RE.test(str.slice(baseStart, prevStart));
}

function stripZeroWidth(text: string): string {
  if (!ZERO_WIDTH_QUICK_RE.test(text)) return text;
  const stripped = text.replace(ZERO_WIDTH_UNCONDITIONAL_RE, '');
  if (!stripped.includes('\u200d')) return stripped;
  let out = '';
  let last = 0;
  for (let i = 0; i < stripped.length; i++) {
    if (stripped.charCodeAt(i) !== 0x200d) continue;
    const afterSlice = stripped.slice(i + 1, i + 3);
    const afterCp = afterSlice.codePointAt(0);
    const afterChar = afterCp === undefined ? '' : String.fromCodePoint(afterCp);
    if (hasEmojiBeforeOffset(stripped, i) && EP_SINGLE_RE.test(afterChar)) continue;
    out += stripped.slice(last, i);
    last = i + 1;
  }
  return last === 0 ? stripped : out + stripped.slice(last);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function foldCaseNfc(value: string): string {
  const nfkc = value.normalize('NFKC');
  const lowered = nfkc.includes('\u0130') ? nfkc.replaceAll('\u0130', 'i\u0307').normalize('NFKC') : nfkc;
  if (lowered.includes('\u0131')) {
    return lowered
      .split('\u0131')
      .map((part) => (part ? part.toLowerCase().toUpperCase().toLowerCase().normalize('NFKC') : ''))
      .join('\u0131');
  }
  return lowered.toLowerCase().toUpperCase().toLowerCase().normalize('NFKC');
}

function isClusterContinuation(text: string, index: number, cp: number): boolean {
  if (index === 0) return false;
  if (cp < 0x0300 || (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0xac00 && cp <= 0xd7a3)) return false;
  if (cp <= 0x036f) return true;
  if (cp >= 0x1160 && cp <= 0x11ff) return true;
  if (cp >= 0xd7b0 && cp <= 0xd7ff) return true;
  COMBINING_MARK_AT_RE.lastIndex = index;
  return COMBINING_MARK_AT_RE.test(text);
}

interface HostSpec {
  folded: string;
  escapedPattern: string;
  asciiRe: RegExp;
  nfcRe: RegExp;
  ascii: boolean;
  clusters: number;
  maxNfdClusterCps: number;
  hasDelimiters: boolean;
  allDelimiters: boolean;
  unmatchable: string;
}

const HOST_SPEC_CACHE = new Map<string, HostSpec>();

function pickUnmatchable(avoid: string): string {
  for (let cp = 0xfdd0; cp <= 0xfdef; cp++) {
    const ch = String.fromCharCode(cp);
    if (!avoid.includes(ch)) return ch;
  }
  for (let cp = 0xe000; cp <= 0xf8ff; cp++) {
    const ch = String.fromCharCode(cp);
    if (!avoid.includes(ch)) return ch;
  }
  return '\uFFFF';
}

function measureNfdClusters(value: string): { clusters: number; maxNfdClusterCps: number } {
  const nfd = value.normalize('NFD');
  let clusters = 0;
  let maxNfdClusterCps = 1;
  let clusterCps = 0;
  for (let i = 0; i < nfd.length; ) {
    const cp = nfd.codePointAt(i) ?? 0;
    const len = cp > 0xffff ? 2 : 1;
    if (!isClusterContinuation(nfd, i, cp)) {
      if (clusterCps > maxNfdClusterCps) maxNfdClusterCps = clusterCps;
      clusters++;
      clusterCps = 1;
    } else {
      clusterCps++;
    }
    i += len;
  }
  if (clusterCps > maxNfdClusterCps) maxNfdClusterCps = clusterCps;
  return { clusters, maxNfdClusterCps };
}

function analyzeHost(hostname: string): HostSpec | undefined {
  const cleanHost = stripZeroWidth(hostname);
  if (!cleanHost) return undefined;
  const cached = HOST_SPEC_CACHE.get(cleanHost);
  if (cached) return cached;
  const asciiInput = isAscii(cleanHost);
  const foldedRaw = asciiInput ? cleanHost.toLowerCase() : foldCaseNfc(cleanHost);
  const folded = foldedRaw.replace(/\s+/gu, ' ');
  const ascii = asciiInput || isAscii(folded);
  let clusters: number;
  let maxNfdClusterCps = 1;
  if (asciiInput) {
    clusters = folded.length;
  } else {
    const rawStats = measureNfdClusters(cleanHost);
    const foldedStats = measureNfdClusters(folded);
    clusters = Math.max(rawStats.clusters, foldedStats.clusters);
    maxNfdClusterCps = Math.max(rawStats.maxNfdClusterCps, foldedStats.maxNfdClusterCps);
  }
  const hasDelimiters = /\s/u.test(folded);
  const allDelimiters = hasDelimiters && folded.replace(/\s+/gu, '').length === 0;
  const escapedPattern = folded.split(/\s+/u).map(escapeRegExp).join('\\s+');
  const spec: HostSpec = {
    folded,
    escapedPattern,
    asciiRe: new RegExp(`${escapedPattern}${CLUSTER_BOUND_LOOKAHEAD}`, 'giu'),
    nfcRe: new RegExp(escapedPattern, 'gu'),
    ascii,
    clusters,
    maxNfdClusterCps,
    hasDelimiters,
    allDelimiters,
    unmatchable: pickUnmatchable(folded),
  };
  if (HOST_SPEC_CACHE.size >= 32) {
    const oldest = HOST_SPEC_CACHE.keys().next().value;
    if (oldest !== undefined) HOST_SPEC_CACHE.delete(oldest);
  }
  HOST_SPEC_CACHE.set(cleanHost, spec);
  return spec;
}

function sliceAsciiBound(text: string, maxCodePoints: number): string {
  if (maxCodePoints <= 0) return '';
  if (text.length <= maxCodePoints) return text;
  let i = 0;
  const candidate = text.slice(0, maxCodePoints);
  if (!SURROGATE_RE.test(candidate)) {
    i = maxCodePoints;
  } else {
    let cps = 0;
    while (i < text.length && cps < maxCodePoints) {
      const cp = text.codePointAt(i) ?? 0;
      cps += 1;
      i += cp > 0xffff ? 2 : 1;
    }
  }
  // Only need at most one trailing combining mark past bound for CLUSTER_BOUND_LOOKAHEAD.
  if (i < text.length) {
    const nextCp = text.codePointAt(i) ?? 0;
    if (isClusterContinuation(text, i, nextCp)) {
      i += nextCp > 0xffff ? 2 : 1;
    }
  }
  return i >= text.length ? text : text.slice(0, i);
}

function sliceToClusterBound(text: string, maxClusters: number, limit?: number, maxMatchClusterCps = 33): string {
  if (text.length <= maxClusters && (limit === undefined || text.length <= limit)) return text;
  const candidate = text.slice(0, maxClusters);
  if (text.length > maxClusters && !NEEDS_CLUSTER_NFC_RE.test(candidate) && !/[\ud800-\udfff]/.test(candidate)) {
    const nextCp = text.codePointAt(maxClusters) ?? 0;
    if (!isClusterContinuation(text, maxClusters, nextCp)) return candidate;
  }
  let clusters = 0;
  let i = 0;
  let clusterCps = 0;
  let permanentCps = 0;
  while (i < text.length) {
    const code = text.charCodeAt(i);
    if (code < 0x300 || (code >= 0x4e00 && code <= 0x9fff) || (code >= 0xac00 && code <= 0xd7a3)) {
      if (i > 0 && ++clusters >= maxClusters) return text.slice(0, i);
      clusterCps = 1;
      i += 1;
      continue;
    }
    if (
      i > 0 &&
      ((code >= 0x0300 && code <= 0x036f) || (code >= 0x1160 && code <= 0x11ff) || (code >= 0xd7b0 && code <= 0xd7ff))
    ) {
      clusterCps++;
      if (clusterCps === maxMatchClusterCps + 1) {
        permanentCps += clusterCps;
      } else if (clusterCps > maxMatchClusterCps + 1) {
        permanentCps++;
      }
      if (limit !== undefined && permanentCps >= limit) return text.slice(0, i + 1);
      i += 1;
      continue;
    }
    const cp = code >= 0xd800 && code <= 0xdbff ? (text.codePointAt(i) ?? code) : code;
    const len = cp > 0xffff ? 2 : 1;
    if (isClusterContinuation(text, i, cp)) {
      clusterCps++;
      if (clusterCps === maxMatchClusterCps + 1) {
        permanentCps += clusterCps;
      } else if (clusterCps > maxMatchClusterCps + 1) {
        permanentCps++;
      }
      if (limit !== undefined && permanentCps >= limit) return text.slice(0, i + len);
      i += len;
      continue;
    }
    if (i > 0 && ++clusters >= maxClusters) return text.slice(0, i);
    clusterCps = 1;
    i += len;
  }
  return text;
}

function segmentNfcClusters(
  text: string,
  maxClusterCps: number,
  unmatchable: string,
): { rawStarts: number[]; nfcStarts: number[]; nfc: string } {
  const normCache = new Map<string, string>();
  const rawStarts: number[] = [];
  const nfcStarts: number[] = [];
  let nfcParts: string[] | undefined;
  let plainStart = 0;
  let nfcLen = 0;
  let segStart = 0;
  let segCps = 0;
  const pushChanged = (norm: string, end: number) => {
    if (!nfcParts) nfcParts = [];
    if (segStart > plainStart) nfcParts.push(text.slice(plainStart, segStart));
    nfcParts.push(norm);
    plainStart = end;
  };
  const pushCluster = (end: number) => {
    rawStarts.push(segStart);
    nfcStarts.push(nfcLen);
    const segLen = end - segStart;
    if (segCps > maxClusterCps) {
      pushChanged(unmatchable, end);
      nfcLen += unmatchable.length;
    } else if (segLen === 1) {
      const c0 = text.charCodeAt(segStart);
      if (c0 < 0x0080) {
        if (c0 >= 65 && c0 <= 90) {
          pushChanged(String.fromCharCode(c0 + 32), end);
        }
        nfcLen += 1;
      } else if (c0 >= 0x4e00 && c0 <= 0x9fff) {
        nfcLen += 1;
      } else {
        const seg = text.slice(segStart, end);
        let norm = normCache.get(seg);
        if (norm === undefined) {
          norm = foldCaseNfc(seg);
          if (normCache.size < 4096) normCache.set(seg, norm);
        }
        if (norm !== seg) pushChanged(norm, end);
        nfcLen += norm.length;
      }
    } else if (
      segLen === 2 &&
      text.charCodeAt(segStart) >= 0x4e00 &&
      text.charCodeAt(segStart) <= 0x9fff &&
      text.charCodeAt(segStart + 1) >= 0x0300 &&
      text.charCodeAt(segStart + 1) <= 0x036f &&
      (text.charCodeAt(segStart + 1) < 0x0340 || text.charCodeAt(segStart + 1) > 0x0344)
    ) {
      nfcLen += 2;
    } else {
      const seg = text.slice(segStart, end);
      let norm = normCache.get(seg);
      if (norm === undefined) {
        norm = foldCaseNfc(seg);
        if (normCache.size < 4096) normCache.set(seg, norm);
      }
      if (norm !== seg) pushChanged(norm, end);
      nfcLen += norm.length;
    }
    segStart = end;
    segCps = 0;
  };
  for (let i = 0; i < text.length; ) {
    const code = text.charCodeAt(i);
    if (code < 0x0300 || (code >= 0x4e00 && code <= 0x9fff) || (code >= 0xac00 && code <= 0xd7a3)) {
      if (i > segStart) pushCluster(i);
      segCps++;
      i += 1;
      continue;
    }
    if (
      i > segStart &&
      ((code >= 0x0300 && code <= 0x036f) || (code >= 0x1160 && code <= 0x11ff) || (code >= 0xd7b0 && code <= 0xd7ff))
    ) {
      segCps++;
      i += 1;
      continue;
    }
    const cp = code >= 0xd800 && code <= 0xdbff ? (text.codePointAt(i) ?? code) : code;
    const len = cp > 0xffff ? 2 : 1;
    if (!isClusterContinuation(text, i, cp) && i > segStart) pushCluster(i);
    segCps++;
    i += len;
  }
  if (text.length > segStart) pushCluster(text.length);
  rawStarts.push(text.length);
  nfcStarts.push(nfcLen);
  let nfc: string;
  if (!nfcParts) {
    nfc = text;
  } else {
    if (plainStart < text.length) nfcParts.push(text.slice(plainStart));
    nfc = nfcParts.join('');
  }
  return { rawStarts, nfcStarts, nfc };
}

const ASCII_HOST_NEEDS_CLUSTER_RE =
  /[\u00df\u1e9e\u0130\u0149\u037e\u1fef\u1e9a\ufb00-\ufb06\uff01-\uff5e\u2100-\u214f]/u;

/**
 * Replaces case-insensitive NFC-equivalent matches of `host` in `text`
 * without altering non-matching NFD sequences or splitting combining clusters.
 * Also returns the offset after the last replacement (`tailStart`).
 */
function replaceHostWithTail(
  text: string,
  host: HostSpec,
  replacement: string,
  limit?: number,
): { text: string; tailStart: number } {
  if (!text) return { text, tailStart: 0 };
  if (host.ascii) {
    if (text.length < host.folded.length && (isAscii(text) || !ASCII_HOST_NEEDS_CLUSTER_RE.test(text))) {
      return { text, tailStart: 0 };
    }
    const boundCps =
      limit === undefined
        ? undefined
        : Math.ceil(limit * Math.max(1, host.folded.length / replacement.length)) + host.folded.length + 1;
    const bounded = boundCps === undefined ? text : sliceAsciiBound(text, boundCps);
    if (isAscii(bounded) || !ASCII_HOST_NEEDS_CLUSTER_RE.test(bounded)) {
      const hostRe = host.asciiRe;
      hostRe.lastIndex = 0;
      if (limit === undefined || bounded.length <= limit * 2) {
        let out = '';
        let last = 0;
        let tailStart = 0;
        for (let match = hostRe.exec(bounded); match !== null; match = hostRe.exec(bounded)) {
          out += bounded.slice(last, match.index) + replacement;
          tailStart = out.length;
          last = match.index + match[0].length;
          if (match[0].length === 0) hostRe.lastIndex++;
        }
        return last === 0 ? { text: bounded, tailStart: 0 } : { text: out + bounded.slice(last), tailStart };
      }
      let out = '';
      let last = 0;
      let outCps = 0;
      for (let match = hostRe.exec(bounded); match !== null; match = hostRe.exec(bounded)) {
        const gap = bounded.slice(last, match.index);
        out += gap + replacement;
        outCps += countCodePoints(gap) + replacement.length;
        last = match.index + match[0].length;
        if (match[0].length === 0) hostRe.lastIndex++;
        if (outCps >= limit) return { text: out, tailStart: out.length };
      }
      return last === 0 ? { text: bounded, tailStart: 0 } : { text: out + bounded.slice(last), tailStart: out.length };
    }
  }
  const maxClusters =
    limit === undefined
      ? Number.POSITIVE_INFINITY
      : Math.ceil(limit * Math.max(1, host.clusters / replacement.length)) + host.clusters;
  const clusterCap = host.maxNfdClusterCps;
  const bounded = limit === undefined ? text : sliceToClusterBound(text, maxClusters, limit, clusterCap);
  if (!host.ascii && isAscii(bounded)) {
    return { text: bounded, tailStart: 0 };
  }
  if (!NEEDS_CLUSTER_NFC_RE.test(bounded) && bounded.normalize('NFKC') === bounded) {
    const hostRe = host.asciiRe;
    hostRe.lastIndex = 0;
    let out = '';
    let last = 0;
    let outCps = 0;
    let tailStart = 0;
    for (let match = hostRe.exec(bounded); match !== null; match = hostRe.exec(bounded)) {
      const gap = bounded.slice(last, match.index);
      out += gap + replacement;
      tailStart = out.length;
      outCps += countCodePoints(gap) + replacement.length;
      last = match.index + match[0].length;
      if (match[0].length === 0) hostRe.lastIndex++;
      if (limit !== undefined && outCps >= limit) return { text: out, tailStart: out.length };
    }
    return last === 0 ? { text: bounded, tailStart: 0 } : { text: out + bounded.slice(last), tailStart };
  }
  const { rawStarts, nfcStarts, nfc } = segmentNfcClusters(bounded, clusterCap, host.unmatchable);
  const hostRe = host.nfcRe;
  hostRe.lastIndex = 0;
  let out = '';
  let lastRaw = 0;
  let segCursor = 0;
  let outCps = 0;
  let tailStart = 0;
  const numSegs = nfcStarts.length - 1;
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
    const gap = bounded.slice(lastRaw, rawFrom);
    out += gap + replacement;
    tailStart = out.length;
    outCps += countCodePoints(gap) + replacement.length;
    lastRaw = rawTo;
    segCursor = endCursor;
    if (limit !== undefined && outCps >= limit) return { text: out, tailStart: out.length };
  }
  return lastRaw === 0 ? { text: bounded, tailStart: 0 } : { text: out + bounded.slice(lastRaw), tailStart };
}

const CLS_BASE = 0;
const CLS_MID_PUNCT = 1;
const CLS_TRAILING_ONLY = 2;
const CLS_DOT = 3;
const CLS_SLASH = 4;
const CLS_MARK = 5;
const CLS_EMOJI = 6;
const CLS_EMOJI_MOD = 7;
const CLS_ZWJ = 8;
const CLS_UNSAFE = 9;

const ASCII_CHAR_CLASS = new Uint8Array(128);
ASCII_CHAR_CLASS.fill(CLS_UNSAFE);
for (let c = 48; c <= 57; c++) ASCII_CHAR_CLASS[c] = CLS_BASE;
for (let c = 65; c <= 90; c++) ASCII_CHAR_CLASS[c] = CLS_BASE;
for (let c = 97; c <= 122; c++) ASCII_CHAR_CLASS[c] = CLS_BASE;
for (const ch of ['-', '_', "'", '!', '?']) ASCII_CHAR_CLASS[ch.charCodeAt(0)] = CLS_MID_PUNCT;
for (const ch of [',', ';', ':', ')', ']']) ASCII_CHAR_CLASS[ch.charCodeAt(0)] = CLS_TRAILING_ONLY;
ASCII_CHAR_CLASS[46] = CLS_DOT;
ASCII_CHAR_CLASS[47] = CLS_SLASH;
ASCII_CHAR_CLASS[92] = CLS_SLASH;

const UNICODE_LETTER_OR_NUM_RE = /^[\p{L}\p{N}]$/u;
const UNICODE_MARK_RE = /^\p{M}$/u;
const UNICODE_EMOJI_MOD_RE = /^\p{Emoji_Modifier}$/u;
const NON_ASCII_DET_CACHE = new Map<number, { mapped: string; kinds: Uint8Array }>();

function classifyMappedChar(ch: string): number {
  const code = ch.charCodeAt(0);
  if (ch.length === 1 && code < 0x80) return ASCII_CHAR_CLASS[code] ?? CLS_UNSAFE;
  if (ch === '\u2019' || ch === '\u2026' || ch === '\u00b7' || ch === '\u2014') return CLS_MID_PUNCT;
  if (UNICODE_LETTER_OR_NUM_RE.test(ch)) return CLS_BASE;
  if (UNICODE_MARK_RE.test(ch)) return CLS_MARK;
  if (EP_SINGLE_RE.test(ch)) return CLS_EMOJI;
  if (UNICODE_EMOJI_MOD_RE.test(ch)) return CLS_EMOJI_MOD;
  if (ch === '\u200d') return CLS_ZWJ;
  return CLS_UNSAFE;
}

function getNonAsciiDetInfo(cp: number): { mapped: string; kinds: Uint8Array } {
  const cached = NON_ASCII_DET_CACHE.get(cp);
  if (cached) return cached;
  let info: { mapped: string; kinds: Uint8Array };
  if (cp >= 0xd800 && cp <= 0xdfff) {
    info = { mapped: '', kinds: Uint8Array.of(CLS_UNSAFE) };
  } else {
    const raw = String.fromCodePoint(cp);
    const nfkc = cp === 0x2026 ? '\u2026' : raw.normalize('NFKC');
    let mapped = '';
    for (const ch of nfkc) {
      mapped += SINGLE_CHAR_HOMOGLYPHS[ch] ?? ch;
    }
    const chars = Array.from(mapped);
    const kinds = new Uint8Array(chars.length);
    for (let i = 0; i < chars.length; i++) {
      kinds[i] = classifyMappedChar(chars[i] as string);
    }
    info = { mapped, kinds };
  }
  if (NON_ASCII_DET_CACHE.size >= 4096) {
    const oldest = NON_ASCII_DET_CACHE.keys().next().value;
    if (oldest !== undefined) NON_ASCII_DET_CACHE.delete(oldest);
  }
  NON_ASCII_DET_CACHE.set(cp, info);
  return info;
}

function readCodePointAt(text: string, index: number): { cp: number; len: number; valid: boolean } {
  const code = text.charCodeAt(index);
  if (code < 0xd800 || code > 0xdfff) return { cp: code, len: 1, valid: true };
  if (code <= 0xdbff && index + 1 < text.length) {
    const low = text.charCodeAt(index + 1);
    if (low >= 0xdc00 && low <= 0xdfff) {
      return { cp: 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00), len: 2, valid: true };
    }
  }
  return { cp: code, len: 1, valid: false };
}

function isWhitespaceCode(code: number): boolean {
  if (code === 32 || (code >= 9 && code <= 13)) return true;
  if (code < 0xa0) return false;
  return (
    code === 0x00a0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

function endsWithDetectionColon(rawToken: string): boolean {
  if (!rawToken) return false;
  const lastCode = rawToken.charCodeAt(rawToken.length - 1);
  if (lastCode < 0x80) return lastCode === 58;
  let start = rawToken.length - 1;
  if (lastCode >= 0xdc00 && lastCode <= 0xdfff && start > 0) {
    const high = rawToken.charCodeAt(start - 1);
    if (high >= 0xd800 && high <= 0xdbff) start--;
  }
  const { cp, valid } = readCodePointAt(rawToken, start);
  if (!valid) return false;
  return getNonAsciiDetInfo(cp).mapped.endsWith(':');
}

function isTrailingPortPunct(ch: string): boolean {
  const cls = classifyMappedChar(ch);
  return cls === CLS_TRAILING_ONLY || cls === CLS_DOT || cls === CLS_MID_PUNCT;
}

function isDetectionDigitsWithOptionalTrailingPunct(rawToken: string): boolean {
  let sawDigit = false;
  for (let i = 0; i < rawToken.length; ) {
    const code = rawToken.charCodeAt(i);
    if (code < 0x80) {
      const isLast = i + 1 === rawToken.length;
      if (code >= 48 && code <= 57) {
        sawDigit = true;
        i++;
        continue;
      }
      if (isLast && sawDigit && isTrailingPortPunct(rawToken[i] as string)) {
        return true;
      }
      return false;
    }
    const { cp, len, valid } = readCodePointAt(rawToken, i);
    if (!valid) return false;
    const { mapped } = getNonAsciiDetInfo(cp);
    const isLastRaw = i + len === rawToken.length;
    for (let k = 0; k < mapped.length; k++) {
      const mc = mapped.charCodeAt(k);
      if (mc >= 48 && mc <= 57) {
        sawDigit = true;
        continue;
      }
      const isVeryLast = isLastRaw && k + 1 === mapped.length;
      if (isVeryLast && sawDigit && isTrailingPortPunct(mapped[k] as string)) {
        return true;
      }
      return false;
    }
    i += len;
  }
  return sawDigit;
}

function isSafeNonPathToken(rawToken: string): boolean {
  if (!rawToken) return false;
  let hasBaseOrEmoji = false;
  let hasStemAlnum = false;
  let lastWasMarkable = false;
  let lastWasEmoji = false;
  let lastWasEmojiChain = false;
  let dotCount = 0;
  let ext = '';
  let finishedWithTrailingPunct = false;

  const stepChar = (cls: number, asciiCharCode: number, isVeryLast: boolean): boolean => {
    if (finishedWithTrailingPunct) return false;
    if (dotCount === 1) {
      if (
        isVeryLast &&
        (cls === CLS_TRAILING_ONLY || cls === CLS_DOT || asciiCharCode === 33 || asciiCharCode === 63)
      ) {
        finishedWithTrailingPunct = true;
        return true;
      }
      if (cls === CLS_BASE && isAsciiLetter(asciiCharCode) && ext.length < 5) {
        ext += String.fromCharCode(asciiCharCode);
        return true;
      }
      return false;
    }
    if (cls === CLS_BASE) {
      hasBaseOrEmoji = true;
      hasStemAlnum = true;
      lastWasMarkable = true;
      lastWasEmoji = false;
      lastWasEmojiChain = false;
      return true;
    }
    if (cls === CLS_EMOJI) {
      hasBaseOrEmoji = true;
      lastWasMarkable = true;
      lastWasEmoji = true;
      lastWasEmojiChain = true;
      return true;
    }
    if (cls === CLS_MARK) {
      if (!lastWasMarkable) return false;
      lastWasEmoji = false;
      return true;
    }
    if (cls === CLS_EMOJI_MOD) {
      if (!lastWasEmoji) return false;
      lastWasEmoji = false;
      lastWasMarkable = true;
      lastWasEmojiChain = true;
      return true;
    }
    if (cls === CLS_ZWJ) {
      if (!lastWasEmojiChain) return false;
      lastWasEmoji = false;
      lastWasMarkable = false;
      return true;
    }
    if (cls === CLS_MID_PUNCT) {
      lastWasMarkable = false;
      lastWasEmoji = false;
      lastWasEmojiChain = false;
      return true;
    }
    if (cls === CLS_TRAILING_ONLY) {
      if (!isVeryLast || !hasBaseOrEmoji) return false;
      finishedWithTrailingPunct = true;
      return true;
    }
    if (cls === CLS_DOT) {
      if (isVeryLast) {
        if (!hasBaseOrEmoji) return false;
        finishedWithTrailingPunct = true;
        return true;
      }
      if (!hasStemAlnum) return false;
      dotCount = 1;
      lastWasMarkable = false;
      lastWasEmoji = false;
      lastWasEmojiChain = false;
      return true;
    }
    return false;
  };

  for (let i = 0; i < rawToken.length; ) {
    const code = rawToken.charCodeAt(i);
    if (code < 0x80) {
      const cls = ASCII_CHAR_CLASS[code] ?? CLS_UNSAFE;
      if (cls === CLS_BASE && dotCount === 0 && !finishedWithTrailingPunct) {
        hasBaseOrEmoji = true;
        hasStemAlnum = true;
        lastWasMarkable = true;
        lastWasEmoji = false;
        lastWasEmojiChain = false;
        i += 1;
        continue;
      }
      if (!stepChar(cls, code, i + 1 === rawToken.length)) return false;
      i += 1;
      continue;
    }
    if (code >= 0x4e00 && code <= 0x9fff && dotCount === 0 && !finishedWithTrailingPunct) {
      hasBaseOrEmoji = true;
      hasStemAlnum = true;
      lastWasMarkable = true;
      lastWasEmoji = false;
      lastWasEmojiChain = false;
      i += 1;
      continue;
    }
    if (code >= 0x0300 && code <= 0x036f && dotCount === 0 && !finishedWithTrailingPunct) {
      if (!lastWasMarkable) return false;
      lastWasEmoji = false;
      i += 1;
      continue;
    }
    if (code >= 0x4e00 && code <= 0x9fff) {
      if (!stepChar(CLS_BASE, 0, i + 1 === rawToken.length)) return false;
      i += 1;
      continue;
    }
    if (code >= 0x0300 && code <= 0x036f) {
      if (!stepChar(CLS_MARK, 0, i + 1 === rawToken.length)) return false;
      i += 1;
      continue;
    }
    const { cp, len, valid } = readCodePointAt(rawToken, i);
    if (!valid) return false;
    const info = getNonAsciiDetInfo(cp);
    const isLastRaw = i + len === rawToken.length;
    if (info.mapped.length === 0) return false;
    let mOff = 0;
    for (let k = 0; k < info.kinds.length; k++) {
      const mcp = info.mapped.codePointAt(mOff) ?? 0;
      const mLen = mcp > 0xffff ? 2 : 1;
      const isVeryLast = isLastRaw && mOff + mLen === info.mapped.length;
      if (!stepChar(info.kinds[k] ?? CLS_UNSAFE, mcp < 0x80 ? mcp : 0, isVeryLast)) return false;
      mOff += mLen;
    }
    i += len;
  }

  if (dotCount === 1) {
    return ext.length >= 1 && SAFE_FILE_EXTENSIONS.has(ext.toLowerCase());
  }
  return true;
}

function isRawSingleSlashChar(rawToken: string, index: number): boolean {
  const code = rawToken.charCodeAt(index);
  if (code === 47 || code === 92) return true;
  if (code < 0x80) return false;
  const ch = rawToken[index] as string;
  const mapped = SINGLE_CHAR_HOMOGLYPHS[ch];
  if (mapped === '/' || mapped === '\\') return true;
  return ch === '\uff0f' || ch === '\uff3c' || ch === '\ufe68';
}

function containsDetectionScheme(rawToken: string): boolean {
  if (rawToken.includes('://')) return true;
  if (!NON_ASCII_RE.test(rawToken) || !MAYBE_ENDPOINT_META_RE.test(rawToken)) return false;
  let p2 = '';
  let p1 = '';
  for (let i = 0; i < rawToken.length; ) {
    const code = rawToken.charCodeAt(i);
    if (code < 0x80) {
      const ch = rawToken[i] as string;
      if (p2 === ':' && p1 === '/' && ch === '/') return true;
      p2 = p1;
      p1 = ch;
      i += 1;
      continue;
    }
    if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x0300 && code <= 0x036f)) {
      p2 = '';
      p1 = '';
      i += 1;
      continue;
    }
    const { cp, len, valid } = readCodePointAt(rawToken, i);
    if (!valid) {
      p2 = '';
      p1 = '';
      i += 1;
      continue;
    }
    const { mapped } = getNonAsciiDetInfo(cp);
    for (let k = 0; k < mapped.length; k++) {
      const ch = mapped[k] as string;
      if (p2 === ':' && p1 === '/' && ch === '/') return true;
      p2 = p1;
      p1 = ch;
    }
    i += len;
  }
  return false;
}

function hasPathEndpointMeta(rawToken: string): boolean {
  if (!MAYBE_ENDPOINT_META_RE.test(rawToken)) return false;
  let detIndex = 0;
  let d0 = 0;
  let d1 = 0;
  let hasDrivePrefix = false;
  let deferredColon = false;
  for (let i = 0; i < rawToken.length; ) {
    const code = rawToken.charCodeAt(i);
    if (code < 0x80) {
      if (detIndex === 0) d0 = code;
      else if (detIndex === 1) d1 = code;
      else if (detIndex === 2) {
        hasDrivePrefix = isAsciiLetter(d0) && d1 === 58 && (code === 47 || code === 92);
        if (deferredColon && !hasDrivePrefix) return true;
        deferredColon = false;
      }
      if (code === 64 || code === 37 || code === 91 || code === 93) return true;
      if (code === 58) {
        if (detIndex === 1) deferredColon = true;
        else return true;
      }
      detIndex++;
      i += 1;
      continue;
    }
    if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x0300 && code <= 0x036f)) {
      if (deferredColon) return true;
      detIndex++;
      i += 1;
      continue;
    }
    const { cp, len, valid } = readCodePointAt(rawToken, i);
    if (!valid) {
      if (deferredColon) return true;
      detIndex++;
      i += 1;
      continue;
    }
    const { mapped } = getNonAsciiDetInfo(cp);
    for (let k = 0; k < mapped.length; k++) {
      const mc = mapped.charCodeAt(k);
      if (detIndex === 0) d0 = mc;
      else if (detIndex === 1) d1 = mc;
      else if (detIndex === 2) {
        hasDrivePrefix = isAsciiLetter(d0) && d1 === 58 && (mc === 47 || mc === 92);
        if (deferredColon && !hasDrivePrefix) return true;
        deferredColon = false;
      }
      if (mc === 64 || mc === 37 || mc === 91 || mc === 93) return true;
      if (mc === 58) {
        if (detIndex === 1) deferredColon = true;
        else return true;
      }
      detIndex++;
    }
    i += len;
  }
  return deferredColon && !hasDrivePrefix;
}

const DOUBLE_SLASH_QUICK_RE =
  /(?:[/\\]|[\u2044\u2215\u2216\u2571\u2572\u29f5\u29f8\u29f9\ufe68\uff0f\uff3c]){2}|[\u00bc-\u00be\u2100\u2101\u2105\u2106\u2150-\u215f\u2189\u33a7\u33a8\u33ae\u33af\u33c6\u33de\u33df]/;

function isUncOrTwoPartServerPath(rawToken: string): boolean {
  if (!DOUBLE_SLASH_QUICK_RE.test(rawToken)) return false;
  let prevWasSlash = false;
  let foundDouble = false;
  let doubleAtStart = false;
  let inSeg = false;
  let segsAfterDouble = 0;
  let detIndex = 0;
  for (let i = 0; i < rawToken.length; ) {
    const code = rawToken.charCodeAt(i);
    if (code < 0x80) {
      const isSlash = code === 47 || code === 92;
      if (!foundDouble) {
        if (isSlash && prevWasSlash) {
          foundDouble = true;
          doubleAtStart = detIndex === 1;
        }
        prevWasSlash = isSlash;
      } else if (isSlash) {
        inSeg = false;
      } else if (!inSeg) {
        inSeg = true;
        segsAfterDouble++;
        if (segsAfterDouble >= 3) return false;
      }
      detIndex++;
      i += 1;
      continue;
    }
    if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x0300 && code <= 0x036f)) {
      if (!foundDouble) prevWasSlash = false;
      else if (!inSeg) {
        inSeg = true;
        segsAfterDouble++;
        if (segsAfterDouble >= 3) return false;
      }
      detIndex++;
      i += 1;
      continue;
    }
    const { cp, len, valid } = readCodePointAt(rawToken, i);
    if (!valid) {
      if (!foundDouble) prevWasSlash = false;
      else if (!inSeg) {
        inSeg = true;
        segsAfterDouble++;
        if (segsAfterDouble >= 3) return false;
      }
      detIndex++;
      i += 1;
      continue;
    }
    const { mapped } = getNonAsciiDetInfo(cp);
    for (let k = 0; k < mapped.length; k++) {
      const mc = mapped.charCodeAt(k);
      const isSlash = mc === 47 || mc === 92;
      if (!foundDouble) {
        if (isSlash && prevWasSlash) {
          foundDouble = true;
          doubleAtStart = detIndex === 1;
        }
        prevWasSlash = isSlash;
      } else if (isSlash) {
        inSeg = false;
      } else if (!inSeg) {
        inSeg = true;
        segsAfterDouble++;
        if (segsAfterDouble >= 3) return false;
      }
      detIndex++;
    }
    i += len;
  }
  if (!foundDouble) return false;
  return doubleAtStart ? segsAfterDouble <= 2 : segsAfterDouble >= 1 && segsAfterDouble <= 2;
}

function extractRawBasename(rawToken: string): string {
  let end = rawToken.length;
  while (end > 0 && isRawSingleSlashChar(rawToken, end - 1)) end--;
  if (end === 0) return '';
  let start = end;
  while (start > 0 && !isRawSingleSlashChar(rawToken, start - 1)) start--;
  return rawToken.slice(start, end);
}

type TokenClassification =
  | { kind: 'plain'; text: string }
  | { kind: 'basename'; text: string }
  | { kind: 'replaced'; text: string };

function isDriveRootBase(rawBase: string): boolean {
  if (rawBase.length !== 2) return false;
  const p0 = readCodePointAt(rawBase, 0);
  if (!p0.valid || p0.len !== 1) return false;
  const p1 = readCodePointAt(rawBase, 1);
  if (!p1.valid || p1.len !== 1) return false;
  const m0 = p0.cp < 0x80 ? String.fromCharCode(p0.cp) : getNonAsciiDetInfo(p0.cp).mapped;
  const m1 = p1.cp < 0x80 ? String.fromCharCode(p1.cp) : getNonAsciiDetInfo(p1.cp).mapped;
  return m0.length === 1 && isAsciiLetter(m0.charCodeAt(0)) && m1 === ':';
}

function classifyToken(rawToken: string, isTitle: boolean, prevEndedWithColon: boolean): TokenClassification {
  const hostPlaceholder = isTitle ? '<host>' : '[host]';
  if (
    rawToken.length <= 12 &&
    (rawToken.charCodeAt(0) === 60 || rawToken.charCodeAt(0) === 91 || rawToken.charCodeAt(0) >= 0xfe47)
  ) {
    let det = '';
    for (let i = 0; i < rawToken.length; ) {
      const { cp, len, valid } = readCodePointAt(rawToken, i);
      if (!valid) {
        det = '';
        break;
      }
      det += cp < 0x80 ? (rawToken[i] as string) : getNonAsciiDetInfo(cp).mapped;
      i += len;
    }
    if (PLACEHOLDERS_SET.has(det)) {
      return { kind: 'replaced', text: det };
    }
  }

  if (prevEndedWithColon && isDetectionDigitsWithOptionalTrailingPunct(rawToken)) {
    return { kind: 'replaced', text: hostPlaceholder };
  }

  if (!MAYBE_SLASH_RE.test(rawToken)) {
    return isSafeNonPathToken(rawToken)
      ? { kind: 'plain', text: rawToken }
      : { kind: 'replaced', text: hostPlaceholder };
  }

  if (containsDetectionScheme(rawToken)) {
    return { kind: 'replaced', text: isTitle ? '<host>' : '[endpoint]' };
  }
  if (hasPathEndpointMeta(rawToken)) {
    return { kind: 'replaced', text: hostPlaceholder };
  }
  if (isUncOrTwoPartServerPath(rawToken)) {
    return { kind: 'replaced', text: '[path]' };
  }
  const rawBase = extractRawBasename(rawToken);
  if (!rawBase || rawBase === '.' || rawBase === '..' || isDriveRootBase(rawBase) || MAYBE_SLASH_RE.test(rawBase)) {
    return { kind: 'replaced', text: '[path]' };
  }
  if (!isSafeNonPathToken(rawBase)) {
    return { kind: 'replaced', text: '[path]' };
  }
  return { kind: 'basename', text: rawBase };
}

function splitTailClusters(text: string, tailClusters: number): [string, string] {
  if (!text || tailClusters <= 0) return [text, ''];
  let clusters = 0;
  let i = text.length;
  while (i > 0) {
    const prevUnit = text.charCodeAt(i - 1);
    let cpStart = i - 1;
    if (prevUnit >= 0xdc00 && prevUnit <= 0xdfff && i >= 2) {
      const high = text.charCodeAt(i - 2);
      if (high >= 0xd800 && high <= 0xdbff) cpStart = i - 2;
    }
    const cp = text.codePointAt(cpStart) ?? 0;
    if (!isClusterContinuation(text, cpStart, cp)) {
      clusters++;
      if (clusters >= tailClusters) return [text.slice(0, cpStart), text.slice(cpStart)];
    }
    i = cpStart;
  }
  return ['', text];
}

function findBoundaryHostMatch(
  left: string,
  right: string,
  host: HostSpec,
): { trimLeftLen: number; trimRightLen: number } | undefined {
  if (!left || !right) return undefined;
  const joint = left + right;
  const splitAt = left.length;
  if (host.ascii && (isAscii(joint) || !ASCII_HOST_NEEDS_CLUSTER_RE.test(joint))) {
    const hostRe = host.asciiRe;
    hostRe.lastIndex = 0;
    for (let match = hostRe.exec(joint); match !== null; match = hostRe.exec(joint)) {
      const mStart = match.index;
      const mEnd = mStart + match[0].length;
      if (mStart < splitAt && mEnd > splitAt) {
        return { trimLeftLen: splitAt - mStart, trimRightLen: mEnd - splitAt };
      }
      if (mStart >= splitAt) break;
      if (match[0].length === 0) hostRe.lastIndex++;
    }
    return undefined;
  }
  const { rawStarts, nfcStarts, nfc } = segmentNfcClusters(joint, host.maxNfdClusterCps, host.unmatchable);
  const hostRe = host.nfcRe;
  hostRe.lastIndex = 0;
  const numSegs = nfcStarts.length - 1;
  let segCursor = 0;
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
    if (rawFrom < splitAt && rawTo > splitAt) {
      return { trimLeftLen: splitAt - rawFrom, trimRightLen: rawTo - splitAt };
    }
    if (rawFrom >= splitAt) break;
  }
  return undefined;
}

function projectModelString(value: string, hostname: string, limit: number, isTitle: boolean): string {
  const cleanValue = stripZeroWidth(value);
  if (!cleanValue) return cleanValue;
  const hostPlaceholder = isTitle ? '<host>' : '[host]';
  const host = analyzeHost(hostname);
  const chunks: string[] = [];
  let outCps = 0;
  let pos = 0;

  const carryClusters = host?.hasDelimiters ? Math.max(0, host.clusters - 1) : 0;
  const flushThreshold = Math.max(Math.min(limit * 2, 16_384), host ? host.clusters * 2 + 256 : 1024);
  let carry = '';
  let plainParts: string[] = [];
  let plainLen = 0;
  let prevReplacedTail = '';

  const flushPlain = (isEndOfSegment: boolean) => {
    const plain = plainParts.join('');
    plainParts = [];
    plainLen = 0;
    let combined = carry ? carry + plain : plain;
    carry = '';
    if (host?.hasDelimiters && prevReplacedTail && combined) {
      const rightHead = sliceToClusterBound(combined, host.clusters * 2 + 16);
      const cross = findBoundaryHostMatch(prevReplacedTail, rightHead, host);
      if (cross) {
        combined = combined.slice(cross.trimRightLen);
      }
      prevReplacedTail = '';
    }
    if (!combined) return;
    const remaining = Math.max(1, limit - outCps);
    const { text: replaced, tailStart } = host
      ? replaceHostWithTail(combined, host, hostPlaceholder, remaining)
      : { text: combined, tailStart: 0 };
    if (isEndOfSegment || carryClusters === 0) {
      const bounded = sliceByCodePoints(replaced, remaining + 12);
      chunks.push(bounded);
      outCps += countCodePoints(bounded);
      return;
    }
    if (tailStart > 0) {
      const finalized = replaced.slice(0, tailStart);
      chunks.push(finalized);
      outCps += countCodePoints(finalized);
    }
    const unmatched = replaced.slice(tailStart);
    const [prefix, nextCarry] = splitTailClusters(unmatched, carryClusters);
    if (prefix) {
      chunks.push(prefix);
      outCps += countCodePoints(prefix);
    }
    if (outCps < limit) carry = nextCarry;
  };

  let prevEndedWithColon = false;
  while (pos < cleanValue.length && outCps < limit) {
    if (isWhitespaceCode(cleanValue.charCodeAt(pos))) {
      const start = pos;
      const maxDelim = host?.allDelimiters
        ? (limit - outCps + 12) * Math.max(1, host.clusters) + host.clusters
        : limit - outCps + 12 + (host?.folded.length ?? 0);
      pos++;
      while (pos < cleanValue.length && pos - start < maxDelim && isWhitespaceCode(cleanValue.charCodeAt(pos))) {
        pos++;
      }
      const delim = cleanValue.slice(start, pos);
      plainParts.push(delim);
      plainLen += delim.length;
      if (pos - start >= maxDelim) {
        flushPlain(false);
        if (outCps >= limit) break;
        while (pos < cleanValue.length && isWhitespaceCode(cleanValue.charCodeAt(pos))) pos++;
      } else if (plainLen >= flushThreshold) {
        flushPlain(false);
      }
      continue;
    }

    const tokStart = pos;
    pos++;
    while (pos < cleanValue.length && !isWhitespaceCode(cleanValue.charCodeAt(pos))) pos++;
    const rawToken = cleanValue.slice(tokStart, pos);
    const classified = classifyToken(rawToken, isTitle, prevEndedWithColon);
    prevEndedWithColon = endsWithDetectionColon(rawToken);
    if (classified.kind === 'replaced') {
      if (host?.hasDelimiters && (carry || plainLen > 0 || prevReplacedTail)) {
        const rawPlain = plainParts.join('');
        let combined = carry ? carry + rawPlain : rawPlain;
        carry = '';
        plainParts = [];
        plainLen = 0;
        const tailBound = host.clusters * 2 + 16;
        const [, plainTail] = splitTailClusters(combined, tailBound);
        const rawHead = sliceToClusterBound(rawToken, tailBound);
        const leftCheck = prevReplacedTail ? prevReplacedTail + plainTail : plainTail;
        const cross = findBoundaryHostMatch(leftCheck, rawHead, host);
        if (cross) {
          const trimFromPlain = Math.min(combined.length, cross.trimLeftLen);
          combined = combined.slice(0, combined.length - trimFromPlain);
        }
        if (combined) {
          plainParts.push(combined);
          plainLen = combined.length;
        }
      }
      flushPlain(true);
      if (host?.hasDelimiters) {
        const tailWindow = rawToken.slice(Math.max(0, rawToken.length - (host.clusters * 4 + 64)));
        const [, tokTail] = splitTailClusters(tailWindow, host.clusters * 2 + 16);
        prevReplacedTail = tokTail;
      }
      if (outCps >= limit || outCps + classified.text.length > limit) break;
      chunks.push(classified.text);
      outCps += classified.text.length;
    } else {
      plainParts.push(classified.text);
      plainLen += classified.text.length;
      if (plainLen >= flushThreshold) flushPlain(false);
    }
  }

  if ((plainLen > 0 || carry) && outCps < limit) flushPlain(true);
  return truncateRedacted(chunks.join(''), limit);
}

export function modelText(value: string, hostname = os.hostname()): string {
  return projectModelString(value, hostname, MAX_BYTES, false);
}

export function modelTitle(value: string, hostname = os.hostname()): string {
  return projectModelString(value, hostname, MAX_TITLE_LENGTH, true);
}

function minimize(
  value: JsonValue,
  hostname: string,
  path = '',
  appNamePaths: readonly string[] = [],
  preSanitizedDictPaths: readonly string[] = [],
): JsonValue {
  if (typeof value === 'string') {
    const source = path.endsWith('.source.id') || path.endsWith('.source.api');
    if (appNamePaths.includes(path) || (source && (isSourceIdentifier(value) || isHashedFileSource(value))))
      return value;
    return path === 'title' || path.endsWith('.title') ? modelTitle(value, hostname) : modelText(value, hostname);
  }
  if (Array.isArray(value))
    return value.map((item) => minimize(item, hostname, path, appNamePaths, preSanitizedDictPaths));
  if (value === null || typeof value !== 'object') return value;
  const entries: Record<string, JsonValue> = Object.create(null);
  for (const [key, child] of Object.entries(value)) {
    if (key === 'host' || key === 'endpoint' || key === 'command' || key === 'userSession') continue;
    const sourceKey = path === 'sources' || path === 'observation.sources';
    const fixedKey =
      ((sourceKey || path.endsWith('permissions.value')) && isSourceIdentifier(key)) ||
      (sourceKey && isHashedFileSource(key)) ||
      preSanitizedDictPaths.includes(path);
    const base = fixedKey ? key : modelText(key, hostname);
    let name = base;
    for (let n = 2; Object.hasOwn(entries, name); n++) name = `${base} (${n})`;
    entries[name] = minimize(child, hostname, path ? `${path}.${key}` : key, appNamePaths, preSanitizedDictPaths);
  }
  return entries;
}

export function modelPath(value: string): string {
  const clean = stripZeroWidth(value);
  if (!clean) return '[path]';
  if (containsDetectionScheme(clean) || hasPathEndpointMeta(clean) || isUncOrTwoPartServerPath(clean)) {
    return '[path]';
  }
  const rawBase = MAYBE_SLASH_RE.test(clean) ? extractRawBasename(clean) : clean;
  if (!rawBase || rawBase === '.' || rawBase === '..' || isDriveRootBase(rawBase) || MAYBE_SLASH_RE.test(rawBase)) {
    return '[path]';
  }
  const parts = rawBase.split(/\s+/u).filter(Boolean);
  if (parts.length === 0 || !parts.every((part) => isSafeNonPathToken(part))) return '[path]';
  return modelText(rawBase);
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
  return projectModelOutput(
    section ? projected[section] : projected,
    now,
    ['env.frontApp.value.name', 'frontApp.value.name'],
    ['watchedPaths.value', 'env.watchedPaths.value'],
  );
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
    undefined,
    ['match.kind'],
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
  return modelOutput(result, undefined, ['change.param']);
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

function projectModelOutput(
  value: unknown,
  now?: number,
  appNamePaths: readonly string[] = [],
  preSanitizedDictPaths: readonly string[] = [],
): JsonValue {
  const normalized = minimize(json(value), os.hostname(), '', appNamePaths, preSanitizedDictPaths);
  const result = now === undefined ? normalized : ages(normalized, now);
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') <= MAX_BYTES) return result;
  return {
    truncated: true,
    message: 'Result exceeds the size limit. Request a smaller section or inspect the current foreground application.',
  };
}

export function modelOutput(value: unknown, now?: number, appNamePaths: readonly string[] = []): JsonValue {
  return projectModelOutput(value, now, appNamePaths);
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
    ['app.value.name', 'recentEvents.kind', 'guidance'],
  );
}
