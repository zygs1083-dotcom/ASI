import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileStoragePort } from '../../src/host/dsh/storage.ts';
import { modelText, modelTitle } from '../../src/host/dsh/tool-output.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function setup() {
  const root = await fs.mkdtemp(join(tmpdir(), 'asi-bakeoff-'));
  roots.push(root);
  const port = new FileStoragePort(root, fs, vi.fn());
  await port.save('settings', 'old');
  return { root, port };
}

const backups = async (root: string) =>
  (await fs.readdir(root)).filter((name) => name.startsWith('settings.json.bak-')).sort();

describe('T1 damaged hash-named backup (hidden regression)', () => {
  it('H1 writes an alternate backup instead of failing and keeps the damaged file', async () => {
    const { root, port } = await setup();
    const hashed = await port.backup('settings', 'old');
    await fs.writeFile(join(root, hashed), 'damaged');
    const alt = await port.backup('settings', 'old');
    expect(alt).not.toBe(hashed);
    expect(alt).toMatch(/^settings\.json\.bak-\d{1,20}-[a-f0-9-]{36}$/i);
    expect(await fs.readFile(join(root, alt), 'utf8')).toBe('old');
    expect((await fs.stat(join(root, alt))).mode & 0o777).toBe(0o600);
    expect(await fs.readFile(join(root, hashed), 'utf8')).toBe('damaged');
  });

  it('H2 is idempotent once recovered', async () => {
    const { root, port } = await setup();
    const hashed = await port.backup('settings', 'old');
    await fs.writeFile(join(root, hashed), 'damaged');
    const first = await port.backup('settings', 'old');
    const second = await port.backup('settings', 'old');
    expect(second).toBe(first);
    expect(await backups(root)).toHaveLength(2);
  });

  it('H3 still refuses when the live file changed', async () => {
    const { port } = await setup();
    await expect(port.backup('settings', 'different')).rejects.toThrow(/changed/);
  });
});

describe('T2 bounded redaction (hidden regression)', () => {
  const H = 'build-host';
  const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

  it('H4 a long separator-free title is not emptied and is bounded', () => {
    const out = modelTitle('x'.repeat(600), H);
    expect(out.length).toBeGreaterThan(0);
    expect([...out].length).toBeLessThanOrEqual(512);
  });

  it('H5 a long separator-free text is not emptied', () => {
    expect(modelText('z'.repeat(40_000), H).length).toBeGreaterThan(0);
  });

  it('H6 never splits a surrogate pair', () => {
    const out = modelTitle(`${'a'.repeat(511)}😀${'b'.repeat(50)}`, H);
    expect(out).not.toMatch(loneSurrogate);
  });

  it('H7 a path straddling the limit leaks no directory components', () => {
    const out = modelTitle(`${'x '.repeat(240)}/Users/someone/secret-project/deep/file.txt${' tail'.repeat(20)}`, H);
    expect(out).not.toContain('someone');
    expect(out).not.toContain('secret-project');
    expect(out).not.toContain('/Users');
  });

  it('H8 a host straddling the limit is not partially leaked', () => {
    const out = modelTitle(`${'y '.repeat(250)}build-host.example.internal:8443/x more`, H);
    expect(out).not.toMatch(/example|internal|8443/);
    expect(out).not.toMatch(/<(?:h|ho|hos|host)?$/);
  });

  it('H9 NFD title matches NFC hostname (title and text)', () => {
    const host = 'café-mac';
    const title = 'open on cafe\u0301-mac now';
    expect(modelTitle(title, host)).not.toMatch(/caf/i);
    expect(modelText(title, host)).not.toMatch(/caf/i);
  });

  it('H10 NFC title matches NFD hostname', () => {
    const host = 'cafe\u0301-mac';
    const title = 'open on café-mac now';
    expect(modelTitle(title, host)).not.toMatch(/caf/i);
    expect(modelText(title, host)).not.toMatch(/caf/i);
  });

  it('H11 email/host tokens containing combining marks are fully hidden', () => {
    const out = modelTitle('mail us\u0308er@he\u0301ste.example now', 'other');
    expect(out).not.toMatch(/ste\.example/);
    expect(out).not.toContain('\u0301');
    expect(out).not.toContain('\u0308');
  });

  it('H12 stays fast on a 1 MB input', () => {
    const big = 'w '.repeat(500_000);
    const t0 = performance.now();
    modelTitle(big, H);
    modelText(big, H);
    expect(performance.now() - t0).toBeLessThan(1500);
  });
});

describe('blind bakeoff adversarial regressions', () => {
  it('A-1 does not leak tokens straddling pre-cap shrink points', () => {
    const pad = `${`${'u'.repeat(100)}@${'d'.repeat(100)},`.repeat(20)}${'x'.repeat(23)},`;
    const hostPortOut = modelTitle(`${pad}secret-db-prod-01.corp.invalidxx:5432/app`, 'other');
    expect(hostPortOut).not.toContain('secret-db-prod-01');
    expect(hostPortOut).not.toContain('corp.invalid');
    expect(hostPortOut.slice(-16)).toBe('xxxxxxxxx,<host>');

    const emailOut = modelTitle(`${pad}alice.executive.secret-accountxx@corp.invalid`, 'other');
    expect(emailOut).not.toContain('alice.executive');
    expect(emailOut).not.toContain('secret-account');
    expect(emailOut).not.toContain('corp.invalid');
    expect(emailOut.slice(-16)).toBe('xxxxxxxxx,<host>');

    const relPathOut = modelTitle(`${pad}secret-acquisition-project-2026x/README.md`, 'other');
    expect(relPathOut).not.toContain('secret-acquisition-project-2026x');
    expect(relPathOut.slice(-19)).toBe('xxxxxxxxx,README.md');

    expect(modelTitle(`/${'secret/'.repeat(600)}public.txt`, 'other')).toBe('public.txt');

    const localHost = 'corp-macbook-pro.invalid';
    const textHostOut = modelText(
      `https://${'a'.repeat(65_520)} ${`${localHost},`.repeat(2730)}${localHost}`,
      localHost,
    );
    expect(textHostOut).not.toContain('corp-macbook-pro');
    expect(textHostOut).not.toContain(localHost);
    expect([...textHostOut].length).toBeLessThanOrEqual(32_768);

    const threeUrls = `${`https://example.invalid/${'p'.repeat(800)} `.repeat(3)}visible title`;
    expect(modelTitle(threeUrls, 'other')).toBe('<host> <host> <host> visible title');
  });

  it('B-2 does not slice paths mid-token into fake filenames', () => {
    const titleOut = modelTitle(`/${'a/'.repeat(4089)}x /secret-corp-project/README.md`, 'host');
    expect(titleOut).not.toContain('secret-corp');
    expect(titleOut).toBe('x README.md');

    const textOut = modelText(`https://${'a'.repeat(524_270)} /secret-corp-dir/README.md`, 'host');
    expect(textOut).not.toContain('secret-corp');
    expect(textOut).toBe('[endpoint] README.md');
  });

  it('B-3 matches mixed NFC/NFD and reordered marks without splitting non-matching clusters', () => {
    expect(modelTitle('on caf\u00e9-no\u0308de', 'caf\u00e9-n\u00f6de')).toBe('on <host>');
    expect(modelText('on caf\u00e9-no\u0308de', 'caf\u00e9-n\u00f6de')).toBe('on [host]');
    expect(modelTitle('on e\u0301\u0323-host', 'e\u0323\u0301-host')).toBe('on <host>');
    expect(modelTitle('at cafe\u0301', 'cafe')).toBe('at cafe\u0301');
  });

  it('B-4 never empties delimiter-prefixed inputs or corrupts literal placeholder prefixes', () => {
    const titleBracket = modelTitle(`<${'a'.repeat(600)}`, 'host');
    expect(titleBracket).toBe(`<${'a'.repeat(511)}`);
    expect(modelText(`<${'a'.repeat(40_000)}`, 'host')).toBe(`<${'a'.repeat(32_767)}`);
    expect(modelTitle(` ${'a'.repeat(600)}`, 'host')).toBe(` ${'a'.repeat(511)}`);
    expect(modelTitle(`${'x'.repeat(508)}a[pa rest`, 'host').slice(505)).toBe('xxxa[pa');
  });

  it('B-5 counts lone surrogates as one code point without splitting valid surrogate pairs', () => {
    const over = modelTitle('\ud800a'.repeat(512), 'host');
    expect([...over].length).toBe(512);

    const split = modelTitle(`${'x'.repeat(511)}\ud800😀`, 'host');
    expect([...split.slice(510)].map((c) => c.codePointAt(0))).toEqual([0x78, 0xd800]);
  });

  it('C-1 handles 1 MB reversed combining-mark clusters quickly for ASCII and Unicode hostnames', () => {
    const millionMarks = `ab${'\u0301'.repeat(262_144)}${'\u0323'.repeat(262_144)}`;
    for (const host of ['fixture-host', 'café'] as const) {
      const t0 = performance.now();
      const titleOut = modelTitle(millionMarks, host);
      const titleMs = performance.now() - t0;
      const t1 = performance.now();
      const textOut = modelText(millionMarks, host);
      const textMs = performance.now() - t1;
      expect(titleOut.length).toBeGreaterThan(0);
      expect(textOut.length).toBeGreaterThan(0);
      expect([...titleOut].length).toBeLessThanOrEqual(512);
      expect([...textOut].length).toBeLessThanOrEqual(32_768);
      expect(titleMs).toBeLessThan(1500);
      expect(textMs).toBeLessThan(1500);
    }

    expect(modelTitle(`ab${'\u0301'.repeat(100)} café`, 'café')).toBe(`ab${'\u0301'.repeat(100)} <host>`);
  });

  it('C-2 preserves delimiter+combining clusters across chunk boundaries and stays fast for hosts with spaces', () => {
    const fiveUrls = `${`https://a.example/${'x'.repeat(800)} `.repeat(5)}`;
    const out = modelTitle(`${fiveUrls}y >\u0338-secret-host`, '\u226f-secret-host');
    expect(out).toBe('<host> <host> <host> <host> <host> y <host>');
    expect(out.normalize('NFC')).not.toContain('\u226f-secret-host');

    const spaceHostInput = '/a '.repeat(350_000);
    const t0 = performance.now();
    expect(modelTitle(spaceHostInput, 'My Host').length).toBeGreaterThan(0);
    expect(modelText(spaceHostInput, 'My Host').length).toBeGreaterThan(0);
    expect(performance.now() - t0).toBeLessThan(1500);

    const spacedSecret = `${`https://a.example/${'x'.repeat(300)} `.repeat(15)}My Host end`;
    expect(modelTitle(spacedSecret, 'My Host')).not.toContain('My Host');
  });

  it('C-3..C-5 hides combining-mark tokens completely, matches Turkish İ/i̇, and preserves literal [redacted] bounds', () => {
    expect(modelTitle('open sche\u0301me://secret.example/a/b', 'fixture-host')).toBe('open <host>');
    expect(modelTitle('ssh user@[2001:db8::1\u0301]:22/secret-dir/secret-file', 'fixture-host')).toBe('ssh <host>');
    expect(modelTitle('connect node\u0301::1', 'fixture-host')).toBe('connect node\u0301::1');
    expect(modelTitle('ping v1\u0301192.168.1.1', 'fixture-host')).toBe('ping v1\u0301192.168.1.1');
    expect(modelTitle('Task:1\u20e3 Notes', 'fixture-host')).toBe('Task:1\u20e3 Notes');
    expect(modelTitle('ssh user@host:22\u0301', 'fixture-host')).toBe('ssh <host>');
    expect(modelTitle('ssh server:22\u0301', 'fixture-host')).toBe('ssh <host>');

    expect(modelTitle('on i\u0307-host', '\u0130-host')).toBe('on <host>');
    expect(modelTitle('on \u0130-host', 'i\u0307-host')).toBe('on <host>');
    expect(modelText('on i\u0307-host', '\u0130-host')).toBe('on [host]');
    expect(modelText('on \u0130-host', 'i\u0307-host')).toBe('on [host]');

    expect(modelTitle(`${'x'.repeat(508)}[redacted]`, 'fixture-host').slice(505)).toBe('xxx');
  });

  it('keeps 1 MB delimiter-free pathological punctuation inputs bounded and fast', () => {
    for (const input of [
      `${':'.repeat(1_000_000)}g`,
      `${'a:'.repeat(500_000)}g`,
      `${'@'.repeat(1_000_000)}`,
      `${'a@b,'.repeat(250_000)}/`,
      '/'.repeat(1_000_000),
    ]) {
      const t0 = performance.now();
      const titleOut = modelTitle(input, 'fixture-host');
      const textOut = modelText(input, 'fixture-host');
      expect(performance.now() - t0).toBeLessThan(1500);
      expect(titleOut.length).toBeGreaterThan(0);
      expect(textOut.length).toBeGreaterThan(0);
      expect([...titleOut].length).toBeLessThanOrEqual(512);
      expect([...textOut].length).toBeLessThanOrEqual(32_768);
    }
  });
});
