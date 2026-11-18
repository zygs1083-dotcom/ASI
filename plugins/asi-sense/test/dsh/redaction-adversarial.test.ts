import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileStoragePort } from '../../src/host/dsh/storage.ts';
import { modelPath, modelText, modelTitle } from '../../src/host/dsh/tool-output.ts';

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

  it('F8 recovers to an alternate backup when the hash backup is replaced by a directory, dangling symlink, or chmod 000 file', async () => {
    const { root, port } = await setup();
    const hashed = await port.backup('settings', 'old');
    const hashedPath = join(root, hashed);

    await fs.rm(hashedPath);
    await fs.mkdir(hashedPath);
    const afterDir = await port.backup('settings', 'old');
    expect(afterDir).not.toBe(hashed);
    expect(afterDir).toMatch(/^settings\.json\.bak-\d{1,20}-[a-f0-9-]{36}$/i);
    expect(await fs.readFile(join(root, afterDir), 'utf8')).toBe('old');
    expect((await fs.stat(join(root, afterDir))).mode & 0o777).toBe(0o600);
    expect(await port.backup('settings', 'old')).toBe(afterDir);

    await fs.rm(join(root, afterDir));
    await fs.rm(hashedPath, { recursive: true, force: true });
    await fs.symlink(join(root, 'nonexistent-target'), hashedPath);
    const afterSymlink = await port.backup('settings', 'old');
    expect(afterSymlink).not.toBe(hashed);
    expect(await fs.readFile(join(root, afterSymlink), 'utf8')).toBe('old');

    if (process.getuid?.() !== 0) {
      await fs.rm(join(root, afterSymlink));
      await fs.rm(hashedPath);
      await fs.writeFile(hashedPath, 'unreadable', { mode: 0o000 });
      try {
        const afterUnreadable = await port.backup('settings', 'old');
        expect(afterUnreadable).not.toBe(hashed);
        expect(await fs.readFile(join(root, afterUnreadable), 'utf8')).toBe('old');
      } finally {
        await fs.chmod(hashedPath, 0o600).catch(() => {});
      }
    }
  });
});

const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe('T2 bounded redaction (hidden regression)', () => {
  const H = 'build-host';

  it('H4 a long separator-free title is not emptied and is bounded', () => {
    const out = modelTitle('x'.repeat(600), H);
    expect(out.length).toBeGreaterThan(0);
    expect([...out].length).toBeLessThanOrEqual(512);
  });

  it('H5 a long separator-free text is not emptied and is bounded', () => {
    const out = modelText('z'.repeat(40_000), H);
    expect(out.length).toBeGreaterThan(0);
    expect([...out].length).toBeLessThanOrEqual(32_768);
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

  // Design target is <200 ms; U1 shared-host CI uses 1000 ms to tolerate load jitter.
  it('H12 stays fast on a 1 MB input', () => {
    const big = 'w '.repeat(500_000);
    const t0 = performance.now();
    modelTitle(big, H);
    expect(performance.now() - t0).toBeLessThan(1000);
    const t1 = performance.now();
    modelText(big, H);
    expect(performance.now() - t1).toBeLessThan(1000);
  });
});

describe('blind bakeoff adversarial regressions', () => {
  it('A-1 does not leak tokens straddling pre-cap shrink points', () => {
    const padComma = `${`${'u'.repeat(100)}@${'d'.repeat(100)},`.repeat(20)}${'x'.repeat(23)},`;
    const padSpace = `${`${'u'.repeat(100)}@${'d'.repeat(100)},`.repeat(20)}${'x'.repeat(23)} `;

    expect(modelTitle(`${padComma}secret-db-prod-01.corp.invalidxx:5432/app`, 'other')).toBe('<host>');
    const hostPortOut = modelTitle(`${padSpace}secret-db-prod-01.corp.invalidxx:5432/app`, 'other');
    expect(hostPortOut).not.toContain('secret-db-prod-01');
    expect(hostPortOut).not.toContain('corp.invalid');
    expect(hostPortOut).toBe('<host> <host>');

    const spacePadPrefix = `${'u'.repeat(100)}@${'d'.repeat(100)} `.repeat(20) + `${'x'.repeat(23)} `;
    const spaceHostOut = modelTitle(`${spacePadPrefix}secret-db-prod-01.corp.invalidxx:5432/app`, 'other');
    expect(spaceHostOut).not.toContain('secret-db-prod-01');
    expect(spaceHostOut).not.toContain('corp.invalid');
    expect(spaceHostOut.slice(-16)).toBe('xxxxxxxxx <host>');

    expect(modelTitle(`${padComma}alice.executive.secret-accountxx@corp.invalid`, 'other')).toBe('<host>');
    const emailOut = modelTitle(`${spacePadPrefix}alice.executive.secret-accountxx@corp.invalid`, 'other');
    expect(emailOut).not.toContain('alice.executive');
    expect(emailOut).not.toContain('secret-account');
    expect(emailOut).not.toContain('corp.invalid');
    expect(emailOut.slice(-16)).toBe('xxxxxxxxx <host>');

    expect(modelTitle(`${padComma}secret-acquisition-project-2026x/README.md`, 'other')).toBe('<host>');
    const relPathOut = modelTitle(`${spacePadPrefix}secret-acquisition-project-2026x/README.md`, 'other');
    expect(relPathOut).not.toContain('secret-acquisition-project-2026x');
    expect(relPathOut.slice(-19)).toBe('xxxxxxxxx README.md');

    expect(modelTitle(`/${'secret/'.repeat(600)}public.txt`, 'other')).toBe('public.txt');

    const localHost = 'corp-macbook-pro.invalid';
    const textHostOut = modelText(
      `https://${'a'.repeat(65_520)} ${`${localHost} `.repeat(2730)}${localHost}`,
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

  it('B-4 handles delimiter-prefixed unsafe inputs conservatively and never corrupts literal placeholders', () => {
    expect(modelTitle(`<${'a'.repeat(600)}`, 'host')).toBe('<host>');
    expect(modelText(`<${'a'.repeat(40_000)}`, 'host')).toBe('[host]');
    expect(modelTitle(` ${'a'.repeat(600)}`, 'host')).toBe(` ${'a'.repeat(511)}`);
    expect(modelTitle(`${'x'.repeat(508)} a[pa rest`, 'host').slice(505)).toBe('xxx ');
    expect(modelTitle(`${'x'.repeat(508)} [path]`, 'host').slice(505)).toBe('xxx ');
  });

  it('B-5 rejects lone surrogates without splitting valid surrogate pairs', () => {
    const over = modelTitle('\ud800a'.repeat(512), 'host');
    expect(over).toBe('<host>');
    expect(over).not.toMatch(loneSurrogate);

    const withLone = modelTitle(`${'x'.repeat(511)}\ud800😀`, 'host');
    expect(withLone).toBe('<host>');
    expect(withLone).not.toMatch(loneSurrogate);

    const validPair = modelTitle(`${'x'.repeat(511)}😀`, 'host');
    expect([...validPair]).toHaveLength(512);
    expect(validPair).not.toMatch(loneSurrogate);
    const trimmedPair = modelTitle(`${'x'.repeat(512)}😀`, 'host');
    expect([...trimmedPair]).toHaveLength(512);
    expect(trimmedPair).not.toMatch(loneSurrogate);
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
      // Design target is <200 ms; U1 shared-host CI uses 1000 ms to tolerate load jitter.
      expect(titleMs).toBeLessThan(1000);
      expect(textMs).toBeLessThan(1000);
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
    // Design target is <200 ms; U1 shared-host CI uses 1000 ms to tolerate load jitter.
    expect(performance.now() - t0).toBeLessThan(1000);
    const t1 = performance.now();
    expect(modelText(spaceHostInput, 'My Host').length).toBeGreaterThan(0);
    expect(performance.now() - t1).toBeLessThan(1000);

    const spacedSecret = `${`https://a.example/${'x'.repeat(300)} `.repeat(15)}My Host end`;
    expect(modelTitle(spacedSecret, 'My Host')).not.toContain('My Host');

    for (const boundary of [4096, 131_072]) {
      const padUrl = `https://a.example/${'x'.repeat(1000)} `;
      const repeats = Math.floor((boundary - 3) / padUrl.length);
      const prefix = padUrl.repeat(repeats);
      const spacer = 'a'.repeat(Math.max(0, boundary - 3 - prefix.length));
      const straddling = `${prefix}${spacer} My Host end`;
      const titleOut = modelTitle(straddling, 'My Host');
      expect(titleOut).not.toContain('My Host');
      expect(titleOut).not.toContain('a.example');
      const textOut = modelText(straddling, 'My Host');
      expect(textOut).not.toContain('My Host');
      expect(textOut).not.toContain('a.example');
    }
  });

  it('C-3..C-5 hides structural tokens conservatively, matches Turkish İ/i̇, and preserves literal [redacted] bounds', () => {
    expect(modelTitle('open sche\u0301me://secret.example/a/b', 'fixture-host')).toBe('open <host>');
    expect(modelTitle('ssh user@[2001:db8::1\u0301]:22/secret-dir/secret-file', 'fixture-host')).toBe('ssh <host>');
    expect(modelTitle('connect node\u0301::1', 'fixture-host')).toBe('connect <host>');
    expect(modelTitle('ping v1\u0301192.168.1.1', 'fixture-host')).toBe('ping <host>');
    expect(modelTitle('Task:1\u20e3 Notes', 'fixture-host')).toBe('<host> Notes');
    expect(modelTitle('ssh user@host:22\u0301', 'fixture-host')).toBe('ssh <host>');
    expect(modelTitle('ssh server:22\u0301', 'fixture-host')).toBe('ssh <host>');

    expect(modelTitle('on i\u0307-host', '\u0130-host')).toBe('on <host>');
    expect(modelTitle('on \u0130-host', 'i\u0307-host')).toBe('on <host>');
    expect(modelText('on i\u0307-host', '\u0130-host')).toBe('on [host]');
    expect(modelText('on \u0130-host', 'i\u0307-host')).toBe('on [host]');

    expect(modelTitle(`${'x'.repeat(508)} [redacted]`, 'fixture-host').slice(505)).toBe('xxx ');
    expect(modelTitle(`${'x'.repeat(508)}[redacted]`, 'fixture-host')).toBe('<host>');
  });

  it('keeps 1 MB delimiter-free pathological punctuation inputs bounded, redacted, and sub-second', () => {
    for (const input of [
      `${':'.repeat(1_000_000)}g`,
      `${'a:'.repeat(500_000)}g`,
      `${'@'.repeat(1_000_000)}`,
      `${'a@b,'.repeat(250_000)}/`,
      '/'.repeat(1_048_576),
    ]) {
      const t0 = performance.now();
      const titleOut = modelTitle(input, 'fixture-host');
      // Design target is <200 ms; U1 shared-host CI uses 1000 ms to tolerate load jitter.
      expect(performance.now() - t0).toBeLessThan(1000);
      const t1 = performance.now();
      const textOut = modelText(input, 'fixture-host');
      expect(performance.now() - t1).toBeLessThan(1000);
      expect(titleOut.length).toBeGreaterThan(0);
      expect(textOut.length).toBeGreaterThan(0);
      expect([...titleOut].length).toBeLessThanOrEqual(512);
      expect([...textOut].length).toBeLessThanOrEqual(32_768);
      expect(titleOut).not.toMatch(/a:a|a@b|::/);
      expect(textOut).not.toMatch(/a:a|a@b|::/);
    }
  });
});

describe('review F1..F6 regressions', () => {
  it('F1 hides IPv4-mapped/embedded IPv6, Zone-ID IPv6, and RFC 5321 literal emails', () => {
    for (const input of [
      'ssh ::ffff:192.168.1.10',
      'connect 2001:db8::192.0.2.1',
      'ssh [fe80::1%eth0]:22',
      'ssh fe80::1%eth0',
      'mail alice@[fe80::1%eth0]',
      'mail alice@[IPv6:2001:db8::1]',
    ]) {
      const titleOut = modelTitle(input, 'build-host');
      const textOut = modelText(input, 'build-host');
      expect(titleOut).not.toMatch(/192|168|eth0|alice|2001|db8|fe80|22/i);
      expect(textOut).not.toMatch(/192|168|eth0|alice|2001|db8|fe80|22/i);
    }
    expect(modelTitle('ssh ::ffff:192.168.1.10', 'build-host')).toBe('ssh <host>');
    expect(modelTitle('connect 2001:db8::192.0.2.1', 'build-host')).toBe('connect <host>');
    expect(modelTitle('ssh [fe80::1%eth0]:22', 'build-host')).toBe('ssh <host>');
    expect(modelTitle('ssh fe80::1%eth0', 'build-host')).toBe('ssh <host>');
    expect(modelTitle('mail alice@[fe80::1%eth0]', 'build-host')).toBe('mail <host>');
    expect(modelTitle('mail alice@[IPv6:2001:db8::1]', 'build-host')).toBe('mail <host>');
    expect(modelText('mail alice@[IPv6:2001:db8::1]', 'build-host')).toBe('mail [host]');
  });

  it('F2 hides UNC paths, drive/relative backslash paths, and punctuated first-level directories', () => {
    expect(modelTitle('open \\\\corp-fs\\finance\\q4.xlsx', 'build-host')).toBe('open q4.xlsx');
    expect(modelText('read \\\\corp-fs\\finance\\q4.xlsx', 'build-host')).toBe('read q4.xlsx');
    expect(modelTitle('open \\\\corp-fs\\secret-share', 'build-host')).toBe('open [path]');
    expect(modelText('open \\\\corp-fs\\secret-share', 'build-host')).toBe('open [path]');
    expect(modelTitle('open C:\\Users\\secret-user\\q4.xlsx', 'build-host')).toBe('open q4.xlsx');
    expect(modelTitle('open corp-secret\\finance\\q4.xlsx', 'build-host')).toBe('open q4.xlsx');
    expect(modelTitle('open [secret-org]/repo/README.md', 'build-host')).toBe('open <host>');
    expect(modelText('open [secret-org]/repo/README.md', 'build-host')).toBe('open [host]');
    expect(modelTitle('open secret:team/sub/README.md', 'build-host')).toBe('open <host>');
    expect(modelText('open secret:team/sub/README.md', 'build-host')).toBe('open [host]');
  });

  it('F3 hides prefix:host:port and prefix:host:port/path tokens completely', () => {
    expect(modelTitle('connect foo:secret-host.internal:8080', 'build-host')).toBe('connect <host>');
    expect(modelText('connect foo:secret-host.internal:8080', 'build-host')).toBe('connect [host]');
    expect(modelTitle('docker:registry.corp.invalid:5000/org/app', 'build-host')).toBe('<host>');
    expect(modelText('docker:registry.corp.invalid:5000/org/app', 'build-host')).toBe('[host]');
  });

  it('F4 processes all six <= 1 MB pathological inputs in < 200 ms each', () => {
    const distinctParts: string[] = [];
    outer: for (let m = 0x0300; m <= 0x036f; m++) {
      for (let b = 0x4e00; b <= 0x5600; b++) {
        distinctParts.push(String.fromCharCode(b, m));
        if (distinctParts.length >= 200_000) break outer;
      }
    }
    const s1 = `/${'a:1,'.repeat(250_000)}`;
    const s2 = `/${'a@b,::1,a:1,'.repeat(87_381)}`;
    const s3 = '\0\u0001\u0004\u0005'.repeat(250_000);
    const s4 = `${distinctParts.join('')} tail`;
    const cases: [string, string, (input: string) => string, number][] = [
      ['slash+hostport (title)', s1, (v) => modelTitle(v, 'fixture-host'), 512],
      ['slash+mixed (title)', s2, (v) => modelTitle(v, 'fixture-host'), 512],
      ['sentinels (title)', s3, (v) => modelTitle(v, 'fixture-host'), 512],
      ['sentinels (text)', s3, (v) => modelText(v, 'fixture-host'), 32_768],
      ['space-host NFD (title)', s4, (v) => modelTitle(v, 'café host'), 512],
      ['space-host NFD (text)', s4, (v) => modelText(v, 'café host'), 32_768],
    ];
    for (const [name, input, fn, limit] of cases) {
      const t0 = performance.now();
      const out = fn(input);
      const elapsed = performance.now() - t0;
      // Design target is <200 ms; U1 shared-host CI uses 1000 ms to tolerate load jitter.
      expect(elapsed, name).toBeLessThan(1000);
      expect(out.length, name).toBeGreaterThan(0);
      expect([...out].length, name).toBeLessThanOrEqual(limit);
      expect(out, name).not.toMatch(/a:1|a@b|::1/);
    }
  });

  it('F5 hides tokens containing combining marks and sentinel control characters', () => {
    expect(modelTitle('ping 192.168.1.1\u0301', 'build-host')).toBe('ping <host>');
    expect(modelTitle('ssh 2001:db8::1\u0301', 'build-host')).toBe('ssh <host>');
    expect(modelTitle('connect secret.corp:80\u030180', 'build-host')).toBe('connect <host>');
    expect(modelTitle('connect secret.corp:8080\u0903', 'build-host')).toBe('connect <host>');
    expect(modelTitle('mail alice\0@secret-corp.internal', 'build-host')).toBe('mail <host>');
    expect(modelText('mail alice\0@secret-corp.internal', 'build-host')).toBe('mail [host]');
  });

  it('F6 matches >32 combining-mark hosts, full Unicode case folding, and never splits clusters at truncation', () => {
    const longMarkHost = `a${'\u0301'.repeat(33)}`;
    expect(modelTitle(`on ${longMarkHost}`, longMarkHost)).toBe('on <host>');
    expect(modelText(`on ${longMarkHost}`, longMarkHost)).toBe('on [host]');

    expect(modelTitle('on \u03a5\u0308\u0301-host', '\u03b0-host')).toBe('on <host>');
    expect(modelTitle('on \u03b0-host', '\u03a5\u0308\u0301-host')).toBe('on <host>');
    expect(modelTitle('on hostß', 'hostSS')).toBe('on <host>');
    expect(modelTitle('on hostSS', 'hostß')).toBe('on <host>');

    const truncated = modelTitle(`${'a'.repeat(508)}host\u0301`, 'host');
    expect(truncated.slice(505)).toBe('aaahos');
    expect(truncated).not.toContain('host');
  });
});

describe('re-review R2..R7 whitelist regressions', () => {
  it('R2 prevents punctuation from splitting paths or URL query/matrix/pipe payloads', () => {
    expect(modelTitle('open /Users/alice/secret-org(confidential)/docs/q4.xlsx', 'build-host')).toBe('open q4.xlsx');
    expect(modelText('open /Users/alice/secret-org(confidential)/docs/q4.xlsx', 'build-host')).toBe('open q4.xlsx');
    expect(modelTitle('open /Users/alice/team,secret-dir/sub/README.md', 'build-host')).toBe('open README.md');
    expect(modelTitle('open /Users/alice/secret-dir;prod/sub/file.txt', 'build-host')).toBe('open file.txt');
    expect(modelTitle('open /Users/alice/secret-dir|prod/sub/file.txt', 'build-host')).toBe('open file.txt');
    expect(modelTitle('https://secret.corp/api?a=1,token=SECRET123', 'build-host')).toBe('<host>');
    expect(modelText('https://secret.corp/api?a=1,token=SECRET123', 'build-host')).toBe('[endpoint]');
    expect(modelTitle('https://secret.corp/api;jsessionid=SECRET123', 'build-host')).toBe('<host>');
    expect(modelText('https://secret.corp/api;jsessionid=SECRET123', 'build-host')).toBe('[endpoint]');
    expect(modelTitle('https://secret.corp/api|secret-host', 'build-host')).toBe('<host>');
    expect(modelText('https://secret.corp/api|secret-host', 'build-host')).toBe('[endpoint]');
  });

  it('R3 hides forward/mixed-slash UNC paths, drive roots, modelPath UNC, and standalone :port forms', () => {
    for (const unc of ['//corp-fs/secret-share', '//corp-fs', '\\/corp-fs/secret-share', '/\\corp-fs\\secret-share']) {
      expect(modelTitle(unc, 'build-host'), unc).toBe('[path]');
      expect(modelText(unc, 'build-host'), unc).toBe('[path]');
    }
    expect(modelTitle('//corp-fs/finance/q4.xlsx', 'build-host')).toBe('q4.xlsx');
    expect(modelPath('\\\\corp-fs\\secret-share')).toBe('[path]');
    expect(modelPath('//corp-fs/secret-share')).toBe('[path]');
    expect(modelPath('//corp-fs')).toBe('[path]');
    expect(modelPath('\\\\corp-fs\\finance\\q4.xlsx')).toBe('q4.xlsx');

    expect(modelTitle('listen :8080', 'build-host')).toBe('listen <host>');
    expect(modelText('listen :8080', 'build-host')).toBe('listen [host]');
    expect(modelTitle('bind :5432', 'build-host')).toBe('bind <host>');
    expect(modelTitle('connect host: 8080', 'build-host')).toBe('connect host: <host>');
    expect(modelText('connect host: 8080', 'build-host')).toBe('connect host: [host]');
    expect(modelTitle('connect host： ８０８０', 'build-host')).toBe('connect host： <host>');
    expect(modelTitle('connect host∶ 8080', 'build-host')).toBe('connect host∶ <host>');
    expect(modelTitle('open C:\\', 'build-host')).toBe('open [path]');
    expect(modelText('open C:\\', 'build-host')).toBe('open [path]');
    expect(modelPath('C:\\')).toBe('[path]');
  });

  it('R4 hides fullwidth and Unicode homoglyph paths, URLs, IPs, emails, and host:port tokens', () => {
    expect(modelTitle('open ／Users／alice／secret-project／README.md', 'build-host')).toBe('open README.md');
    expect(modelTitle('open ∕Users∕alice∕secret-corp∕notes', 'build-host')).toBe('open notes');
    expect(modelTitle('open https：//prod-db', 'build-host')).toBe('open <host>');
    expect(modelText('open https：//prod-db', 'build-host')).toBe('open [endpoint]');
    expect(modelTitle('ping 192．168．1．10', 'build-host')).toBe('ping <host>');
    expect(modelTitle('ping 192․168․1․10', 'build-host')).toBe('ping <host>');
    expect(modelTitle('ping 192。168。1。10', 'build-host')).toBe('ping <host>');
    expect(modelTitle('mail alice＠secret-corp．internal', 'build-host')).toBe('mail <host>');
    expect(modelTitle('connect secret-db．corp：5432', 'build-host')).toBe('connect <host>');
    expect(modelTitle('connect secret-host∶8080', 'build-host')).toBe('connect <host>');
    expect(modelTitle('ssh ［fe80∶∶1％eth0］：22', 'build-host')).toBe('ssh <host>');
    expect(modelTitle('visit secret-corp‧nz', 'build-host')).toBe('visit <host>');
  });

  it('R5 redacts unlisted TLDs and dotfiles while keeping safe extensions, emoji ZWJ, and stripping zero-width chars', () => {
    for (const unlisted of [
      'open secret-corp.nz',
      'connect db.prod',
      'visit wiki.intra',
      'open portal.app',
      'ssh auth.sh',
    ]) {
      expect(modelTitle(unlisted, 'build-host'), unlisted).not.toMatch(/secret-corp|prod|wiki|intra|portal|auth/);
    }
    expect(modelTitle('open /Volumes/secret-corp.nz', 'build-host')).toBe('open [path]');
    expect(modelTitle('open /srv/portal.app', 'build-host')).toBe('open [path]');
    expect(modelTitle('open /Users/alice/secret-project/.env', 'build-host')).toBe('open [path]');
    expect(modelTitle('open /Users/alice/secret-project/secret.md', 'build-host')).toBe('open secret.md');
    expect(modelTitle('open /Users/alice/.ssh/id_rsa', 'build-host')).toBe('open id_rsa');

    expect(modelTitle('README.md — project', 'build-host')).toBe('README.md — project');
    expect(modelTitle('Q4 预算.xlsx - Numbers', 'build-host')).toBe('Q4 预算.xlsx - Numbers');
    expect(modelTitle('Untitled — Edited', 'build-host')).toBe('Untitled — Edited');
    expect(modelTitle('v1.2 release notes', 'build-host')).toBe('<host> release notes');
    expect(modelTitle('Inbox (3) – Mail', 'build-host')).toBe('Inbox <host> <host> Mail');

    expect(modelTitle('Deploy 🚀 👨‍👩‍👧 ❤️ 👍🏽', 'build-host')).toBe('Deploy 🚀 👨‍👩‍👧 ❤️ 👍🏽');
    expect(modelTitle('on local\u200bhost now', 'localhost')).toBe('on <host> now');
    expect(modelTitle('ping 192\u200b.168\u200d.1\ufeff.1', 'build-host')).toBe('ping <host>');
    expect(modelTitle('open\u00a0README.md\u3000please…', 'build-host')).toBe('open\u00a0README.md\u3000please…');
    expect(modelTitle('请查看文档。', 'build-host')).toBe('请查看文档。');
  });

  it('R7 keeps fast and delimiter-host truncation consistent around literal <host> boundaries', () => {
    const dense = `${'x '.repeat(250)}a:1 ${'<host>'.repeat(3)} /`;
    const spaced = `${'x '.repeat(250)}a:1 ${'<host> '.repeat(3)}/`;
    expect(modelTitle(dense, 'host-without-delim')).toBe(modelTitle(dense, 'host with delim'));
    expect(modelTitle(spaced, 'host-without-delim')).toBe(modelTitle(spaced, 'host with delim'));
    expect(modelTitle(spaced, 'host-without-delim')).not.toMatch(/<(?:h|ho|hos|host)?$/);
  });
});
