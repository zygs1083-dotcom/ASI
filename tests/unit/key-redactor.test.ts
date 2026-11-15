import { describe, expect, it } from 'vitest';
import { KEY_MASK, KeyRedactor, redactKeys } from '../../src/main/chat/key-redactor';

const KEY = 'sk-ABCDEFGH';

function drain(chunks: string[], keys: string[]): { emitted: string[]; tail: string } {
  const r = new KeyRedactor(keys);
  const emitted = chunks.map((c) => r.push(c));
  return { emitted, tail: r.flush() };
}

describe('redactKeys', () => {
  it('replaces every occurrence of each key with the mask', () => {
    expect(redactKeys(`a${KEY}b${KEY}c`, [KEY])).toBe(`a${KEY_MASK}b${KEY_MASK}c`);
  });

  it('masks short keys too (there is no minimum length)', () => {
    expect(redactKeys('x ab y', ['ab'])).toBe(`x ${KEY_MASK} y`);
    expect(redactKeys('aXa', ['a'])).toBe(`${KEY_MASK}X${KEY_MASK}`);
    expect(redactKeys('k1', ['k1'])).toBe(KEY_MASK);
  });

  it('ignores empty and undefined keys', () => {
    expect(redactKeys(`a${KEY}b`, [undefined, '', KEY])).toBe(`a${KEY_MASK}b`);
    expect(redactKeys(KEY, [undefined, ''])).toBe(KEY);
    expect(redactKeys('', [KEY])).toBe('');
  });

  it('dedupes and prefers the longest key first', () => {
    expect(redactKeys('abc ab', ['ab', 'abc', 'abc'])).toBe(`${KEY_MASK} ${KEY_MASK}`);
    expect(redactKeys('xabcy', ['ab', 'abc'])).toBe(`x${KEY_MASK}y`);
  });

  it('uses an empty replacement when the key is equal to the mask', () => {
    expect(redactKeys(`pre${KEY_MASK}post`, [KEY_MASK])).toBe('prepost');
  });

  it('uses an empty replacement when the key is inside the mask', () => {
    // 含 key 的"掩码形"文本也不能留下 key 片段
    const out = redactKeys(`keep${KEY_MASK}keep`, ['已隐']);
    expect(out).not.toContain('已隐');
    expect(out).toBe('keep[藏]keep');
  });

  it('removes keys containing the mask without leaving the key behind', () => {
    const k = `x${KEY_MASK}y`;
    const out = redactKeys(`p${k}q`, [k]);
    expect(out).not.toContain(k);
    expect(out).toBe(`p${KEY_MASK}q`);
  });

  it('cleans up a key that the mask itself re-forms', () => {
    // 'aab' → 'a' + mask = 'a[已隐藏]'，恰好是另一把 key，必须由兜底清空
    const k = `a${KEY_MASK}`;
    expect(redactKeys('aab', ['ab', k])).toBe('');
    expect(redactKeys(`taabt`, ['ab', k])).toBe('tt');
  });

  it('keeps cleaning when a cleanup deletion re-forms another key', () => {
    // 'a' + 'ab' + 'c'：mask 后 'a' + mask + 'c'，其中不剩 'ab'/'ac'；
    // 这里验证删除 X 可能拼出 Y 的循环也能收敛
    const out = redactKeys('axc', ['axc', 'ac']);
    expect(out).not.toContain('axc');
    expect(out).not.toContain('ac');
  });

  it('terminates on pathological mask-overlapping key sets', () => {
    const keys = [KEY_MASK, '已', '藏]', '[已', `${KEY_MASK}${KEY_MASK}`];
    const out = redactKeys(`x${KEY_MASK}y${KEY_MASK}z`, keys);
    expect(out).not.toContain('已');
    expect(out).not.toContain('藏]');
    expect(out).not.toContain('[已');
    expect(out).not.toContain(KEY_MASK);
  });

  it('does not mask ordinary text that merely shares prefixes with a key', () => {
    expect(redactKeys('sk-is a prefix, not the key', [KEY])).toBe('sk-is a prefix, not the key');
  });
});

describe('KeyRedactor streaming', () => {
  it('emits benign text immediately', () => {
    const r = new KeyRedactor([KEY]);
    expect(r.push('hello ')).toBe('hello ');
    expect(r.push('world')).toBe('world');
    expect(r.flush()).toBe('');
  });

  it('masks a whole key arriving in one chunk', () => {
    const { emitted, tail } = drain([`pre${KEY}post`], [KEY]);
    expect(`${emitted.join('')}${tail}`).toBe(`pre${KEY_MASK}post`);
    expect(emitted.join('')).not.toContain(KEY);
  });

  it('masks the key at every two-chunk split boundary', () => {
    for (let i = 1; i < KEY.length; i++) {
      const r = new KeyRedactor([KEY]);
      const out = r.push(`pre${KEY.slice(0, i)}`) + r.push(`${KEY.slice(i)}post`) + r.flush();
      expect(out, `split at ${i}`).toBe(`pre${KEY_MASK}post`);
    }
  });

  it('masks the key across single-character chunks', () => {
    const r = new KeyRedactor([KEY]);
    let out = '';
    for (const ch of KEY) out += r.push(ch);
    out += r.flush();
    expect(out).toBe(KEY_MASK);
  });

  it('never releases a key prefix prematurely', () => {
    const r = new KeyRedactor([KEY]);
    expect(r.push('ok')).toBe('ok');
    expect(r.push(KEY.slice(0, 5))).toBe('');
    expect(r.push(KEY.slice(5))).toBe(KEY_MASK);
    expect(r.flush()).toBe('');
  });

  it('releases a held prefix once it can no longer form any key', () => {
    const r = new KeyRedactor([KEY]);
    expect(r.push(`tail${KEY.slice(0, 3)}`)).toBe('tail');
    expect(r.push('-not-the-key')).toBe(`${KEY.slice(0, 3)}-not-the-key`);
  });

  it('holds the longest suffix that is a proper prefix of ANY key', () => {
    const k1 = 'abcd';
    const k2 = 'cdef';
    const r = new KeyRedactor([k1, k2]);
    expect(r.push('xabc')).toBe('x');
    // 'abc' 是 k1 的前缀被扣留；随后 'def' 拼出完整 k1，k2 的残片 'ef' 放出
    expect(r.push('def')).toBe(`${KEY_MASK}ef`);
    expect(r.flush()).toBe('');
  });

  it('masks repeated and adjacent occurrences across chunks', () => {
    const { emitted, tail } = drain([`${KEY}${KEY}`, `x${KEY.slice(0, 4)}`, KEY.slice(4)], [KEY]);
    expect(`${emitted.join('')}${tail}`).toBe(`${KEY_MASK}${KEY_MASK}x${KEY_MASK}`);
    for (const e of emitted) expect(e).not.toContain(KEY);
  });

  it('handles a key equal to the mask without leaking it', () => {
    const r = new KeyRedactor([KEY_MASK]);
    const out = r.push(`pre${KEY_MASK}post`) + r.flush();
    expect(out).toBe('prepost');
    expect(out).not.toContain(KEY_MASK);
  });

  it('handles a key inside the mask across chunks', () => {
    const r = new KeyRedactor(['已隐']);
    const o1 = r.push('keep[已');
    // '已' + '隐藏]' 在 pending 里拼出真匹配，插入的掩码自身又含 key：兜底必须清掉
    const o2 = r.push('隐藏]keep');
    const tail = r.flush();
    const out = `${o1}${o2}${tail}`;
    expect(out).not.toContain('已隐');
  });

  it('never emits a key that mask insertion re-forms, at every split boundary and per char', () => {
    const assertNeverEmits = (keys: string[], text: string) => {
      const check = (emitted: string) => {
        for (const k of keys) expect(emitted).not.toContain(k);
      };
      // 每个两切分边界
      for (let i = 1; i < text.length; i++) {
        const r = new KeyRedactor(keys);
        let emitted = '';
        for (const chunk of [text.slice(0, i), text.slice(i)]) {
          emitted += r.push(chunk);
          check(emitted);
        }
        emitted += r.flush();
        check(emitted);
      }
      // 单字符流
      const r = new KeyRedactor(keys);
      let emitted = '';
      for (const ch of text) {
        emitted += r.push(ch);
        check(emitted);
      }
      emitted += r.flush();
      check(emitted);
    };
    // 掩码 + 'abcd' 恰好重组 key（key 以掩码开头）
    const key = `${KEY_MASK}abcd`;
    assertNeverEmits([key], `${key}abcd`);
    assertNeverEmits([key], `${key}abcdabcdabcd`);
    // 一把 key 藏在掩码内 + 一把普通 key
    assertNeverEmits(['已隐', 'sk-real-88'], 'pre[已隐藏]mid sk-real-88 post');
    // 重叠 key：'abcdef' 中 'abcd' 与 'cdef' 交叠
    assertNeverEmits(['abcd', 'cdef'], 'xabcdefy cdef x');
  });

  it('masks a short key split across single-character chunks', () => {
    const r = new KeyRedactor(['ab']);
    let out = '';
    for (const ch of 'zabz') out += r.push(ch);
    out += r.flush();
    expect(out).toBe(`z${KEY_MASK}z`);
  });

  it('keeps a pending key prefix in flush output (it is only a prefix, never a key)', () => {
    const r = new KeyRedactor([KEY]);
    expect(r.push(`tail${KEY.slice(0, 4)}`)).toBe('tail');
    expect(r.flush()).toBe(KEY.slice(0, 4));
  });

  it('flush output also goes through full redaction', () => {
    const r = new KeyRedactor([KEY, KEY_MASK]);
    r.push(`a${KEY.slice(0, 3)}`);
    const out = r.flush();
    expect(out).not.toContain(KEY);
    expect(out).not.toContain(KEY_MASK);
  });

  it('redacts multiple different keys in one stream', () => {
    const k1 = 'sk-first-1';
    const k2 = 'sk-second-2';
    const r = new KeyRedactor([k2, k1]);
    const out = r.push(`${k1}x${k2.slice(0, 6)}`) + r.push(k2.slice(6)) + r.flush();
    expect(out).toBe(`${KEY_MASK}x${KEY_MASK}`);
  });
});

describe('KeyRedactor boundary safety (legal keys)', () => {
  const LEGAL_A = 'abcd1234';
  const LEGAL_B = '1234wxyz';

  /**
   * 逐 push 断言不变量：累计已放出文本不含任何完整 key，
   * 也不以任何 key 的真前缀结尾（否则下一段放出文本可能在边界上拼出 key）。
   * flush 是终端例外，只要求最终文本不含完整 key。
   */
  function drainSafe(keys: string[], chunks: string[]): string {
    const r = new KeyRedactor(keys);
    let emitted = '';
    for (const c of chunks) {
      emitted += r.push(c);
      for (const k of keys) {
        expect(emitted).not.toContain(k);
        for (let p = 1; p < k.length; p++) {
          expect(
            emitted.endsWith(k.slice(0, p)),
            `emitted ${JSON.stringify(emitted)} must not end with a proper prefix of ${k}`,
          ).toBe(false);
        }
      }
    }
    emitted += r.flush();
    for (const k of keys) {
      expect(emitted).not.toContain(k);
    }
    return emitted;
  }

  it.each([LEGAL_A, LEGAL_B])(
    'masks %s at every two- and three-chunk split and across single chars',
    (key) => {
      const text = `pre${key}post`;
      const expected = `pre${KEY_MASK}post`;
      for (let i = 1; i < text.length; i++) {
        expect(drainSafe([key], [text.slice(0, i), text.slice(i)]), `two-split ${i}`).toBe(expected);
      }
      for (let i = 1; i < text.length - 1; i++) {
        for (let j = i + 1; j < text.length; j++) {
          expect(
            drainSafe([key], [text.slice(0, i), text.slice(i, j), text.slice(j)]),
            `three-split ${i},${j}`,
          ).toBe(expected);
        }
      }
      expect(drainSafe([key], [...text])).toBe(expected);
    },
  );

  it('withholds text ending in a competing proper prefix instead of releasing it', () => {
    // 'abc' 是 'abcdefgh' 的前缀、'XYZ' 是 'XYZabcde' 的前缀：
    // 在 'XYZ' 前切开会让已放出的 'abc' 以受保护前缀结尾，必须整段扣留
    const r = new KeyRedactor(['abcdefgh', 'XYZabcde']);
    expect(r.push('abcXYZ')).toBe('');
    // 后续片段让 pending 不再以任何受保护前缀结尾：整段放出（'abcXYZ' 本身不是 key）
    expect(r.push('defgh tail')).toBe('abcXYZdefgh tail');
    expect(r.flush()).toBe('');
  });

  it('stays safe for competing proper prefixes at every split and per char', () => {
    const keys = ['abcdefgh', 'XYZabcde'];
    for (const text of ['abcXYZabcdefgh', 'abcXYZdefgh', 'abcdefghXYZabcde', 'xabcdefghabcXYZ']) {
      for (let i = 1; i < text.length; i++) {
        drainSafe(keys, [text.slice(0, i), text.slice(i)]);
      }
      drainSafe(keys, [...text]);
    }
  });

  it('keeps protecting a legacy key that contains the mask across chunk splits', () => {
    // 遗留 key 可能含掩码子串（新保存已不可能）：分片拼出时仍不得泄漏
    const legacy = `a${KEY_MASK}b`;
    const emitted = drainSafe([legacy], [`x${legacy.slice(0, 4)}`, legacy.slice(4), 'y']);
    expect(emitted).not.toContain(legacy);
  });

  it('masks both legal keys through overlapping, interleaved and repeated text at every split', () => {
    const keys = [LEGAL_A, LEGAL_B];
    for (const text of [
      // 'abcd1234wxyz'：A 与 B 经共享的 '1234' 交叠；两把 key 各自重复出现
      'x abcd1234wxyz 1234wxyz abcd1234 end',
      'abcd1234 abcd1234 1234wxyz 1234wxyz',
      'pre abcd1234 mid 1234wxyz tail',
    ]) {
      const expected = redactKeys(text, keys);
      for (let i = 1; i < text.length; i++) {
        expect(drainSafe(keys, [text.slice(0, i), text.slice(i)]), `two-split ${i}`).toBe(expected);
      }
      for (let i = 1; i < text.length - 1; i++) {
        for (let j = i + 1; j < text.length; j++) {
          expect(
            drainSafe(keys, [text.slice(0, i), text.slice(i, j), text.slice(j)]),
            `three-split ${i},${j}`,
          ).toBe(expected);
        }
      }
      expect(drainSafe(keys, [...text])).toBe(expected);
    }
  });

  it('loses nothing when a long held proper-prefix chain completes a key then goes safe', () => {
    const keys = [LEGAL_A, LEGAL_B];
    // 5000 个 'a' 全是 'abcd1234' 的真前缀后缀：整段扣留；
    // 'bcd1234' 在链尾拼出完整 key，扣留前缀一个字符都不能丢
    const text = `${'a'.repeat(5000)}bcd1234 tail`;
    const chunks: string[] = [];
    for (let i = 0; i < text.length; i += 20) {
      chunks.push(text.slice(i, i + 20));
    }
    const emitted = drainSafe(keys, chunks);
    expect(emitted).toBe(`${'a'.repeat(4999)}${KEY_MASK} tail`);
    expect(emitted).not.toContain(LEGAL_A);
    expect(emitted).not.toContain(LEGAL_B);
  });

  it('processes a 100000-char all-proper-prefix stream in linear time', () => {
    // 对抗性回压：每个 'a' 都让文本以 'abcd1234' 的真前缀结尾，永远无法放出；
    // 持久匹配器只处理新增字符，不允许退化为逐片重扫扣留串
    const keys = [LEGAL_A, LEGAL_B];
    const full = 'a'.repeat(100000);
    const fragments: string[] = [];
    for (let i = 0; i < full.length; i += 20) {
      fragments.push(full.slice(i, i + 20));
    }
    expect(fragments).toHaveLength(5000);
    const r = new KeyRedactor(keys);
    const t0 = performance.now();
    for (const f of fragments) {
      expect(r.push(f)).toBe('');
    }
    const tail = r.flush();
    const elapsed = performance.now() - t0;
    console.log(`[perf] 100000 prefix-holding chars / 5000 fragments: ${elapsed.toFixed(1)}ms`);
    expect(elapsed).toBeLessThan(1000);
    expect(tail).toBe(full);
  });

  it('never reconstructs a legacy invalid stored key across event boundaries', () => {
    // 遗留非法 key 'abcd[已隐藏' 含掩码前缀（新保存已不可能入库）：
    // 'abcd1234' + '5678' 跨片拼出 '12345678'，掩码插入又恰好拼出遗留 key，
    // 兜底清理必须连它一起清掉；任意切分点上同样不得泄漏任何受保护值
    const legacy = `abcd${KEY_MASK.slice(0, -1)}`; // 'abcd[已隐藏'
    const keys = [legacy, '12345678'];
    const emitted = drainSafe(keys, ['abcd1234', '5678']);
    expect(emitted).toBe(redactKeys('abcd12345678', keys));
    expect(emitted).not.toContain('12345678');
    expect(emitted).not.toContain(legacy);
    const text = 'abcd12345678';
    for (let i = 1; i < text.length; i++) {
      drainSafe(keys, [text.slice(0, i), text.slice(i)]);
    }
    drainSafe(keys, [...text]);
  });

  it('redact() applies the cached key snapshot to arbitrary text', () => {
    const r = new KeyRedactor([KEY]);
    expect(r.redact(`pre${KEY}post`)).toBe(`pre${KEY_MASK}post`);
    expect(r.redact('clean')).toBe('clean');
  });
});
