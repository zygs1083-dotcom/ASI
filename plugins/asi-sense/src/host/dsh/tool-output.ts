import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type { Fact, SenseState, WatchRule } from '@asi/sense-types';
import { isRemoteJsonValue } from '@deepseek-ai/dsh-typert-protocol';
import type { createSenseRuntime } from '../runtime/index.ts';
import type { JsonValue } from './wire-types.ts';

const MAX_BYTES = 32_768;
const MAX_TITLE_LENGTH = 512;
const PLACEHOLDERS = ['<host>', '[host]', '[endpoint]', '[path]', '[redacted]'] as const;
const PLACEHOLDERS_SET = new Set<string>(PLACEHOLDERS);
const DELIMITER_RE = /(?:[\s"'<>,;()|](?![\p{M}\u1160-\u11ff\ud7b0-\ud7ff]))+/gu;
const DELIM_CHAR_RE = /[\s"'<>,;()|](?![\p{M}\u1160-\u11ff\ud7b0-\ud7ff])/gu;
const COMBINING_MARK_AT_RE = /\p{M}/uy;
const ALNUM_AT_RE = /[\p{L}\p{N}]/uy;
const NON_DOT_RUN_RE = /[^.]+/g;
const SURROGATE_RE = /[\ud800-\udfff]/;
const NON_ASCII_RE = /[\u0080-\uffff]/;
const FAST_TRUNCATE_UNSAFE_RE = /[\p{M}\u1160-\u11ff\ud7b0-\ud7ff<[]/u;
const HAS_STRUCTURAL_CHAR_RE = /[:/\\@%.[]/;
const STRUCTURAL_CHAR_AT_RE = /[:/\\@%.[]/g;
const NEEDS_CLUSTER_NFC_RE =
  /[\p{M}\u1100-\u11ff\ud7b0-\ud7ff\u00b5\u00df\u0130\u0149\u017f\u01f0\u037e\u03c2\u03d0-\u03f5\u0587\u1c80-\u1c88\u1e96-\u1e9e\u1f80-\u1ffc\u1fef\ufb00-\ufb17]/u;
const CLUSTER_BOUND_LOOKAHEAD = '(?![\\p{M}\\u1160-\\u11ff\\ud7b0-\\ud7ff])';

const KNOWN_TLDS = new Set([
  'com',
  'net',
  'org',
  'edu',
  'gov',
  'mil',
  'int',
  'biz',
  'info',
  'name',
  'pro',
  'xyz',
  'top',
  'site',
  'tech',
  'cloud',
  'dev',
  'io',
  'co',
  'me',
  'tv',
  'gg',
  'ai',
  'uk',
  'de',
  'cn',
  'jp',
  'fr',
  'eu',
  'au',
  'ca',
  'nl',
  'ru',
  'kr',
  'in',
  'sg',
  'hk',
  'tw',
  'it',
  'es',
  'se',
  'ch',
  'br',
  'pl',
  'us',
  'local',
  'lan',
  'home',
  'corp',
  'arpa',
  'test',
  'onion',
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

function isAsciiAlnum(code: number): boolean {
  return isAsciiLetter(code) || (code >= 48 && code <= 57);
}

function isAlnumAt(text: string, index: number): boolean {
  const code = text.charCodeAt(index);
  if (code < 0x80) return isAsciiAlnum(code);
  ALNUM_AT_RE.lastIndex = index;
  return ALNUM_AT_RE.test(text);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function foldCaseNfc(value: string): string {
  const nfc = value.normalize('NFC');
  const lowered = nfc.includes('\u0130') ? nfc.replaceAll('\u0130', 'i\u0307').normalize('NFC') : nfc;
  if (lowered.includes('\u0131')) {
    return lowered
      .split('\u0131')
      .map((part) => (part ? part.toLowerCase().toUpperCase().toLowerCase().normalize('NFC') : ''))
      .join('\u0131');
  }
  return lowered.toLowerCase().toUpperCase().toLowerCase().normalize('NFC');
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
  if (!hostname) return undefined;
  const cached = HOST_SPEC_CACHE.get(hostname);
  if (cached) return cached;
  const asciiInput = isAscii(hostname);
  const folded = asciiInput ? hostname.toLowerCase() : foldCaseNfc(hostname);
  const ascii = asciiInput || isAscii(folded);
  let clusters: number;
  let maxNfdClusterCps = 1;
  if (asciiInput) {
    clusters = folded.length;
  } else {
    const rawStats = measureNfdClusters(hostname);
    const foldedStats = measureNfdClusters(folded);
    clusters = Math.max(rawStats.clusters, foldedStats.clusters);
    maxNfdClusterCps = Math.max(rawStats.maxNfdClusterCps, foldedStats.maxNfdClusterCps);
  }
  DELIM_CHAR_RE.lastIndex = 0;
  const hasDelimiters = DELIM_CHAR_RE.test(folded);
  const allDelimiters = hasDelimiters && folded.replace(DELIMITER_RE, '').length === 0;
  const escapedPattern = escapeRegExp(folded);
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
  HOST_SPEC_CACHE.set(hostname, spec);
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
  while (i < text.length) {
    const nextCp = text.codePointAt(i) ?? 0;
    if (!isClusterContinuation(text, i, nextCp)) break;
    i += nextCp > 0xffff ? 2 : 1;
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

const ASCII_HOST_NEEDS_CLUSTER_RE = /[\u00df\u1e9e\u0130\u0149\u037e\u1fef\u1e9a\ufb00-\ufb06]/u;

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
  if (!NEEDS_CLUSTER_NFC_RE.test(bounded) && bounded.normalize('NFC') === bounded) {
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

function hasBracketAddress(token: string): boolean {
  let pos = 0;
  while (true) {
    const open = token.indexOf('[', pos);
    if (open === -1) return false;
    const close = token.indexOf(']', open + 1);
    if (close === -1) return false;
    if (close > open + 1) {
      const slice = token.slice(open, close + 1);
      if (!PLACEHOLDERS_SET.has(slice)) return true;
    }
    pos = close + 1;
  }
}

function hasColonWithAlnumSides(token: string): boolean {
  const firstColon = token.indexOf(':');
  if (firstColon === -1) return false;
  let firstAlnum = -1;
  for (let i = 0; i < token.length; ) {
    const cp = token.codePointAt(i) ?? 0;
    if (isAlnumAt(token, i)) {
      firstAlnum = i;
      break;
    }
    i += cp > 0xffff ? 2 : 1;
  }
  if (firstAlnum === -1 || firstAlnum >= token.length - 1) return false;
  const colonAfter = token.indexOf(':', firstAlnum + 1);
  if (colonAfter === -1) return false;
  let lastAlnum = -1;
  for (let i = token.length; i > colonAfter + 1; ) {
    const prevUnit = token.charCodeAt(i - 1);
    let cpStart = i - 1;
    if (prevUnit >= 0xdc00 && prevUnit <= 0xdfff && i >= 2) {
      const high = token.charCodeAt(i - 2);
      if (high >= 0xd800 && high <= 0xdbff) cpStart = i - 2;
    }
    if (isAlnumAt(token, cpStart)) {
      lastAlnum = cpStart;
      break;
    }
    i = cpStart;
  }
  return lastAlnum > colonAfter;
}

function isSafeSingleDotFilename(seg1: string, seg2: string): boolean {
  let hasAlnum1 = false;
  for (let i = 0; i < seg1.length; ) {
    const cp = seg1.codePointAt(i) ?? 0;
    if (isAlnumAt(seg1, i)) {
      hasAlnum1 = true;
      break;
    }
    i += cp > 0xffff ? 2 : 1;
  }
  if (!hasAlnum1) return false;
  const ext = seg2.replace(/[!?\u3002\uff01\uff1f]+$/u, '');
  if (!ext) return true;
  if (!/^[A-Za-z]{1,5}$/.test(ext)) return false;
  return !KNOWN_TLDS.has(ext.toLowerCase());
}

function hasHostOrIpDotFeature(token: string): boolean {
  if (!token.includes('.')) return false;
  NON_DOT_RUN_RE.lastIndex = 0;
  const first = NON_DOT_RUN_RE.exec(token);
  if (first === null) return false;
  const second = NON_DOT_RUN_RE.exec(token);
  if (second === null) return false;
  const third = NON_DOT_RUN_RE.exec(token);
  if (third !== null) return true;
  if (second.index !== first.index + first[0].length + 1) return true;
  return !isSafeSingleDotFilename(first[0], second[0]);
}

function lastPathSegment(value: string): string {
  let end = value.length;
  while (end > 0 && (value[end - 1] === '/' || value[end - 1] === '\\')) end--;
  if (end === 0) return '';
  let start = end;
  while (start > 0 && value[start - 1] !== '/' && value[start - 1] !== '\\') start--;
  return value.slice(start, end);
}

function isTwoPartUnc(token: string): boolean {
  const uncStart = token.indexOf('\\\\');
  if (uncStart === -1) return false;
  let i = uncStart + 2;
  while (i < token.length && (token[i] === '\\' || token[i] === '/')) i++;
  let segments = 0;
  while (i < token.length) {
    const start = i;
    while (i < token.length && token[i] !== '\\' && token[i] !== '/') i++;
    if (i > start) {
      segments++;
      if (segments >= 3) return false;
    }
    while (i < token.length && (token[i] === '\\' || token[i] === '/')) i++;
  }
  return segments <= 2;
}

type TokenClassification =
  | { kind: 'plain'; text: string }
  | { kind: 'basename'; text: string }
  | { kind: 'replaced'; text: string };

function classifyToken(token: string, isTitle: boolean): TokenClassification {
  if (!HAS_STRUCTURAL_CHAR_RE.test(token)) {
    return { kind: 'plain', text: token };
  }
  const hostPlaceholder = isTitle ? '<host>' : '[host]';
  if (PLACEHOLDERS_SET.has(token)) {
    return { kind: 'replaced', text: token };
  }
  if (token.includes('://')) {
    return { kind: 'replaced', text: isTitle ? '<host>' : '[endpoint]' };
  }
  const hasSlash = token.includes('/') || token.includes('\\');
  if (hasSlash) {
    const hasDrivePrefix =
      token.length >= 3 &&
      isAsciiLetter(token.charCodeAt(0)) &&
      token.charCodeAt(1) === 58 &&
      (token.charCodeAt(2) === 47 || token.charCodeAt(2) === 92);
    const colonStart = hasDrivePrefix ? 2 : 0;
    if (
      token.includes('@') ||
      token.includes('%') ||
      token.includes('::') ||
      token.indexOf(':', colonStart) !== -1 ||
      hasBracketAddress(token)
    ) {
      return { kind: 'replaced', text: hostPlaceholder };
    }
    if (isTwoPartUnc(token)) {
      return { kind: 'replaced', text: '[path]' };
    }
    const base = lastPathSegment(token);
    if (!base || base === '.' || base === '..') {
      return { kind: 'replaced', text: '[path]' };
    }
    if (hasHostOrIpDotFeature(base)) {
      return { kind: 'replaced', text: hostPlaceholder };
    }
    return { kind: 'basename', text: base };
  }
  if (
    token.includes('@') ||
    token.includes('%') ||
    token.includes('::') ||
    hasColonWithAlnumSides(token) ||
    hasBracketAddress(token) ||
    hasHostOrIpDotFeature(token)
  ) {
    return { kind: 'replaced', text: hostPlaceholder };
  }
  return { kind: 'plain', text: token };
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

function isAsciiDelimiterCode(code: number): boolean {
  return (
    code === 32 ||
    (code >= 9 && code <= 13) ||
    code === 34 ||
    code === 39 ||
    code === 40 ||
    code === 41 ||
    code === 44 ||
    code === 59 ||
    code === 60 ||
    code === 62 ||
    code === 124
  );
}

function isDelimiterAt(text: string, index: number): boolean {
  const code = text.charCodeAt(index);
  if (code < 0x80) {
    if (!isAsciiDelimiterCode(code)) return false;
    if (index + 1 < text.length) {
      const nextCp = text.codePointAt(index + 1) ?? 0;
      if (isClusterContinuation(text, index + 1, nextCp)) return false;
    }
    return true;
  }
  if (code >= 0xd800 && code <= 0xdfff) return false;
  DELIM_CHAR_RE.lastIndex = index;
  const m = DELIM_CHAR_RE.exec(text);
  return m !== null && m.index === index;
}

function findPrevDelimiter(value: string, minIndex: number, beforeIndex: number): number {
  for (let k = beforeIndex - 1; k >= minIndex; k--) {
    const code = value.charCodeAt(k);
    if (code < 0x80) {
      if (!isAsciiDelimiterCode(code)) continue;
      if (k + 1 < value.length) {
        const nextCp = value.codePointAt(k + 1) ?? 0;
        if (isClusterContinuation(value, k + 1, nextCp)) continue;
      }
      return k;
    }
    if (code >= 0x4e00 && code <= 0x9fff) continue;
    if (isDelimiterAt(value, k)) return k;
  }
  return -1;
}

function projectModelString(value: string, hostname: string, limit: number, isTitle: boolean): string {
  if (!value) return value;
  const hostPlaceholder = isTitle ? '<host>' : '[host]';
  const host = analyzeHost(hostname);
  const chunks: string[] = [];
  let outCps = 0;
  let pos = 0;

  if (!host?.hasDelimiters) {
    const emitPlainSpan = (span: string) => {
      const remaining = limit - outCps;
      const redacted = host ? replaceHostWithTail(span, host, hostPlaceholder, remaining).text : span;
      const bounded = sliceByCodePoints(redacted, remaining + 12);
      chunks.push(bounded);
      outCps += countCodePoints(bounded);
    };

    while (pos < value.length && outCps < limit) {
      STRUCTURAL_CHAR_AT_RE.lastIndex = pos;
      const structMatch = STRUCTURAL_CHAR_AT_RE.exec(value);
      if (structMatch === null) {
        emitPlainSpan(value.slice(pos));
        break;
      }
      if (structMatch.index - pos > 256) {
        const delimEnd = findPrevDelimiter(value, pos, structMatch.index);
        if (delimEnd >= pos) {
          emitPlainSpan(value.slice(pos, delimEnd + 1));
          pos = delimEnd + 1;
          continue;
        }
      }
      if (isDelimiterAt(value, pos)) {
        const start = pos;
        const maxDelim = limit - outCps + 12;
        pos++;
        while (pos < value.length && pos - start < maxDelim && isDelimiterAt(value, pos)) pos++;
        const delim = sliceByCodePoints(value.slice(start, pos), maxDelim);
        chunks.push(delim);
        outCps += countCodePoints(delim);
        continue;
      }
      DELIM_CHAR_RE.lastIndex = pos;
      const match = DELIM_CHAR_RE.exec(value);
      const tokEnd = match === null ? value.length : match.index;
      const token = value.slice(pos, tokEnd);
      pos = tokEnd;
      const classified = classifyToken(token, isTitle);
      if (classified.kind === 'replaced') {
        if (outCps + classified.text.length > limit) break;
        chunks.push(classified.text);
        outCps += classified.text.length;
      } else {
        emitPlainSpan(classified.text);
      }
    }
    return truncateRedacted(chunks.join(''), limit);
  }

  const carryClusters = Math.max(0, host.clusters - 1);
  const flushThreshold = Math.max(limit * 2, 65_536);
  let carry = '';
  let plainParts: string[] = [];
  let plainLen = 0;

  const flushPlain = (isEndOfSegment: boolean) => {
    const plain = plainParts.join('');
    plainParts = [];
    plainLen = 0;
    const combined = carry ? carry + plain : plain;
    carry = '';
    if (!combined) return;
    const remaining = Math.max(1, limit - outCps);
    const { text: replaced, tailStart } = replaceHostWithTail(combined, host, hostPlaceholder, remaining);
    if (isEndOfSegment || carryClusters === 0) {
      chunks.push(replaced);
      outCps += countCodePoints(replaced);
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

  while (pos < value.length && outCps < limit) {
    STRUCTURAL_CHAR_AT_RE.lastIndex = pos;
    const structMatch = STRUCTURAL_CHAR_AT_RE.exec(value);
    if (structMatch === null) {
      const rest = value.slice(pos);
      plainParts.push(rest);
      plainLen += rest.length;
      pos = value.length;
      break;
    }
    if (structMatch.index - pos > 256) {
      const delimEnd = findPrevDelimiter(value, pos, structMatch.index);
      if (delimEnd >= pos) {
        const span = value.slice(pos, delimEnd + 1);
        plainParts.push(span);
        plainLen += span.length;
        pos = delimEnd + 1;
        if (plainLen >= flushThreshold) flushPlain(false);
        continue;
      }
    }
    if (isDelimiterAt(value, pos)) {
      const start = pos;
      pos++;
      const maxDelim = host.allDelimiters
        ? (limit - outCps + 12) * Math.max(1, host.clusters) + host.clusters
        : limit - outCps + 12 + host.folded.length;
      while (pos < value.length && pos - start < maxDelim && isDelimiterAt(value, pos)) pos++;
      const delim = value.slice(start, pos);
      plainParts.push(delim);
      plainLen += delim.length;
      if (pos - start >= maxDelim) {
        flushPlain(false);
        if (outCps >= limit) break;
        while (pos < value.length && isDelimiterAt(value, pos)) pos++;
      } else if (plainLen >= flushThreshold) {
        flushPlain(false);
      }
      continue;
    }
    DELIM_CHAR_RE.lastIndex = pos;
    const match = DELIM_CHAR_RE.exec(value);
    const tokEnd = match === null ? value.length : match.index;
    const token = value.slice(pos, tokEnd);
    pos = tokEnd;
    const classified = classifyToken(token, isTitle);
    if (classified.kind === 'replaced') {
      flushPlain(true);
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

function minimize(value: JsonValue, hostname: string, path = '', appNamePaths: readonly string[] = []): JsonValue {
  if (typeof value === 'string') {
    const source = path.endsWith('.source.id') || path.endsWith('.source.api');
    if (appNamePaths.includes(path) || (source && (isSourceIdentifier(value) || isHashedFileSource(value))))
      return value;
    return path === 'title' || path.endsWith('.title') ? modelTitle(value, hostname) : modelText(value, hostname);
  }
  if (Array.isArray(value)) return value.map((item) => minimize(item, hostname, path, appNamePaths));
  if (value === null || typeof value !== 'object') return value;
  const entries: Record<string, JsonValue> = Object.create(null);
  for (const [key, child] of Object.entries(value)) {
    if (key === 'host' || key === 'endpoint' || key === 'command' || key === 'userSession') continue;
    const sourceKey = path === 'sources' || path === 'observation.sources';
    const fixedKey =
      ((sourceKey || path.endsWith('permissions.value')) && isSourceIdentifier(key)) ||
      (sourceKey && isHashedFileSource(key));
    const base = fixedKey ? key : modelText(key, hostname);
    let name = base;
    for (let n = 2; Object.hasOwn(entries, name); n++) name = `${base} (${n})`;
    entries[name] = minimize(child, hostname, path ? `${path}.${key}` : key, appNamePaths);
  }
  return entries;
}

export function modelPath(value: string): string {
  const normalized = value.replaceAll('\\', '/').replace(/\/+$/, '');
  const base = path.posix.basename(normalized);
  if (!base || base === '.' || base === '..' || /^[A-Za-z]:$/.test(base)) return '[path]';
  return modelText(base);
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
    ['app.value.name', 'recentEvents.kind'],
  );
}
