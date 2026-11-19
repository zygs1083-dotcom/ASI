export interface CredentialSpan {
  start: number;
  end: number;
}

const [F_DIGIT, F_UPPER, F_LOWER, F_DASH_UNDER, F_PLUS_EQ, F_DOT_TILDE] = [1, 2, 4, 8, 16, 32];
const F_LETTER = F_UPPER | F_LOWER;
const F_ENTROPY = F_DIGIT | F_LETTER | F_DASH_UNDER | F_PLUS_EQ;
const F_AUTH = F_ENTROPY | F_DOT_TILDE;

const CHAR_FLAGS = new Uint8Array(128);
for (let c = 48; c <= 122; c++) {
  CHAR_FLAGS[c] = c <= 57 ? F_DIGIT : c >= 65 && c <= 90 ? F_UPPER : c >= 97 ? F_LOWER : 0;
}
for (const ch of '-_') CHAR_FLAGS[ch.charCodeAt(0)] = F_DASH_UNDER;
for (const ch of '+/=') CHAR_FLAGS[ch.charCodeAt(0)] = F_PLUS_EQ;
for (const ch of '.~') CHAR_FLAGS[ch.charCodeAt(0)] = F_DOT_TILDE;

const PAIR2 = new Uint8Array(16384);
for (const p of 'gh gl gi gs sk rk pk py AI AK AS ey np hf ts do li xo ya SG'.split(' ')) {
  PAIR2[(p.charCodeAt(0) << 7) | p.charCodeAt(1)] |= 1;
}
for (const p of 'au ap be ba pa se to'.split(' ')) {
  for (const d of [0, 32]) for (const e of [0, 32]) PAIR2[((p.charCodeAt(0) ^ d) << 7) | (p.charCodeAt(1) ^ e)] |= 2;
}
const FREQ = new Int32Array(128);
const LOG2_N = Float64Array.from({ length: 256 }, (_, n) => (n ? n * Math.log2(n) : 0));

const STRONG_PREFIX_RE =
  /(?:github_pat_|gh[pousr]_|glpat-|npm_|hf_|AIza|sk[-_]|(?:pk|rk)[-_](?:live|test)[-_]|tskey-|pypi-|dop_v1_|lin_api_|gsk_|xox[abceprs][-_]|ya29\.)[A-Za-z0-9_-]{8,}|(?:AKIA|ASIA)[A-Z0-9]{16}|SG\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})?|eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?/y;
const PEM_BEGIN_RE = /-----BEGIN(?:[ A-Za-z0-9_-]{0,64}-----|[A-Za-z0-9_-]*)/y;
const AUTH_CTX_RE =
  /(?:authorization:[ \t\u00a0]*(?:(?:bearer|basic|token)[ \t\u00a0]+)?|(bearer|basic)[ \t\u00a0]+)/iy;
const ASSIGN_CTX_RE = /(?:api[-_]?key|apikey|token|secret|password)=/iy;
const ASSIGN_VAL_RE = /"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s,;&"')\]}>]+)/y;
const GENERIC_WORD_RE = /(?:api[-_]?key|apikey|token|secret|password|bearer)[-_]([A-Za-z0-9_-]{12,})/iy;

const sticky = (re: RegExp, s: string, pos: number): RegExpExecArray | null => {
  re.lastIndex = pos;
  return re.exec(s);
};
const flags = (code: number): number => (code < 128 ? (CHAR_FLAGS[code] ?? 0) : 0);
const isKebabSlug = (s: string): boolean =>
  !/[A-Z_+/=]/.test(s) && s.split('-').filter((p) => /^[a-z]{4,}$/.test(p)).length >= 2;
export const isBasicCred = (tok: string): boolean =>
  tok.length >= 16 || /[\d+/=_]/.test(tok) || /[A-Z]/.test(tok.slice(1));

function evalEntropy(input: string, start: number, end: number, spans: CredentialSpan[]): void {
  const len = end - start;
  if (len < 24) return;
  let mask = 0;
  let hasSlash = false;
  let hasPlusEq = false;
  for (let k = start; k < end; k++) {
    const c = input.charCodeAt(k);
    mask |= flags(c);
    if (c === 47) hasSlash = true;
    else if (c === 43 || c === 61) hasPlusEq = true;
  }
  if ((mask & F_LETTER) === 0 || (mask & F_DIGIT) === 0) return;
  if (hasSlash && !hasPlusEq) {
    const parts = input.slice(start, end).split('/');
    const isPlain = (p: string) =>
      !p || !/[A-Za-z]/.test(p) || (!/\d/.test(p) && (/^[A-Z]?[a-z]+$/.test(p) || /^[A-Z]{2,12}$/.test(p)));
    if ((mask & F_DASH_UNDER) !== 0 || parts.some(isPlain)) {
      let off = start;
      for (const p of parts) {
        evalEntropy(input, off, off + p.length, spans);
        off += p.length + 1;
      }
      return;
    }
  }
  if ((mask & F_DASH_UNDER) !== 0 && isKebabSlug(input.slice(start, end))) return;
  for (let k = start; k < end; k++) FREQ[input.charCodeAt(k)]++;
  let sum = 0;
  for (let c = 43; c <= 122; c++) {
    const n = FREQ[c] ?? 0;
    if (n > 0) {
      sum += n < 256 ? (LOG2_N[n] ?? 0) : n * Math.log2(n);
      FREQ[c] = 0;
    }
  }
  if (Math.log2(len) - sum / len < 3.5) return;
  const prev = spans[spans.length - 1];
  const gap = prev ? start - prev.end : 0;
  if (prev && gap >= 3 && gap <= 18 && /^\.[A-Za-z0-9_-]+\.$/.test(input.slice(prev.end, start))) prev.end = end;
  else spans.push({ start, end });
}

function scanAssignVal(input: string, start: number): CredentialSpan | null {
  const m = sticky(ASSIGN_VAL_RE, input, start);
  if (!m) return null;
  const unquoted = m[3] !== undefined;
  const s = unquoted ? start : start + 1;
  let e = start + m[0].length - (unquoted ? 0 : 1);
  if (unquoted && e > s && input.charCodeAt(e - 1) === 46 && (e === input.length || input.charCodeAt(e) <= 32)) e--;
  return e > s && !input.startsWith('[redacted]', s) ? { start: s, end: e } : null;
}

function matchBoundary(input: string, i: number, p2: number): CredentialSpan | null {
  if ((p2 & 1) !== 0 && i + 10 <= input.length) {
    const m = sticky(STRONG_PREFIX_RE, input, i);
    if (m) return { start: i, end: i + m[0].length };
  }
  if ((p2 & 2) === 0 || i + 6 >= input.length) return null;
  const auth = sticky(AUTH_CTX_RE, input, i);
  if (auth) {
    const p = i + auth[0].length;
    let end = p;
    while (end < input.length && (flags(input.charCodeAt(end)) & F_AUTH) !== 0) end++;
    while (end > p && input.charCodeAt(end - 1) === 46) end--;
    const basicOnly = auth[1] !== undefined && (auth[1].charCodeAt(1) | 32) === 97;
    if (end - p >= 2 && !input.startsWith('[redacted]', p)) {
      return !basicOnly || isBasicCred(input.slice(p, end)) ? { start: p, end } : null;
    }
    return basicOnly ? null : scanAssignVal(input, p);
  }
  const assign = sticky(ASSIGN_CTX_RE, input, i);
  if (assign) return scanAssignVal(input, i + assign[0].length);
  const word = sticky(GENERIC_WORD_RE, input, i);
  if (word && /\d/.test(word[1] ?? '') && !isKebabSlug(word[1] ?? '')) return { start: i, end: i + word[0].length };
  return null;
}

/** Single linear-time credential scanner returning `[start, end)` spans that should be redacted. */
export function scanCredentials(input: string): CredentialSpan[] {
  const len = input.length;
  if (len < 7) return [];
  const spans: CredentialSpan[] = [];
  let runStart = 0;
  for (let i = 0; i < len; ) {
    const code = input.charCodeAt(i);
    const pem = code === 45 && input.startsWith('-----BEGIN', i) ? sticky(PEM_BEGIN_RE, input, i) : null;
    if (pem) {
      if (i - runStart >= 24) evalEntropy(input, runStart, i, spans);
      spans.push({ start: i, end: i + pem[0].length });
      i = runStart = i + pem[0].length;
      continue;
    }
    const c1 = i + 1 < len ? input.charCodeAt(i + 1) : 128;
    const p2 = code < 128 && c1 < 128 ? (PAIR2[(code << 7) | c1] ?? 0) : 0;
    const atBound = i === 0 || (flags(input.charCodeAt(i - 1)) & (F_DIGIT | F_LETTER)) === 0;
    const span = p2 !== 0 && atBound ? matchBoundary(input, i, p2) : null;
    if (span) {
      if (i - runStart >= 24) evalEntropy(input, runStart, i, spans);
      spans.push(span);
      i = runStart = span.end;
    } else if ((flags(code) & F_ENTROPY) === 0) {
      if (i - runStart >= 24) evalEntropy(input, runStart, i, spans);
      runStart = ++i;
    } else i++;
  }
  if (len - runStart >= 24) evalEntropy(input, runStart, len, spans);
  return spans;
}

export const containsCredential = (input: string): boolean => scanCredentials(input).length > 0;

export function redactCredentials(input: string): string {
  const spans = scanCredentials(input);
  if (spans.length === 0) return input;
  let out = '';
  let cursor = 0;
  for (const { start, end } of spans) {
    out += `${input.slice(cursor, start)}[redacted]`;
    cursor = end;
  }
  return out + input.slice(cursor);
}
