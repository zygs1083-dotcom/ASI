import type { RateRule } from './rate.ts';
import { type AdaptiveState, BODY_HISTORY } from './state.ts';

export function rateEvidence(
  state: AdaptiveState | undefined,
  rules: readonly RateRule[],
  sample: { stream: string; mono: number; wall: number } | undefined,
  metric: string,
) {
  const history = sample && state?.[BODY_HISTORY]?.[sample.stream]?.rate;
  const matching = rules.filter((rule) =>
    rule.metric.endsWith(':*') ? metric.startsWith(rule.metric.slice(0, -1)) : rule.metric === metric,
  );
  const latchKey = (rule: RateRule) => (rule.metric.endsWith(':*') ? `rate:${rule.id}:${metric}` : `rate:${rule.id}`);
  const rule = matching.find((item) => history?.latch[latchKey(item)] === 'warn') ?? matching[0];
  const latched = !!rule && history?.latch[latchKey(rule)] === 'warn';
  const window = history?.windows[metric];
  const evaluationMono =
    window && 'evaluationMono' in window && typeof window.evaluationMono === 'number'
      ? window.evaluationMono
      : (history?.lastMono ?? window?.lastMono);
  const points =
    rule && window && evaluationMono !== undefined
      ? window.points
          .filter((point) => point.at >= evaluationMono - rule.windowMs)
          .map((point) => ({
            mono: point.at,
            value: point.value,
          }))
      : [];
  const last = points.at(-1);
  if (!last) return { latched, points };
  const lastRaw = window?.points.at(-1);
  const asOf = lastRaw?.wall ?? (sample?.mono === last.mono ? sample.wall : undefined);
  const meanX = points.reduce((sum, point) => sum + (point.mono - last.mono), 0) / points.length;
  const meanY = points.reduce((sum, point) => sum + point.value, 0) / points.length;
  let sxx = 0;
  let sxy = 0;
  for (const point of points) {
    const x = point.mono - last.mono - meanX;
    sxx += x * x;
    sxy += x * (point.value - meanY);
  }
  const ratePerMinute = (sxy / sxx) * 60_000;
  return {
    latched,
    points,
    ...(asOf === undefined ? {} : { asOf }),
    ...(Number.isFinite(ratePerMinute) ? { ratePerMinute } : {}),
  };
}
