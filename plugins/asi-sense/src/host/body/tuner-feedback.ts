import { randomUUID } from 'node:crypto';
import type { TunerGuard, TuningResult } from './tuner-guard.ts';
import { ALERT_CAP, finiteNum } from './tuner-spec.ts';
import type { TunerStore } from './tuner-state.ts';

export function register(
  store: TunerStore,
  clock: () => number,
  wallClock: () => number,
  alertId: string,
  ruleId: string,
  param: string,
): boolean {
  if (
    typeof alertId !== 'string' ||
    alertId === '' ||
    typeof ruleId !== 'string' ||
    ruleId === '' ||
    !finiteNum(clock()) ||
    !finiteNum(wallClock()) ||
    !store.specs.has(param) ||
    store.alerts.has(alertId)
  )
    return false;
  if (store.alerts.size >= ALERT_CAP) {
    const oldest = store.alerts.keys().next().value as string;
    const binding = store.alerts.get(oldest);
    store.alerts.delete(oldest);
    store.appendLog({
      id: `volatile-${randomUUID()}`,
      param: binding?.param ?? '',
      from: '',
      to: '',
      by: 'auto',
      reason: `alert ${oldest}`,
      at: wallClock(),
      operation: 'feedback',
      status: 'rejected',
      rejectionReason: 'evicted',
    });
  }
  store.alerts.set(alertId, { ruleId, param });
  return true;
}

/** Consumes an alert registration once; three noise streaks auto-tune. */
export function feedback(
  store: TunerStore,
  guard: TunerGuard,
  clock: () => number,
  wallClock: () => number,
  alertId: string,
  verdict: 'useful' | 'noise',
): TuningResult {
  const by = guard.actor() ?? 'agent';
  const binding = store.alerts.get(alertId);
  const badClock = !finiteNum(clock()) || !finiteNum(wallClock());
  if (!binding || (verdict !== 'useful' && verdict !== 'noise') || badClock) {
    return guard.audit({
      param: binding?.param ?? '',
      from: '',
      to: '',
      by,
      reason: `feedback ${String(verdict)}`,
      at: guard.auditAt(),
      operation: 'feedback',
      status: 'rejected',
      rejectionReason: badClock ? 'nonfinite clock' : 'unknown or consumed alert',
    });
  }
  store.alerts.delete(alertId);
  const result = guard.audit({
    param: binding.param,
    from: verdict,
    to: verdict,
    by,
    reason: `feedback ${verdict} on ${alertId}`,
    at: guard.auditAt(),
    operation: 'feedback',
    status: 'applied',
  });
  const streak = verdict === 'useful' ? 0 : (store.noise.get(binding.ruleId) ?? 0) + 1;
  store.noise.set(binding.ruleId, streak);
  if (streak < 3) return result;
  store.noise.set(binding.ruleId, 0);
  const spec = store.specs.get(binding.param);
  const current = store.values.get(binding.param);
  const dir = spec?.noiseDirection;
  if (dir && typeof current === 'number' && finiteNum(current)) {
    guard.attempt(
      'propose',
      binding.param,
      current * (dir === 'up' ? 1.25 : 0.8),
      `auto: 3 consecutive noise on ${binding.ruleId}`,
      'auto',
    );
  } else {
    guard.audit({
      param: binding.param,
      from: current ?? '',
      to: current ?? '',
      by: 'auto',
      reason: `auto: no noise policy for ${binding.param}`,
      at: guard.auditAt(),
      operation: 'propose',
      status: 'rejected',
      rejectionReason: 'no noise policy',
    });
  }
  return result;
}
