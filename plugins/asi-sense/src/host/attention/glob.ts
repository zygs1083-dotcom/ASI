const SLASH = 47; // '/'

const enum Op {
  LITERAL = 0,
  ANY_NON_SLASH = 1,
  STAR_NON_SLASH = 2,
  STAR_ALL = 3,
  STAR_DIR = 4,
}

interface Token {
  op: Op;
  code: number;
}

export interface CompiledGlob {
  test(target: string): boolean;
}

function tokenize(pattern: string): Token[] {
  const raw: Token[] = [];
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] as string;
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          raw.push({ op: Op.STAR_DIR, code: 0 });
          i += 2;
        } else {
          raw.push({ op: Op.STAR_ALL, code: 0 });
          i += 1;
        }
      } else {
        raw.push({ op: Op.STAR_NON_SLASH, code: 0 });
      }
    } else if (ch === '?') {
      raw.push({ op: Op.ANY_NON_SLASH, code: 0 });
    } else {
      raw.push({ op: Op.LITERAL, code: pattern.charCodeAt(i) });
    }
  }
  const collapsed: Token[] = [];
  for (const tok of raw) {
    const prev = collapsed.at(-1);
    if (prev) {
      if (
        prev.op === Op.STAR_ALL &&
        (tok.op === Op.STAR_ALL || tok.op === Op.STAR_NON_SLASH || tok.op === Op.STAR_DIR)
      ) {
        continue;
      }
      if ((prev.op === Op.STAR_NON_SLASH || prev.op === Op.STAR_DIR) && tok.op === Op.STAR_ALL) {
        prev.op = Op.STAR_ALL;
        continue;
      }
      if (prev.op === Op.STAR_NON_SLASH && tok.op === Op.STAR_NON_SLASH) continue;
      if (prev.op === Op.STAR_DIR && tok.op === Op.STAR_NON_SLASH) {
        prev.op = Op.STAR_ALL;
        continue;
      }
      if (prev.op === Op.STAR_DIR && tok.op === Op.STAR_DIR) continue;
    }
    collapsed.push(tok);
  }
  return collapsed;
}

function compileSmallNfa(tokens: readonly Token[], stateCount: number, matchDescendants: boolean): CompiledGlob {
  let eps1 = 0;
  let eps2 = 0;
  let starAll = 0;
  let starNonSlash = 0;
  let anyNonSlash = 0;
  let starDirLoop = 0;
  const charMasks = new Map<number, number>();

  let state = 0;
  for (const tok of tokens) {
    const bit = 1 << state;
    if (tok.op === Op.LITERAL) {
      charMasks.set(tok.code, (charMasks.get(tok.code) ?? 0) | bit);
      state += 1;
    } else if (tok.op === Op.ANY_NON_SLASH) {
      anyNonSlash |= bit;
      state += 1;
    } else if (tok.op === Op.STAR_NON_SLASH) {
      starNonSlash |= bit;
      eps1 |= bit;
      state += 1;
    } else if (tok.op === Op.STAR_ALL) {
      starAll |= bit;
      eps1 |= bit;
      state += 1;
    } else {
      const loopBit = 1 << (state + 1);
      eps1 |= bit;
      eps2 |= bit;
      starAll |= loopBit;
      starDirLoop |= loopBit;
      state += 2;
    }
  }
  const acceptBit = 1 << (stateCount - 1);
  let initial = 1;
  initial |= (initial & eps1) << 1;
  initial |= ((initial & eps1) << 1) | ((initial & eps2) << 2);

  return {
    test(target: string): boolean {
      let cur = initial;
      for (let i = 0; i < target.length; i++) {
        const code = target.charCodeAt(i);
        if (matchDescendants && (cur & acceptBit) !== 0 && code === SLASH) return true;
        let adv = charMasks.get(code) ?? 0;
        if (code !== SLASH) adv |= anyNonSlash;
        else adv |= starDirLoop;
        let next = ((cur & adv) << 1) | (cur & starAll);
        if (code !== SLASH) next |= cur & starNonSlash;
        if (next === 0) return false;
        next |= (next & eps1) << 1;
        next |= ((next & eps1) << 1) | ((next & eps2) << 2);
        cur = next;
      }
      return (cur & acceptBit) !== 0;
    },
  };
}

function shiftLeft1(src: Uint32Array, mask: Uint32Array, dst: Uint32Array, words: number): void {
  let carry = 0;
  for (let w = 0; w < words; w++) {
    const v = (src[w] as number) & (mask[w] as number);
    dst[w] = (dst[w] as number) | ((v << 1) >>> 0) | carry;
    carry = v >>> 31;
  }
}

function shiftLeft2Or(src: Uint32Array, eps1: Uint32Array, eps2: Uint32Array, dst: Uint32Array, words: number): void {
  let c1 = 0;
  let c2 = 0;
  for (let w = 0; w < words; w++) {
    const x = src[w] as number;
    const v1 = x & (eps1[w] as number);
    const v2 = x & (eps2[w] as number);
    dst[w] = (dst[w] as number) | ((v1 << 1) >>> 0) | c1 | ((v2 << 2) >>> 0) | c2;
    c1 = v1 >>> 31;
    c2 = v2 >>> 30;
  }
}

function compileWideNfa(tokens: readonly Token[], stateCount: number, matchDescendants: boolean): CompiledGlob {
  const words = Math.ceil(stateCount / 32);
  const eps1 = new Uint32Array(words);
  const eps2 = new Uint32Array(words);
  const starAll = new Uint32Array(words);
  const starNonSlash = new Uint32Array(words);
  const anyNonSlash = new Uint32Array(words);
  const starDirLoop = new Uint32Array(words);
  const charMasks = new Map<number, Uint32Array>();
  let hasStarDir = false;

  const setBit = (arr: Uint32Array, idx: number) => {
    arr[idx >>> 5] |= 1 << (idx & 31);
  };

  let state = 0;
  for (const tok of tokens) {
    if (tok.op === Op.LITERAL) {
      let mask = charMasks.get(tok.code);
      if (!mask) {
        mask = new Uint32Array(words);
        charMasks.set(tok.code, mask);
      }
      setBit(mask, state);
      state += 1;
    } else if (tok.op === Op.ANY_NON_SLASH) {
      setBit(anyNonSlash, state);
      state += 1;
    } else if (tok.op === Op.STAR_NON_SLASH) {
      setBit(starNonSlash, state);
      setBit(eps1, state);
      state += 1;
    } else if (tok.op === Op.STAR_ALL) {
      setBit(starAll, state);
      setBit(eps1, state);
      state += 1;
    } else {
      hasStarDir = true;
      setBit(eps1, state);
      setBit(eps2, state);
      setBit(starAll, state + 1);
      setBit(starDirLoop, state + 1);
      state += 2;
    }
  }

  const acceptWord = (stateCount - 1) >>> 5;
  const acceptMask = (1 << ((stateCount - 1) & 31)) >>> 0;
  const initial = new Uint32Array(words);
  initial[0] = 1;
  shiftLeft1(initial, eps1, initial, words);
  if (hasStarDir) shiftLeft2Or(initial, eps1, eps2, initial, words);

  const asciiMasks = new Array<Uint32Array | undefined>(128);
  for (const [code, mask] of charMasks) {
    if (code < 128) asciiMasks[code] = mask;
  }

  // Scratch buffers reused per match invocation (safe because JS test() is synchronous and non-reentrant).
  const buf0 = new Uint32Array(words);
  const buf1 = new Uint32Array(words);

  return {
    test(target: string): boolean {
      let cur = buf0;
      let next = buf1;
      cur.set(initial);
      for (let i = 0; i < target.length; i++) {
        const code = target.charCodeAt(i);
        if (matchDescendants && ((cur[acceptWord] as number) & acceptMask) !== 0 && code === SLASH) return true;
        const charMask = code < 128 ? asciiMasks[code] : charMasks.get(code);
        const notSlash = code !== SLASH;
        let advCarry = 0;
        let eps1Carry = 0;
        let eps2Carry = 0;
        let any = 0;
        for (let w = 0; w < words; w++) {
          const cw = cur[w] as number;
          const adv =
            (charMask ? (charMask[w] as number) : 0) |
            (notSlash ? (anyNonSlash[w] as number) : (starDirLoop[w] as number));
          const moved = cw & adv;
          let nw = ((moved << 1) | advCarry | (cw & (starAll[w] as number)) | eps1Carry | eps2Carry) >>> 0;
          if (notSlash) nw = (nw | (cw & (starNonSlash[w] as number))) >>> 0;
          advCarry = moved >>> 31;
          const ep1 = nw & (eps1[w] as number);
          nw = (nw | (ep1 << 1)) >>> 0;
          eps1Carry = ep1 >>> 31;
          if (hasStarDir) {
            const ep2 = nw & (eps2[w] as number);
            nw = (nw | (ep2 << 2)) >>> 0;
            eps2Carry = ep2 >>> 30;
          }
          next[w] = nw;
          any |= nw;
        }
        if (any === 0) return false;
        const tmp = cur;
        cur = next;
        next = tmp;
      }
      return ((cur[acceptWord] as number) & acceptMask) !== 0;
    },
  };
}

function tryCompileLiteralStarAll(tokens: readonly Token[], matchDescendants: boolean): CompiledGlob | undefined {
  let hasStarAll = false;
  const pieces: string[] = [];
  let current = '';
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i] as Token;
    if (tok.op === Op.LITERAL) {
      current += String.fromCharCode(tok.code);
    } else if (tok.op === Op.STAR_ALL) {
      hasStarAll = true;
      pieces.push(current);
      current = '';
    } else {
      return undefined;
    }
  }
  if (!hasStarAll) return undefined;
  pieces.push(current);

  const first = pieces[0] as string;
  const last = pieces[pieces.length - 1] as string;
  const middleCount = pieces.length - 2;
  const lastSlashSuffix = matchDescendants && last.length > 0 ? `${last}/` : '';

  return {
    test(target: string): boolean {
      if (first.length > 0 && !target.startsWith(first)) return false;
      let pos = first.length;
      for (let i = 1; i <= middleCount; i++) {
        const piece = pieces[i] as string;
        const idx = target.indexOf(piece, pos);
        if (idx < 0) return false;
        pos = idx + piece.length;
      }
      if (last.length === 0) return true;
      if (target.length - pos >= last.length && target.endsWith(last)) return true;
      if (matchDescendants && target.indexOf(lastSlashSuffix, pos) >= 0) return true;
      return false;
    },
  };
}

/**
 * Compiles a path/subject glob (`*`, `**`, `?`) into a linear-time NFA matcher
 * free of regex backtracking (ReDoS-proof).
 */
export function compileGlob(pattern: string, options: { matchDescendants?: boolean } = {}): CompiledGlob {
  const matchDescendants = options.matchDescendants === true;
  if (!pattern.includes('*') && !pattern.includes('?')) {
    if (!matchDescendants) return { test: (target: string) => target === pattern };
    const prefix = pattern === '/' ? '/' : `${pattern}/`;
    return { test: (target: string) => target === pattern || target.startsWith(prefix) };
  }
  const tokens = tokenize(pattern);
  const literalFast = tryCompileLiteralStarAll(tokens, matchDescendants);
  if (literalFast) return literalFast;
  let stateCount = 1; // +1 for ACCEPT
  for (const tok of tokens) stateCount += tok.op === Op.STAR_DIR ? 2 : 1;
  return stateCount <= 32
    ? compileSmallNfa(tokens, stateCount, matchDescendants)
    : compileWideNfa(tokens, stateCount, matchDescendants);
}

const GLOB_CACHE_MAX = 512;
const globCache = new Map<string, CompiledGlob>();

/** Cached linear-time glob test for rule matching. */
export function matchGlob(pattern: string, target: string, matchDescendants = false): boolean {
  const key = `${matchDescendants ? '1' : '0'}:${pattern}`;
  let compiled = globCache.get(key);
  if (!compiled) {
    if (globCache.size >= GLOB_CACHE_MAX) {
      const oldest = globCache.keys().next().value;
      if (oldest !== undefined) globCache.delete(oldest);
    }
    compiled = compileGlob(pattern, { matchDescendants });
    globCache.set(key, compiled);
  }
  return compiled.test(target);
}
