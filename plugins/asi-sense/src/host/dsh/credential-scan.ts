/**
 * Unified single-pass O(N) credential scanner and model-input sanitizer.
 *
 * ## Detection Contract (检测契约)
 *
 * Every model-facing string passes through `sanitizeForModel(s)` once before
 * field-specific formatting or truncation:
 *   `normalizeForModel(s)` (NFKC, strip `\p{Cc}`/`\p{Cf}` keeping emoji ZWJ
 *   between `\p{Extended_Pictographic}`, whitespace controls/newlines to space)
 *   -> `scanCredentials` / redact to `[redacted]`.
 *
 * ### Must redact (any channel, any position):
 * 1. Known strong-prefix tokens as substrings at any position (arbitrary
 *    preceding/following delimiters or text):
 *    `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_`, `glpat-`, `npm_`,
 *    `hf_`, `xox[a-z]-`, `AIza`, `(?:AKIA|ASIA)[A-Z0-9]{16}`, `sk-proj-`,
 *    `sk-ant-`, `sk_live_`, `sk_test_`, `pk_(?:live|test)_`, `rk_(?:live|test)_`,
 *    `SG.`, `tskey-`, `pypi-`, `dop_v1_`, `lin_api_`, `gsk_`, `ya29.`,
 *    JWT (`eyJ...\.eyJ...`), PEM 头（五个连字符 + BEGIN）.
 *    Bare `sk-` ONLY matches when followed immediately by >=20 `[A-Za-z0-9_-]`
 *    characters containing at least one digit (`sk-design-system` does not match).
 * 2. Auth context values: `Bearer|Basic|Token|Authorization` followed by
 *    whitespace (including normalized newlines/NBSP) or `:` / `=` (including
 *    NFKC fullwidth), followed by a >=8 char value containing a digit, symbol,
 *    or high entropy; common pure-letter English words (`^[A-Z][a-z]+$`,
 *    PascalCase `^(?:[A-Z][a-z]{2,})+$`, or lowercase <=12 `^[a-z]{1,12}$` such
 *    as `Bearer Token`, `Basic TypeScript`, `Basic settings`) are NOT redacted.
 * 3. Key-value pairs: case-insensitive keys (camelCase/snake_case/kebab-case/space)
 *    in `{api key, apikey, access token, refresh token, secret, secret key,
 *    client secret, password, passwd, pwd, token, auth, private key}`:
 *    - Delimiters `=`, `:`, `：` (NFKC `:`), JSON `":"`: value is redacted.
 *    - Delimiters `-` or `_` (including `bearer`): when the `[A-Za-z0-9_-]`
 *      value is >=12 chars and contains a digit (excluding pure lowercase
 *      kebab versioned slugs like `secret-scanning-pipeline-v2`), the entire
 *      `key[-_]value` token is redacted.
 * 4. URL userinfo: `pass` in `scheme://user:pass@host` is redacted.
 * 5. High-entropy / long hex runs:
 *    - Runs of `[A-Za-z0-9_+/=-]` containing `-` or `_` are evaluated per
 *      `-`/`_`-separated segment: a segment is redacted when its own length
 *      is >=20 chars with letters, digits, and Shannon entropy >=3.5 bits/char,
 *      or when it contains a pure hex run >=40 `[0-9A-Fa-f]` chars.
 *    - Runs of `[A-Za-z0-9_+/=-]` without `-` or `_` are redacted as a whole
 *      when length >=32 chars with letters, digits, and Shannon entropy >=3.5
 *      bits/char, or on any pure hex run >=40 chars.
 *
 * ### Known limitations (explicitly not chased):
 * - Random strings <32 chars (or <20 chars per `-`/`_` segment) without strong
 *   prefix or auth/KV context.
 * - Low-entropy hex <40 chars, or >=32 char high-entropy strings without digits.
 * - Cross-field splitting (e.g., half in `subject` and half in `title`).
 * - `Bearer\u200b...` where `\p{Cf}` deletion removes the zero-width char
 *   leaving no separator and <32 chars.
 */

export interface CredentialSpan {
  start: number;
  end: number;
}

const F_DIGIT = 1;
const F_UPPER = 2;
const F_LOWER = 4;
const F_HEX_AF = 8;
const F_DASH_UNDER = 16;
const F_PLUS_EQ_SLASH = 32;
const F_LETTER = F_UPPER | F_LOWER;
const F_ALNUM = F_DIGIT | F_LETTER;
const F_SUBRUN = F_ALNUM | F_DASH_UNDER;
const F_ENTROPY = F_SUBRUN | F_PLUS_EQ_SLASH;
const F_HEX = F_DIGIT | F_HEX_AF;

const CHAR_FLAGS = new Uint8Array(128);
for (let c = 48; c <= 57; c++) CHAR_FLAGS[c] = F_DIGIT;
for (let c = 65; c <= 90; c++) CHAR_FLAGS[c] = F_UPPER | (c <= 70 ? F_HEX_AF : 0);
for (let c = 97; c <= 122; c++) CHAR_FLAGS[c] = F_LOWER | (c <= 102 ? F_HEX_AF : 0);
CHAR_FLAGS[45] = F_DASH_UNDER; // -
CHAR_FLAGS[95] = F_DASH_UNDER; // _
CHAR_FLAGS[43] = F_PLUS_EQ_SLASH; // +
CHAR_FLAGS[47] = F_PLUS_EQ_SLASH; // /
CHAR_FLAGS[61] = F_PLUS_EQ_SLASH; // =

const FREQ = new Int32Array(128);
const LOG2_N = Float64Array.from({ length: 256 }, (_, n) => (n ? n * Math.log2(n) : 0));

const PLACEHOLDERS = new Set(['[redacted]', '[host]', '<host>', '[path]', '[endpoint]', '[long]']);
const PEM_MARK = ['-----', 'BEGIN'].join('');

const HASHED_SIGNAL_ID_RE = /^(?:body\.rate|file\.burst):[0-9a-f]{64}$/;

const EP_SINGLE_RE = /^\p{Extended_Pictographic}$/u;
const EP_CACHE = new Map<number, boolean>();
const CF_TEST_RE = /\p{Cf}/u;
const CF_CHAR_RE = /^\p{Cf}$/u;
const MARK_TEST_RE = /\p{M}/u;

const flags = (code: number): number => (code < 128 ? (CHAR_FLAGS[code] ?? 0) : 0);
const isAsciiLetter = (code: number): boolean => (flags(code) & F_LETTER) !== 0;
const isUpperAscii = (code: number): boolean => (flags(code) & F_UPPER) !== 0;
const isLowerAscii = (code: number): boolean => (flags(code) & F_LOWER) !== 0;
const isDigit = (code: number): boolean => (flags(code) & F_DIGIT) !== 0;

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

function prevCharStart(str: string, end: number): number {
  let start = end - 1;
  const unit = str.charCodeAt(start);
  if (unit >= 0xdc00 && unit <= 0xdfff && start > 0) {
    const high = str.charCodeAt(start - 1);
    if (high >= 0xd800 && high <= 0xdbff) start--;
  }
  return start;
}

function isExtendedPictographicCp(cp: number): boolean {
  if (cp < 0x80) return false;
  let cached = EP_CACHE.get(cp);
  if (cached === undefined) {
    cached = EP_SINGLE_RE.test(String.fromCodePoint(cp));
    if (EP_CACHE.size >= 4096) EP_CACHE.clear();
    EP_CACHE.set(cp, cached);
  }
  return cached;
}

function readPrevLogical(
  out: string,
  input: string,
  last: number,
  inPos: number,
  outPos: number,
): { cp: number; valid: boolean; inPos: number; outPos: number } | null {
  if (inPos > last) {
    const start = Math.max(prevCharStart(input, inPos), last);
    const { cp, valid } = readCodePointAt(input, start);
    return { cp, valid, inPos: start, outPos };
  }
  if (outPos > 0) {
    const start = prevCharStart(out, outPos);
    const { cp, valid } = readCodePointAt(out, start);
    return { cp, valid, inPos, outPos: start };
  }
  return null;
}

function endsWithEmojiForZwjLogical(out: string, input: string, last: number, inEnd: number): boolean {
  const c1 = readPrevLogical(out, input, last, inEnd, out.length);
  if (!c1?.valid) return false;
  if (isExtendedPictographicCp(c1.cp)) return true;
  if (c1.cp !== 0xfe0f && (c1.cp < 0x1f3fb || c1.cp > 0x1f3ff)) return false;
  const c2 = readPrevLogical(out, input, last, c1.inPos, c1.outPos);
  if (!c2?.valid) return false;
  return isExtendedPictographicCp(c2.cp);
}

function startsWithEmojiSingle(str: string, offset: number): boolean {
  if (offset >= str.length) return false;
  const { cp, valid } = readCodePointAt(str, offset);
  return valid && isExtendedPictographicCp(cp);
}

function isQuickCf(cp: number): boolean {
  if (cp === 0x00ad || cp === 0x061c || cp === 0xfeff) return true;
  if (cp >= 0x200b && cp <= 0x200f) return true;
  if (cp >= 0x202a && cp <= 0x202e) return true;
  if (cp >= 0x2060 && cp <= 0x206f) return true;
  if (cp >= 0xfff9 && cp <= 0xfffb) return true;
  if (cp < 0x0600) return false;
  if (
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0x1f300 && cp <= 0x1faff)
  ) {
    return false;
  }
  return CF_CHAR_RE.test(String.fromCodePoint(cp));
}

function isSafeNfkcCodeUnit(code: number): boolean {
  return (
    (code >= 0x20 && code <= 0x7e) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xac00 && code <= 0xd7a3)
  );
}

function isSafeNfkcEmojiSurrogateAt(text: string, i: number, code: number): boolean {
  if (code < 0xd83c || code > 0xd83e || i + 1 >= text.length) return false;
  const low = text.charCodeAt(i + 1);
  if (low < 0xdc00 || low > 0xdfff) return false;
  const cp = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
  return cp >= 0x1f300 && cp <= 0x1faff;
}

function stripControlsAndCf(input: string, mapNewlinesToSpace: boolean): string {
  let out = '';
  let last = 0;
  const len = input.length;
  for (let i = 0; i < len; ) {
    const code = input.charCodeAt(i);
    if (code >= 0x20 && code <= 0x7e) {
      i++;
      continue;
    }
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      out += input.slice(last, i);
      if (
        mapNewlinesToSpace &&
        (code === 9 || code === 10 || code === 11 || code === 12 || code === 13 || code === 0x85)
      ) {
        out += ' ';
        if (code === 13 && i + 1 < len && input.charCodeAt(i + 1) === 10) i++;
      }
      i++;
      last = i;
      continue;
    }
    if (code === 0x2028 || code === 0x2029) {
      if (mapNewlinesToSpace) {
        out += `${input.slice(last, i)} `;
        last = i + 1;
      }
      i++;
      continue;
    }
    const { cp, len: cpLen, valid } = readCodePointAt(input, i);
    if (valid && cp === 0x200d) {
      if (!(endsWithEmojiForZwjLogical(out, input, last, i) && startsWithEmojiSingle(input, i + cpLen))) {
        out += input.slice(last, i);
        last = i + cpLen;
      }
      i += cpLen;
      continue;
    }
    if (valid && isQuickCf(cp)) {
      out += input.slice(last, i);
      last = i + cpLen;
      i += cpLen;
      continue;
    }
    i += cpLen;
  }
  return last === 0 ? input : out + input.slice(last);
}

function isCombiningMarkAt(text: string, i: number, cp: number, len: number): boolean {
  if (cp < 0x0300) return false;
  if (cp <= 0x036f) return true;
  if ((cp >= 0x1160 && cp <= 0x11ff) || (cp >= 0xd7b0 && cp <= 0xd7ff)) return true;
  if (cp >= 0x1f300 && cp <= 0x1faff) return false;
  return MARK_TEST_RE.test(text.slice(i, i + len));
}

function normalizeBoundedNfkc(text: string): string {
  let needsNorm = false;
  for (let i = 0; i < text.length; ) {
    const code = text.charCodeAt(i);
    if (isSafeNfkcCodeUnit(code) || code === 0x200d) {
      i++;
      continue;
    }
    if (isSafeNfkcEmojiSurrogateAt(text, i, code)) {
      i += 2;
      continue;
    }
    needsNorm = true;
    break;
  }
  if (!needsNorm) return text;

  const CHUNK_TARGET = 512;
  let out = '';
  let chunkStart = 0;
  let markRun = 0;
  let overflowedMarkCluster = false;
  let nfkcChanged = false;

  for (let i = 0; i < text.length; ) {
    const code = text.charCodeAt(i);
    const safeUnit = isSafeNfkcCodeUnit(code) || code === 0x200d;
    const safeEmoji = !safeUnit && isSafeNfkcEmojiSurrogateAt(text, i, code);
    if (safeUnit || safeEmoji) {
      if (overflowedMarkCluster) {
        out += text.slice(chunkStart, i);
        chunkStart = i;
        overflowedMarkCluster = false;
      } else if (i - chunkStart >= CHUNK_TARGET) {
        const rawChunk = text.slice(chunkStart, i);
        const normChunk = rawChunk.normalize('NFKC');
        if (normChunk !== rawChunk) nfkcChanged = true;
        out += normChunk;
        chunkStart = i;
      }
      markRun = 0;
      i += safeEmoji ? 2 : 1;
      continue;
    }
    const { cp, len, valid } = readCodePointAt(text, i);
    if (valid && isCombiningMarkAt(text, i, cp, len)) {
      markRun++;
      if (markRun > 128) overflowedMarkCluster = true;
    } else {
      markRun = 0;
    }
    i += len;
  }
  if (chunkStart < text.length) {
    if (overflowedMarkCluster) {
      out += text.slice(chunkStart);
    } else {
      const rawTail = text.slice(chunkStart);
      const normTail = rawTail.normalize('NFKC');
      if (normTail !== rawTail) nfkcChanged = true;
      out += normTail;
    }
  }
  return nfkcChanged && CF_TEST_RE.test(out) ? stripControlsAndCf(out, false) : out;
}

/**
 * Normalizes untrusted input before credential scanning and model projection:
 * NFKC, deletes `\p{Cc}`/`\p{Cf}` (preserving emoji ZWJ `U+200D` joining
 * `\p{Extended_Pictographic}` sequences), and turns newlines/tabs into spaces.
 */
export function normalizeForModel(input: string): string {
  if (!input) return '';
  let cleanAscii = true;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) {
      cleanAscii = false;
      break;
    }
  }
  if (cleanAscii) return input;
  const stripped = stripControlsAndCf(input, true);
  return normalizeBoundedNfkc(stripped);
}

function shannonEntropyAscii(freq: Int32Array, len: number): number {
  let sum = 0;
  for (let c = 43; c <= 122; c++) {
    const n = freq[c] ?? 0;
    if (n > 0) {
      sum += n < 256 ? (LOG2_N[n] ?? 0) : n * Math.log2(n);
      freq[c] = 0;
    }
  }
  return Math.log2(len) - sum / len;
}

function evalContract5Segment(
  input: string,
  start: number,
  end: number,
  minEntropyLen: number,
  spans: CredentialSpan[],
): void {
  const len = end - start;
  if (len < minEntropyLen) return;

  let hasLetter = false;
  let hasDigit = false;
  let hexStart = -1;
  const hexSpans: CredentialSpan[] = [];

  for (let k = start; k < end; k++) {
    const code = input.charCodeAt(k);
    const f = flags(code);
    if ((f & F_LETTER) !== 0) hasLetter = true;
    if ((f & F_DIGIT) !== 0) hasDigit = true;
    FREQ[code]++;

    if ((f & F_HEX) !== 0) {
      if (hexStart < 0) hexStart = k;
    } else if (hexStart >= 0) {
      if (k - hexStart >= 40) hexSpans.push({ start: hexStart, end: k });
      hexStart = -1;
    }
  }
  if (hexStart >= 0 && end - hexStart >= 40) hexSpans.push({ start: hexStart, end });

  const entropy = shannonEntropyAscii(FREQ, len);
  if (hasLetter && hasDigit && entropy >= 3.5) {
    spans.push({ start, end });
    return;
  }
  for (const hs of hexSpans) spans.push(hs);
}

function evalContract5(input: string, start: number, end: number, hasDelim: boolean, spans: CredentialSpan[]): void {
  if (!hasDelim) {
    evalContract5Segment(input, start, end, 32, spans);
    return;
  }
  let segStart = start;
  for (let k = start; k <= end; k++) {
    const isEnd = k === end;
    const code = isEnd ? 0 : input.charCodeAt(k);
    if (isEnd || code === 45 || code === 95) {
      if (k - segStart >= 20) {
        evalContract5Segment(input, segStart, k, 20, spans);
      }
      segStart = k + 1;
    }
  }
}

function isSimpleWordValue(tok: string): boolean {
  // Common pure-letter English word shape: Titlecase (`Authentication`), PascalCase (`TypeScript`), or lowercase <=12 (`settings`).
  let hasNonLetter = false;
  for (let i = 0; i < tok.length; i++) {
    if (!isAsciiLetter(tok.charCodeAt(i))) {
      hasNonLetter = true;
      break;
    }
  }
  if (hasNonLetter) return false;
  if (/^[a-z]{1,12}$/.test(tok)) return true;
  if (/^[A-Z][a-z]+$/.test(tok)) return true;
  if (/^(?:[A-Z][a-z]{2,})+$/.test(tok)) return true;
  return false;
}

function isAuthSecretValue(tok: string): boolean {
  const len = tok.length;
  if (len < 8 || PLACEHOLDERS.has(tok)) return false;
  if (isSimpleWordValue(tok)) return false;

  let hasDigitOrSymbol = false;
  for (let i = 0; i < len; i++) {
    const code = tok.charCodeAt(i);
    if (!isAsciiLetter(code)) {
      hasDigitOrSymbol = true;
      break;
    }
  }
  if (hasDigitOrSymbol) return true;

  // Pure letters that do not match common English word shapes (e.g. `dXNlcjpwYXNz` or `AbCdEfGhIjKl`):
  for (let i = 0; i < len; i++) {
    const c = tok.charCodeAt(i);
    if (c < 128) FREQ[c]++;
  }
  return shannonEntropyAscii(FREQ, len) >= 3.3;
}

function isVersionedLowerKebab(input: string, start: number, end: number): boolean {
  // Trailing `-v\d{1,2}` after >=2 lowercase words of length >=4 (e.g. `scanning-pipeline-v2`).
  let vPos = end - 2;
  if (vPos > start && isDigit(input.charCodeAt(vPos)) && input.charCodeAt(vPos - 1) === 118) {
    vPos--;
  } else if (!(vPos >= start && input.charCodeAt(vPos) === 118 && isDigit(input.charCodeAt(end - 1)))) {
    return false;
  }
  if (vPos <= start || input.charCodeAt(vPos - 1) !== 45) return false;
  const wordEnd = vPos - 1;
  let segments = 0;
  let segLen = 0;
  for (let k = start; k < wordEnd; k++) {
    const c = input.charCodeAt(k);
    if (c === 45) {
      if (segLen < 4) return false;
      segments++;
      segLen = 0;
    } else if (isLowerAscii(c)) {
      segLen++;
    } else {
      return false;
    }
  }
  if (segLen < 4) return false;
  segments++;
  return segments >= 2;
}

const KF_AUTH = 1;
const KF_KV = 2;
const KF_MODE3B = 4;

const packKey = (keyEnd: number, keyFlags: number): number => (keyEnd << 3) | keyFlags;

function eqLowerAt(input: string, pos: number, lowerLit: string): boolean {
  if (pos + lowerLit.length > input.length) return false;
  for (let k = 0; k < lowerLit.length; k++) {
    const c = input.charCodeAt(pos + k);
    if (c >= 65 && c <= 90) {
      if (c + 32 !== lowerLit.charCodeAt(k)) return false;
    } else if (c !== lowerLit.charCodeAt(k)) {
      return false;
    }
  }
  return true;
}

function matchTwoWord(input: string, i: number, first: string, second: string): number {
  if (!eqLowerAt(input, i, first)) return -1;
  let p = i + first.length;
  if (p < input.length) {
    const sep = input.charCodeAt(p);
    if (sep === 45 || sep === 95 || sep === 32) p++;
  }
  return eqLowerAt(input, p, second) ? p + second.length : -1;
}

function matchKeyAt(input: string, i: number): number {
  const low = input.charCodeAt(i) | 32;
  if (i + 2 >= input.length) return -1;
  const c1 = input.charCodeAt(i + 1) | 32;
  if (low === 97 /* a */) {
    if (c1 === 112 /* p */) {
      const apiKey = matchTwoWord(input, i, 'api', 'key');
      return apiKey > 0 ? packKey(apiKey, KF_KV | KF_MODE3B) : -1;
    }
    if (c1 === 117 /* u */) {
      if (eqLowerAt(input, i, 'authorization')) return packKey(i + 13, KF_AUTH);
      if (eqLowerAt(input, i, 'auth')) return packKey(i + 4, KF_KV | KF_MODE3B);
      return -1;
    }
    if (c1 === 99 /* c */) {
      const accessToken = matchTwoWord(input, i, 'access', 'token');
      return accessToken > 0 ? packKey(accessToken, KF_KV | KF_MODE3B) : -1;
    }
    return -1;
  }
  if (low === 98 /* b */) {
    if (eqLowerAt(input, i, 'bearer')) return packKey(i + 6, KF_AUTH | KF_MODE3B);
    if (eqLowerAt(input, i, 'basic')) return packKey(i + 5, KF_AUTH);
    return -1;
  }
  if (low === 99 /* c */) {
    const clientSecret = matchTwoWord(input, i, 'client', 'secret');
    return clientSecret > 0 ? packKey(clientSecret, KF_KV | KF_MODE3B) : -1;
  }
  if (low === 112 /* p */) {
    const privateKey = matchTwoWord(input, i, 'private', 'key');
    if (privateKey > 0) return packKey(privateKey, KF_KV | KF_MODE3B);
    if (eqLowerAt(input, i, 'password')) return packKey(i + 8, KF_KV | KF_MODE3B);
    if (eqLowerAt(input, i, 'passwd')) return packKey(i + 6, KF_KV | KF_MODE3B);
    if (eqLowerAt(input, i, 'pwd')) return packKey(i + 3, KF_KV | KF_MODE3B);
    return -1;
  }
  if (low === 114 /* r */) {
    const refreshToken = matchTwoWord(input, i, 'refresh', 'token');
    return refreshToken > 0 ? packKey(refreshToken, KF_KV | KF_MODE3B) : -1;
  }
  if (low === 115 /* s */) {
    const secretKey = matchTwoWord(input, i, 'secret', 'key');
    if (secretKey > 0) return packKey(secretKey, KF_KV | KF_MODE3B);
    if (eqLowerAt(input, i, 'secret')) return packKey(i + 6, KF_KV | KF_MODE3B);
    return -1;
  }
  if (low === 116 /* t */) {
    if (eqLowerAt(input, i, 'token')) return packKey(i + 5, KF_AUTH | KF_KV | KF_MODE3B);
    return -1;
  }
  return -1;
}

const isWs = (c: number): boolean =>
  c === 32 || (c >= 9 && c <= 13) || c === 0x00a0 || c === 0x3000 || c === 0x2028 || c === 0x2029;
const isHws = (c: number): boolean => c === 32 || c === 9 || c === 0x00a0;
const isAssignStop = (c: number): boolean =>
  isWs(c) || c === 44 || c === 59 || c === 38 || c === 34 || c === 39 || c === 41 || c === 93 || c === 125 || c === 62;
const isAuthStop = (c: number): boolean => isWs(c) || c === 44 || c === 59 || c === 38;
const isTrailPunct = (c: number): boolean =>
  c === 33 || c === 63 || c === 44 || c === 59 || c === 46 || c === 34 || c === 39;

function stripMatchedTrailingPunct(input: string, start: number, end: number): number {
  let openParen = 0;
  let closeParen = 0;
  let openBracket = 0;
  let closeBracket = 0;
  let openBrace = 0;
  let closeBrace = 0;
  for (let k = start; k < end; k++) {
    const c = input.charCodeAt(k);
    if (c === 40) openParen++;
    else if (c === 41) closeParen++;
    else if (c === 91) openBracket++;
    else if (c === 93) closeBracket++;
    else if (c === 123) openBrace++;
    else if (c === 125) closeBrace++;
  }
  let e = end;
  while (e > start) {
    const c = input.charCodeAt(e - 1);
    if (isTrailPunct(c)) {
      e--;
      continue;
    }
    if (c === 41 && closeParen > openParen) {
      closeParen--;
      e--;
      continue;
    }
    if (c === 93 && closeBracket > openBracket) {
      closeBracket--;
      e--;
      continue;
    }
    if (c === 125 && closeBrace > openBrace) {
      closeBrace--;
      e--;
      continue;
    }
    break;
  }
  return e;
}

/**
 * Single-pass O(N) credential scanner returning `[start, end)` spans in `input`.
 */
export function scanCredentials(input: string): CredentialSpan[] {
  const len = input.length;
  if (len < 6) return [];

  const spans: CredentialSpan[] = [];
  let entropyRunStart = 0;
  let entropyRunHasDelim = false;

  let subRunStart = -1;
  let subRunEnd = -1;
  let subLastDigit = -1;
  let subIsLowerKebabV = false;
  let jwtFailEnd = -1;
  let urlFailEnd = -1;
  let noDoubleQuoteBefore = -1;
  let noSingleQuoteBefore = -1;

  const ensureSubRun = (pos: number): void => {
    if (pos < subRunEnd) return;
    subRunStart = pos;
    let k = pos;
    let firstDigit = -1;
    let lastDigit = -1;
    let hasUpperOrUnder = false;
    while (k < len) {
      const code = input.charCodeAt(k);
      const f = flags(code);
      if ((f & F_SUBRUN) === 0) break;
      if ((f & F_DIGIT) !== 0) {
        if (firstDigit < 0) firstDigit = k;
        lastDigit = k;
      } else if ((f & F_UPPER) !== 0 || code === 95) {
        hasUpperOrUnder = true;
      }
      k++;
    }
    subRunEnd = k;
    subLastDigit = lastDigit;
    subIsLowerKebabV =
      !hasUpperOrUnder &&
      firstDigit >= subRunStart &&
      firstDigit >= subRunEnd - 2 &&
      isVersionedLowerKebab(input, subRunStart, subRunEnd);
  };

  const emit = (start: number, end: number): number => {
    const runLen = start - entropyRunStart;
    if (runLen >= 32 || (entropyRunHasDelim && runLen >= 20)) {
      evalContract5(input, entropyRunStart, start, entropyRunHasDelim, spans);
    }
    spans.push({ start, end });
    entropyRunStart = end;
    entropyRunHasDelim = false;
    return end;
  };

  const scanQuoted = (qStart: number, quote: number): { start: number; end: number } | null => {
    const noQuoteBefore = quote === 34 ? noDoubleQuoteBefore : noSingleQuoteBefore;
    if (qStart + 1 <= noQuoteBefore) return null;
    let p = qStart + 1;
    while (p < len) {
      const c = input.charCodeAt(p);
      if (c === quote) {
        if (p === qStart + 1 || input.startsWith('[redacted]', qStart + 1)) return null;
        return { start: qStart + 1, end: p };
      }
      if (c === 10 || c === 13) break;
      p++;
    }
    if (quote === 34) noDoubleQuoteBefore = p;
    else noSingleQuoteBefore = p;
    return null;
  };

  const scanAuthVal = (valStart: number): CredentialSpan | null => {
    if (valStart >= len || input.startsWith('[redacted]', valStart)) return null;
    const c0 = input.charCodeAt(valStart);
    if (c0 === 34 || c0 === 39) {
      const q = scanQuoted(valStart, c0);
      if (q) {
        return isAuthSecretValue(input.slice(q.start, q.end)) ? q : null;
      }
    }
    let e = valStart;
    while (e < len && !isAuthStop(input.charCodeAt(e))) e++;
    e = stripMatchedTrailingPunct(input, valStart, e);
    if (e <= valStart || input.startsWith('[redacted]', valStart)) return null;
    return isAuthSecretValue(input.slice(valStart, e)) ? { start: valStart, end: e } : null;
  };

  const scanKvVal = (valStart: number): CredentialSpan | null => {
    if (valStart >= len || input.startsWith('[redacted]', valStart)) return null;
    const c0 = input.charCodeAt(valStart);
    if (c0 === 34 || c0 === 39) {
      const q = scanQuoted(valStart, c0);
      if (q) return q;
    }
    let e = valStart;
    while (e < len && !isAssignStop(input.charCodeAt(e))) e++;
    if (e > valStart && input.charCodeAt(e - 1) === 46 && (e === len || isWs(input.charCodeAt(e)))) e--;
    if (e <= valStart || input.startsWith('[redacted]', valStart)) return null;
    return { start: valStart, end: e };
  };

  const checkPrefixToken = (i: number, prefixLen: number, minSuffix: number): number => {
    ensureSubRun(i);
    return subRunEnd - (i + prefixLen) >= minSuffix ? subRunEnd : -1;
  };

  const isAuthSchemeFollowedByWs = (valStart: number): boolean => {
    for (const scheme of ['bearer', 'basic', 'token'] as const) {
      if (eqLowerAt(input, valStart, scheme)) {
        const after = valStart + scheme.length;
        if (after < len && isWs(input.charCodeAt(after))) return true;
      }
    }
    return false;
  };

  for (let i = 0; i < len; ) {
    const code = input.charCodeAt(i);

    // 0. PEM 头（五个连字符 + BEGIN）
    if (code === 45 && input.startsWith(PEM_MARK, i)) {
      let end = i + PEM_MARK.length;
      const closeLimit = Math.min(len, end + 64);
      let foundClose = false;
      while (end < closeLimit) {
        const c = input.charCodeAt(end);
        if (c === 45 && input.startsWith('-----', end)) {
          end += 5;
          foundClose = true;
          break;
        }
        if (c !== 32 && (flags(c) & F_SUBRUN) === 0) break;
        end++;
      }
      if (!foundClose) {
        while (end < len && (flags(input.charCodeAt(end)) & F_SUBRUN) !== 0) end++;
      }
      i = emit(i, end);
      continue;
    }

    // 1. URL userinfo: scheme://user:pass@host
    if (code === 58 && i + 2 < len && input.charCodeAt(i + 1) === 47 && input.charCodeAt(i + 2) === 47) {
      let s = i;
      const minScheme = Math.max(0, i - 24);
      while (s > minScheme) {
        const c = input.charCodeAt(s - 1);
        if ((flags(c) & F_ALNUM) !== 0 || c === 43 || c === 45 || c === 46) s--;
        else break;
      }
      const hasValidScheme =
        s < i &&
        isAsciiLetter(input.charCodeAt(s)) &&
        (s === 0 || (!isAsciiLetter(input.charCodeAt(s - 1)) && !isDigit(input.charCodeAt(s - 1))));
      if (hasValidScheme && i + 3 >= urlFailEnd) {
        let k = i + 3;
        let colonPos = -1;
        let atPos = -1;
        while (k < len) {
          const c = input.charCodeAt(k);
          if (c === 47 || c === 63 || c === 35 || c <= 32 || c === 34 || c === 39 || c === 60 || c === 62) break;
          if (c === 58 && colonPos < 0) colonPos = k;
          else if (c === 64) {
            atPos = k;
            break;
          }
          k++;
        }
        if (
          atPos > i + 3 &&
          colonPos >= i + 3 &&
          colonPos + 1 < atPos &&
          !input.startsWith('[redacted]', colonPos + 1)
        ) {
          const nextI = emit(colonPos + 1, atPos) + 1;
          entropyRunStart = nextI;
          entropyRunHasDelim = false;
          i = nextI;
          continue;
        }
        urlFailEnd = k;
      }
    }

    // 2. Strong prefix tokens (substring at any position)
    let strongEnd = -1;
    if (code === 103 /* g */ && i + 3 < len) {
      const c1 = input.charCodeAt(i + 1);
      if (c1 === 104 /* h */ && input.charCodeAt(i + 3) === 95) {
        const c2 = input.charCodeAt(i + 2);
        if (c2 === 112 || c2 === 111 || c2 === 117 || c2 === 115 || c2 === 114) {
          strongEnd = checkPrefixToken(i, 4, 8);
        }
      } else if (c1 === 105 /* i */ && input.startsWith('github_pat_', i)) {
        strongEnd = checkPrefixToken(i, 11, 8);
      } else if (c1 === 108 /* l */ && input.startsWith('glpat-', i)) {
        strongEnd = checkPrefixToken(i, 6, 8);
      } else if (c1 === 115 /* s */ && input.startsWith('gsk_', i)) {
        strongEnd = checkPrefixToken(i, 4, 8);
      }
    } else if (code === 110 /* n */ && input.startsWith('npm_', i)) {
      strongEnd = checkPrefixToken(i, 4, 8);
    } else if (code === 104 /* h */ && input.startsWith('hf_', i)) {
      strongEnd = checkPrefixToken(i, 3, 8);
    } else if (
      code === 120 /* x */ &&
      i + 5 <= len &&
      input.charCodeAt(i + 1) === 111 &&
      input.charCodeAt(i + 2) === 120 &&
      isLowerAscii(input.charCodeAt(i + 3)) &&
      input.charCodeAt(i + 4) === 45
    ) {
      strongEnd = checkPrefixToken(i, 5, 8);
    } else if (code === 65 /* A */) {
      if (input.startsWith('AIza', i)) {
        strongEnd = checkPrefixToken(i, 4, 8);
      } else if (i + 20 <= len && (input.startsWith('AKIA', i) || input.startsWith('ASIA', i))) {
        let ok = true;
        for (let k = i + 4; k < i + 20; k++) {
          const f = flags(input.charCodeAt(k));
          if ((f & (F_UPPER | F_DIGIT)) === 0) {
            ok = false;
            break;
          }
        }
        if (ok) strongEnd = i + 20;
      }
    } else if (code === 115 /* s */ && input.charCodeAt(i + 1) === 107) {
      const c2 = input.charCodeAt(i + 2);
      if (c2 === 45) {
        if (input.startsWith('sk-proj-', i)) strongEnd = checkPrefixToken(i, 8, 8);
        else if (input.startsWith('sk-ant-', i)) strongEnd = checkPrefixToken(i, 7, 8);
        else {
          ensureSubRun(i);
          if (subRunEnd - (i + 3) >= 20 && subLastDigit >= i + 3) strongEnd = subRunEnd;
        }
      } else if (c2 === 95) {
        if (input.startsWith('sk_live_', i) || input.startsWith('sk_test_', i)) {
          strongEnd = checkPrefixToken(i, 8, 8);
        }
      }
    } else if (code === 112 /* p */ && i + 5 < len) {
      const c1 = input.charCodeAt(i + 1);
      if (
        c1 === 107 /* k */ &&
        (input.startsWith('pk_live_', i) ||
          input.startsWith('pk_test_', i) ||
          input.startsWith('pk-live-', i) ||
          input.startsWith('pk-test-', i))
      ) {
        strongEnd = checkPrefixToken(i, 8, 8);
      } else if (c1 === 121 /* y */ && input.startsWith('pypi-', i)) {
        strongEnd = checkPrefixToken(i, 5, 8);
      }
    } else if (code === 114 /* r */ && i + 8 < len && input.charCodeAt(i + 1) === 107 /* k */) {
      if (
        input.startsWith('rk_live_', i) ||
        input.startsWith('rk_test_', i) ||
        input.startsWith('rk-live-', i) ||
        input.startsWith('rk-test-', i)
      ) {
        strongEnd = checkPrefixToken(i, 8, 8);
      }
    } else if (code === 116 /* t */ && input.startsWith('tskey-', i)) {
      strongEnd = checkPrefixToken(i, 6, 8);
    } else if (code === 100 /* d */ && input.startsWith('dop_v1_', i)) {
      strongEnd = checkPrefixToken(i, 7, 8);
    } else if (code === 108 /* l */ && input.startsWith('lin_api_', i)) {
      strongEnd = checkPrefixToken(i, 8, 8);
    } else if (code === 83 /* S */ && input.startsWith('SG.', i)) {
      let e1 = i + 3;
      while (e1 < len && (flags(input.charCodeAt(e1)) & F_SUBRUN) !== 0) e1++;
      if (e1 - (i + 3) >= 8) {
        strongEnd = e1;
        if (e1 < len && input.charCodeAt(e1) === 46) {
          let e2 = e1 + 1;
          while (e2 < len && (flags(input.charCodeAt(e2)) & F_SUBRUN) !== 0) e2++;
          if (e2 - (e1 + 1) >= 8) strongEnd = e2;
        }
      }
    } else if (code === 121 /* y */ && input.startsWith('ya29.', i)) {
      let e1 = i + 5;
      while (e1 < len && (flags(input.charCodeAt(e1)) & F_SUBRUN) !== 0) e1++;
      if (e1 - (i + 5) >= 8) {
        strongEnd = e1;
        while (strongEnd < len && input.charCodeAt(strongEnd) === 46) {
          let e2 = strongEnd + 1;
          while (e2 < len && (flags(input.charCodeAt(e2)) & F_SUBRUN) !== 0) e2++;
          if (e2 - (strongEnd + 1) >= 8) strongEnd = e2;
          else break;
        }
      }
    } else if (code === 101 /* e */ && i >= jwtFailEnd && input.startsWith('eyJ', i)) {
      ensureSubRun(i);
      const seg1End = subRunEnd;
      if (
        seg1End > i + 3 &&
        seg1End + 4 <= len &&
        input.charCodeAt(seg1End) === 46 &&
        input.startsWith('eyJ', seg1End + 1)
      ) {
        let seg2End = seg1End + 4;
        while (seg2End < len && (flags(input.charCodeAt(seg2End)) & F_SUBRUN) !== 0) seg2End++;
        if (seg2End > seg1End + 4) {
          strongEnd = seg2End;
          if (seg2End + 1 < len && input.charCodeAt(seg2End) === 46) {
            let seg3End = seg2End + 1;
            while (seg3End < len && (flags(input.charCodeAt(seg3End)) & F_SUBRUN) !== 0) seg3End++;
            if (seg3End > seg2End + 1) strongEnd = seg3End;
          }
        }
      } else {
        jwtFailEnd = seg1End;
      }
    }

    if (strongEnd > i) {
      i = emit(i, strongEnd);
      continue;
    }

    // 3. Auth context & KV key-value pairs at key boundary
    const atKeyBound =
      i === 0 ||
      !isAsciiLetter(input.charCodeAt(i - 1)) ||
      (isLowerAscii(input.charCodeAt(i - 1)) && isUpperAscii(code));
    if (atKeyBound && isAsciiLetter(code)) {
      const km = matchKeyAt(input, i);
      const keyEnd = km >= 0 ? km >>> 3 : -1;
      if (keyEnd >= 0 && keyEnd < len) {
        const delim = input.charCodeAt(keyEnd);
        const isKv = (km & KF_KV) !== 0;
        const isAuth = (km & KF_AUTH) !== 0;
        const isMode3b = (km & KF_MODE3B) !== 0;

        // 3a. JSON quoted key: "key": "val" or 'key': 'val'
        if ((isKv || isAuth) && i > 0 && (input.charCodeAt(i - 1) === 34 || input.charCodeAt(i - 1) === 39)) {
          if (delim === input.charCodeAt(i - 1)) {
            let p = keyEnd + 1;
            let wsCount = 0;
            while (p < len && wsCount < 4 && isHws(input.charCodeAt(p))) {
              p++;
              wsCount++;
            }
            if (p < len && (input.charCodeAt(p) === 58 || input.charCodeAt(p) === 61)) {
              p++;
              while (p < len && isHws(input.charCodeAt(p))) p++;
              const valSpan = isKv ? (isAuthSchemeFollowedByWs(p) ? null : scanKvVal(p)) : scanAuthVal(p);
              if (valSpan) {
                i = emit(valSpan.start, valSpan.end);
                continue;
              }
            }
          }
        }

        // 3b. Mode 3b: key[-_]value (>=12 chars with digit)
        if (isMode3b && (delim === 45 || delim === 95)) {
          ensureSubRun(keyEnd + 1);
          if (
            subRunEnd - (keyEnd + 1) >= 12 &&
            subLastDigit >= keyEnd + 1 &&
            !subIsLowerKebabV &&
            !input.startsWith('[redacted]', keyEnd + 1)
          ) {
            i = emit(i, subRunEnd);
            continue;
          }
        }

        // 3c. Unquoted `=` or `:` (horizontal whitespace before delimiter is unbounded and stays linear)
        let sepPos = keyEnd;
        if (isHws(delim)) {
          let p = sepPos + 1;
          while (p < len && isHws(input.charCodeAt(p))) p++;
          if (p < len && (input.charCodeAt(p) === 58 || input.charCodeAt(p) === 61)) sepPos = p;
        }
        const sep = sepPos < len ? input.charCodeAt(sepPos) : -1;
        if (sep === 58 || sep === 61) {
          let p = sepPos + 1;
          while (p < len && isHws(input.charCodeAt(p))) p++;
          if (isKv && !isAuthSchemeFollowedByWs(p)) {
            const kvSpan = scanKvVal(p);
            if (kvSpan) {
              i = emit(kvSpan.start, kvSpan.end);
              continue;
            }
          } else if (isAuth) {
            const authSpan = scanAuthVal(p);
            if (authSpan) {
              i = emit(authSpan.start, authSpan.end);
              continue;
            }
          }
        }

        // 3d. Auth context followed by whitespace (require standalone word boundary, not snake/kebab suffix)
        const prevAuth = i > 0 ? input.charCodeAt(i - 1) : 0;
        const atAuthWsBound =
          i === 0 || (!isAsciiLetter(prevAuth) && !isDigit(prevAuth) && prevAuth !== 95 && prevAuth !== 45);
        if (atAuthWsBound && isAuth && isWs(delim)) {
          let p = keyEnd + 1;
          while (p < len && isWs(input.charCodeAt(p))) p++;
          const authSpan = scanAuthVal(p);
          if (authSpan) {
            i = emit(authSpan.start, authSpan.end);
            continue;
          }
        }
      }
    }

    const cf = flags(code);
    if ((cf & F_ENTROPY) === 0) {
      const runLen = i - entropyRunStart;
      if (runLen >= 32 || (entropyRunHasDelim && runLen >= 20)) {
        evalContract5(input, entropyRunStart, i, entropyRunHasDelim, spans);
      }
      entropyRunStart = ++i;
      entropyRunHasDelim = false;
    } else {
      if ((cf & F_DASH_UNDER) !== 0) entropyRunHasDelim = true;
      i++;
    }
  }

  const tailLen = len - entropyRunStart;
  if (tailLen >= 32 || (entropyRunHasDelim && tailLen >= 20)) {
    evalContract5(input, entropyRunStart, len, entropyRunHasDelim, spans);
  }
  return spans;
}

export const containsCredential = (input: string): boolean => scanCredentials(normalizeForModel(input)).length > 0;

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

/** Single entry point for all model-facing strings: normalize then redact. */
export function sanitizeForModel(input: string): string {
  if (!input) return '';
  return redactCredentials(normalizeForModel(input));
}

/** Sanitizes model-facing IDs: collapses the entire ID to `[redacted]` if any credential matches. */
export function sanitizeModelId(input: string, allowHashedSignalId = false): { value: string; redacted: boolean } {
  if (allowHashedSignalId && HASHED_SIGNAL_ID_RE.test(input)) {
    return { value: input, redacted: false };
  }
  const norm = normalizeForModel(input);
  if (scanCredentials(norm).length > 0) {
    return { value: '[redacted]', redacted: true };
  }
  return { value: norm, redacted: false };
}

/** Sanitizes signal/event IDs while preserving strict `body.rate:<sha256>` / `file.burst:<sha256>` digests. */
export const sanitizeSignalId = (input: string): { value: string; redacted: boolean } => sanitizeModelId(input, true);
