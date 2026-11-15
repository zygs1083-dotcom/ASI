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
 * 共用脱敏原语（调用方保证 ks 已归一化、非空检查在内部）：
 * 1. 逐 key 替换为 KEY_MASK；若掩码本身包含该 key（key 等于/位于掩码内），该 key 用空串替换。
 * 2. 兜底循环：掩码与上下文可能重新拼出 key、删除某 key 也可能拼出另一把，
 *    只要还能找到 key 就用空串清掉。每轮替换都严格缩短文本，必然终止。
 */
function redactNormalized(text: string, ks: readonly string[]): string {
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

/** 把 text 中所有受保护 key 抹掉：归一化后走同一个 redactNormalized 原语 */
export function redactKeys(text: string, keys: Iterable<string | null | undefined>): string {
  return redactNormalized(text, normalizeRedactionKeys(keys));
}

/** KMP 前缀函数表：table[i] = pattern[0..i] 的最长真前后缀长度 */
function kmpPrefixTable(pattern: string): number[] {
  const table = new Array<number>(pattern.length).fill(0);
  let s = 0;
  for (let i = 1; i < pattern.length; i++) {
    while (s > 0 && pattern.charCodeAt(i) !== pattern.charCodeAt(s)) {
      s = table[s - 1];
    }
    if (pattern.charCodeAt(i) === pattern.charCodeAt(s)) {
      s += 1;
    }
    table[i] = s;
  }
  return table;
}

/**
 * 跨分片流式脱敏器：key 可能被切成任意多片到达。
 * 每个请求一个实例，构造时归一化并缓存 key 集合、KMP 前缀表与各 key 的替换文本。
 * push 维护一个持久的增量匹配器：只对新到达的 code unit 推进各 key 的 KMP 状态
 * 并入档；完整匹配按最长优先删除其仍在缓冲中的字符与状态档（原始输入的匹配随后
 * 插入该 key 的替换文本，替换期间产生的匹配只删除不再插入——与 redactNormalized
 * 的兜底清理同一收敛原则）；任一时刻所有状态归零即安全边界，整段缓冲放出。
 * 每次 push 收尾再放出缓冲的安全前缀，只保留能继续拼出某个 key 的最长真前缀后缀
 * （长度上界 = 最长 key 减一，扣留不再随输入无界增长）；emittedStates 记录已放出
 * 输出末尾的各 key 状态基线，跨放出边界重组的完整匹配仍会被捕获并压制其缓冲内
 * 部分。已放出文本允许以某个 key 的真前缀结尾——累计输出承诺的只是不含完整 key。
 * 增量匹配不重复扫描已处理文本，但每次放出都要搬移保留的后缀，扣留极长时
 * 这部分搬移随片段数累积。flush 是终端例外，扣留残片过同一 redact 原语后全部放出。
 */
export class KeyRedactor {
  /** 扣留的 UTF-16 code unit（每元素一个字符，按 raw[i] 切分，与 string.length 一致） */
  private pending: string[] = [];
  /** 平铺的逐位置状态档：位置 i 占 hist[i*K .. i*K+K)，删除 key 时同步截尾 */
  private hist: number[] = [];
  /** 已放出输出末尾的各 key KMP 状态基线：hist/states 描述包含该基线在内的整体有效输出 */
  private readonly emittedStates: number[];
  /** 当前各 key 的 KMP 状态（已放出基线 + 扣留缓冲的末尾） */
  private readonly states: number[];
  private readonly keys: string[];
  private readonly tables: number[][];
  /** 每个 key 的替换文本（原始匹配时插入，构造时随快照算好） */
  private readonly replacements: string[];

  constructor(keys: Iterable<string | null | undefined>) {
    this.keys = normalizeRedactionKeys(keys);
    this.tables = this.keys.map(kmpPrefixTable);
    this.replacements = this.keys.map((k) => redactNormalized(k, this.keys));
    this.states = new Array<number>(this.keys.length).fill(0);
    this.emittedStates = new Array<number>(this.keys.length).fill(0);
  }

  /** 与请求快照一致的整段脱敏（终态正文/错误信息等一次性出口共用） */
  redact(text: string): string {
    return redactNormalized(text, this.keys);
  }

  /**
   * 追加一个 code unit：各 key 的 KMP 状态前进一步并入档。
   * 完整 key 收尾时取最长匹配（keys 已按长度降序），只删除仍在缓冲中的字符
   * 与状态行——匹配可能跨越已放出边界，但绝不回撤已放出文本；随后从存档恢复
   * 当前状态（缓冲删空时恢复 emittedStates 基线而非清零，已放出末尾的
   * key 前缀状态仍在保护中）。被删的只是后缀，剩余前缀的存档状态依旧准确，
   * 不可能在存档里藏着未处理的完整匹配。
   */
  private append(unit: string, inserting: boolean): void {
    const K = this.keys.length;
    const code = unit.charCodeAt(0);
    for (let k = 0; k < K; k++) {
      const key = this.keys[k];
      const table = this.tables[k];
      let s = this.states[k];
      while (s > 0 && code !== key.charCodeAt(s)) {
        s = table[s - 1];
      }
      if (code === key.charCodeAt(s)) {
        s += 1;
      }
      this.states[k] = s;
    }
    this.pending.push(unit);
    for (let k = 0; k < K; k++) {
      this.hist.push(this.states[k]);
    }
    let matched = -1;
    for (let k = 0; k < K; k++) {
      if (this.states[k] === this.keys[k].length) {
        matched = k;
        break;
      }
    }
    if (matched === -1) {
      return;
    }
    // 匹配可能跨越已放出边界：只删仍在缓冲中的部分，不回撤已放出文本
    const drop = Math.min(this.keys[matched].length, this.pending.length);
    this.pending.length -= drop;
    this.hist.length -= drop * K;
    if (this.hist.length === 0) {
      // 缓冲删空：恢复已放出末尾的基线状态，已放出文本里的 key 前缀状态依然有效
      for (let k = 0; k < K; k++) {
        this.states[k] = this.emittedStates[k];
      }
    } else {
      for (let k = 0; k < K; k++) {
        this.states[k] = this.hist[this.hist.length - K + k];
      }
    }
    if (!inserting) {
      // 原始输入的匹配：把该 key 的替换文本也送过匹配器；
      // 替换内容自身拼出的匹配只删除、不再插入，必然收敛
      const replacement = this.replacements[matched];
      for (let i = 0; i < replacement.length; i++) {
        this.append(replacement[i], true);
      }
    }
  }

  push(raw: string): string {
    const K = this.keys.length;
    if (K === 0) {
      return raw;
    }
    const parts: string[] = [];
    for (let i = 0; i < raw.length; i++) {
      this.append(raw[i], false);
      // 全部状态归零 = 缓冲末尾不可能拼出任何 key 的前缀：整段放出
      if (this.states.every((s) => s === 0)) {
        parts.push(this.pending.join(''));
        this.pending.length = 0;
        this.hist.length = 0;
        this.emittedStates.fill(0);
      }
    }
    // 收尾放出安全前缀：只保留能继续拼出某个 key 的最长真前缀后缀。
    // 匹配状态可能伸进已放出文本（s > 扣留长度）：沿失配链回退到扣留范围内，
    // 取各 key 中最大的剩余状态（完整匹配都已在 append 中处理，剩下的必是真前缀）。
    const pendingLength = this.pending.length;
    if (pendingLength > 0) {
      let retain = 0;
      for (let k = 0; k < K; k++) {
        let s = this.states[k];
        while (s > pendingLength) {
          s = this.tables[k][s - 1];
        }
        if (s > retain) {
          retain = s;
        }
      }
      const release = pendingLength - retain;
      if (release > 0) {
        parts.push(this.pending.slice(0, release).join(''));
        // 新放出段最后一行的状态即已放出末尾基线（覆盖被删空前缀时的旧基线）
        for (let k = 0; k < K; k++) {
          this.emittedStates[k] = this.hist[(release - 1) * K + k];
        }
        this.pending.splice(0, release);
        this.hist.splice(0, release * K);
      }
    }
    return parts.join('');
  }

  /** 扣留残片过同一原语后全部放出（终端例外：不完整的前缀片段也会被释放） */
  flush(): string {
    const out = this.redact(this.pending.join(''));
    this.pending.length = 0;
    this.hist.length = 0;
    this.states.fill(0);
    this.emittedStates.fill(0);
    return out;
  }
}
