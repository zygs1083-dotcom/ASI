import { createHash } from 'node:crypto';
import os from 'node:os';
import type { Fact, SenseState, WatchRule } from '@asi/sense-types';
import { isRemoteJsonValue } from '@deepseek-ai/dsh-typert-protocol';
import { isHomeRoot, isHomeRootShape, toHomeRelative } from '../attention/path.ts';
import type { createSenseRuntime } from '../runtime/index.ts';
import { sanitizeForModel, sanitizeModelId } from './credential-scan.ts';
import { MODEL_RULE_KINDS } from './kinds.ts';
import type { JsonValue } from './wire-types.ts';

export { MODEL_RULE_KINDS };

const MAX_BYTES = 32_768;
const MAX_TITLE_LENGTH = 512;
const MAX_TOKEN_CODEPOINTS = 256;
const MAX_RAW_NORMALIZE_CODEPOINTS = 1024;
const PLACEHOLDERS = ['<host>', '[host]', '[endpoint]', '[path]', '[redacted]', '[long]'] as const;
const PLACEHOLDERS_SET = new Set<string>(PLACEHOLDERS);
const COMBINING_MARK_AT_RE = /\p{M}/uy;
const COMBINING_MARK_TEST_RE = /\p{M}/u;
const COMBINING_MARK_RE = /\p{M}/gu;
const ASCII_ENDPOINT_META_RE = /[:@%[\]]/;
const DOUBLE_SLASH_ASCII_RE = /\/\/|\\\\|\/\\|\\\//;
const SURROGATE_RE = /[\ud800-\udfff]/;
const NON_ASCII_RE = /[\u0080-\uffff]/;
const FAST_TRUNCATE_UNSAFE_RE = /[\p{M}\u1160-\u11ff\ud7b0-\ud7ff<[]/u;
const NEEDS_CLUSTER_NFC_RE = /[\p{M}\u1100-\u11ff\ud7b0-\ud7ff\u00df\u0130\u01f0\u03c2\u1e9e]|\ufe0f/u;
const ASCII_HOST_NEEDS_CLUSTER_RE = /[\u00df\u1e9e]/;
const CLUSTER_BOUND_LOOKAHEAD = '(?![\\p{M}\\u1160-\\u11ff\\ud7b0-\\ud7ff])';

const DEFAULT_IGNORABLE_QUICK_RE =
  /\u034f|[\u180b-\u180f]|[\ufe00-\ufe0f]|[\u00ad\u061c\u115f\u1160\u17b4\u17b5\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufeff\uffa0\ufff0-\ufff8]|\ud82f[\udca0-\udca3]|\ud834[\udd73-\udd7a]|\udb40[\udc00-\udfff]/;

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
  '\u066a': '%',
  '\u2052': '%',
  '\u2010': '-',
  '\u2212': '-',
};

const HOMOGLYPH_QUICK_RE =
  /[\u02d0\u02f8\u0589\u05c3\u066a\u0703\u1361\u1803\u2010\u2044\u2052\u205a\u205d\u2212\u2215\u2216\u2236\u2571\u2572\u29f5\u29f8\u29f9\ua789]/;

const CONNECTOR_TEST_RE = /[·•‧∙・—–‒'’‘…。‥]|\.{2,}/;
const CONNECTOR_SPLIT_RE = /[·•‧∙・—–‒'’‘…。‥]+|\.{2,}/;
const CN_PUNCT_TEST_RE = /[【】「」『』《》〈〉“”、]/;
const CN_PUNCT_SPLIT_RE = /[【】「」『』《》〈〉“”、]+/;
const STANDALONE_SEPARATORS = new Set(['-', '–', '—', '|', '·', '•']);
const VALID_TIME_RE = /^(?:[01]?\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/;
const VALID_VERSION_HEAD_RE = /^v?\d+$/i;
const PURE_DIGITS_RE = /^\d+$/;
const SAFE_EXT_RE = /^[a-zA-Z]{1,5}$/;
const ASCII_LIST_ENUM_RE = /^[a-z0-9-]+(?:、[a-z0-9-]+)+$/i;

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
  'files-global',
  'files-global-denied',
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

function isClusterContinuation(text: string, index: number, cp: number): boolean {
  if (index === 0) return false;
  if (cp < 0x0300 || (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0xac00 && cp <= 0xd7a3)) return false;
  if (cp <= 0x036f) return true;
  if (cp >= 0x1160 && cp <= 0x11ff) return true;
  if (cp >= 0xd7b0 && cp <= 0xd7ff) return true;
  COMBINING_MARK_AT_RE.lastIndex = index;
  return COMBINING_MARK_AT_RE.test(text);
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
    code === 0x3000
  );
}

function isDefaultIgnorableCode(cp: number): boolean {
  if (cp < 0x00ad) return false;
  if (cp <= 0x206f) {
    return (
      cp === 0x00ad ||
      cp === 0x034f ||
      cp === 0x061c ||
      cp === 0x115f ||
      cp === 0x1160 ||
      cp === 0x17b4 ||
      cp === 0x17b5 ||
      (cp >= 0x180b && cp <= 0x180f) ||
      (cp >= 0x200b && cp <= 0x200f) ||
      (cp >= 0x202a && cp <= 0x202e) ||
      (cp >= 0x2060 && cp <= 0x206f)
    );
  }
  if (cp <= 0xffff) {
    return (
      cp === 0x3164 ||
      (cp >= 0xfe00 && cp <= 0xfe0f) ||
      cp === 0xfeff ||
      cp === 0xffa0 ||
      (cp >= 0xfff0 && cp <= 0xfff8)
    );
  }
  return (cp >= 0x1bca0 && cp <= 0x1bca3) || (cp >= 0x1d173 && cp <= 0x1d17a) || (cp >= 0xe0000 && cp <= 0xe0fff);
}

const EP_SINGLE_RE = /^\p{Extended_Pictographic}$/u;
const EP_MOD_OR_VS_RE = /^[\ufe0f\p{Emoji_Modifier}]$/u;

function prevCharStart(str: string, end: number): number {
  let start = end - 1;
  const unit = str.charCodeAt(start);
  if (unit >= 0xdc00 && unit <= 0xdfff && start > 0) {
    const high = str.charCodeAt(start - 1);
    if (high >= 0xd800 && high <= 0xdbff) start--;
  }
  return start;
}

function endsWithEmojiSingle(str: string): boolean {
  if (!str) return false;
  return EP_SINGLE_RE.test(str.slice(prevCharStart(str, str.length)));
}

function endsWithEmojiForZwj(str: string): boolean {
  if (!str) return false;
  const prevStart = prevCharStart(str, str.length);
  const prevCh = str.slice(prevStart);
  if (EP_SINGLE_RE.test(prevCh)) return true;
  if (!EP_MOD_OR_VS_RE.test(prevCh) || prevStart <= 0) return false;
  return EP_SINGLE_RE.test(str.slice(prevCharStart(str, prevStart), prevStart));
}

function startsWithEmojiSingle(str: string, offset: number): boolean {
  if (offset >= str.length) return false;
  const { cp, len, valid } = readCodePointAt(str, offset);
  if (!valid) return false;
  return cp >= 0x80 && EP_SINGLE_RE.test(str.slice(offset, offset + len));
}

/**
 * Strips all `\p{Default_Ignorable_Code_Point}` except `U+FE0F` immediately following
 * `\p{Extended_Pictographic}` and `U+200D` joining `\p{Extended_Pictographic}` sequences.
 */
function stripDefaultIgnorables(text: string): string {
  if (!DEFAULT_IGNORABLE_QUICK_RE.test(text)) return text;
  let pre = '';
  let lastPre = 0;
  for (let i = 0; i < text.length; ) {
    const { cp, len, valid } = readCodePointAt(text, i);
    if (valid && cp !== 0x200d && cp !== 0xfe0f && isDefaultIgnorableCode(cp)) {
      pre += text.slice(lastPre, i);
      lastPre = i + len;
    }
    i += len;
  }
  const clean = lastPre === 0 ? text : pre + text.slice(lastPre);
  if (!clean.includes('\u200d') && !clean.includes('\ufe0f')) return clean;

  let out = '';
  for (let i = 0; i < clean.length; ) {
    const { cp, len, valid } = readCodePointAt(clean, i);
    if (valid && cp === 0xfe0f) {
      if (endsWithEmojiSingle(out)) out += '\ufe0f';
    } else if (valid && cp === 0x200d) {
      if (endsWithEmojiForZwj(out) && startsWithEmojiSingle(clean, i + len)) out += '\u200d';
    } else {
      out += clean.slice(i, i + len);
    }
    i += len;
  }
  return out;
}

function applyHomoglyphs(text: string): string {
  if (!HOMOGLYPH_QUICK_RE.test(text)) return text;
  let out = '';
  for (let i = 0; i < text.length; ) {
    const ch = text[i] as string;
    const mapped = SINGLE_CHAR_HOMOGLYPHS[ch];
    if (mapped !== undefined) {
      out += mapped;
      i += 1;
      continue;
    }
    const { len } = readCodePointAt(text, i);
    out += text.slice(i, i + len);
    i += len;
  }
  return out;
}

/** Normalizes a short segment (<= MAX_RAW_NORMALIZE_CODEPOINTS) into canonical output text. */
function normalizeShortSegment(raw: string): string {
  if (!NON_ASCII_RE.test(raw)) return raw;
  let needsNorm = false;
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i);
    if (code < 0x80) continue;
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0x3400 && code <= 0x4dbf)
    ) {
      continue;
    }
    needsNorm = true;
    break;
  }
  if (!needsNorm) return raw;
  let norm = raw.normalize('NFKC');
  const stripped = stripDefaultIgnorables(norm);
  if (stripped.length !== norm.length) norm = stripped.normalize('NFKC');
  return applyHomoglyphs(norm);
}

/** Collapses Unicode whitespace runs in a short normalized string to single ASCII spaces. */
function collapseNormalizedWhitespace(text: string): string {
  let hasWs = false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (isWhitespaceCode(code)) {
      hasWs = true;
      break;
    }
  }
  if (!hasWs) return text;
  let out = '';
  let inSpace = false;
  for (let i = 0; i < text.length; ) {
    const code = text.charCodeAt(i);
    if (isWhitespaceCode(code)) {
      if (!inSpace) {
        out += ' ';
        inSpace = true;
      }
      i += 1;
      continue;
    }
    inSpace = false;
    const len = code >= 0xd800 && code <= 0xdbff && i + 1 < text.length ? 2 : 1;
    out += text.slice(i, i + len);
    i += len;
  }
  return out;
}

function normalizeFullShort(raw: string): string {
  return collapseNormalizedWhitespace(normalizeShortSegment(raw));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripEmojiVsForMatch(value: string): string {
  if (!value.includes('\ufe0f')) return value;
  let out = '';
  for (let i = 0; i < value.length; ) {
    const { cp, len, valid } = readCodePointAt(value, i);
    if (!(valid && cp === 0xfe0f && endsWithEmojiSingle(out))) {
      out += value.slice(i, i + len);
    }
    i += len;
  }
  return out;
}

function foldCaseNfc(value: string): string {
  const nfkc = stripEmojiVsForMatch(value.normalize('NFKC'));
  const lowered = nfkc.includes('\u0130') ? nfkc.replaceAll('\u0130', 'i\u0307').normalize('NFKC') : nfkc;
  if (lowered.includes('\u0131')) {
    return lowered
      .split('\u0131')
      .map((part) => (part ? part.toLowerCase().toUpperCase().toLowerCase().normalize('NFKC') : ''))
      .join('\u0131');
  }
  return lowered.toLowerCase().toUpperCase().toLowerCase().normalize('NFKC');
}

interface HostSpec {
  rawNormalized: string;
  folded: string;
  asciiRe: RegExp;
  nfcRe: RegExp;
  ascii: boolean;
  clusters: number;
  maxNfdClusterCps: number;
  hasDelimiters: boolean;
  tailGuardClusters: number;
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
  if (!hostname) return undefined;
  const cached = HOST_SPEC_CACHE.get(hostname);
  if (cached) return cached;
  const boundedHost = sliceByCodePoints(hostname, MAX_RAW_NORMALIZE_CODEPOINTS);
  const rawNormalized = normalizeFullShort(boundedHost).trim();
  if (!rawNormalized) return undefined;

  const asciiInput = isAscii(rawNormalized);
  const foldedRaw = asciiInput ? rawNormalized.toLowerCase() : foldCaseNfc(rawNormalized);
  const folded = foldedRaw.replace(/ +/g, ' ');
  const ascii = asciiInput || isAscii(folded);
  let clusters: number;
  let maxNfdClusterCps = 1;
  if (asciiInput) {
    clusters = folded.length;
  } else {
    const rawStats = measureNfdClusters(rawNormalized);
    const foldedStats = measureNfdClusters(folded);
    clusters = Math.max(rawStats.clusters, foldedStats.clusters);
    maxNfdClusterCps = Math.max(rawStats.maxNfdClusterCps, foldedStats.maxNfdClusterCps);
  }
  const hasDelimiters = folded.includes(' ');
  const escapedPattern = folded.split(' ').map(escapeRegExp).join(' ');
  const tailGuardClusters = Math.max(clusters, rawNormalized.length, folded.length) + 2;
  const spec: HostSpec = {
    rawNormalized,
    folded,
    asciiRe: new RegExp(`${escapedPattern}${CLUSTER_BOUND_LOOKAHEAD}`, 'giu'),
    nfcRe: new RegExp(escapedPattern, 'gu'),
    ascii,
    clusters,
    maxNfdClusterCps,
    hasDelimiters,
    tailGuardClusters,
    unmatchable: pickUnmatchable(folded),
  };
  if (HOST_SPEC_CACHE.size >= 32) {
    const oldest = HOST_SPEC_CACHE.keys().next().value;
    if (oldest !== undefined) HOST_SPEC_CACHE.delete(oldest);
  }
  HOST_SPEC_CACHE.set(hostname, spec);
  return spec;
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
        if (c0 >= 65 && c0 <= 90) pushChanged(String.fromCharCode(c0 + 32), end);
        nfcLen += 1;
      } else if ((c0 >= 0x4e00 && c0 <= 0x9fff) || (c0 >= 0xac00 && c0 <= 0xd7a3) || (c0 >= 0x3400 && c0 <= 0x4dbf)) {
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

/**
 * Replaces case-insensitive NFC-equivalent matches of `host` in normalized `text`
 * without splitting combining clusters. Returns the replaced text and `tailStart`
 * (output offset immediately after the last replacement).
 */
function replaceHostWithTail(text: string, host: HostSpec, replacement: string): { text: string; tailStart: number } {
  if (!text) return { text, tailStart: 0 };
  if (host.ascii && (isAscii(text) || !ASCII_HOST_NEEDS_CLUSTER_RE.test(text))) {
    if (text.length < host.folded.length) return { text, tailStart: 0 };
    const hostRe = host.asciiRe;
    hostRe.lastIndex = 0;
    let out = '';
    let last = 0;
    let tailStart = 0;
    for (let match = hostRe.exec(text); match !== null; match = hostRe.exec(text)) {
      out += text.slice(last, match.index) + replacement;
      tailStart = out.length;
      last = match.index + match[0].length;
      if (match[0].length === 0) hostRe.lastIndex++;
    }
    return last === 0 ? { text, tailStart: 0 } : { text: out + text.slice(last), tailStart };
  }
  if (!host.ascii && isAscii(text)) {
    return { text, tailStart: 0 };
  }
  if (!host.ascii && !NEEDS_CLUSTER_NFC_RE.test(text)) {
    const hostRe = host.asciiRe;
    hostRe.lastIndex = 0;
    let out = '';
    let last = 0;
    let tailStart = 0;
    for (let match = hostRe.exec(text); match !== null; match = hostRe.exec(text)) {
      out += text.slice(last, match.index) + replacement;
      tailStart = out.length;
      last = match.index + match[0].length;
      if (match[0].length === 0) hostRe.lastIndex++;
    }
    return last === 0 ? { text, tailStart: 0 } : { text: out + text.slice(last), tailStart };
  }
  const { rawStarts, nfcStarts, nfc } = segmentNfcClusters(text, host.maxNfdClusterCps, host.unmatchable);
  const hostRe = host.nfcRe;
  hostRe.lastIndex = 0;
  let out = '';
  let lastRaw = 0;
  let segCursor = 0;
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
    out += text.slice(lastRaw, rawFrom) + replacement;
    tailStart = out.length;
    lastRaw = rawTo;
    segCursor = endCursor;
  }
  return lastRaw === 0 ? { text, tailStart: 0 } : { text: out + text.slice(lastRaw), tailStart };
}

function hostMatchesText(text: string, host: HostSpec | undefined): boolean {
  if (!host || !text) return false;
  return replaceHostWithTail(text, host, 'x').tailStart > 0;
}

const CLS_BASE = 0;
const CLS_HYPHEN_UNDER = 1;
const CLS_MARK = 2;
const CLS_EMOJI = 3;
const CLS_EMOJI_MOD = 4;
const CLS_EMOJI_VS = 5;
const CLS_ZWJ = 6;
const CLS_UNSAFE = 7;

const ASCII_ATOM_CLASS = new Uint8Array(128);
ASCII_ATOM_CLASS.fill(CLS_UNSAFE);
for (let c = 48; c <= 57; c++) ASCII_ATOM_CLASS[c] = CLS_BASE;
for (let c = 65; c <= 90; c++) ASCII_ATOM_CLASS[c] = CLS_BASE;
for (let c = 97; c <= 122; c++) ASCII_ATOM_CLASS[c] = CLS_BASE;
ASCII_ATOM_CLASS[45] = CLS_HYPHEN_UNDER; // -
ASCII_ATOM_CLASS[95] = CLS_HYPHEN_UNDER; // _

const UNICODE_LETTER_OR_NUM_RE = /^[\p{L}\p{N}]$/u;
const UNICODE_MARK_RE = /^\p{M}$/u;
const UNICODE_EMOJI_MOD_RE = /^\p{Emoji_Modifier}$/u;
const NON_ASCII_CLASS_CACHE = new Map<number, number>();

function classifyNonAsciiAtomCodePoint(cp: number): number {
  if (
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0x3041 && cp <= 0x3096) ||
    (cp >= 0x30a1 && cp <= 0x30fa)
  ) {
    return CLS_BASE;
  }
  if (cp >= 0x0300 && cp <= 0x036f) return CLS_MARK;
  if (cp === 0x200d) return CLS_ZWJ;
  if (cp === 0xfe0f) return CLS_EMOJI_VS;

  const cached = NON_ASCII_CLASS_CACHE.get(cp);
  if (cached !== undefined) return cached;

  const ch = String.fromCodePoint(cp);
  let cls = CLS_UNSAFE;
  if (UNICODE_LETTER_OR_NUM_RE.test(ch)) cls = CLS_BASE;
  else if (UNICODE_MARK_RE.test(ch)) cls = CLS_MARK;
  else if (EP_SINGLE_RE.test(ch)) cls = CLS_EMOJI;
  else if (UNICODE_EMOJI_MOD_RE.test(ch)) cls = CLS_EMOJI_MOD;

  if (NON_ASCII_CLASS_CACHE.size >= 16_384) {
    const oldest = NON_ASCII_CLASS_CACHE.keys().next().value;
    if (oldest !== undefined) NON_ASCII_CLASS_CACHE.delete(oldest);
  }
  NON_ASCII_CLASS_CACHE.set(cp, cls);
  return cls;
}

/** Validates a single segment (no dots, slashes, structural chars, or connectors). */
function isSafeSingleAtom(seg: string): boolean {
  if (!seg) return false;
  let lastWasMarkable = false;
  let lastWasEmoji = false;
  let lastWasEmojiChain = false;
  for (let i = 0; i < seg.length; ) {
    const code = seg.charCodeAt(i);
    if (code < 0x80) {
      const cls = ASCII_ATOM_CLASS[code] ?? CLS_UNSAFE;
      if (cls === CLS_BASE) {
        lastWasMarkable = true;
        lastWasEmoji = false;
        lastWasEmojiChain = false;
        i += 1;
        continue;
      }
      if (cls === CLS_HYPHEN_UNDER) {
        lastWasMarkable = false;
        lastWasEmoji = false;
        lastWasEmojiChain = false;
        i += 1;
        continue;
      }
      return false;
    }
    if (
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xac00 && code <= 0xd7a3)
    ) {
      lastWasMarkable = true;
      lastWasEmoji = false;
      lastWasEmojiChain = false;
      i += 1;
      continue;
    }
    const { cp, len, valid } = readCodePointAt(seg, i);
    if (!valid) return false;
    const cls = classifyNonAsciiAtomCodePoint(cp);
    if (cls === CLS_BASE) {
      lastWasMarkable = true;
      lastWasEmoji = false;
      lastWasEmojiChain = false;
    } else if (cls === CLS_EMOJI) {
      lastWasMarkable = true;
      lastWasEmoji = true;
      lastWasEmojiChain = true;
    } else if (cls === CLS_MARK) {
      if (!lastWasMarkable) return false;
      lastWasEmoji = false;
    } else if (cls === CLS_EMOJI_MOD) {
      if (!lastWasEmoji) return false;
      lastWasEmoji = false;
      lastWasMarkable = true;
      lastWasEmojiChain = true;
    } else if (cls === CLS_EMOJI_VS) {
      if (!lastWasEmoji) return false;
      lastWasEmoji = false;
      lastWasMarkable = false;
      lastWasEmojiChain = true;
    } else if (cls === CLS_ZWJ) {
      if (!lastWasEmojiChain) return false;
      lastWasEmoji = false;
      lastWasMarkable = false;
    } else {
      return false;
    }
    i += len;
  }
  return true;
}

function isIpv4OctetTuple(parts: readonly string[]): boolean {
  if (parts.length !== 4) return false;
  for (let i = 0; i < 4; i++) {
    const part = parts[i];
    if (part === undefined) return false;
    const raw = i === 0 ? part.replace(/^v/i, '') : part;
    if (!PURE_DIGITS_RE.test(raw)) return false;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0 || n > 255) return false;
  }
  return true;
}

function isSafeDotToken(core: string, allowFileAndVersionWhitelist: boolean): boolean {
  if (!core || core.startsWith('.') || core.endsWith('.')) return false;
  const parts = core.split('.');
  if (parts.some((p) => p.length === 0)) return false;

  const first = parts[0];
  if (first === undefined) return false;

  if (!allowFileAndVersionWhitelist) {
    return parts.length === 1 && isSafeSingleAtom(first);
  }

  if (
    parts.length >= 2 &&
    parts.length <= 4 &&
    VALID_VERSION_HEAD_RE.test(first) &&
    parts.slice(1).every((p) => PURE_DIGITS_RE.test(p))
  ) {
    return !isIpv4OctetTuple(parts);
  }

  if (parts.length >= 2 && parts.length <= 4) {
    const ext = parts[parts.length - 1];
    if (ext !== undefined && SAFE_EXT_RE.test(ext) && SAFE_FILE_EXTENSIONS.has(ext.toLowerCase())) {
      return parts.slice(0, -1).every((stem) => isSafeSingleAtom(stem));
    }
  }

  return false;
}

function isSimpleTrailingPunctCode(code: number): boolean {
  return (
    code === 33 || // !
    code === 63 || // ?
    code === 44 || // ,
    code === 59 || // ;
    code === 58 || // :
    code === 46 || // .
    code === 0x3002 || // 。
    code === 0x3001 // 、
  );
}

/**
 * Strips trailing punctuation run (`!?,;:.)]}` plus Chinese `。、`), keeping matched
 * closing brackets `)`, `]`, `}` intact when their opener appears inside `core`.
 */
function splitTrailingPunct(token: string): { core: string; trail: string } {
  let end = token.length;
  if (end === 0) return { core: '', trail: '' };
  let openParen = 0;
  let closeParen = 0;
  let openBracket = 0;
  let closeBracket = 0;
  let openBrace = 0;
  let closeBrace = 0;
  const last = token.charCodeAt(end - 1);
  if (last === 41 || last === 93 || last === 125 || isSimpleTrailingPunctCode(last)) {
    for (let i = 0; i < end; i++) {
      const c = token.charCodeAt(i);
      if (c === 40) openParen++;
      else if (c === 41) closeParen++;
      else if (c === 91) openBracket++;
      else if (c === 93) closeBracket++;
      else if (c === 123) openBrace++;
      else if (c === 125) closeBrace++;
    }
  }
  while (end > 0) {
    const c = token.charCodeAt(end - 1);
    if (isSimpleTrailingPunctCode(c)) {
      end--;
      continue;
    }
    if (c === 41 && closeParen > openParen) {
      closeParen--;
      end--;
      continue;
    }
    if (c === 93 && closeBracket > openBracket) {
      closeBracket--;
      end--;
      continue;
    }
    if (c === 125 && closeBrace > openBrace) {
      closeBrace--;
      end--;
      continue;
    }
    break;
  }
  if (end === 0) return { core: token, trail: '' };
  if (end === token.length) return { core: token, trail: '' };
  return { core: token.slice(0, end), trail: token.slice(end) };
}

function rawEndsWithColon(value: string, start: number, end: number): boolean {
  let i = end;
  while (i > start) {
    const c = value.charCodeAt(i - 1);
    if (c < 0x80) {
      if (c === 58) return true;
      if (c === 39 || c === 34) {
        i--;
        continue;
      }
      return false;
    }
    if (c < 0xd800 || c > 0xdfff) {
      if ((c >= 0x0300 && c <= 0x036f) || c === 0x2019 || c === 0x201d) {
        i--;
        continue;
      }
      if (c >= 0x00ad && isDefaultIgnorableCode(c)) {
        i--;
        continue;
      }
      const ch = value.charAt(i - 1);
      if (UNICODE_MARK_RE.test(ch)) {
        i--;
        continue;
      }
      return normalizeShortSegment(ch).endsWith(':');
    }
    const chStart = prevCharStart(value, i);
    const { cp, valid } = readCodePointAt(value, chStart);
    if (!valid) return false;
    if (isDefaultIgnorableCode(cp)) {
      i = chStart;
      continue;
    }
    const ch = value.slice(chStart, i);
    if (UNICODE_MARK_RE.test(ch)) {
      i = chStart;
      continue;
    }
    return normalizeShortSegment(ch).endsWith(':');
  }
  return false;
}

function endsWithDetectionColon(normToken: string): boolean {
  if (!normToken) return false;
  let i = normToken.length;
  while (i > 0) {
    const start = prevCharStart(normToken, i);
    const cp = normToken.codePointAt(start) ?? 0;
    if (cp === 58) return true;
    const ch = normToken.slice(start, i);
    if (UNICODE_MARK_RE.test(ch) || cp === 39 || cp === 34 || cp === 0x2019 || cp === 0x201d) {
      i = start;
      continue;
    }
    return false;
  }
  return false;
}

function isSlashChar(code: number): boolean {
  return code === 47 || code === 92;
}

function hasSlash(token: string): boolean {
  return token.includes('/') || token.includes('\\');
}

function hasPathEndpointMetaNormalized(normToken: string): boolean {
  if (!ASCII_ENDPOINT_META_RE.test(normToken)) return false;
  let hasDrivePrefix = false;
  let deferredColon = false;
  let detIndex = 0;
  let d0 = 0;
  let d1 = 0;
  for (let i = 0; i < normToken.length; ) {
    const code = normToken.charCodeAt(i);
    const len = code >= 0xd800 && code <= 0xdbff && i + 1 < normToken.length ? 2 : 1;
    if (len === 1 && code >= 0xd800 && code <= 0xdfff) return true;
    if (detIndex === 0) d0 = code;
    else if (detIndex === 1) d1 = code;
    else if (detIndex === 2) {
      hasDrivePrefix = isAsciiLetter(d0) && d1 === 58 && isSlashChar(code);
      if (deferredColon && !hasDrivePrefix) return true;
      deferredColon = false;
    }
    if (code === 64 || code === 37 || code === 91 || code === 93) return true;
    if (code === 58) {
      if (detIndex === 1) deferredColon = true;
      else return true;
    }
    detIndex++;
    i += len;
  }
  return deferredColon && !hasDrivePrefix;
}

function isUncOrTwoPartServerPathNormalized(detNoMarks: string): boolean {
  if (!DOUBLE_SLASH_ASCII_RE.test(detNoMarks)) return false;
  let prevWasSlash = false;
  let foundDouble = false;
  let doubleAtStart = false;
  let inSeg = false;
  let segsAfterDouble = 0;
  for (let i = 0; i < detNoMarks.length; i++) {
    const code = detNoMarks.charCodeAt(i);
    const isSlash = isSlashChar(code);
    if (!foundDouble) {
      if (isSlash && prevWasSlash) {
        foundDouble = true;
        doubleAtStart = i === 1;
      }
      prevWasSlash = isSlash;
    } else if (isSlash) {
      inSeg = false;
    } else if (!inSeg) {
      inSeg = true;
      segsAfterDouble++;
      if (segsAfterDouble >= 3) return false;
    }
  }
  if (!foundDouble) return false;
  return doubleAtStart ? segsAfterDouble <= 2 : segsAfterDouble >= 1 && segsAfterDouble <= 2;
}

function extractBasenameNormalized(normToken: string): string {
  let end = normToken.length;
  while (end > 0 && isSlashChar(normToken.charCodeAt(end - 1))) end--;
  if (end === 0) return '';
  let start = end;
  while (start > 0 && !isSlashChar(normToken.charCodeAt(start - 1))) start--;
  return normToken.slice(start, end);
}

function isDriveRootBaseNormalized(base: string): boolean {
  return base.length === 2 && isAsciiLetter(base.charCodeAt(0)) && base.charCodeAt(1) === 58;
}

type TokenClassification =
  | { kind: 'plain'; text: string }
  | { kind: 'basename'; text: string }
  | { kind: 'replaced'; text: string };

function isPortCoreAfterColon(core: string): { isPort: boolean; keepTrail: boolean } {
  const noMarks = stripCombiningMarksIfAny(core);
  if (PURE_DIGITS_RE.test(noMarks)) return { isPort: true, keepTrail: true };
  const unwrapped = noMarks.replace(/^['"‘“([—–‒-]+/, '').replace(/['"’”)\]—–‒-]+$/, '');
  if (unwrapped.length > 0 && PURE_DIGITS_RE.test(unwrapped)) {
    return { isPort: true, keepTrail: false };
  }
  return { isPort: false, keepTrail: false };
}

function isSafeNonPathCore(core: string, host: HostSpec | undefined): boolean {
  if (!core) return false;

  if (STANDALONE_SEPARATORS.has(core)) {
    return !hostMatchesText(core, host);
  }

  if (core.startsWith('(') && core.endsWith(')') && PURE_DIGITS_RE.test(core.slice(1, -1))) {
    return !hostMatchesText(core, host);
  }

  if (
    core.includes('@') ||
    core.includes('%') ||
    core.includes('[') ||
    core.includes(']') ||
    core.includes('(') ||
    core.includes(')') ||
    core.includes('{') ||
    core.includes('}')
  ) {
    return false;
  }

  if (core.includes(':')) {
    return VALID_TIME_RE.test(core) && !hostMatchesText(core, host);
  }

  if (CONNECTOR_TEST_RE.test(core)) {
    // Word-internal connectors are treated as potential dot/host separators (Decision 2).
    const segments = core.split(CONNECTOR_SPLIT_RE).filter(Boolean);
    if (segments.length !== 1) {
      return false;
    }
    // Single remaining segment had leading/trailing connector (e.g. '8080', —8080); only allow if not secret and not host?
    // Keep conservative: reject leading/trailing connector wrappers unless plain prose check explicitly allows.
    return false;
  }

  if (CN_PUNCT_TEST_RE.test(core)) {
    if (ASCII_LIST_ENUM_RE.test(core)) return false;
    const parts = core.split(CN_PUNCT_SPLIT_RE).filter(Boolean);
    if (parts.length === 0) return false;
    return parts.every(
      (part) =>
        !CONNECTOR_TEST_RE.test(part) &&
        !part.includes(':') &&
        !part.includes('@') &&
        !part.includes('%') &&
        !part.includes('[') &&
        !part.includes(']') &&
        !part.includes('(') &&
        !part.includes(')') &&
        !part.includes('{') &&
        !part.includes('}') &&
        !hostMatchesText(part, host) &&
        (part.includes('.') ? isSafeDotToken(part, true) : isSafeSingleAtom(part)),
    );
  }

  if (core.includes('.')) {
    return isSafeDotToken(core, true);
  }

  return isSafeSingleAtom(core);
}

const REVERSE_DOMAIN_SEG_RE = /^[A-Za-z][A-Za-z0-9-]{0,62}$/;

function isSimpleAsciiAlnumWord(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 45 || c === 95) continue;
    return false;
  }
  return text.length > 0;
}

function classifyNonPathToken(
  normToken: string,
  isTitle: boolean,
  prevEndedWithColon: boolean,
  host: HostSpec | undefined,
): TokenClassification {
  if (!prevEndedWithColon && isSimpleAsciiAlnumWord(normToken)) {
    return { kind: 'plain', text: normToken };
  }
  const hostPlaceholder = isTitle ? '<host>' : '[host]';
  const { core, trail } = splitTrailingPunct(normToken);

  if (PLACEHOLDERS_SET.has(core)) {
    return { kind: 'replaced', text: core + trail };
  }

  if (prevEndedWithColon) {
    const port = isPortCoreAfterColon(core);
    if (port.isPort) {
      return { kind: 'replaced', text: port.keepTrail ? hostPlaceholder + trail : hostPlaceholder };
    }
  }

  if (isSafeNonPathCore(core, host)) {
    return { kind: 'plain', text: core + trail };
  }

  return {
    kind: 'replaced',
    text: hostPlaceholder + (trail && !core.includes('[') && !core.includes('(') && !core.includes('{') ? trail : ''),
  };
}

function stripCombiningMarksIfAny(text: string): string {
  return NON_ASCII_RE.test(text) && COMBINING_MARK_TEST_RE.test(text) ? text.replace(COMBINING_MARK_RE, '') : text;
}

function classifyNormalizedToken(
  normToken: string,
  isTitle: boolean,
  prevEndedWithColon: boolean,
  host: HostSpec | undefined,
): TokenClassification {
  const hostPlaceholder = isTitle ? '<host>' : '[host]';

  if (!hasSlash(normToken)) {
    return classifyNonPathToken(normToken, isTitle, prevEndedWithColon, host);
  }

  const detNoMarks = stripCombiningMarksIfAny(normToken);
  if (detNoMarks.includes('://')) {
    return { kind: 'replaced', text: isTitle ? '<host>' : '[endpoint]' };
  }
  if (hasPathEndpointMetaNormalized(normToken)) {
    return { kind: 'replaced', text: hostPlaceholder };
  }
  if (isUncOrTwoPartServerPathNormalized(detNoMarks)) {
    return { kind: 'replaced', text: '[path]' };
  }
  const rawBase = extractBasenameNormalized(normToken);
  if (!rawBase || rawBase === '.' || rawBase === '..' || isDriveRootBaseNormalized(rawBase) || hasSlash(rawBase)) {
    return { kind: 'replaced', text: '[path]' };
  }
  const baseClassified = classifyNonPathToken(rawBase, isTitle, false, host);
  if (baseClassified.kind === 'replaced') {
    if (hostMatchesText(rawBase, host)) {
      return { kind: 'replaced', text: hostPlaceholder };
    }
    return { kind: 'replaced', text: '[path]' };
  }
  return { kind: 'basename', text: baseClassified.text };
}

function splitTailClusters(text: string, tailClusters: number): [string, string] {
  if (!text || tailClusters <= 0) return [text, ''];
  if (isAscii(text)) {
    if (text.length <= tailClusters) return ['', text];
    const cut = text.length - tailClusters;
    return [text.slice(0, cut), text.slice(cut)];
  }
  let clusters = 0;
  let i = text.length;
  while (i > 0) {
    const cpStart = prevCharStart(text, i);
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
  if (!host.ascii && isAscii(joint)) return undefined;
  if (!host.ascii && !NEEDS_CLUSTER_NFC_RE.test(joint)) {
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

function projectModelString(rawValue: string, hostname: string, limit: number, isTitle: boolean): string {
  if (!rawValue) return '';
  const value = sanitizeForModel(rawValue);
  if (!value) return '';
  const host = analyzeHost(hostname);
  const hostPlaceholder = isTitle ? '<host>' : '[host]';
  const tailGuard = host ? host.tailGuardClusters : 0;
  const flushThreshold = Math.max(Math.min(limit * 2, 4096), tailGuard * 2 + 256);

  const chunks: string[] = [];
  let finalizedCps = 0;
  let pendingParts: string[] = [];
  let pendingLen = 0;
  let lastWasSpace = false;
  let prevEndedWithColon = false;
  let prevReplacedTail = '';

  const drainPendingString = (): string => {
    if (pendingLen === 0) return '';
    const joined = pendingParts.length === 1 ? (pendingParts[0] ?? '') : pendingParts.join('');
    pendingParts = [];
    pendingLen = 0;
    return joined;
  };

  const applyPrevReplacedTrim = (text: string): string => {
    if (!host?.hasDelimiters || !prevReplacedTail || !text) return text;
    const rightHead = sliceByCodePoints(text, tailGuard * 2);
    const cross = findBoundaryHostMatch(prevReplacedTail, rightHead, host);
    prevReplacedTail = '';
    return cross ? text.slice(cross.trimRightLen) : text;
  };

  const commitPending = (commitAll: boolean) => {
    let pending = drainPendingString();
    pending = applyPrevReplacedTrim(pending);
    if (!pending) return;
    const replaced = host ? replaceHostWithTail(pending, host, hostPlaceholder).text : pending;
    if (commitAll || tailGuard === 0) {
      chunks.push(replaced);
      finalizedCps += countCodePoints(replaced);
      return;
    }
    const [prefix, nextCarry] = splitTailClusters(replaced, tailGuard);
    if (prefix) {
      chunks.push(prefix);
      finalizedCps += countCodePoints(prefix);
    }
    if (nextCarry) {
      pendingParts.push(nextCarry);
      pendingLen = nextCarry.length;
    }
  };

  const emitPlainOrSpace = (text: string) => {
    if (!text) return;
    pendingParts.push(text);
    pendingLen += text.length;
    lastWasSpace = text.endsWith(' ');
    if (pendingLen >= flushThreshold) commitPending(false);
  };

  const trimPendingBeforeRawToken = (rawSub: string) => {
    if (!host?.hasDelimiters || (!pendingLen && !prevReplacedTail)) return;
    if (prevReplacedTail) {
      let pending = applyPrevReplacedTrim(drainPendingString());
      if (pending) {
        const [, leftTail] = splitTailClusters(pending, tailGuard * 2);
        const rightHead = sliceByCodePoints(rawSub, tailGuard * 2);
        const cross = findBoundaryHostMatch(leftTail, rightHead, host);
        if (cross) {
          const trimLen = Math.min(pending.length, cross.trimLeftLen);
          pending = pending.slice(0, pending.length - trimLen);
        }
        if (pending) {
          pendingParts.push(pending);
          pendingLen = pending.length;
        }
      }
      return;
    }
    if (pendingParts.length === 0) return;
    const neededClusters = tailGuard * 2;
    const popped: string[] = [];
    let poppedLen = 0;
    let tail = '';
    let keepPrefix = '';
    let leftTail = '';
    while (pendingParts.length > 0) {
      const part = pendingParts.pop();
      if (part === undefined) break;
      popped.push(part);
      poppedLen += part.length;
      if (poppedLen < neededClusters && pendingParts.length > 0) continue;
      tail = popped.length === 1 ? (popped[0] ?? '') : popped.slice().reverse().join('');
      [keepPrefix, leftTail] = splitTailClusters(tail, neededClusters);
      if (keepPrefix.length > 0 || pendingParts.length === 0) break;
    }
    pendingLen -= poppedLen;
    if (!tail) return;
    const rightHead = sliceByCodePoints(rawSub, neededClusters);
    const cross = findBoundaryHostMatch(leftTail, rightHead, host);
    const keepRight = cross
      ? leftTail.slice(0, leftTail.length - Math.min(leftTail.length, cross.trimLeftLen))
      : leftTail;
    if (keepPrefix) {
      pendingParts.push(keepPrefix);
      pendingLen += keepPrefix.length;
    }
    if (keepRight) {
      pendingParts.push(keepRight);
      pendingLen += keepRight.length;
    }
  };

  const emitReplaced = (text: string, rawSubForBoundary?: string) => {
    if (host?.hasDelimiters && rawSubForBoundary) {
      trimPendingBeforeRawToken(rawSubForBoundary);
    }
    commitPending(true);
    chunks.push(text);
    finalizedCps += countCodePoints(text);
    lastWasSpace = false;
    if (host?.hasDelimiters && rawSubForBoundary) {
      const tailWindow = rawSubForBoundary.slice(Math.max(0, rawSubForBoundary.length - tailGuard * 4));
      const [, tokTail] = splitTailClusters(tailWindow, tailGuard * 2);
      prevReplacedTail = tokTail;
    } else {
      prevReplacedTail = '';
    }
  };

  const processNormalizedSubToken = (sub: string) => {
    if (!sub) return;
    if (countCodePoints(sub) > MAX_TOKEN_CODEPOINTS) {
      emitReplaced('[long]', sub);
      prevEndedWithColon = endsWithDetectionColon(sub);
      return;
    }
    const classified = classifyNormalizedToken(sub, isTitle, prevEndedWithColon, host);
    prevEndedWithColon = endsWithDetectionColon(sub);
    if (classified.kind === 'replaced') {
      emitReplaced(classified.text, sub);
    } else {
      if (classified.kind === 'basename' && host?.hasDelimiters) {
        trimPendingBeforeRawToken(sub);
      }
      emitPlainOrSpace(classified.text);
    }
  };

  let pos = 0;
  while (pos < value.length && finalizedCps < limit) {
    const code = value.charCodeAt(pos);
    if (isWhitespaceCode(code)) {
      pos++;
      while (pos < value.length) {
        const c = value.charCodeAt(pos);
        if (isWhitespaceCode(c)) {
          pos++;
          continue;
        }
        if (c < 0x00ad) break;
        const { cp, len, valid } = readCodePointAt(value, pos);
        if (valid && cp !== 0x200d && cp !== 0xfe0f && isDefaultIgnorableCode(cp)) {
          pos += len;
          continue;
        }
        break;
      }
      if (!lastWasSpace) emitPlainOrSpace(' ');
      continue;
    }

    // Skip leading non-ZWJ/VS default-ignorable codepoints before a token or inside whitespace.
    if (code >= 0x00ad) {
      const first = readCodePointAt(value, pos);
      if (first.valid && first.cp !== 0x200d && first.cp !== 0xfe0f && isDefaultIgnorableCode(first.cp)) {
        pos += first.len;
        continue;
      }
    }

    const tokStart = pos;
    let nonDiCps = 0;
    let asciiOnly = true;
    let exceededRawCap = false;

    while (pos < value.length) {
      const c = value.charCodeAt(pos);
      if (c <= 32) {
        if (c === 32 || (c >= 9 && c <= 13)) break;
        nonDiCps++;
        pos++;
        if (nonDiCps > MAX_RAW_NORMALIZE_CODEPOINTS) {
          exceededRawCap = true;
          break;
        }
        continue;
      }
      if (c < 0x80) {
        nonDiCps++;
        pos++;
        if (nonDiCps > MAX_RAW_NORMALIZE_CODEPOINTS) {
          exceededRawCap = true;
          break;
        }
        continue;
      }
      if (isWhitespaceCode(c)) break;
      asciiOnly = false;
      if (c < 0xd800 || c > 0xdfff) {
        if (c === 0x200d || c === 0xfe0f || !isDefaultIgnorableCode(c)) {
          nonDiCps++;
          if (nonDiCps > MAX_RAW_NORMALIZE_CODEPOINTS) {
            exceededRawCap = true;
            break;
          }
        }
        pos += 1;
        continue;
      }
      const { cp, len, valid } = readCodePointAt(value, pos);
      if (!valid || !isDefaultIgnorableCode(cp)) {
        nonDiCps++;
        if (nonDiCps > MAX_RAW_NORMALIZE_CODEPOINTS) {
          exceededRawCap = true;
          break;
        }
      }
      pos += len;
    }

    if (exceededRawCap) {
      while (pos < value.length) {
        const c = value.charCodeAt(pos);
        if (c === 32 || (c >= 9 && c <= 13) || (c >= 0xa0 && isWhitespaceCode(c))) break;
        pos++;
      }
      if (host?.hasDelimiters) {
        const headRaw = value.slice(tokStart, Math.min(pos, tokStart + Math.min(tailGuard * 4, 256)));
        const normHead = normalizeShortSegment(headRaw);
        emitReplaced('[long]', normHead);
        const tailRaw = value.slice(Math.max(tokStart, pos - Math.min(tailGuard * 4, 256)), pos);
        const normTail = normalizeShortSegment(tailRaw);
        const [, tokTail] = splitTailClusters(normTail, tailGuard * 2);
        prevReplacedTail = tokTail;
      } else {
        emitReplaced('[long]');
      }
      prevEndedWithColon = rawEndsWithColon(value, tokStart, pos);
      continue;
    }

    const rawToken = value.slice(tokStart, pos);
    if (asciiOnly) {
      if (rawToken.length > MAX_TOKEN_CODEPOINTS) {
        emitReplaced('[long]', rawToken);
        prevEndedWithColon = endsWithDetectionColon(rawToken);
        continue;
      }
      processNormalizedSubToken(rawToken);
      continue;
    }

    const normSegment = normalizeShortSegment(rawToken);
    if (!normSegment) continue;
    const collapsed = collapseNormalizedWhitespace(normSegment);
    if (!collapsed) continue;
    if (!collapsed.includes(' ')) {
      processNormalizedSubToken(collapsed);
      continue;
    }
    for (let sPos = 0; sPos < collapsed.length; ) {
      if (collapsed.charCodeAt(sPos) === 32) {
        if (!lastWasSpace) emitPlainOrSpace(' ');
        prevEndedWithColon = false;
        sPos++;
        continue;
      }
      let sEnd = sPos + 1;
      while (sEnd < collapsed.length && collapsed.charCodeAt(sEnd) !== 32) sEnd++;
      processNormalizedSubToken(collapsed.slice(sPos, sEnd));
      if (finalizedCps >= limit) break;
      sPos = sEnd;
    }
  }

  commitPending(true);
  return truncateRedacted(chunks.join(''), limit);
}

export function modelText(value: string, hostname = os.hostname()): string {
  return projectModelString(value, hostname, MAX_BYTES, false);
}

export function modelTitle(value: string, hostname = os.hostname()): string {
  return projectModelString(value, hostname, MAX_TITLE_LENGTH, true);
}

const MAX_ACTIVITY_NAME = 512;

function truncateName(value: string, limit = MAX_ACTIVITY_NAME): string {
  if (value.length <= limit) return value;
  const max = Math.max(0, limit - 3);
  let end = 0;
  for (const ch of value) {
    if (end + ch.length > max) break;
    end += ch.length;
  }
  return `${value.slice(0, end)}...`;
}

export function modelActivityName(raw: string, maskHomeRoot = false): string {
  // Stored summaries already contain the '~' placeholder; keep it instead of re-redacting it to [path].
  if (raw === '~') return '~';
  // Paths at or below a home alias collapse to `~`/`~/…` before credential scanning, so a
  // custom `globalFileWatch.homedir` or test tmp home dir is masked exactly like `os.homedir()`.
  const relative = maskHomeRoot ? toHomeRelative(raw) : undefined;
  if (relative === '~' || (maskHomeRoot && isHomeRootShape(raw))) return '~';
  if (maskHomeRoot && relative === undefined) {
    const sanitized = sanitizeForModel(raw);
    const postRel = toHomeRelative(sanitized);
    if (postRel === '~' || isHomeRootShape(sanitized)) return '~';
  }
  const base = modelPath(relative ?? raw);
  if (base === '~') return '~';
  const masked = projectModelString(truncateName(base), os.hostname(), MAX_TITLE_LENGTH, true);
  return masked.trim() ? masked : '[file]';
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

function isRawSlashOrHomoglyph(raw: string, i: number): boolean {
  const code = raw.charCodeAt(i);
  if (code === 47 || code === 92) return true;
  if (code < 0x80) return false;
  const ch = raw[i] as string;
  const mapped = SINGLE_CHAR_HOMOGLYPHS[ch];
  return mapped === '/' || mapped === '\\' || ch === '\uff0f' || ch === '\uff3c' || ch === '\ufe68';
}

export function modelPath(rawValue: string): string {
  if (!rawValue) return '[path]';
  const value = sanitizeForModel(rawValue);
  if (!value) return '[path]';
  if (value.length <= MAX_RAW_NORMALIZE_CODEPOINTS * 4) {
    const norm = normalizeFullShort(value);
    if (!norm) return '[path]';
    if (hasSlash(norm)) {
      const detNoMarks = stripCombiningMarksIfAny(norm);
      if (
        detNoMarks.includes('://') ||
        hasPathEndpointMetaNormalized(norm) ||
        isUncOrTwoPartServerPathNormalized(detNoMarks)
      ) {
        return '[path]';
      }
      const rawBase = extractBasenameNormalized(norm);
      if (!rawBase || rawBase === '.' || rawBase === '..' || isDriveRootBaseNormalized(rawBase) || hasSlash(rawBase)) {
        return '[path]';
      }
      const parts = rawBase.split(' ').filter(Boolean);
      if (
        parts.length === 0 ||
        parts.some((p) => countCodePoints(p) > MAX_TOKEN_CODEPOINTS) ||
        !parts.every((part) => classifyNonPathToken(part, false, false, undefined).kind === 'plain')
      ) {
        return '[path]';
      }
      return projectModelString(rawBase, os.hostname(), MAX_BYTES, false);
    }
    const parts = norm.split(' ').filter(Boolean);
    if (
      parts.length === 0 ||
      parts.some((p) => countCodePoints(p) > MAX_TOKEN_CODEPOINTS) ||
      !parts.every((part) => classifyNonPathToken(part, false, false, undefined).kind === 'plain')
    ) {
      return '[path]';
    }
    return projectModelString(norm, os.hostname(), MAX_BYTES, false);
  }

  // Long path fast-path: reject endpoint metadata anywhere, extract trailing segment if bounded.
  let end = value.length;
  while (end > 0 && isRawSlashOrHomoglyph(value, end - 1)) end--;
  if (end === 0) return '[path]';
  let start = end;
  while (start > 0 && !isRawSlashOrHomoglyph(value, start - 1)) start--;
  if (end - start > MAX_RAW_NORMALIZE_CODEPOINTS) return '[path]';
  if (start === 0) return '[path]';
  const prefix = value.slice(0, start);
  if (/[:@%[\]]/.test(prefix) || prefix.includes('//') || prefix.includes('\\\\')) return '[path]';
  const baseRaw = value.slice(start, end);
  const normBase = normalizeFullShort(baseRaw);
  if (!normBase || normBase === '.' || normBase === '..' || isDriveRootBaseNormalized(normBase) || hasSlash(normBase)) {
    return '[path]';
  }
  const parts = normBase.split(' ').filter(Boolean);
  if (
    parts.length === 0 ||
    parts.some((p) => countCodePoints(p) > MAX_TOKEN_CODEPOINTS) ||
    !parts.every((part) => classifyNonPathToken(part, false, false, undefined).kind === 'plain')
  ) {
    return '[path]';
  }
  return projectModelString(normBase, os.hostname(), MAX_BYTES, false);
}

export function modelLabel(value: string): string {
  if (!value || value.length > MAX_RAW_NORMALIZE_CODEPOINTS) return '[redacted]';
  const norm = normalizeFullShort(sanitizeForModel(value));
  return norm && /^[\p{L}\p{N}_ -]+$/u.test(norm) ? modelText(norm) : '[redacted]';
}

export function modelAppName(value: string): string {
  return Array.from(sanitizeForModel(value)).slice(0, 256).join('');
}

function modelEventSubject(raw: string, hostname = os.hostname()): string {
  if (!raw) return '';
  if (raw === '~' || isHomeRoot(raw)) return '~';
  const rel = toHomeRelative(raw);
  if (rel === '~' || isHomeRootShape(raw)) return '~';
  const target = rel ?? sanitizeForModel(raw);
  if (target === '~' || isHomeRoot(target) || isHomeRootShape(target)) return '~';
  if (rel === undefined) {
    const postRel = toHomeRelative(target);
    if (postRel === '~') return '~';
    if (postRel !== undefined) {
      return truncateRedacted(projectModelString(postRel, hostname, MAX_BYTES, false), 256);
    }
  }
  if (!target) return '';
  return truncateRedacted(projectModelString(target, hostname, MAX_BYTES, false), 256);
}

function modelBundleId(value: string, hostname = os.hostname()): string {
  if (!value) return '';
  const id = sanitizeModelId(value);
  if (id.redacted) return '[redacted]';
  const cleaned = id.value;
  if (!cleaned) return '';
  if (cleaned.length > 128 || (hostname && cleaned.toLowerCase().includes(hostname.toLowerCase()))) return '[redacted]';
  const segments = cleaned.split('.');
  if (segments.length < 2 || segments.length > 8 || !segments.every((seg) => REVERSE_DOMAIN_SEG_RE.test(seg))) {
    return '[redacted]';
  }
  return cleaned;
}

function identifier(value: string): string {
  const id = sanitizeModelId(value);
  if (id.redacted) return '[redacted]';
  return /^[\w-]+$/.test(id.value) ? modelText(id.value) : '[redacted]';
}

function isSourceIdentifier(value: string): boolean {
  return FIXED_IDENTIFIERS.has(value);
}

function isHashedFileSource(value: string): boolean {
  return /^files:r-[a-f0-9]{8}$/.test(value);
}

export function sourceIdentifier(value: string): string {
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
            mount: modelActivityName(disk.mount, true),
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
        toolExec: fact(env.where.toolExec, (value) => ({ cwd: modelActivityName(value.cwd, true) })),
      },
      frontApp: fact(env.frontApp, (value) => ({
        name: modelAppName(value.name),
        ...(typeof value.bundleId === 'string' ? { bundleId: modelBundleId(value.bundleId) } : {}),
      })),
      focusedWindow: fact(env.focusedWindow, (value) => ({ title: value.title })),
      activeJobs: fact(env.activeJobs, (value) =>
        value.map((job) => ({ ...pick(job, ['startedAt', 'status', 'exitCode']), id: identifier(job.id) })),
      ),
      watchedPaths: fact(env.watchedPaths, (value) =>
        dictionary(
          value,
          (key) => modelActivityName(key, true),
          (item) => pick(item, ['lastChange', 'changes']),
        ),
      ),
      ...(env.globalFileWatch
        ? {
            globalFileWatch: fact(env.globalFileWatch, (value) => ({
              enabled: value.enabled,
              status: value.status,
              windowMs: value.windowMs,
              eventsPerSec: value.eventsPerSec,
              degraded: value.degraded,
              countOnly: value.countOnly,
              deniedCount: value.deniedPaths.length,
              exclusionCount: value.exclusions.length,
            })),
          }
        : {}),
      ...(env.system
        ? {
            system: fact(env.system, (value) => ({
              locked: Boolean(value.locked),
              ...(typeof value.lastSleepAt === 'number' && Number.isFinite(value.lastSleepAt)
                ? { lastSleepAt: value.lastSleepAt }
                : {}),
              ...(typeof value.lastWakeAt === 'number' && Number.isFinite(value.lastWakeAt)
                ? { lastWakeAt: value.lastWakeAt }
                : {}),
            })),
          }
        : {}),
    },
    observation: observations(state.observation),
  };
  return projectModelOutput(
    section ? projected[section] : projected,
    now,
    ['env.frontApp.value.name', 'frontApp.value.name', 'env.frontApp.value.bundleId', 'frontApp.value.bundleId'],
    ['watchedPaths.value', 'env.watchedPaths.value'],
  );
}

export function modelRules(rules: WatchRule[]): JsonValue {
  const kinds = MODEL_RULE_KINDS;
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
          ...((rule.match.kind === 'file.changed' ||
            rule.match.kind === 'file.activity' ||
            rule.match.kind === 'file.burst') &&
          rule.match.subject !== undefined
            ? { subject: modelActivityName(rule.match.subject, true) }
            : {}),
          ...(Object.keys(where).length ? { where } : {}),
        },
      };
    }),
    undefined,
    // `match.subject` is already masked by `modelActivityName`, so keep its `~` placeholder verbatim.
    ['match.kind', 'match.subject'],
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

/** Projects pre-sanitized tool output while keeping specified value paths and dictionary keys verbatim. */
export function modelProjectedOutput(
  value: unknown,
  appNamePaths: readonly string[] = [],
  preSanitizedDictPaths: readonly string[] = [],
): JsonValue {
  return projectModelOutput(value, undefined, appNamePaths, preSanitizedDictPaths);
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
  const safeBundle = typeof front?.bundleId === 'string' ? modelBundleId(front.bundleId) : undefined;
  const matchesApp =
    front === null
      ? null
      : app === undefined || app === modelAppName(front.name) || (safeBundle !== '[redacted]' && app === safeBundle);
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
        .map(({ kind, subject, at, level, source }) => ({
          kind,
          subject: modelEventSubject(subject),
          at,
          level,
          source: { id: sourceIdentifier(source.id), api: sourceIdentifier(source.api) },
        }))
    : [];
  return modelOutput(
    {
      current: available,
      match: mismatch ? 'not-current' : available ? 'current' : 'unknown',
      app: mismatch
        ? null
        : fact(env.frontApp, (value) => ({
            name: modelAppName(value.name),
            ...(safeBundle !== undefined ? { bundleId: safeBundle } : {}),
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
    ['app.value.name', 'app.value.bundleId', 'recentEvents.kind', 'recentEvents.subject', 'guidance'],
  );
}
