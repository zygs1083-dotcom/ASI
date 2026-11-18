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
  ] as const)('redacts boundary-spanning secrets before truncating in %s', (label, project, limit) => {
    const tokens = [
      'secret-host.invalid',
      'https://secret-host.invalid/file',
      '/private/secret-file',
      'src/private/secret-file',
      'user@secret-host.invalid',
      '[2001:db8::1]:22/private/file',
    ] as const;
    for (const length of [2, 4, 8, 16]) {
      const prefix = 'x '.repeat((limit - length) / 2);
      for (const token of tokens) {
        const result = project(`${prefix}${token}`, 'secret-host.invalid');
        expect(Array.from(result).length).toBeLessThanOrEqual(limit);
        expect(result).not.toContain('secret-host');
        if (label === 'title') {
          expect(result).not.toContain('/private/');
          expect(result).not.toContain('user@');
          expect(result).not.toContain('2001:db8::1');
          const placeholderFits = length >= 6;
          if (token === '/private/secret-file' || token === 'src/private/secret-file') {
            expect(result).toBe(`${prefix}${'secret-file'.slice(0, length)}`);
          } else {
            expect(result).toBe(placeholderFits ? `${prefix}<host>` : prefix);
          }
        } else {
          expect(result).not.toMatch(/\[(?:ho|host|endpo|endpoint|pa|path)?$/);
          if (token === 'secret-host.invalid') {
            expect(result).toBe(length >= 6 ? `${prefix}[host]` : prefix);
          } else if (token === 'https://secret-host.invalid/file') {
            expect(result).toBe(length >= 10 ? `${prefix}[endpoint]` : prefix);
          } else if (token === '/private/secret-file' || token === 'src/private/secret-file') {
            expect(result).not.toContain('/private/');
            expect(result).not.toContain('src/');
            expect(result).toBe(`${prefix}${'secret-file'.slice(0, length)}`);
          } else {
            expect(result).not.toContain('user@');
            expect(result).not.toContain('2001:db8::1');
            expect(result).toBe(length >= 6 ? `${prefix}[host]` : prefix);
          }
        }
      }
    }
    const prefix = 'x '.repeat((limit - 2) / 2);
    expect(project(`${prefix}ok rest`, 'secret-host.invalid')).toBe(`${prefix}ok`);
  });

  it('retains a complete title token at the limit', () => {
    expect(modelTitle('汉'.repeat(512), 'fixture-host')).toBe('汉'.repeat(512));
  });

  it('keeps non-empty output when inputs exceed limits without delimiters or shrink before secrets', () => {
    expect(modelTitle('汉'.repeat(20_000), 'fixture-host')).toBe('汉'.repeat(512));
    expect(modelText('汉'.repeat(40_000), 'fixture-host')).toBe('汉'.repeat(32_768));

    expect(modelTitle(`${'a'.repeat(505)}secret-host.invalid`, 'secret-host.invalid')).toBe('<host>');
    expect(modelTitle(`${'a'.repeat(509)}secret-host.invalid`, 'secret-host.invalid')).toBe('<host>');
    expect(modelText(`${'a'.repeat(32_760)}https://secret-host.invalid/p`, 'secret-host.invalid')).toBe('[endpoint]');
    expect(modelText(`${'a'.repeat(32_758)}https://secret-host.invalid/p`, 'secret-host.invalid')).toBe('[endpoint]');

    expect(modelTitle(`${'a'.repeat(504)} secret-host.invalid`, 'secret-host.invalid')).toBe(
      `${'a'.repeat(504)} <host>`,
    );
    expect(modelTitle(`${'a'.repeat(508)} secret-host.invalid`, 'secret-host.invalid')).toBe(`${'a'.repeat(508)} `);
    expect(modelText(`${'a'.repeat(32_759)} https://secret-host.invalid/p`, 'secret-host.invalid')).toBe(
      `${'a'.repeat(32_759)} `,
    );
    expect(modelText(`${'a'.repeat(32_757)} https://secret-host.invalid/p`, 'secret-host.invalid')).toBe(
      `${'a'.repeat(32_757)} [endpoint]`,
    );

    expect(modelTitle(`https://a.invalid/${'x'.repeat(20_000)} secret-host.invalid`, 'secret-host.invalid')).toBe(
      '<host> <host>',
    );
    expect(modelTitle(`/${'secret/'.repeat(500)}public.txt`, 'secret-host.invalid')).toBe('public.txt');
    expect(modelText(`https://a.invalid/${'x'.repeat(200_000)} secret-host.invalid`, 'secret-host.invalid')).toBe(
      '[endpoint] [host]',
    );
  });

  it('truncates by code points without splitting surrogate pairs or redaction placeholders', () => {
    expect(modelTitle('😀'.repeat(600), 'fixture-host')).toBe('😀'.repeat(512));
    expect(modelTitle(`${'a'.repeat(511)}😀`, 'fixture-host')).toBe(`${'a'.repeat(511)}😀`);
    expect(modelTitle(`${'a'.repeat(512)}😀`, 'fixture-host')).toBe('a'.repeat(512));
    expect(modelTitle(`${'😀'.repeat(506)}fixture-host`, 'fixture-host')).toBe(`${'😀'.repeat(506)}<host>`);
    expect(modelTitle(`${'😀'.repeat(507)}fixture-host`, 'fixture-host')).toBe('😀'.repeat(507));

    expect(modelText('😀'.repeat(33_000), 'fixture-host')).toBe('😀'.repeat(32_768));
    expect(modelText(`${'a'.repeat(32_767)}😀`, 'fixture-host')).toBe(`${'a'.repeat(32_767)}😀`);
    expect(modelText(`${'a'.repeat(32_768)}😀`, 'fixture-host')).toBe('a'.repeat(32_768));
    expect(modelText(`${'a'.repeat(32_765)}fixture-host`, 'fixture-host')).toBe('a'.repeat(32_765));
    expect(modelText(`${'a'.repeat(32_764)} /`, 'fixture-host')).toBe(`${'a'.repeat(32_764)} `);
    expect(modelText(`${'a'.repeat(32_761)} /`, 'fixture-host')).toBe(`${'a'.repeat(32_761)} [path]`);
    expect(modelTitle(`${'a'.repeat(508)} /`, 'fixture-host')).toBe(`${'a'.repeat(508)} `);
    expect(modelTitle(`${'a'.repeat(505)} /`, 'fixture-host')).toBe(`${'a'.repeat(505)} [path]`);
  });

  it('matches local hostnames with NFC normalization and case-insensitivity', () => {
    const nfcHost = 'Café-No\u0308de'.normalize('NFC');
    const nfdHost = 'Café-No\u0308de'.normalize('NFD');
    const mixedNfd = 'CAFE\u0301-no\u0308de';
    const mixedNfc = 'CAFÉ-NÖDE';

    expect(modelTitle(`open ${nfdHost} and ${mixedNfd}`, nfcHost)).toBe('open <host> and <host>');
    expect(modelTitle(`open ${nfcHost} and ${mixedNfc}`, nfdHost)).toBe('open <host> and <host>');
    expect(modelTitle('open /Volumes/Cafe\u0301-no\u0308de', nfcHost)).toBe('open <host>');
    expect(modelText(`on ${nfdHost} and ${mixedNfd}`, nfcHost)).toBe('on [host] and [host]');
    expect(modelText(`on ${nfcHost} and ${mixedNfc}`, nfdHost)).toBe('on [host] and [host]');
    expect(modelTitle('Cafe\u0301-note on host\u0301 vs host', 'host')).toBe('Cafe\u0301-note on host\u0301 vs <host>');
  });

  it('hides entire tokens containing Unicode combining marks in modelTitle', () => {
    expect(modelTitle('ssh u\u0301ser@se\u0301rver.invalid', 'fixture-host')).toBe('ssh <host>');
    expect(modelTitle('ssh a\u0301@b\u0301:22/tmp/x', 'fixture-host')).toBe('ssh <host>');
    expect(modelTitle('ssh se\u0301rver:22/tmp/report', 'fixture-host')).toBe('ssh <host>');
    expect(modelTitle('connect e\u0301:8080', 'fixture-host')).toBe('connect <host>');
    expect(modelTitle('open re\u0301po/se\u0301cret/README.md', 'fixture-host')).toBe('open README.md');
    expect(modelTitle('open e\u0301/secret/file.txt', 'fixture-host')).toBe('open file.txt');
    expect(modelTitle('q\u0301\u0323/secret/file q\u0301\u0323@r\u0301\u0323 q\u0301\u0323:80', 'fixture-host')).toBe(
      'file <host> <host>',
    );
    expect(modelTitle('\0\u0001\u0004\u0005 user@host \0 /a/b', 'host')).toBe('\0\u0001\u0004\u0005 <host> \0 b');
    expect(modelText('\0\u0001\u0004\u0005 https://a/b / endpoint', 'endpoint')).toBe(
      '\0\u0001\u0004\u0005 [endpoint] [path] [host]',
    );
    expect(modelTitle('open My\u0020Cafe\u0301 now', 'My Café')).toBe('open <host> now');
  });

  it('projects 1 MB inputs in sub-second time', () => {
    const millionCases = [
      ['CJK', '汉'.repeat(1_048_576), 'fixture-host'],
      ['a@', 'a@'.repeat(524_288), 'fixture-host'],
      ['/a', '/a'.repeat(524_288), 'fixture-host'],
      ['a:', 'a:'.repeat(524_288), 'fixture-host'],
      ['slashes', '/'.repeat(1_048_576), 'fixture-host'],
      ['NFD', 'e\u0301'.repeat(524_288), 'café'],
      ['NFD-match', 'Cafe\u0301,'.repeat(174_762), 'café'],
      ['spaces', 'x '.repeat(524_288), 'fixture-host'],
    ] as const;

    for (const [name, value, host] of millionCases) {
      for (const [label, project] of [
        ['title', modelTitle],
        ['text', modelText],
      ] as const) {
        const start = performance.now();
        const result = project(value, host);
        const elapsed = performance.now() - start;
        expect(result.length).toBeGreaterThan(0);
        expect(elapsed).toBeLessThan(1000);
        if (elapsed > 500) console.log(`1MB ${name} ${label}: ${elapsed.toFixed(1)}ms`);
      }
    }
  });
});
