/** 身体各项指标的阈值与聚合健康度。全部纯函数，时间一律用传入的 now。 */

import { diskFact, diskSeverity, diskUsable, diskValid, effectiveDisks, unavailableMountSet } from './disk-health';
import { effectiveStatus, isUsable, maxSeverity, type Severity } from './fact-status';
import type { Body, Fact, MetricKey } from './view-model';

export {
  diskFact,
  diskSeverity,
  diskUsable,
  diskValid,
  effectiveStatus,
  isUsable,
  maxSeverity,
  type Severity,
  unavailableMountSet,
};

export type BodyRowKey = 'memory' | 'tokens' | 'cpu' | 'disks' | 'battery' | 'thermal' | 'network' | 'process';

export const BODY_ROW_PRIORITY: readonly BodyRowKey[] = [
  'memory',
  'tokens',
  'cpu',
  'disks',
  'battery',
  'thermal',
  'network',
  'process',
];

export const ROW_WARN_SENTENCE: Record<BodyRowKey, string> = {
  memory: '内存紧张',
  tokens: '上下文快满了',
  cpu: 'CPU 负载较高',
  disks: '磁盘空间不足',
  battery: '电量不足',
  thermal: '设备温度偏高',
  network: '网络已断开',
  process: 'DSH 负载较高',
};

export interface RowResult {
  severity: Severity;
  hidden: boolean;
  uncounted?: boolean;
  partial?: boolean;
}

export interface BodyEvaluation {
  severity: Severity;
  sentence: string;
  rows: Record<BodyRowKey, RowResult>;
  partial?: boolean;
}

function unusable(): RowResult {
  return { severity: 'unknown', hidden: false };
}

function evalCpu(body: Body, now: number): RowResult {
  const f = body.cpu;
  if (!isUsable(f, now) || !f.value) return unusable();
  const u = f.value.usage;
  const severity: Severity = u >= 0.9 ? 'critical' : u >= 0.75 ? 'warn' : 'good';
  return { severity, hidden: false };
}

function evalMemory(body: Body, now: number): RowResult {
  const f = body.memory;
  if (!isUsable(f, now) || !f.value) return unusable();
  const { pressure, used, total } = f.value;
  const pressureSev: Severity = pressure === 'critical' ? 'critical' : pressure === 'warn' ? 'warn' : 'good';
  const ratio = total > 0 ? used / total : 0;
  const ratioSev: Severity = ratio >= 0.95 ? 'critical' : ratio >= 0.85 ? 'warn' : 'good';
  return { severity: maxSeverity(pressureSev, ratioSev), hidden: false };
}

function evalDisks(body: Body, now: number): RowResult {
  const f = effectiveDisks(body.disks, now);
  const values = f.value ?? [];
  const fresh = values.filter((d) => d.status === 'ok' && diskValid(d));
  if (fresh.length === 0) return unusable();
  let severity: Severity = 'good';
  for (const d of fresh) {
    severity = maxSeverity(severity, diskSeverity(d.free / d.total));
  }
  const partial = f.indeterminateMounts.length > 0 || values.some((d) => !diskValid(d));
  return { severity, hidden: false, ...(partial ? { partial: true } : {}) };
}

function evalBattery(body: Body, now: number): RowResult {
  const f = body.battery;
  if (effectiveStatus(f, now) === 'ok' && f.value === null) {
    return { severity: 'good', hidden: true };
  }
  if (!isUsable(f, now) || !f.value) return unusable();
  const v = f.value;
  if (v.charging) return { severity: 'good', hidden: false };
  const severity: Severity = v.percent <= 5 ? 'critical' : v.percent <= 15 ? 'warn' : 'good';
  return { severity, hidden: false };
}

function evalThermal(body: Body, now: number): RowResult {
  const f = body.thermal;
  if (!isUsable(f, now) || !f.value) return unusable();
  const t = f.value;
  const severity: Severity = t === 'critical' ? 'critical' : t === 'serious' ? 'warn' : 'good';
  return { severity, hidden: false };
}

function evalNetwork(body: Body, now: number): RowResult {
  const f = body.network;
  if (!isUsable(f, now) || !f.value) return unusable();
  return { severity: f.value.online ? 'good' : 'warn', hidden: false };
}

function evalProcess(body: Body, now: number): RowResult {
  const f = body.harnessProcess;
  if (!isUsable(f, now) || !f.value) return unusable();
  const u = f.value.cpu;
  const severity: Severity = u >= 0.9 ? 'critical' : u >= 0.75 ? 'warn' : 'good';
  return { severity, hidden: false };
}

function evalTokens(body: Body, now: number): RowResult {
  const f = body.tokens;
  if (!isUsable(f, now) || !f.value) return unusable();
  const { contextWindow, contextUsed, contextWindowSource } = f.value;
  if (contextWindowSource === 'fallback') {
    return { severity: 'unknown', hidden: false, uncounted: true };
  }
  if (contextWindow == null || contextWindow <= 0 || contextUsed == null) {
    return unusable();
  }
  const ratio = contextUsed / contextWindow;
  const severity: Severity = ratio >= 0.95 ? 'critical' : ratio >= 0.85 ? 'warn' : 'good';
  return { severity, hidden: false };
}

const ROW_EVALUATORS: Record<BodyRowKey, (body: Body, now: number) => RowResult> = {
  memory: evalMemory,
  tokens: evalTokens,
  cpu: evalCpu,
  disks: evalDisks,
  battery: evalBattery,
  thermal: evalThermal,
  network: evalNetwork,
  process: evalProcess,
};

export function rowMetricKeys(key: BodyRowKey, body: Body, now: number): MetricKey[] {
  switch (key) {
    case 'cpu':
    case 'memory':
    case 'battery':
    case 'thermal':
    case 'tokens':
      return [key];
    case 'network':
      return ['networkRx', 'networkTx'];
    case 'process':
      return ['processCpu', 'processRss'];
    case 'disks':
      return (body.disks.value ?? [])
        .filter((d) => diskUsable(body.disks, d, now))
        .map((d) => `disk:${d.mount}` as const);
  }
}

export function rowFact(key: BodyRowKey, body: Body): Fact<unknown> {
  return {
    cpu: body.cpu,
    memory: body.memory,
    disks: body.disks,
    battery: body.battery,
    thermal: body.thermal,
    network: body.network,
    process: body.harnessProcess,
    tokens: body.tokens,
  }[key];
}

export function evaluateBody(body: Body, now: number): BodyEvaluation {
  const rows = {} as Record<BodyRowKey, RowResult>;
  for (const key of BODY_ROW_PRIORITY) {
    rows[key] = ROW_EVALUATORS[key](body, now);
  }

  let worst: Severity = 'good';
  let hasUnknown = false;
  let partial = false;
  for (const key of BODY_ROW_PRIORITY) {
    const s = rows[key].severity;
    if (s === 'unknown') {
      if (!rows[key].uncounted) hasUnknown = true;
    } else if (s === 'critical') worst = 'critical';
    else if (s === 'warn' && worst !== 'critical') worst = 'warn';
    if (rows[key].partial) partial = true;
  }
  const out = (severity: Severity, sentence: string): BodyEvaluation =>
    partial ? { severity, sentence, rows, partial: true } : { severity, sentence, rows };

  if (worst === 'critical' || worst === 'warn') {
    const key = BODY_ROW_PRIORITY.find((k) => rows[k].severity === worst) ?? 'cpu';
    const sentence = key === 'network' && body.network.value?.online ? '网络流量异常' : ROW_WARN_SENTENCE[key];
    return out(worst, sentence);
  }
  if (hasUnknown) {
    return out('unknown', '数据待补全');
  }
  if (partial) {
    return out('good', '部分 · 数据待补全');
  }
  return out('good', '状态良好');
}
