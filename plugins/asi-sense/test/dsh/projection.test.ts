import { describe, expect, it } from 'vitest';
import { modelText, modelTitle } from '../../src/host/dsh/tool-output.ts';

describe('bounded model projections', () => {
  const cases = [
    ['CJK', '汉'.repeat(20_000)],
    ['a.', 'a.'.repeat(10_000)],
    ['a:', 'a:'.repeat(10_000)],
    ['/a', '/a'.repeat(10_000)],
    ['a@', 'a@'.repeat(10_000)],
  ] as const;

  it.each(cases)('projects 20,000 characters of %s within 50ms', (name, value) => {
    for (const [label, project] of [
      ['title', modelTitle],
      ['text', modelText],
    ] as const) {
      const start = performance.now();
      project(value, 'fixture-host');
      const elapsed = performance.now() - start;
      console.log(`projection ${name} ${label}: ${elapsed.toFixed(2)}ms`);
      expect(elapsed).toBeLessThanOrEqual(50);
    }
  });

  it.each(['汉', 'a.', 'a:', '/a', 'a@'])('projects full-length %s inputs within 50ms', (unit) => {
    for (const [label, project, limit] of [
      ['title', modelTitle, 512],
      ['text', modelText, 32_768],
    ] as const) {
      const value = unit.repeat(limit / unit.length);
      const start = performance.now();
      project(value, 'fixture-host');
      const elapsed = performance.now() - start;
      console.log(`projection full ${unit} ${label}: ${elapsed.toFixed(2)}ms`);
      expect(elapsed).toBeLessThanOrEqual(50);
    }
  });

  it.each([
    ['title', modelTitle, 512],
    ['text', modelText, 32_768],
  ] as const)('discards a cut host, endpoint or path in %s', (_label, project, limit) => {
    for (const length of [2, 4, 8, 16]) {
      const prefix = 'x '.repeat((limit - length) / 2);
      for (const token of [
        'secret-host.invalid',
        'https://secret-host.invalid/file',
        '/private/secret-file',
        'src/private/secret-file',
        'user@secret-host.invalid',
        '[2001:db8::1]:22/private/file',
      ]) {
        expect(project(`${prefix}${token}`, 'secret-host.invalid')).toBe(prefix);
      }
    }
    const prefix = 'x '.repeat((limit - 2) / 2);
    expect(project(`${prefix}ok rest`, 'secret-host.invalid')).toBe(`${prefix}ok`);
  });

  it('retains a complete title token at the limit', () => {
    expect(modelTitle('汉'.repeat(512), 'fixture-host')).toBe('汉'.repeat(512));
  });
});
