import { createContext, useContext } from 'react';
import type { MetricKey } from './view-model';

/**
 * Body 区共享时钟：随 model.now 更新，让事实年龄等
 * 纯时间显示自行前进，不必重渲外层 memo 化的指标卡片。
 * Body 之外（单测、其他面板）回退到组件 props 传入的 now。
 */
const ClockCtx = createContext<number | null>(null);
const SamplingCtx = createContext<{ paused: boolean; intervals?: Partial<Record<MetricKey, number>> }>({
  paused: false,
});

export const ClockProvider = ClockCtx.Provider;
export const SamplingProvider = SamplingCtx.Provider;

export function useClock(fallback: number): number {
  return useContext(ClockCtx) ?? fallback;
}

export function useSampling(metric?: MetricKey, override?: number): { paused: boolean; interval: number } {
  const { paused, intervals } = useContext(SamplingCtx);
  const value = override ?? (metric ? intervals?.[metric] : undefined);
  const fallback =
    metric?.startsWith('disk:') || metric?.startsWith('diskFree:') ? 10_000 : metric === 'battery' ? 30_000 : 2000;
  return { paused, interval: value && Number.isFinite(value) && value > 0 ? value : fallback };
}
