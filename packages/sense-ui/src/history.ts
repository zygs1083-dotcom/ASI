import type { SparkThreshold } from './thresholds';
import type { MetricPoint } from './view-model';

export const HISTORY_WINDOW_MS = 5 * 60 * 1000;

/** 折线最多绘制的原始观测点数：2×119 桶 + 首末 = 240。 */
const MAX_PLOT_POINTS = 240;
const BUCKETS = MAX_PLOT_POINTS / 2 - 1; // 119

/**
 * 预渲染降采样：窗口内有效点 ≤240 原样保留（仅按时间排序）；超过则分
 * 119 桶各留 min/max + 首末端点，O(n)。另对任一有限 thresholds（含未
 * 激活参考线）发生「穿越/相等状态迁移」的相邻点对两点都强制保留——容量
 * 为软上限（≤240 普通采样 + 不设上限的越界边界点），不静默丢弃 excursion。
 * 同时间戳按输入顺序稳定（仅非非降序时才排序），末点为最晚时间戳的最后点。
 */
export function sampleHistory(
  points: MetricPoint[],
  now: number,
  thresholds: SparkThreshold[] = [],
  windowMs = HISTORY_WINDOW_MS,
): MetricPoint[] {
  const window = Number.isFinite(windowMs) && windowMs > 0 ? windowMs : HISTORY_WINDOW_MS;
  const since = now - window;
  const valid: MetricPoint[] = [];
  for (const p of points) {
    if (!Number.isFinite(p.at) || !Number.isFinite(p.value) || p.at < since || p.at > now) continue;
    valid.push(p);
  }
  // 已按时间非降序则零拷贝；否则稳定排序（同时间戳保留原始顺序）
  let sorted = valid;
  for (let i = 1; i < valid.length; i++) {
    if (valid[i]!.at < valid[i - 1]!.at) {
      sorted = [...valid].sort((a, b) => a.at - b.at);
      break;
    }
  }
  if (sorted.length <= MAX_PLOT_POINTS) return sorted;

  const buckets: ({ min: MetricPoint; max: MetricPoint } | undefined)[] = new Array(BUCKETS);
  for (const p of sorted) {
    const i = Math.min(BUCKETS - 1, Math.floor(((p.at - since) / window) * BUCKETS));
    const b = buckets[i];
    if (!b) buckets[i] = { min: p, max: p };
    else {
      if (p.value < b.min.value) b.min = p;
      if (p.value > b.max.value) b.max = p;
    }
  }
  const kept = new Set<MetricPoint>([sorted[0]!, sorted[sorted.length - 1]!]);
  for (const b of buckets)
    if (b) {
      kept.add(b.min);
      kept.add(b.max);
    }

  // 阈值方位（下方/恰等/上方）在相邻点间变化时两点都保留；sorted 已按
  // (时间, 原始序号) 排好，filter 保序输出。
  const finite = thresholds.filter((t) => Number.isFinite(t.value));
  if (finite.length > 0) {
    for (const t of finite) {
      const side = (v: number) => (v < t.value ? -1 : v > t.value ? 1 : 0);
      for (let i = 1; i < sorted.length; i++) {
        if (side(sorted[i]!.value) !== side(sorted[i - 1]!.value)) {
          kept.add(sorted[i - 1]!);
          kept.add(sorted[i]!);
        }
      }
    }
  }
  return sorted.filter((p) => kept.has(p));
}
