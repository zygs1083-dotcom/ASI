/**
 * 指标阈值解析：画线用的阈值线集合 + 明细三行文案。
 * 规则：宿主提供的 floor 优先（单位不符则不画线），否则用既有健康底线；
 * rate/baseline 不做数值假设，未提供即「未提供」。
 */

import { formatMetricValue } from './format'
import type {
  DetailUnit,
  MetricInsight,
  MetricKey,
  ThresholdLayer,
} from './view-model'

export interface SparkThreshold {
  value: number
  sev: 'warn' | 'critical'
  /** above = 高于阈值告警；below = 低于阈值告警（电池反向）。 */
  direction: 'above' | 'below'
}

/** 各指标 history 序列的单位（电池按百分点数值、温控按档位序数，均为 count）。 */
export function metricUnit(key: MetricKey): DetailUnit {
  if (key === 'tokens') return 'tokens'
  if (key === 'networkRx' || key === 'networkTx' || key === 'processRss') {
    return 'bytes'
  }
  if (key === 'battery' || key === 'thermal') return 'count'
  return 'ratio'
}

const FLOOR_DEFAULTS: Record<
  string,
  { warn: number; critical: number; direction: 'above' | 'below' }
> = {
  cpu: { warn: 0.75, critical: 0.9, direction: 'above' },
  memory: { warn: 0.85, critical: 0.95, direction: 'above' },
  'disk:*': { warn: 0.9, critical: 0.95, direction: 'above' },
  battery: { warn: 15, critical: 5, direction: 'below' },
  thermal: { warn: 1, critical: 3, direction: 'above' },
  processCpu: { warn: 0.75, critical: 0.9, direction: 'above' },
}

/** 既有健康底线（history 单位）；无既有底线的指标（网络/processRss）返回 null。 */
export function defaultFloors(
  key: MetricKey,
  tokenWindow?: number,
): SparkThreshold[] | null {
  if (key === 'tokens') {
    if (tokenWindow == null || !Number.isFinite(tokenWindow) || tokenWindow <= 0) {
      return null
    }
    return [
      { value: tokenWindow * 0.85, sev: 'warn', direction: 'above' },
      { value: tokenWindow * 0.95, sev: 'critical', direction: 'above' },
    ]
  }
  const d = key.startsWith('disk:') ? FLOOR_DEFAULTS['disk:*'] : FLOOR_DEFAULTS[key]
  if (!d) return null
  return [
    { value: d.warn, sev: 'warn', direction: d.direction },
    { value: d.critical, sev: 'critical', direction: d.direction },
  ]
}

export interface ChartThresholds {
  lines: SparkThreshold[]
  /** supplied = 宿主提供；default = 既有显示底线；null = 无线可画。 */
  source: 'supplied' | 'default' | null
}

/**
 * 画线阈值：宿主 floor 优先；显式 unit 与 history 单位不符时不画线也不回退
 * （单位对不上时既有底线的数值同样可疑），只在明细行里展示原值。
 */
export function chartThresholds(
  key: MetricKey,
  insight: MetricInsight | undefined,
  tokenWindow?: number,
): ChartThresholds {
  const floor = insight?.thresholds?.floor
  if (floor && Number.isFinite(floor.value)) {
    if (floor.unit != null && floor.unit !== metricUnit(key)) {
      return { lines: [], source: null }
    }
    return {
      lines: [
        {
          value: floor.value,
          // 单条宿主阈值不带严重度层级，固定按 warn 画；
          // 方向跟随指标语义（电池越低越糟，其余越高越糟）。
          sev: 'warn',
          direction: key === 'battery' ? 'below' : 'above',
        },
      ],
      source: 'supplied',
    }
  }
  const d = defaultFloors(key, tokenWindow)
  return d ? { lines: d, source: 'default' } : { lines: [], source: null }
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
  const t = insight?.thresholds?.[layer]
  if (t && Number.isFinite(t.value)) {
    return `${formatMetricValue(t.value, t.unit ?? metricUnit(key))}（${t.source}）`
  }
  if (layer === 'baseline') {
    return insight?.baseline
      ? `${format(insight.baseline.low)} ~ ${format(insight.baseline.high)}`
      : '未提供'
  }
  if (layer === 'floor') {
    const d = defaultFloors(key, tokenWindow)
    return d
      ? `${format(d[0]!.value)} / ${format(d[1]!.value)}（显示底线）`
      : '未提供'
  }
  return '未提供'
}
