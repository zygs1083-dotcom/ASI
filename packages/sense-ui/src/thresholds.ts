/**
 * 指标阈值解析：画线用的阈值线集合 + 明细三行文案。
 * 规则：宿主提供的 floor/rate/baseline 凡单位可比较都画线（各带层名标签），
 * supplied floor 缺失时回退既有健康底线；显式单位不符的 floor 阻断该回退
 * （单位对不上时既有底线的数值同样可疑），只在明细行里展示原值。
 * rate/baseline 不做数值假设，未提供即「未提供」。
 */

import { formatMetricValue } from './format';
import { effectiveSeverity } from './health';
import type { DetailUnit, MetricInsight, MetricKey, ThresholdLayer } from './view-model';

export interface SparkThreshold {
  value: number;
  sev: 'warn' | 'critical';
  /** above = 高于阈值告警；below = 低于阈值告警（电池反向）。 */
  direction: 'above' | 'below';
  /** 线的短标签（底线 / 变化率 / 基线 / 显示底线）；展开图标注用。 */
  label?: string;
  /**
   * 该线是否代表宿主当前触发状态。false 的线仅作信息参考画出，
   * 不参与曲线分段告警染色。缺省视为 true（直接传入的阈值与
   * 既有显示底线都按可告警处理）。
   */
  active?: boolean;
}

/** 各指标 history 序列的单位（电池按百分点数值、温控按档位序数，均为 count）。 */
export function metricUnit(key: MetricKey): DetailUnit {
  if (key === 'tokens') return 'tokens';
  if (key === 'networkRx' || key === 'networkTx') return 'bytes/s';
  if (key === 'processRss') return 'bytes';
  if (key === 'battery' || key === 'thermal') return 'count';
  return 'ratio';
}

const NETWORK_KEYS = new Set<MetricKey>(['networkRx', 'networkTx']);

/**
 * 宿主标注单位能否画在 history 坐标上：
 * 缺省视为同单位；网络序列本来就是 B/s，兼容旧版 'bytes' 标注。
 */
function unitPlottable(key: MetricKey, unit?: DetailUnit): boolean {
  if (unit == null) return true;
  if (NETWORK_KEYS.has(key)) return unit === 'bytes/s' || unit === 'bytes';
  return unit === metricUnit(key);
}

/** 明细文本用的单位：网络旧版 'bytes' 按 B/s 展示，其余原样。 */
function displayUnit(key: MetricKey, unit: DetailUnit): DetailUnit {
  return NETWORK_KEYS.has(key) && unit === 'bytes' ? 'bytes/s' : unit;
}

const FLOOR_DEFAULTS: Record<string, { warn: number; critical: number; direction: 'above' | 'below' }> = {
  cpu: { warn: 0.75, critical: 0.9, direction: 'above' },
  memory: { warn: 0.85, critical: 0.95, direction: 'above' },
  'disk:*': { warn: 0.9, critical: 0.95, direction: 'above' },
  battery: { warn: 15, critical: 5, direction: 'below' },
  thermal: { warn: 2, critical: 3, direction: 'above' },
  processCpu: { warn: 0.75, critical: 0.9, direction: 'above' },
};

const LAYER_LABEL: Record<ThresholdLayer, string> = {
  floor: '底线',
  rate: '变化率',
  baseline: '基线',
};

/** 既有健康底线（history 单位）；无既有底线的指标（网络/processRss）返回 null。 */
export function defaultFloors(key: MetricKey, tokenWindow?: number): SparkThreshold[] | null {
  if (key === 'tokens') {
    if (tokenWindow == null || !Number.isFinite(tokenWindow) || tokenWindow <= 0) {
      return null;
    }
    return [
      { value: tokenWindow * 0.85, sev: 'warn', direction: 'above' },
      { value: tokenWindow * 0.95, sev: 'critical', direction: 'above' },
    ];
  }
  const d = key.startsWith('disk:') ? FLOOR_DEFAULTS['disk:*'] : FLOOR_DEFAULTS[key];
  if (!d) return null;
  return [
    { value: d.warn, sev: 'warn', direction: d.direction },
    { value: d.critical, sev: 'critical', direction: d.direction },
  ];
}

export interface ChartThresholds {
  lines: SparkThreshold[];
  /** supplied = 含宿主提供线；default = 仅既有显示底线；null = 无线可画。 */
  source: 'supplied' | 'default' | null;
}

/**
 * 画线阈值：收集全部可比较的宿主 floor/rate/baseline 线；
 * 无 supplied floor 时并入既有显示底线；floor 显式单位不符则阻断回退。
 * 宿主线的 active 取「该层在 triggered 中且有效严重度非 good」：
 * 激活线严重度取 effectiveSeverity（warn/critical）；未触发层仍是
 * 信息参考线（warn 虚线样式、active=false），不充当当前告警线色。
 */
export function chartThresholds(
  key: MetricKey,
  insight: MetricInsight | undefined,
  tokenWindow?: number,
): ChartThresholds {
  const lines: SparkThreshold[] = [];
  const eff = effectiveSeverity(insight);
  const triggered = new Set(insight?.triggered ?? []);
  const direction = key === 'battery' ? 'below' : 'above';
  let supplied = false;
  let floorBlocked = false;
  for (const layer of ['floor', 'rate', 'baseline'] as const) {
    const t = insight?.thresholds?.[layer];
    if (!t || !Number.isFinite(t.value)) continue;
    if (!unitPlottable(key, t.unit)) {
      if (layer === 'floor') floorBlocked = true;
      continue;
    }
    supplied = true;
    const active = eff !== 'good' && triggered.has(layer);
    lines.push({
      value: t.value,
      sev: active && eff === 'critical' ? 'critical' : 'warn',
      direction,
      label: LAYER_LABEL[layer],
      active,
    });
  }
  const floorSupplied = lines.some((l) => l.label === LAYER_LABEL.floor);
  if (!floorSupplied && !floorBlocked) {
    const d = defaultFloors(key, tokenWindow);
    if (d) lines.push(...d.map((t) => ({ ...t, label: '显示底线' })));
  }
  if (lines.length === 0) return { lines, source: null };
  return { lines, source: supplied ? 'supplied' : 'default' };
}

/**
 * 明细层文案（floor/rate/baseline 三行各调用一次）：
 * 宿主值 → 「值（来源）」；floor 无宿主值但有既有底线 → 「值（显示底线）」；
 * baseline 用 insight.baseline 区间；其余一律「未提供」，不虚构。
 */
export function thresholdRowText(
  key: MetricKey,
  layer: ThresholdLayer,
  insight: MetricInsight | undefined,
  tokenWindow: number | undefined,
  format: (v: number) => string,
): string {
  const t = insight?.thresholds?.[layer];
  if (t && Number.isFinite(t.value)) {
    return `${formatMetricValue(t.value, displayUnit(key, t.unit ?? metricUnit(key)))}（${t.source}）`;
  }
  if (layer === 'baseline') {
    return insight?.baseline ? `${format(insight.baseline.low)} ~ ${format(insight.baseline.high)}` : '未提供';
  }
  if (layer === 'floor') {
    const d = defaultFloors(key, tokenWindow);
    return d ? `${format(d[0]!.value)} / ${format(d[1]!.value)}（显示底线）` : '未提供';
  }
  return '未提供';
}
