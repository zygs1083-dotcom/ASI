import path from 'node:path';
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
export function globToRegExp(pattern: string): RegExp {
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

/** `/w` itself plus everything below it. */
function subtreeRegExp(dir: string): RegExp {
  const escaped = (dir === '/' ? '' : dir).replace(REGEX_SPECIALS, '\\$&');
  return new RegExp(`^${escaped}(?:/.*)?$`);
}

/** The glob pattern `P` itself and everything below it (`P` may contain wildcards). */
function dirBoundaryRegExp(pattern: string): RegExp {
  const inner = globToRegExp(pattern).source;
  return new RegExp(`${inner.slice(0, -1)}(?:/.*)?$`);
}

/**
 * The normalized literal root a subject pattern lives under: the pattern
 * itself when literal, else the directory above the first wildcard.
 * `file.burst` signals carry this as their `subject` — never a trailing `/`.
 */
export function watchRootOf(subject: string): string | undefined {
  if (!path.isAbsolute(subject)) return undefined;
  const wildcard = subject.search(/[*?]/);
  if (wildcard < 0) {
    const normalized = path.normalize(subject).replace(/[/]+$/, '');
    return normalized || '/';
  }
  const prefix = subject.slice(0, wildcard);
  if (!prefix.includes('/')) return '/';
  const base = prefix.endsWith('/') ? path.normalize(prefix) : path.dirname(prefix);
  const normalized = base.replace(/[/]+$/, '');
  return normalized || '/';
}

/**
 * The set of paths a file rule legitimately observes — a literal path or a
 * `<literal-dir>/**` subject covers the whole subtree (dir semantics), any
 * other wildcard subject is limited to its own matchable set: single-level
 * globs see direct children only, in-segment prefix wildcards see only
 * matching first-level entries, and `/**`-containing globs see only their
 * glob's own matches. A rule can never observe outside this set.
 */
export function subjectScope(subject: string): RegExp | undefined {
  const pattern = path.normalize(subject);
  if (!path.isAbsolute(pattern)) return undefined;
  if (!/[*?]/.test(pattern)) return subtreeRegExp(pattern.replace(/[/]+$/, '') || '/');
  if (pattern.endsWith('/**')) {
    const base = pattern.slice(0, -3);
    if (!/[*?]/.test(base)) return subtreeRegExp(base || '/');
  }
  return globToRegExp(pattern);
}

/**
 * Whether the subject's scope can reach below the watch root's first level:
 * literal dirs and any subject containing `**` or a wildcard in a non-last
 * segment need a recursive native watcher; single-level globs do not.
 */
export function subjectNeedsDeep(subject: string): boolean {
  const pattern = path.normalize(subject);
  if (!/[*?]/.test(pattern)) return true;
  return /\*\*/.test(pattern) || pattern.search(/[*?]/) < pattern.lastIndexOf('/');
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

/** Plain object = `Object.prototype` or null prototype (JSON-compatible). */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
}

/** Ordered comparisons only take finite-number operands, like the matcher. */
const ORDERED_OPS: ReadonlySet<string> = new Set(['>', '>=', '<', '<=']);

function validateWhere(where: Record<string, unknown>, path: string, errors: string[]): void {
  for (const [key, expected] of Object.entries(where)) {
    const at = `${path}.${key}`;
    if (validPrim(expected)) continue; // literal equality
    if (!isPlainObject(expected)) {
      errors.push(`${at}: expected a primitive or {op: operand} comparator`);
      continue;
    }
    const entries = Object.entries(expected);
    if (entries.length === 0) {
      errors.push(`${at}: empty comparator object`);
      continue;
    }
    for (const [op, operand] of entries) {
      if (!OPERATORS.has(op)) {
        errors.push(`${at}: unknown operator ${JSON.stringify(op)}`);
      } else if (!validPrim(operand) || (ORDERED_OPS.has(op) && typeof operand !== 'number')) {
        errors.push(`${at}: invalid operand for ${op}`);
      }
    }
  }
}

/**
 * Runtime validation of a {@link WatchRule}, e.g. one arriving via JSON.
 * Returns the list of violations (empty = valid). `where` must be absent or
 * a plain object — an *empty* object stays a legal unconditional rule —
 * and every condition must be expressible by the fail-closed matcher, so an
 * invalid rule can never widen into a catch-all at match time.
 */
export function validateRule(input: unknown): string[] {
  const errors: string[] = [];
  if (!isPlainObject(input)) return ['rule must be a plain object'];
  const r = input;
  if (typeof r.id !== 'string' || r.id.length === 0) errors.push('id must be a non-empty string');
  if (!isPlainObject(r.match)) {
    errors.push('match must be a plain object');
  } else {
    const m = r.match;
    if (typeof m.kind !== 'string' || m.kind.length === 0) errors.push('match.kind must be a non-empty string');
    if (m.subject !== undefined && typeof m.subject !== 'string') errors.push('match.subject must be a string');
    if (Object.hasOwn(m, 'where')) {
      if (!isPlainObject(m.where)) errors.push('match.where must be a plain object when present');
      else validateWhere(m.where, 'match.where', errors);
    }
  }
  if (r.level !== 'record' && r.level !== 'context' && r.level !== 'wake') {
    errors.push('level must be record | context | wake');
  }
  if (r.note !== undefined && typeof r.note !== 'string') errors.push('note must be a string');
  if (r.createdBy !== 'user' && r.createdBy !== 'agent') errors.push('createdBy must be user | agent');
  if (typeof r.approved !== 'boolean') errors.push('approved must be a boolean');
  if (r.expiresAt !== undefined && (typeof r.expiresAt !== 'number' || !Number.isFinite(r.expiresAt))) {
    errors.push('expiresAt must be a finite number');
  }
  return errors;
}

/**
 * True when `rule` matches `signal` at `now` (expired rules never match).
 * Fully fail closed: a rule that is invalid at runtime — including a
 * `where` that is not a plain object — simply never matches, and no
 * malformed input can make it throw.
 */
export function matchesRule(rule: WatchRule, signal: Signal, now: number): boolean {
  if (validateRule(rule).length > 0 || !isPlainObject(signal)) return false;
  if (rule.expiresAt !== undefined && now >= rule.expiresAt) return false;
  if (rule.match.kind !== signal.kind) return false;
  if (rule.match.subject !== undefined) {
    const pattern = path.normalize(rule.match.subject);
    const subject = signal.subject;
    let matched = typeof subject === 'string' && globToRegExp(pattern).test(subject);
    // A file.burst subject is a normalized watch root (e.g. `/w`), which the
    // raw glob misses for `<dir>/`, `<dir>/*`, `<dir>/**` and `<dir>/pkg-*/**`
    // spellings: compare the pattern's own watch root, plus a boundary-
    // inclusive `P/**` scope so deeper burst roots inside `P` still match.
    if (!matched && signal.kind === 'file.burst' && typeof subject === 'string') {
      matched =
        watchRootOf(pattern) === subject ||
        (pattern.endsWith('/**') && dirBoundaryRegExp(pattern.slice(0, -3) || '/').test(subject));
    }
    if (!matched) return false;
  }
  if (rule.match.where !== undefined) {
    const data = isPlainObject(signal.data) ? signal.data : {};
    for (const [key, expected] of Object.entries(rule.match.where)) {
      if (!Object.hasOwn(data, key) || !matchWhere(data[key], expected)) {
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
