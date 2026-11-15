import type { DeliveryLevel, Signal, WatchRule } from '@asi/sense-types';

/** Ordering of delivery levels for rule priority. */
export const LEVEL_RANK: Record<DeliveryLevel, number> = {
  record: 0,
  context: 1,
  wake: 2,
};

const OPERATORS: ReadonlySet<string> = new Set(['==', '!=', '>', '>=', '<', '<=']);

const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;

/**
 * Converts a subject glob to a RegExp. `*` matches any run of non-`/`
 * characters, `**` matches across `/`, `?` matches a single non-`/` char.
 * Everything else is literal.
 */
function globToRegExp(pattern: string): RegExp {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i] as string;
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        const directory = pattern[i + 2] === '/';
        re += directory ? '(?:.*/)?' : '.*';
        i += directory ? 2 : 1;
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else {
      re += ch.replace(REGEX_SPECIALS, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

/** Valid `where` operand: null, or a finite number, string or boolean. */
function validPrim(v: unknown): v is number | string | boolean | null {
  return v === null || typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));
}

function compare(actual: unknown, op: string, expected: unknown): boolean {
  if (!validPrim(actual) || !validPrim(expected) || typeof actual !== typeof expected) {
    return false;
  }
  if (op === '==') return actual === expected;
  if (op === '!=') return actual !== expected;
  if (typeof actual !== 'number' || typeof expected !== 'number') return false;
  switch (op) {
    case '>':
      return actual > expected;
    case '>=':
      return actual >= expected;
    case '<':
      return actual < expected;
    case '<=':
      return actual <= expected;
    default:
      return false;
  }
}

/**
 * `where` clause evaluation — fully fail closed. A primitive expected value
 * means literal equality (`null` only equals `null`); a plain object means a
 * comparison `{op: operand}` (all entries ANDed, ops: ==, !=, >, >=, <, <=).
 * Comparisons require the same primitive type on both sides; ordered
 * comparisons require numbers. Missing/inherited fields, objects, arrays,
 * functions, non-finite numbers, undefined, empty comparison objects and
 * unknown operators all fail closed.
 */
function matchWhere(actual: unknown, expected: unknown): boolean {
  if (expected !== null && typeof expected === 'object' && !Array.isArray(expected)) {
    const entries = Object.entries(expected as Record<string, unknown>);
    if (entries.length === 0) return false;
    return entries.every(([op, operand]) => OPERATORS.has(op) && compare(actual, op, operand));
  }
  return validPrim(actual) && validPrim(expected) && actual === expected;
}

/** True when `rule` matches `signal` at `now` (expired rules never match). */
export function matchesRule(rule: WatchRule, signal: Signal, now: number): boolean {
  if (rule.expiresAt !== undefined && now >= rule.expiresAt) return false;
  if (rule.match.kind !== signal.kind) return false;
  if (rule.match.subject !== undefined && !globToRegExp(rule.match.subject).test(signal.subject)) {
    return false;
  }
  if (rule.match.where) {
    for (const [key, expected] of Object.entries(rule.match.where)) {
      if (!Object.hasOwn(signal.data, key) || !matchWhere(signal.data[key], expected)) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Creates a {@link WatchRule} applying the approval default:
 * `input.approved ?? input.createdBy === 'user'` — user-created rules are
 * approved, agent-proposed rules start pending.
 */
export function createWatchRule(input: Omit<WatchRule, 'approved'> & { approved?: boolean }): WatchRule {
  return { ...input, approved: input.approved ?? input.createdBy === 'user' };
}

/** Effective approval of a rule: the required `approved` flag. */
export function isRuleApproved(rule: WatchRule): boolean {
  return rule.approved;
}

/** Level used for ranking: an unapproved `wake` ranks as `context`. */
function effectiveLevel(rule: WatchRule): DeliveryLevel {
  return rule.level === 'wake' && !rule.approved ? 'context' : rule.level;
}

/**
 * Picks the matching rule with the highest *effective* level (`wake` >
 * `context` > `record`, unapproved wakes ranked as context so they cannot
 * mask an approved wake). On ties the earliest rule in the list wins.
 */
export function selectRule(rules: readonly WatchRule[], signal: Signal, now: number): WatchRule | undefined {
  let best: WatchRule | undefined;
  for (const rule of rules) {
    if (!matchesRule(rule, signal, now)) continue;
    if (!best || LEVEL_RANK[effectiveLevel(rule)] > LEVEL_RANK[effectiveLevel(best)]) {
      best = rule;
    }
  }
  return best;
}

const def = (id: string, match: WatchRule['match'], level: DeliveryLevel): WatchRule =>
  createWatchRule({ id, match, level, createdBy: 'user' });

/** Built-in attention table (DESIGN §2.3). */
export const DEFAULT_RULES: readonly WatchRule[] = [
  def('app-activity', { kind: 'app.activated' }, 'record'),
  def('window-activity', { kind: 'window.focused' }, 'record'),
  def('window-title', { kind: 'window.title-changed' }, 'record'),
  def('watched-file', { kind: 'file.changed' }, 'context'),
  def('job-failed', { kind: 'job.exited', where: { exitCode: { '!=': 0 } } }, 'wake'),
  def('job-done', { kind: 'job.exited' }, 'context'),
  def('process-failed', { kind: 'process.exited', where: { exitCode: { '!=': 0 } } }, 'wake'),
  def('process-done', { kind: 'process.exited' }, 'context'),
  def('source-denied', { kind: 'source.status', where: { status: 'denied' } }, 'context'),
  def('source-errored', { kind: 'source.status', where: { status: 'error' } }, 'context'),
  def('source-error', { kind: 'source.error' }, 'context'),
  def('body-warn', { kind: 'body.threshold', where: { severity: 'warn' } }, 'context'),
  def('body-critical', { kind: 'body.threshold', where: { severity: 'critical' } }, 'wake'),
];
