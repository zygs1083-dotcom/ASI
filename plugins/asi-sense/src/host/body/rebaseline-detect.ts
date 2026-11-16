import type { BodyThresholdSample } from '@asi/sense-types';
import type { AnomalyRule } from './anomaly.ts';
import { BASELINE_MIN_COUNT, BASELINE_MIN_DATES } from './baseline.ts';
import { formatter, slotOf } from './baseline-time.ts';
import { type BodySignal, readMetrics } from './metrics.ts';
import {
  type Candidate,
  candidateId,
  expired,
  keyOf,
  ready,
  record,
  suggestionExpired,
} from './rebaseline-candidate.ts';
import { type AdaptiveState, BODY_HISTORY } from './state.ts';

export function detectCandidates(
  next: BodyThresholdSample,
  state: AdaptiveState,
  rules: readonly AnomalyRule[],
  candidates: Map<string, Candidate>,
): BodySignal[] {
  const signals: BodySignal[] = [];
  const metrics = readMetrics(next);
  const elapsed = state[BODY_HISTORY]?.[next.source.id]?.anomaly?.baseline?.elapsed;
  if (elapsed !== undefined) {
    for (const [key, candidate] of candidates) {
      if (
        candidate.stream === next.source.id &&
        (candidate.suggested ? suggestionExpired(candidate, elapsed, next.at) : expired(candidate, elapsed, next.at))
      )
        candidates.delete(key);
    }
  }
  const seen = new Set<string>();
  for (const rule of rules) {
    if (seen.has(rule.metric)) continue;
    seen.add(rule.metric);
    const history = state[BODY_HISTORY]?.[next.source.id]?.anomaly;
    const baseline = history?.baseline;
    const value = metrics.get(rule.metric)?.value;
    const stat = value === undefined ? undefined : baseline?.read(rule.metric, next.at);
    if (baseline && value !== undefined && history?.lastAt === next.monotonicAt) {
      for (const candidate of candidates.values()) {
        if (candidate.stream === next.source.id && candidate.metric === rule.metric)
          candidate.latest = { at: next.at, value, zone: baseline.timeZone };
      }
    }
    if (
      !baseline ||
      value === undefined ||
      !stat ||
      history.lastAt !== next.monotonicAt ||
      stat.count < BASELINE_MIN_COUNT ||
      stat.dates < BASELINE_MIN_DATES
    )
      continue;
    const zone = baseline.timeZone;
    const local = slotOf(formatter(zone), next.at);
    const key = keyOf(next.source.id, rule.metric, local.index);
    if (!rules.some((r) => r.metric === rule.metric && history.latch[`baseline:${r.id}`] === 'warn')) {
      candidates.delete(key);
      continue;
    }
    let candidate = candidates.get(key);
    if (!candidate) {
      if (candidates.size >= 1024) {
        const first = candidates.keys().next().value;
        if (first !== undefined) candidates.delete(first);
      }
      candidate = { stream: next.source.id, metric: rule.metric, slot: local.index, days: [] };
      candidates.set(key, candidate);
    }
    candidate.latest = { at: next.at, value, zone };
    if (candidate.suggested) continue;
    if (!record(candidate, local.date, baseline.elapsed, next.monotonicAt, { at: next.at, value, zone })) continue;
    if (ready(candidate)) {
      candidate.suggested = true;
      signals.push({
        id: `rebaseline:${candidateId(candidate)}`,
        kind: 'body.anomaly',
        at: next.at,
        layer: 'baseline',
        source: next.source,
        subject: `baseline:${rule.metric}`,
        data: {
          layer: 'baseline',
          severity: 'warn',
          type: 'rebaseline-suggestion',
          suggestionId: candidateId(candidate),
        },
      });
    }
  }
  return signals;
}
