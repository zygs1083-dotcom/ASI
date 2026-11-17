import { describe, expect, it } from 'vitest';
import {
  formatAge,
  formatBytes,
  formatClock,
  formatDuration,
  formatMetricValue,
  formatMoney,
  formatPercent,
  formatRate,
  formatTimestamp,
  formatTokens,
  formatTuningValue,
} from '../../src/format';
import { T0 } from '../../src/mock/fixtures';

describe('format', () => {
  it('百分比', () => {
    expect(formatPercent(0)).toBe('0%');
    expect(formatPercent(0.346)).toBe('35%');
    expect(formatPercent(1)).toBe('100%');
  });

  it('字节', () => {
    expect(formatBytes(32e9)).toBe('29.8 GB');
    expect(formatBytes(512e6)).toBe('488 MB');
    expect(formatBytes(2_048)).toBe('2 KB');
  });

  it('token 计数', () => {
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(12_800)).toBe('12.8k');
    expect(formatTokens(128_000)).toBe('128.0k');
  });

  it('速率', () => {
    expect(formatRate(512_000)).toBe('500 KB/s');
    expect(formatRate(2.5e6)).toBe('2.4 MB/s');
  });

  it('年龄', () => {
    expect(formatAge(T0, T0 - 2_000)).toBe('刚刚');
    expect(formatAge(T0, T0 - 30_000)).toBe('30 秒前');
    expect(formatAge(T0, T0 - 5 * 60_000)).toBe('300 秒前');
    expect(formatAge(T0, T0 - 2 * 3_600_000)).toBe('2 小时前');
  });

  it('时刻与时长', () => {
    expect(formatClock(T0)).toMatch(/\d{2}:\d{2}:\d{2}/);
    expect(formatDuration(59)).toBe('59 秒');
    expect(formatDuration(125)).toBe('2 分 5 秒');
    expect(formatDuration(3_900)).toBe('1 小时 5 分');
  });

  it('金额', () => {
    expect(formatMoney(12.34, 'CNY')).toContain('12.34');
    expect(formatMoney(1.5, 'USD')).toContain('1.50');
    expect(formatMoney(2, '$$')).toBe('2 $$');
  });
});

describe('formatTuningValue', () => {
  it('数字精确输出不取整', () => {
    expect(formatTuningValue(0.85)).toBe('0.85');
    expect(formatTuningValue(0.9)).toBe('0.9');
    expect(formatTuningValue(0.00025)).toBe('0.00025');
    expect(formatTuningValue(4, 'σ')).toBe('4 σ');
    expect(formatTuningValue('auto')).toBe('auto');
  });
});

describe('formatTimestamp', () => {
  it('包含日历日期与时分秒', () => {
    expect(formatTimestamp(1_763_300_000_000)).toMatch(/\d{4}.\d{1,2}.\d{1,2}.+\d{1,2}:\d{2}:\d{2}/);
  });
});

describe('formatDuration 边界', () => {
  it('非有限输入不输出 Infinity/NaN，超过 7 天封顶', () => {
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('未知');
    expect(formatDuration(Number.NaN)).toBe('未知');
    expect(formatDuration(10 * 86_400)).toBe('7 天以上');
    // 7 天以内保持原有粒度，不受影响
    expect(formatDuration(7 * 86_400 - 1)).toBe('167 小时 59 分');
  });
});

describe('formatMetricValue 速率单位', () => {
  it('bytes/s 走速率格式，其余 /s、/分 后缀拼接基础格式', () => {
    expect(formatMetricValue(512_000, 'bytes/s')).toBe('500 KB/s');
    expect(formatMetricValue(2.5e6, 'bytes/s')).toBe('2.4 MB/s');
    expect(formatMetricValue(2 * 1024 ** 3, 'bytes/min')).toBe('2.0 GB/分');
    expect(formatMetricValue(0.5, 'ratio/s')).toBe('50%/s');
    expect(formatMetricValue(0.5, 'ratio/min')).toBe('50%/分');
    expect(formatMetricValue(12_800, 'tokens/s')).toBe('12.8k/s');
    expect(formatMetricValue(500, 'tokens/min')).toBe('500/分');
    expect(formatMetricValue(3, 'count/s')).toBe('3/s');
    expect(formatMetricValue(3, 'count/min')).toBe('3/分');
  });
});
