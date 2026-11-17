import type { WatchRule } from '@asi/sense-types';
import { describe, expect, it } from 'vitest';
import {
  createWatchRule,
  DEFAULT_RULES,
  isRuleApproved,
  matchesRule,
  selectRule,
} from '../src/host/attention/rules.ts';
import { sig } from './helpers.ts';

function rule(partial: Partial<WatchRule> & Pick<WatchRule, 'id'>): WatchRule {
  return createWatchRule({
    match: { kind: 'k' },
    level: 'context',
    createdBy: 'user',
    ...partial,
  });
}

describe('matchesRule', () => {
  it('requires exact kind', () => {
    const r = rule({ id: 'r', match: { kind: 'file.changed' } });
    expect(matchesRule(r, sig({ id: '1', kind: 'file.changed' }), 0)).toBe(true);
    expect(matchesRule(r, sig({ id: '2', kind: 'file.x' }), 0)).toBe(false);
  });

  it('supports subject globs *, **, ?', () => {
    const mk = (subject: string) => rule({ id: 'r', match: { kind: 'k', subject } });
    const s = (subject: string) => sig({ id: '1', kind: 'k', subject });
    expect(matchesRule(mk('/src/*.ts'), s('/src/a.ts'), 0)).toBe(true);
    expect(matchesRule(mk('/src/*.ts'), s('/src/deep/a.ts'), 0)).toBe(false);
    expect(matchesRule(mk('/src/**'), s('/src/deep/a.ts'), 0)).toBe(true);
    expect(matchesRule(mk('/src/**/*.ts'), s('/src/a.ts'), 0)).toBe(true);
    expect(matchesRule(mk('/src/a?.ts'), s('/src/ab.ts'), 0)).toBe(true);
    expect(matchesRule(mk('/src/a?.ts'), s('/src/axb.ts'), 0)).toBe(false);
    expect(matchesRule(mk('/src/a.b'), s('/src/a.b'), 0)).toBe(true);
    expect(matchesRule(mk('*.log'), s('x.log'), 0)).toBe(true);
  });

  it('matches a file.burst recursive directory glob at its directory without widening other kinds', () => {
    const burst = rule({
      id: 'burst',
      match: { kind: 'file.burst', subject: '/src/**', where: { deleted: { '>': 50 } } },
      expiresAt: 100,
    });
    const event = (subject: string, deleted = 51) => sig({ id: '1', kind: 'file.burst', subject, data: { deleted } });
    expect(matchesRule(burst, event('/src'), 99)).toBe(true);
    expect(matchesRule(burst, event('/src/sub'), 99)).toBe(true);
    expect(matchesRule(burst, event('/src-other'), 99)).toBe(false);
    expect(matchesRule(burst, event('/src', 50), 99)).toBe(false);
    expect(matchesRule(burst, event('/src'), 100)).toBe(false);
    const changed = rule({ id: 'changed', match: { kind: 'file.changed', subject: '/src/**' } });
    expect(matchesRule(changed, sig({ id: '2', kind: 'file.changed', subject: '/src' }), 0)).toBe(false);
    expect(matchesRule(changed, sig({ id: '3', kind: 'file.changed', subject: '/src/a' }), 0)).toBe(true);
  });

  it('matches a normalized file.burst root across literal, slash, glob and prefix spellings', () => {
    const burstAt = (subject: string) => sig({ id: 'b', kind: 'file.burst', subject });
    const mk = (subject: string) => rule({ id: 'r', match: { kind: 'file.burst', subject } });
    // All these spellings root at /dir; the emitted subject is the
    // normalized root — never a trailing slash.
    for (const subject of ['/dir', '/dir/', '/dir/**', '/dir/*', '/dir/pkg-*/**']) {
      expect(matchesRule(mk(subject), burstAt('/dir'), 0)).toBe(true);
    }
    // Bursts at a nested root stay inside each spelling's own matchable set —
    // `/dir/sub` is itself a direct child match for `/dir/*`.
    expect(matchesRule(mk('/dir/*'), burstAt('/dir/sub'), 0)).toBe(true);
    expect(matchesRule(mk('/dir/pkg-*/**'), burstAt('/dir/pkg-a'), 0)).toBe(true);
    expect(matchesRule(mk('/dir/pkg-*/**'), burstAt('/dir/other'), 0)).toBe(false);
    expect(matchesRule(mk('/dir/**'), burstAt('/other'), 0)).toBe(false);
  });

  it('supports literal and comparison where clauses', () => {
    const s = sig({ id: '1', kind: 'k', data: { exitCode: 1, name: 't' } });
    expect(
      matchesRule(
        rule({
          id: 'r',
          match: { kind: 'k', where: { exitCode: { '!=': 0 } } },
        }),
        s,
        0,
      ),
    ).toBe(true);
    expect(matchesRule(rule({ id: 'r', match: { kind: 'k', where: { exitCode: 0 } } }), s, 0)).toBe(false);
    expect(
      matchesRule(
        rule({
          id: 'r',
          match: { kind: 'k', where: { exitCode: { '>': 0 } } },
        }),
        s,
        0,
      ),
    ).toBe(true);
    expect(
      matchesRule(
        rule({
          id: 'r',
          match: { kind: 'k', where: { exitCode: { '>=': 1 } } },
        }),
        s,
        0,
      ),
    ).toBe(true);
    expect(
      matchesRule(
        rule({
          id: 'r',
          match: { kind: 'k', where: { exitCode: { '<': 2, '>': 5 } } },
        }),
        s,
        0,
      ),
    ).toBe(false);
    expect(matchesRule(rule({ id: 'r', match: { kind: 'k', where: { name: 't' } } }), s, 0)).toBe(true);
    expect(
      matchesRule(
        rule({
          id: 'r',
          match: { kind: 'k', where: { exitCode: { '==': 1 } } },
        }),
        s,
        0,
      ),
    ).toBe(true);
  });

  it('fails closed on missing fields, wrong types and unknown operators', () => {
    const s = sig({ id: '1', kind: 'k', data: { exitCode: 'x' } });
    expect(
      matchesRule(
        rule({
          id: 'r',
          match: { kind: 'k', where: { exitCode: { '!=': 0 } } },
        }),
        s,
        0,
      ),
    ).toBe(false);
    expect(
      matchesRule(
        rule({
          id: 'r',
          match: { kind: 'k', where: { exitCode: { '>': 0 } } },
        }),
        s,
        0,
      ),
    ).toBe(false);
    expect(
      matchesRule(
        rule({
          id: 'r',
          match: { kind: 'k', where: { missing: { '!=': 0 } } },
        }),
        s,
        0,
      ),
    ).toBe(false);
    expect(
      matchesRule(
        rule({
          id: 'r',
          match: { kind: 'k', where: { exitCode: { '~': 1 } } },
        }),
        s,
        0,
      ),
    ).toBe(false);
    expect(matchesRule(rule({ id: 'r', match: { kind: 'k', where: {} } }), s, 0)).toBe(true);
  });

  it('fails closed on NaN, inherited fields and non-primitive values', () => {
    const ne = rule({
      id: 'r',
      match: { kind: 'k', where: { exitCode: { '!=': 0 } } },
    });
    // NaN is non-finite: must not pass even '!='
    expect(matchesRule(ne, sig({ id: '1', kind: 'k', data: { exitCode: NaN } }), 0)).toBe(false);
    // objects/arrays/functions never satisfy comparisons or equality
    for (const v of [{}, [], () => 1, undefined] as const) {
      expect(matchesRule(ne, sig({ id: '2', kind: 'k', data: { exitCode: v } }), 0)).toBe(false);
    }
    // inherited data properties are invisible
    const inherited = sig({
      id: '3',
      kind: 'k',
      data: Object.create({ exitCode: 1 }),
    });
    expect(matchesRule(ne, inherited, 0)).toBe(false);
    // null only equals null
    expect(
      matchesRule(
        rule({ id: 'r2', match: { kind: 'k', where: { exitCode: null } } }),
        sig({ id: '4', kind: 'k', data: { exitCode: null } }),
        0,
      ),
    ).toBe(true);
    expect(matchesRule(ne, sig({ id: '5', kind: 'k', data: { exitCode: null } }), 0)).toBe(false);
  });

  it('excludes expired rules (now >= expiresAt)', () => {
    const r = rule({ id: 'r', expiresAt: 100 });
    expect(matchesRule(r, sig({ id: '1', kind: 'k' }), 99)).toBe(true);
    expect(matchesRule(r, sig({ id: '1', kind: 'k' }), 100)).toBe(false);
  });
});

describe('selectRule', () => {
  it('picks the highest level; first matching rule wins ties', () => {
    const s = sig({ id: '1', kind: 'k' });
    const rules = [
      rule({ id: 'ctx1', level: 'context' }),
      rule({ id: 'w1', level: 'wake' }),
      rule({ id: 'w2', level: 'wake' }),
      rule({ id: 'rec', level: 'record' }),
    ];
    expect(selectRule(rules, s, 0)?.id).toBe('w1');
    expect(selectRule([rules[3], rules[0]], s, 0)?.id).toBe('ctx1');
    expect(selectRule([], s, 0)).toBeUndefined();
  });

  it('ranks unapproved wake as context so it cannot mask an approved wake', () => {
    const s = sig({ id: '1', kind: 'k' });
    const pending = rule({
      id: 'pending',
      level: 'wake',
      createdBy: 'agent',
    });
    const approved = rule({ id: 'ok', level: 'wake' });
    expect(selectRule([pending, approved], s, 0)?.id).toBe('ok');
    expect(selectRule([approved, pending], s, 0)?.id).toBe('ok');
  });
});

describe('rule approval', () => {
  it('defaults to createdBy: user approved, agent pending', () => {
    expect(isRuleApproved(rule({ id: 'u', createdBy: 'user' }))).toBe(true);
    expect(isRuleApproved(rule({ id: 'a', createdBy: 'agent' }))).toBe(false);
    expect(isRuleApproved(rule({ id: 'a2', createdBy: 'agent', approved: true }))).toBe(true);
    expect(isRuleApproved(rule({ id: 'u2', createdBy: 'user', approved: false }))).toBe(false);
  });

  it('createWatchRule applies the approval default once', () => {
    const user = createWatchRule({
      id: 'u',
      match: { kind: 'k' },
      level: 'wake',
      createdBy: 'user',
    });
    const agent = createWatchRule({
      id: 'a',
      match: { kind: 'k' },
      level: 'wake',
      createdBy: 'agent',
    });
    const agentConfirmed = createWatchRule({ ...agent, approved: true });
    expect(user.approved).toBe(true);
    expect(agent.approved).toBe(false);
    expect(agentConfirmed.approved).toBe(true);
    // every default-table rule is already approved
    expect(DEFAULT_RULES.every((r) => r.approved)).toBe(true);
  });
});

describe('DEFAULT_RULES', () => {
  it('implements the design table', () => {
    const at = 0;
    const sel = (s: Parameters<typeof selectRule>[1]) => selectRule(DEFAULT_RULES, s, at);
    expect(sel(sig({ id: '1', kind: 'app.activated' }))?.level).toBe('record');
    expect(sel(sig({ id: '2', kind: 'window.title-changed' }))?.level).toBe('record');
    expect(sel(sig({ id: '3', kind: 'file.changed' }))?.level).toBe('context');
    expect(sel(sig({ id: '4', kind: 'job.exited', data: { exitCode: 1 } }))?.level).toBe('wake');
    expect(sel(sig({ id: '5', kind: 'job.exited', data: { exitCode: 0 } }))?.level).toBe('context');
    expect(sel(sig({ id: '6', kind: 'job.exited' }))?.level).toBe('context'); // no catchall wake
    expect(sel(sig({ id: '7', kind: 'process.exited', data: { exitCode: 2 } }))?.level).toBe('wake');
    expect(sel(sig({ id: '8', kind: 'source.status', data: { status: 'denied' } }))?.level).toBe('context');
    expect(sel(sig({ id: '9', kind: 'source.error' }))?.level).toBe('context');
    expect(sel(sig({ id: '10', kind: 'body.threshold', data: { severity: 'warn' } }))?.level).toBe('context');
    expect(
      sel(
        sig({
          id: '11',
          kind: 'body.threshold',
          data: { severity: 'critical' },
        }),
      )?.level,
    ).toBe('wake');
  });
});
