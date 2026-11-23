import { describe, expect, it } from 'vitest';
import {
  computeMemoryRetention,
  createInitialFsrsState,
  shouldPruneMemory,
  strengthenFsrsState,
} from '../src/host/fsrs.js';
import { searchMemoryItems, tokenizeCjkAndLatin } from '../src/shared/search.js';
import type { MemoryViewItem } from '../src/shared/types.js';

const T0 = 1_764_000_000_000;
const DAY = 86_400_000;

describe('ts-fsrs 记忆保留衰减、回忆强化与置顶永不衰减模型', () => {
  it('未置顶记忆随时间单调衰减，episode 衰减快于 preference；置顶记忆永远锁定 100% 且绝不修剪', () => {
    const prefFsrs = createInitialFsrsState('preference', T0);
    const epiFsrs = createInitialFsrsState('episode', T0);
    expect(epiFsrs.stability).toBeLessThan(prefFsrs.stability);

    const r0 = computeMemoryRetention(prefFsrs, false, T0);
    const r1 = computeMemoryRetention(prefFsrs, false, T0 + 1 * DAY);
    const r7 = computeMemoryRetention(prefFsrs, false, T0 + 7 * DAY);
    const r30 = computeMemoryRetention(prefFsrs, false, T0 + 30 * DAY);
    expect(r0).toBe(1);
    expect(r1).toBeLessThan(r0);
    expect(r7).toBeLessThan(r1);
    expect(r30).toBeLessThan(r7);

    // 同一时间点下 episode 保留率低于 preference
    const epiR14 = computeMemoryRetention(epiFsrs, false, T0 + 14 * DAY);
    const prefR14 = computeMemoryRetention(prefFsrs, false, T0 + 14 * DAY);
    expect(epiR14).toBeLessThan(prefR14);

    // 超长时间未访问的未置顶 episode 达到修剪阈值，但置顶项在 10 年后依然保留率 1.0 且绝不修剪
    expect(shouldPruneMemory(epiFsrs, 'episode', false, T0 + 365 * DAY)).toBe(true);
    expect(computeMemoryRetention(epiFsrs, true, T0 + 3_650 * DAY)).toBe(1);
    expect(shouldPruneMemory(epiFsrs, 'episode', true, T0 + 3_650 * DAY)).toBe(false);
  });

  it('回忆命中（recall）同日与跨日均会提升 FSRS 稳定度 S 并恢复保留率', () => {
    const initial = createInitialFsrsState('decision', T0);
    const sameHour = strengthenFsrsState(initial, T0 + 1_800_000, 'recall');
    expect(sameHour.stability).toBeGreaterThan(initial.stability);

    const decayedAt10d = computeMemoryRetention(initial, false, T0 + 10 * DAY);
    expect(decayedAt10d).toBeLessThan(0.9);

    const recalledAt10d = strengthenFsrsState(initial, T0 + 10 * DAY, 'recall');
    expect(recalledAt10d.stability).toBeGreaterThan(initial.stability);
    expect(computeMemoryRetention(recalledAt10d, false, T0 + 10 * DAY)).toBe(1);
    expect(computeMemoryRetention(recalledAt10d, false, T0 + 20 * DAY)).toBeGreaterThan(
      computeMemoryRetention(initial, false, T0 + 20 * DAY),
    );
  });
});

describe('MiniSearch 中英混合分词、BM25、前缀与模糊检索', () => {
  function item(
    overrides: Partial<MemoryViewItem> & Pick<MemoryViewItem, 'id' | 'kind' | 'title' | 'content'>,
  ): MemoryViewItem {
    return {
      tags: [],
      pinned: false,
      confidence: 0.9,
      sourceSessionIds: ['s1'],
      evidenceCount: 1,
      recallCount: 0,
      createdAt: T0,
      updatedAt: T0,
      retention: 0.9,
      fsrs: createInitialFsrsState(overrides.kind, T0),
      ...overrides,
    };
  }

  it('正确切分中英混合文本、二元词组与驼峰代码标识符', () => {
    const tokens = tokenizeCjkAndLatin('偏好使用 pnpmWorkspace 实现睡眠整合');
    expect(tokens).toContain('pnpmworkspace');
    expect(tokens).toContain('pnpm');
    expect(tokens).toContain('workspace');
    expect(tokens).toContain('睡眠');
    expect(tokens).toContain('整合');
  });

  it('支持中文检索、英文前缀/拼写容错检索、类型过滤与低保留率默认过滤', () => {
    const docs: MemoryViewItem[] = [
      item({
        id: 'm1',
        kind: 'preference',
        title: '统一采用 pnpm 管理工作区',
        content: '禁止使用 yarn，始终提交 pnpm-lock.yaml。',
        tags: ['pnpm', 'monorepo'],
        pinned: true,
        retention: 1,
      }),
      item({
        id: 'm2',
        kind: 'pitfall',
        title: 'TypeScript 装饰器需在 Vitest 预加载插件编译',
        content: 'Typert @Remote 装饰器测试前需挂载 decoratorPlugin。',
        tags: ['typescript', 'vitest'],
        retention: 0.88,
      }),
      item({
        id: 'm3',
        kind: 'episode',
        title: '早期已淡忘的临时构建记录',
        content: '测试 pnpm 缓存脚本的一次性记录',
        tags: ['pnpm'],
        retention: 0.11,
      }),
    ];

    // 中文检索 + 默认过滤低保留率 (<0.2) 条目
    const cjkHits = searchMemoryItems(docs, '工作区');
    expect(cjkHits.map((h) => h.id)).toEqual(['m1']);

    // pnpm 检索默认不含保留率 0.11 的 m3，开启 includeLowRetention 后包含且排在 m1 之后
    expect(searchMemoryItems(docs, 'pnpm').map((h) => h.id)).toEqual(['m1']);
    expect(searchMemoryItems(docs, 'pnpm', { includeLowRetention: true }).map((h) => h.id)).toEqual(['m1', 'm3']);

    // 英文拼写容错（fuzzy: typescrpt -> typescript）与前缀（vite -> vitest）
    expect(searchMemoryItems(docs, 'typescrpt').map((h) => h.id)).toContain('m2');
    expect(searchMemoryItems(docs, 'vite').map((h) => h.id)).toContain('m2');

    // 按 kind 过滤
    expect(searchMemoryItems(docs, '', { kind: 'pitfall' }).map((h) => h.id)).toEqual(['m2']);

    // 回归：含中文助词「的/了/在」或英文停用词「about/the」的无关查询绝不因单字拆分误命中无关记忆
    expect(searchMemoryItems(docs, '关于数据库的迁移决策')).toEqual([]);
    expect(searchMemoryItems(docs, 'decision about postgresql')).toEqual([]);

    // 单汉字精确查询依然可命中含该汉字的记忆
    expect(searchMemoryItems(docs, '禁').map((h) => h.id)).toContain('m1');
  });
});
