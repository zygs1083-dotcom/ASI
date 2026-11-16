import type { DeliveryLevel, EnvChange, Signal, WatchRule } from '@asi/sense-types';
import type { BucketDrain } from './drain.ts';
import type { SessionContext, SessionState } from './pipeline-types.ts';
import { isRuleApproved, selectRule } from './rules.ts';
import { sourceMarkSeen } from './source-mark.ts';

const DEDUP_MAX = 1024;

/** All mutable accept intake — runs inside the store's apply callback (FIFO). */
export function intake(
  s: SessionState,
  ev: Signal,
  session: SessionContext,
  now: number,
  count: number,
  other: boolean,
  rules: WatchRule[],
  wallClock: () => number,
  drain: BucketDrain,
  mergeWindowMs: number,
  fileMergeWindowMs: number,
): EnvChange {
  s.context = session;
  const change: EnvChange = { signal: ev, count: 1, level: 'record' };
  if (isDuplicate(s, ev.id)) {
    change.reason = 'duplicate';
  } else {
    const repeatedStatus = sourceMarkSeen(s, ev);
    if (ev.cause === 'agent') {
      change.reason = 'self-caused';
    } else {
      const rule = selectRule(rules, ev, wallClock());
      if (other) ev.kind = 'other';
      let level: DeliveryLevel = rule?.level ?? 'record';
      let reason: string | undefined;
      if (level === 'wake' && rule && !isRuleApproved(rule)) {
        level = 'context';
        reason = 'rule-pending-approval';
      }
      if ((ev.kind === 'source.status' || ev.kind === 'source.error') && repeatedStatus) {
        level = 'record';
      }
      change.level = level;
      if (rule) {
        change.ruleId = rule.id;
        if (rule.note !== undefined) change.note = rule.note;
      }
      if (reason !== undefined) change.reason = reason;
      if (level !== 'record') {
        const win = ev.kind === 'file.changed' ? fileMergeWindowMs : mergeWindowMs;
        drain.enqueue(ev, session.id, level, rule, reason, now, win, count);
      }
    }
  }
  return structuredClone(change);
}

function isDuplicate(s: SessionState, id: string): boolean {
  if (s.seenIds.has(id)) return true;
  s.seenIds.add(id);
  s.seenOrder.push(id);
  if (s.seenOrder.length > DEDUP_MAX) s.seenIds.delete(s.seenOrder.shift() as string);
  return false;
}
