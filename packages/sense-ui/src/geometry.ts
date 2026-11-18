/** 走势图几何：数据域/绘图域、告警分段路径、阈值标注摆位。 */

import type { Severity } from './health';
import { HISTORY_WINDOW_MS, sampleHistory } from './history';
import type { SparkThreshold } from './thresholds';
import type { MetricInsight, MetricPoint } from './view-model';

type SegSev = 'warn' | 'critical';

/** 值相对激活阈值线的告警级；active=false 的信息参考线不参与分类。 */
function sevOf(v: number, thresholds: SparkThreshold[]): SegSev | null {
  let hit: SegSev | null = null;
  for (const t of thresholds) {
    if (t.active === false) continue;
    const beyond = t.direction === 'above' ? v >= t.value : v <= t.value;
    if (beyond && hit !== 'critical') hit = t.sev;
  }
  return hit;
}

/**
 * 曲线告警上限：critical/未给 severity → 允许 critical；
 * warn → 至多 warn（fallback critical 越线也只染 warn）；
 * good/unknown → 全部中性（历史越线不冒充当前告警）。
 */
function sevCap(severity: Severity | undefined): SegSev | null {
  if (severity === undefined || severity === 'critical') return 'critical';
  return severity === 'warn' ? 'warn' : null;
}

/** 展开图阈值标注：按线位排序后保证 ≥13px/110px 间距并夹在图内。 */
function spreadLabels(marks: { t: SparkThreshold; y: number }[]): { t: SparkThreshold; y: number }[] {
  const GAP = (13 / 110) * 100;
  for (let i = 1; i < marks.length; i++) {
    marks[i]!.y = Math.max(marks[i]!.y, marks[i - 1]!.y + GAP);
  }
  const over = marks.length ? marks[marks.length - 1]!.y - 100 : 0;
  if (over > 0) {
    const shift = Math.min(over, marks[0]!.y);
    for (const m of marks) m.y -= shift;
  }
  return marks;
}

export interface RangeBandPoint {
  at: number;
  min: number;
  max: number;
}

function buildRangeBandPath(
  points: readonly RangeBandPoint[],
  xOf: (at: number) => number,
  yOf: (v: number) => number,
): string | undefined {
  if (points.length === 0) return undefined;
  let minStep = Number.POSITIVE_INFINITY;
  for (let i = 1; i < points.length; i++) {
    const dt = points[i]!.at - points[i - 1]!.at;
    if (dt > 0 && dt < minStep) minStep = dt;
  }
  const gapBreakMs = Number.isFinite(minStep) ? Math.max(15 * 60_000, minStep * 2.5) : 15 * 60_000;
  const parts: string[] = [];
  let start = 0;
  while (start < points.length) {
    let end = start + 1;
    while (end < points.length && points[end]!.at - points[end - 1]!.at <= gapBreakMs) {
      end += 1;
    }
    const run = points.slice(start, end);
    if (run.length === 1) {
      const p = run[0]!;
      const x = xOf(p.at);
      const yTop = yOf(Math.max(p.min, p.max));
      const yBot = yOf(Math.min(p.min, p.max));
      parts.push(
        `M${Math.max(0, x - 0.5).toFixed(2)},${yTop.toFixed(2)} L${Math.min(100, x + 0.5).toFixed(2)},${yTop.toFixed(2)} L${Math.min(100, x + 0.5).toFixed(2)},${yBot.toFixed(2)} L${Math.max(0, x - 0.5).toFixed(2)},${yBot.toFixed(2)} Z`,
      );
    } else {
      const top = run.map((p, idx) => {
        const prefix = idx === 0 ? 'M' : 'L';
        return `${prefix}${xOf(p.at).toFixed(2)},${yOf(Math.max(p.min, p.max)).toFixed(2)}`;
      });
      const bottom: string[] = [];
      for (let i = run.length - 1; i >= 0; i--) {
        const p = run[i]!;
        bottom.push(`L${xOf(p.at).toFixed(2)},${yOf(Math.min(p.min, p.max)).toFixed(2)}`);
      }
      parts.push(`${top.join(' ')} ${bottom.join(' ')} Z`);
    }
    start = end;
  }
  return parts.length > 0 ? parts.join(' ') : undefined;
}

export interface SparkGeometry {
  since: number;
  dataMin: number;
  dataMax: number;
  min: number;
  max: number;
  xOf: (at: number) => number;
  yOf: (v: number) => number;
  band: { low: number; high: number } | null;
  rangeBandPath?: string;
  normalSegs: string[];
  warnSegs: string[];
  critSegs: string[];
  last: MetricPoint;
  thrMarks: { t: SparkThreshold; y: number }[];
}

/**
 * 窗口内采样 + 路径几何。x 域固定为 [anchor-windowMs, anchor]（稀疏点也按真实
 * 时间摆位）；y 域取数据/min-max 带/基线/阈值的并集。越界线段才染告警色；末点保留。
 * recent < 2 点返回 null（调用方画占位文案）。
 */
export function buildSpark(
  points: MetricPoint[],
  anchor: number,
  opts: {
    baseline?: MetricInsight['baseline'];
    thresholds?: SparkThreshold[];
    severity?: Severity;
    expanded?: boolean;
    windowMs?: number;
    minMaxBand?: readonly RangeBandPoint[];
  } = {},
): { recent: MetricPoint[]; g: SparkGeometry } | null {
  const thresholds = opts.thresholds ?? [];
  const window =
    opts.windowMs !== undefined && Number.isFinite(opts.windowMs) && opts.windowMs > 0
      ? opts.windowMs
      : HISTORY_WINDOW_MS;
  // 阈值传入采样器：越界/相等迁移的边界点强制保留（含未激活参考线的几何）
  const recent = sampleHistory(points, anchor, thresholds, window);
  if (recent.length < 2) return null;

  const since = anchor - window;
  const rawBand = opts.minMaxBand
    ? opts.minMaxBand.filter(
        (p) =>
          Number.isFinite(p.at) && Number.isFinite(p.min) && Number.isFinite(p.max) && p.at >= since && p.at <= anchor,
      )
    : [];
  const bandPoints = rawBand.some((p, i) => i > 0 && p.at < rawBand[i - 1]!.at)
    ? [...rawBand].sort((a, b) => a.at - b.at)
    : rawBand;

  // 数据极值只来自观察点与 min/max 统计带（无障碍文案）；绘图域再纳入基线带与阈值线保证可见。
  let dataMin = Infinity;
  let dataMax = -Infinity;
  for (const p of recent) {
    if (p.value < dataMin) dataMin = p.value;
    if (p.value > dataMax) dataMax = p.value;
  }
  for (const p of bandPoints) {
    const lo = Math.min(p.min, p.max);
    const hi = Math.max(p.min, p.max);
    if (lo < dataMin) dataMin = lo;
    if (hi > dataMax) dataMax = hi;
  }
  const band =
    opts.baseline && Number.isFinite(opts.baseline.low) && Number.isFinite(opts.baseline.high) ? opts.baseline : null;
  let min = dataMin;
  let max = dataMax;
  if (band) {
    min = Math.min(min, band.low);
    max = Math.max(max, band.high);
  }
  for (const t of thresholds) {
    if (Number.isFinite(t.value)) {
      min = Math.min(min, t.value);
      max = Math.max(max, t.value);
    }
  }
  const pad = (max - min) * 0.08 || Math.max(Math.abs(max) * 0.1, 1e-6);
  min -= pad;
  max += pad;
  const span = max - min;

  const xOf = (at: number) => ((at - since) / window) * 100;
  const yOf = (v: number) => (1 - (v - min) / span) * 100;
  const rangeBandPath = buildRangeBandPath(bandPoints, xOf, yOf);

  // 逐段拆分：跨越激活阈值线的段在交点切开，越界部分单独着色。
  // 染色上限受行级 severity 约束（good/unknown 全中性，warn 不升 critical），
  // active=false 的参考线只画不切。
  const cap = sevCap(opts.severity);
  const normalSegs: string[] = [];
  const warnSegs: string[] = [];
  const critSegs: string[] = [];
  for (let i = 1; i < recent.length; i++) {
    const p0 = recent[i - 1]!;
    const p1 = recent[i]!;
    const x0 = xOf(p0.at);
    const x1 = xOf(p1.at);
    const cuts = thresholds
      .filter((t) => t.active !== false && Number.isFinite(t.value) && (p0.value - t.value) * (p1.value - t.value) < 0)
      .map((t) => (t.value - p0.value) / (p1.value - p0.value))
      .sort((a, b) => a - b);
    let prev = 0;
    for (const cut of [...cuts, 1]) {
      const xa = x0 + (x1 - x0) * prev;
      const xb = x0 + (x1 - x0) * cut;
      const ya = yOf(p0.value + (p1.value - p0.value) * prev);
      const yb = yOf(p0.value + (p1.value - p0.value) * cut);
      const mid = p0.value + (p1.value - p0.value) * ((prev + cut) / 2);
      const seg = sevOf(mid, thresholds);
      const capped = seg === null || cap === null ? null : seg === 'critical' && cap === 'warn' ? 'warn' : seg;
      const bucket = capped === 'critical' ? critSegs : capped === 'warn' ? warnSegs : normalSegs;
      bucket.push(`M${xa.toFixed(2)},${ya.toFixed(2)} L${xb.toFixed(2)},${yb.toFixed(2)}`);
      prev = cut;
    }
  }

  const thrMarks = opts.expanded
    ? spreadLabels(
        thresholds
          .filter((t) => Number.isFinite(t.value))
          .map((t) => ({ t, y: Math.min(100, Math.max(0, yOf(t.value))) }))
          .sort((a, b) => a.y - b.y),
      )
    : [];

  return {
    recent,
    g: {
      since,
      dataMin,
      dataMax,
      min,
      max,
      xOf,
      yOf,
      band,
      ...(rangeBandPath ? { rangeBandPath } : {}),
      normalSegs,
      warnSegs,
      critSegs,
      last: recent[recent.length - 1]!,
      thrMarks,
    },
  };
}

/** 阈值数组的语义相等：引用不等但逐字段一致也视为未变（调用方常新分配）。 */
export function sameThresholds(a: SparkThreshold[], b: SparkThreshold[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (
      x.value !== y.value ||
      x.sev !== y.sev ||
      x.direction !== y.direction ||
      x.label !== y.label ||
      x.active !== y.active
    ) {
      return false;
    }
  }
  return true;
}
