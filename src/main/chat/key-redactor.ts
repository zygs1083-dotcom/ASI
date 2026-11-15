/**
 * 统一的 key 脱敏工具：一次性文本（redactKeys）与流式分片（KeyRedactor）。
 * 只在主进程使用；任何长度的 key 都参与脱敏（遗留数据里可能有过短 key）。
 */

export const KEY_MASK = '[已隐藏]';

/** 归一化 key 列表：去空、去重、长 key 优先（保证重叠时先吃最长匹配） */
export function normalizeRedactionKeys(keys: Iterable<string | null | undefined>): string[] {
  const set = new Set<string>();
  for (const k of keys) {
    if (typeof k === 'string' && k !== '') {
      set.add(k);
    }
  }
  return [...set].sort((a, b) => b.length - a.length);
}

/**
 * 把 text 中所有受保护 key 抹掉：
 * 1. 逐 key 替换为 KEY_MASK；若掩码本身包含该 key（key 等于/位于掩码内），该 key 用空串替换。
 * 2. 兜底循环：掩码与上下文可能重新拼出 key、删除某 key 也可能拼出另一把，
 *    只要还能找到 key 就用空串清掉。每轮替换都严格缩短文本，必然终止。
 */
export function redactKeys(text: string, keys: Iterable<string | null | undefined>): string {
  const ks = normalizeRedactionKeys(keys);
  if (ks.length === 0 || text === '') {
    return text;
  }
  let out = text;
  for (const k of ks) {
    const replacement = KEY_MASK.includes(k) ? '' : KEY_MASK;
    if (out.includes(k)) {
      out = out.split(k).join(replacement);
    }
  }
  for (;;) {
    let hit = false;
    for (const k of ks) {
      if (out.includes(k)) {
        out = out.split(k).join('');
        hit = true;
      }
    }
    if (!hit) {
      return out;
    }
  }
}

/**
 * 跨分片流式脱敏器：key 可能被切成任意多片到达。
 * 每追加一段原始文本，先整体过一遍 redactKeys 清掉完整 key，
 * 再扣留尾部最长的"任一 key 的真前缀"，只放出绝不可能参与构成 key 的部分；
 * flush 时剩余内容再过一遍完整 redactKeys 后全部放出。
 * 这样保证任何已放出/已存储的文本里都不存在完整 key。
 */
export class KeyRedactor {
  private pending = '';
  private readonly keys: string[];
  /** 需要扣留检查的最大长度 = 最长 key 长度 - 1 */
  private readonly maxHold: number;

  constructor(keys: Iterable<string | null | undefined>) {
    this.keys = normalizeRedactionKeys(keys);
    this.maxHold = this.keys.reduce((m, k) => Math.max(m, k.length - 1), 0);
  }

  push(raw: string): string {
    this.pending += raw;
    if (this.keys.length === 0) {
      const out = this.pending;
      this.pending = '';
      return out;
    }
    this.pending = redactKeys(this.pending, this.keys);
    let hold = 0;
    const max = Math.min(this.pending.length, this.maxHold);
    for (let len = max; len > hold; len--) {
      const suffix = this.pending.slice(this.pending.length - len);
      if (this.keys.some((k) => k.length > len && k.startsWith(suffix))) {
        hold = len;
        break;
      }
    }
    const out = this.pending.slice(0, this.pending.length - hold);
    this.pending = this.pending.slice(this.pending.length - hold);
    return out;
  }

  /** 剩余 pending 不可能是完整 key（顶多是 key 前缀片段），过完整脱敏后放出 */
  flush(): string {
    const out = redactKeys(this.pending, this.keys);
    this.pending = '';
    return out;
  }
}
