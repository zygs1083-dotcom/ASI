/** 数字与时间格式化，统一走 Intl zh-CN。 */

import type { DetailUnit as DeltaUnit } from './view-model';

const intFmt = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 });
const oneDecimal = new Intl.NumberFormat('zh-CN', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const minuteFmt = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
const timeFmt = new Intl.DateTimeFormat('zh-CN', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});
const dateTimeFmt = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});
const preciseFmt = new Intl.NumberFormat('zh-CN', {
  maximumSignificantDigits: 21,
});

export function formatPercent(ratio: number): string {
  return `${intFmt.format(Math.round(ratio * 100))}%`;
}

export function formatBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3;
  if (gb >= 1) return `${oneDecimal.format(gb)} GB`;
  const mb = bytes / 1024 ** 2;
  if (mb >= 1) return `${intFmt.format(Math.round(mb))} MB`;
  return `${intFmt.format(Math.round(bytes / 1024))} KB`;
}

/** token 计数：>=10k 用 k 缩写（如 12.3k），否则原值。 */
export function formatTokens(n: number): string {
  if (n >= 10_000) return `${oneDecimal.format(n / 1000)}k`;
  return intFmt.format(n);
}

export function formatRate(bps: number): string {
  const mbps = bps / 1024 ** 2;
  if (mbps >= 1) return `${oneDecimal.format(mbps)} MB/s`;
  return `${intFmt.format(Math.round(bps / 1024))} KB/s`;
}

/** 相对年龄：1 小时内按秒粒度（"N 秒前"），更长按小时。 */
export function formatAge(now: number, at: number): string {
  const sec = Math.max(0, Math.round((now - at) / 1000));
  if (sec < 5) return '刚刚';
  if (sec < 3600) return `${sec} 秒前`;
  return `${Math.floor(sec / 3600)} 小时前`;
}

export function formatCount(n: number): string {
  return intFmt.format(n);
}

/** 系统负载等一位小数的数值。 */
export function formatLoad(n: number): string {
  return oneDecimal.format(n);
}

/** 0..100 的百分值（区别于 0..1 的 formatPercent）。 */
export function formatPercentValue(n: number): string {
  return `${intFmt.format(Math.round(n))}%`;
}

/** 按单位格式化指标数值（事件 detail、异常对比共用）。 */
export function formatMetricValue(v: number, unit: DeltaUnit): string {
  if (unit === 'bytes/s') return formatRate(v);
  if (unit.endsWith('/s') || unit.endsWith('/min')) {
    const base = unit.slice(0, unit.indexOf('/')) as DeltaUnit;
    const per = unit.endsWith('/min') ? '/分' : '/s';
    return `${formatMetricValue(v, base)}${per}`;
  }
  switch (unit) {
    case 'bytes':
      return formatBytes(v);
    case 'ratio':
      return formatPercent(v);
    case 'tokens':
      return formatTokens(v);
    case 'count':
      return formatCount(v);
    default:
      return String(v);
  }
}

/** 带符号的指标变化量，如 −2.1 GB / +18%。 */
export function formatSignedDelta(delta: number, unit: DeltaUnit): string {
  const sign = delta > 0 ? '+' : delta < 0 ? '−' : '';
  return `${sign}${formatMetricValue(Math.abs(delta), unit)}`;
}

/** 调整日志的参数值：数字精确输出（0.85 ≠ 0.9），字符串原样，附带单位。 */
export function formatTuningValue(v: number | string, unit?: string): string {
  const text = typeof v === 'number' ? preciseFmt.format(v) : v;
  return unit ? `${text} ${unit}` : text;
}

/** 温控历史序数（0..3）→ 文案。 */
export function formatThermalOrdinal(v: number): string {
  return ['正常', '偏高', '偏高', '过热'][Math.max(0, Math.min(3, Math.round(v)))]!;
}

export function formatClock(at: number): string {
  return timeFmt.format(new Date(at));
}

/** 分钟级时刻（事件分组标题用，秒位省略）。 */
export function formatMinute(at: number): string {
  return minuteFmt.format(new Date(at));
}

/** 日历日期 + 时分秒，用于跨天的调整日志时间。 */
export function formatTimestamp(at: number): string {
  return dateTimeFmt.format(new Date(at));
}

export function formatDuration(totalSec: number): string {
  if (!Number.isFinite(totalSec)) return '未知';
  const sec = Math.max(0, Math.round(totalSec));
  // 显示上限 7 天：更长的跨度以「7 天以上」封顶，不堆天文数字。
  if (sec > 7 * 86_400) return '7 天以上';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h} 小时 ${m} 分`;
  if (m > 0) return `${m} 分 ${sec % 60} 秒`;
  return `${sec} 秒`;
}

/** 分钟级估算的显示上限（7 天）。 */
export const MAX_DISPLAY_MINUTES = 7 * 24 * 60;

export function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('zh-CN', {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}
