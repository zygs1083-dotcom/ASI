import { describe, expect, it } from 'vitest';
import { modelPath, modelText, modelTitle } from '../../../src/sense/host/dsh/tool-output.ts';

const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)] as T;
}

function collectForbiddenTokens(value: string): string[] {
  const clean = value.normalize('NFKC').replace(/\p{M}/gu, '').toLowerCase();
  const chars = [...clean];
  if (chars.length < 4) return clean ? [clean] : [];
  const slices: string[] = [];
  for (let i = 0; i <= chars.length - 4; i++) {
    slices.push(chars.slice(i, i + 4).join(''));
  }
  return slices;
}

interface FuzzCase {
  hostname: string;
  secretText: string;
  forbidden: string[];
  kind: 'hostname' | 'ipv4' | 'ipv6' | 'email' | 'path' | 'endpoint' | 'homoglyph' | 'punctcut' | 'unc' | 'port';
}

const PAD_DELIMS = [' ', '\t', '\n', '\u00a0', '\u3000', '\u2028', '\u200b', '\ufeff'] as const;
const PAD_PUNCT = ['!', '?', '-', '_', "'", '’', '…', '·', '—'] as const;
const PAD_MARKS = ['\u0301', '\u0308', '\u0323'] as const;
const PAD_CONTROLS = ['\0', '\u0001', '\u0004', '\u0005'] as const;
const PAD_WORDS = ['alpha', 'notes', 'window', 'visible', 'draft', 'tab', '汉', '😀', '🚀'] as const;

function makePadding(rng: () => number, mode: 'normal' | 'long' | 'huge', allowTrailingMark: boolean): string {
  if (mode === 'huge') {
    const ch = pick(rng, ['x', 'w', '汉', '😀'] as const);
    return ch.repeat(34_000 + Math.floor(rng() * 4000));
  }
  if (mode === 'long') {
    const ch = pick(rng, ['x', 'w', '汉', '😀', '\u0301'] as const);
    const len = ch === '\u0301' ? 600 : 550 + Math.floor(rng() * 1200);
    return ch === '\u0301' ? `b${ch.repeat(len)}` : ch.repeat(len);
  }
  const parts: string[] = [];
  const count = 1 + Math.floor(rng() * 6);
  for (let i = 0; i < count; i++) {
    const roll = rng();
    if (roll < 0.35) parts.push(pick(rng, PAD_WORDS));
    else if (roll < 0.65) parts.push(pick(rng, PAD_DELIMS));
    else if (roll < 0.8) parts.push(pick(rng, PAD_PUNCT));
    else if (roll < 0.9) parts.push(pick(rng, PAD_CONTROLS));
    else if (allowTrailingMark || i < count - 1) parts.push(`e${pick(rng, PAD_MARKS)}`);
    else parts.push(pick(rng, PAD_WORDS));
  }
  if (!allowTrailingMark && parts.length > 0) {
    const last = parts[parts.length - 1] as string;
    if (/\p{M}$/u.test(last)) parts.push(' ');
  }
  return parts.join('');
}

function buildSecret(rng: () => number): FuzzCase {
  const category = Math.floor(rng() * 10);
  if (category === 0) {
    const variants: [string, string, string[]][] = [
      ['zqvx-build-node', 'ZqVx-BuIlD-NoDe', ['zqvx-build-node']],
      ['zqvx-db.corp.invalid', 'zqvx-db.corp.invalid', ['zqvx-db', 'corp', 'invalid']],
      ['Zqvx Node', 'zqvX NoDe', ['zqvx', 'node']],
      ['Zqvx Node', 'zqvX\u00a0NoDe', ['zqvx', 'node']],
      ['Zqvx Node', 'zqvX\u3000NoDe', ['zqvx', 'node']],
      ['Zqvx Node', 'zqvX\u2028NoDe', ['zqvx', 'node']],
      ['ZqvxNode', 'zqvX\u200bNoDe', ['zqvx', 'node']],
      ['café-mkgp', 'cafe\u0301-mkgp', ['café-mkgp', 'cafe-mkgp']],
      ['cafe\u0301-mkgp', 'CAFÉ-MKGP', ['café-mkgp', 'cafe-mkgp']],
      ['vbrn-e\u0301\u0323', 'vbrn-e\u0323\u0301', ['vbrn-e']],
      [`plqx${'\u0301'.repeat(35)}`, `PLQX${'\u0301'.repeat(35)}`, ['plqx']],
      ['\u0130-zqvx', 'i\u0307-zqvx', ['i-zqvx', 'zqvx']],
      ['\u03b0-mkgp', '\u03a5\u0308\u0301-mkgp', ['mkgp']],
      ['vbrnSS', 'vbrnß', ['vbrn']],
      ['\u226f-zqvx', '>\u0338-zqvx', ['zqvx']],
    ];
    const [hostname, secretText, forbidden] = pick(rng, variants);
    return { hostname, secretText, forbidden, kind: 'hostname' };
  }
  if (category === 1) {
    const variants: [string, string[]][] = [
      ['198.51.100.42', ['198.51', '51.100', '100.42']],
      ['203.0.113.77:8443', ['203.0', '0.113', '113.77', '8443']],
      ['198.51.100.42\u0301', ['198.51', '51.100', '100.42']],
      ['198\u0301.51.100.42', ['198.51', '51.100', '100.42']],
      ['198.51.100.1', ['198.51', '51.100', '100.1']],
      ['198.51/24', ['198.51']],
      ['(203.0.113.77)', ['203.0', '0.113', '113.77']],
      ['zqvx-node.com', ['zqvx-node']],
      ['zqvx-corp.nz', ['zqvx-corp']],
      ['zqvx-db.prod', ['zqvx-db', 'prod']],
      ['zqvx-wiki.intra', ['zqvx-wiki', 'intra']],
      ['zqvx-portal.app', ['zqvx-portal']],
      ['zqvx-auth.sh', ['zqvx-auth']],
    ];
    const [secretText, forbidden] = pick(rng, variants);
    return { hostname: 'fixture-host', secretText, forbidden, kind: 'ipv4' };
  }
  if (category === 2) {
    const variants: [string, string[]][] = [
      ['2001:db8:85a3::8a2e:370:7334', ['2001:db8', '85a3', '8a2e', '7334']],
      ['::ffff:198.51.100.42', ['ffff', '198.51', '51.100', '100.42']],
      ['2001:db8::203.0.113.77', ['2001', '203.0', '0.113', '113.77']],
      ['fe80::1%eth0', ['fe80', 'eth0']],
      ['zqvx%en0', ['zqvx', 'en0']],
      ['[fe80::1%en0]:2222', ['fe80', 'en0', '2222']],
      ['[zqvx-box]', ['zqvx-box']],
      ['[2001:db8::1\u0301]:443/mkgp/secret', ['2001', 'mkgp', 'secret']],
    ];
    const [secretText, forbidden] = pick(rng, variants);
    return { hostname: 'fixture-host', secretText, forbidden, kind: 'ipv6' };
  }
  if (category === 3) {
    const variants: [string, string[]][] = [
      ['zqvxuser@mkgp-corp.invalid', ['zqvxuser', 'mkgp-corp', 'invalid']],
      ['zqvx\u0301user@mkgp\u0301.corp', ['zqvxuser', 'mkgp']],
      ['zqvx\0user@mkgp-corp.internal', ['zqvx', 'user', 'mkgp-corp', 'internal']],
      ['zqvxuser@[fe80::1%eth0]', ['zqvxuser', 'fe80', 'eth0']],
      ['zqvxuser@[IPv6:2001:db8::42]', ['zqvxuser', 'ipv6', '2001']],
      ['zqvxuser@[198.51.100.42]', ['zqvxuser', '198.51', '51.100', '100.42']],
    ];
    const [secretText, forbidden] = pick(rng, variants);
    return { hostname: 'fixture-host', secretText, forbidden, kind: 'email' };
  }
  if (category === 4) {
    const variants: [string, string[]][] = [
      ['\\\\zqvx-srv\\mkgp-share\\vbrn-dir\\notes.txt', ['zqvx-srv', 'mkgp-share', 'vbrn-dir']],
      ['C:\\mkgp-users\\vbrn-acct\\q4.xlsx', ['mkgp-users', 'vbrn-acct']],
      ['D:/mkgp-root/vbrn-sub/README.md', ['mkgp-root', 'vbrn-sub']],
      ['mkgp-rel\\vbrn-sub\\q4.xlsx', ['mkgp-rel', 'vbrn-sub']],
      ['mkgp-rel/vbrn-sub/notes.txt', ['mkgp-rel', 'vbrn-sub']],
      ['/mkgp-root/vbrn-proj/deep/file.txt', ['mkgp-root', 'vbrn-proj', 'deep']],
      ['[zqvx-org]/mkgp-repo/README.md', ['zqvx-org', 'mkgp-repo']],
      ['zqvx-team:mkgp-sub/vbrn-dir/README.md', ['zqvx-team', 'mkgp-sub', 'vbrn-dir']],
      ['zqvx\u0004/mkgp\u0005/notes.txt', ['zqvx', 'mkgp']],
      ['/mkgp-root/zqvx-box.corp.invalid', ['mkgp-root', 'zqvx-box', 'corp', 'invalid']],
    ];
    const [secretText, forbidden] = pick(rng, variants);
    return { hostname: 'fixture-host', secretText, forbidden, kind: 'path' };
  }
  if (category === 5) {
    const variants: [string, string[]][] = [
      ['zqvx-node.corp:8443', ['zqvx-node', 'corp', '8443']],
      ['mkgp:zqvx-internal.corp:8080', ['mkgp', 'zqvx-internal', 'corp', '8080']],
      ['mkgp\0:zqvx\u0001.corp:8080', ['mkgp', 'zqvx', 'corp', '8080']],
      [
        'docker:vbrn-registry.invalid:5000/plqx-org/tykm-app',
        ['docker', 'vbrn-registry', '5000', 'plqx-org', 'tykm-app'],
      ],
      ['zqvx\u0301node:80\u030180', ['zqvxnode', '8080']],
      [
        'https://zqvx-api.example.invalid/mkgp-v1/vbrn-secret?k=plqx',
        ['zqvx-api', 'example', 'mkgp-v1', 'vbrn-secret', 'plqx'],
      ],
      ['ssh://zqvxuser@mkgp-box:2222/vbrn-dir', ['zqvxuser', 'mkgp-box', '2222', 'vbrn-dir']],
      ['https://zqvx-internal', ['zqvx-internal']],
    ];
    const [secretText, forbidden] = pick(rng, variants);
    return { hostname: 'fixture-host', secretText, forbidden, kind: 'endpoint' };
  }
  if (category === 6) {
    const variants: [string, string[]][] = [
      ['／Users／alice／mkgp-proj／README.md', ['users', 'alice', 'mkgp-proj']],
      ['∕Users∕alice∕zqvx-corp∕notes', ['users', 'alice', 'zqvx-corp']],
      ['https：//zqvx-db', ['https', 'zqvx-db']],
      ['https：∕∕zqvx-api.example∕vbrn-dir', ['zqvx-api', 'example', 'vbrn-dir']],
      ['192．168．1．10', ['192.168', '168.1']],
      ['192․168․1․10', ['192.168', '168.1']],
      ['192。168。1。10', ['192.168', '168.1']],
      ['zqvx＠mkgp-corp．internal', ['zqvx', 'mkgp-corp', 'internal']],
      ['zqvx-db．corp：5432', ['zqvx-db', 'corp', '5432']],
      ['zqvx-srvr∶8080', ['zqvx-srvr', '8080']],
      ['［fe80∶∶1％eth0］：2222', ['fe80', 'eth0', '2222']],
      ['zqvx-corp。nz', ['zqvx-corp']],
      ['zqvx-db‧prod', ['zqvx-db', 'prod']],
    ];
    const [secretText, forbidden] = pick(rng, variants);
    return { hostname: 'fixture-host', secretText, forbidden, kind: 'homoglyph' };
  }
  if (category === 7) {
    const variants: [string, string[]][] = [
      ['/Users/alice/zqvx-org(mkgp-conf)/docs/q4.xlsx', ['zqvx-org', 'mkgp-conf']],
      ['/Users/alice/zqvx,mkgp-dir/sub/README.md', ['zqvx', 'mkgp-dir']],
      ['/Users/alice/zqvx-dir;mkgp/sub/file.txt', ['zqvx-dir', 'mkgp']],
      ['/Users/alice/zqvx-dir|mkgp/sub/file.txt', ['zqvx-dir', 'mkgp']],
      ['https://zqvx.corp/api?a=1,token=MKGP123', ['zqvx', 'token', 'mkgp123']],
      ['https://zqvx.corp/api;jsessionid=MKGP123', ['zqvx', 'jsessionid', 'mkgp123']],
      ['https://zqvx.corp/api|mkgp-srvr', ['zqvx', 'mkgp-srvr']],
      ['zqvx-org(mkgp-conf)', ['zqvx-org', 'mkgp-conf']],
    ];
    const [secretText, forbidden] = pick(rng, variants);
    return { hostname: 'fixture-host', secretText, forbidden, kind: 'punctcut' };
  }
  if (category === 8) {
    const variants: [string, string[]][] = [
      ['\\\\zqvx-srv\\mkgp-share', ['zqvx-srv', 'mkgp-share']],
      ['//zqvx-fs/mkgp-share', ['zqvx-fs', 'mkgp-share']],
      ['//zqvx-fs', ['zqvx-fs']],
      ['\\/zqvx-fs/mkgp-share', ['zqvx-fs', 'mkgp-share']],
      ['/\\zqvx-fs\\mkgp-share', ['zqvx-fs', 'mkgp-share']],
      ['//zqvx-fs/mkgp-dir/q4.xlsx', ['zqvx-fs', 'mkgp-dir']],
    ];
    const [secretText, forbidden] = pick(rng, variants);
    return { hostname: 'fixture-host', secretText, forbidden, kind: 'unc' };
  }
  const variants: [string, string, string[]][] = [
    ['fixture-host', ':8080', ['8080']],
    ['fixture-host', ':5432', ['5432']],
    ['zqvx-srvr', 'zqvx-srvr: 8080', ['zqvx-srvr', '8080']],
    ['zqvx-srvr', 'zqvx-srvr： 8443', ['zqvx-srvr', '8443']],
    ['zqvx-srvr', 'zqvx-srvr∶ 9090', ['zqvx-srvr', '9090']],
  ];
  const [hostname, secretText, forbidden] = pick(rng, variants);
  return { hostname, secretText, forbidden, kind: 'port' };
}

describe('conservative redaction fuzz suite', () => {
  it('hides >= 5000 seeded adversarial secret embeddings in modelTitle and modelText without leaks or stalls', () => {
    const rng = mulberry32(0x5eed2026);
    const totalSamples = 5200;
    const t0 = performance.now();

    for (let i = 0; i < totalSamples; i++) {
      const item = buildSecret(rng);
      const prefixRoll = rng();
      const suffixRoll = rng();
      // Keep prefix short enough for modelTitle on most iterations so secrets actually reach the 512-char window.
      const prefixMode = prefixRoll < 0.004 ? 'huge' : prefixRoll < 0.04 ? 'long' : 'normal';
      const suffixMode = suffixRoll < 0.008 ? 'huge' : suffixRoll < 0.1 ? 'long' : 'normal';
      const before = makePadding(rng, prefixMode, item.kind !== 'hostname');
      const after = makePadding(rng, suffixMode, item.kind !== 'hostname');
      const sepBefore = item.kind === 'hostname' ? (rng() < 0.5 ? ' ' : '') : '';
      const sepAfter =
        item.kind === 'hostname'
          ? rng() < 0.5
            ? ' '
            : ''
          : item.kind === 'port'
            ? pick(rng, [' ', '\t', '\n', '\u00a0', '\u3000', '\u2028'] as const)
            : '';
      const input = `visible ${before}${sepBefore}${item.secretText}${sepAfter}${after} tail`;

      const forbiddenPieces = item.forbidden.flatMap(collectForbiddenTokens);

      for (const [fn, limit] of [
        [modelTitle, 512],
        [modelText, 32_768],
      ] as const) {
        const out = fn(input, item.hostname);
        expect(out.length).toBeGreaterThan(0);
        expect([...out].length).toBeLessThanOrEqual(limit);
        expect(out).not.toMatch(LONE_SURROGATE_RE);

        const normalized = out.normalize('NFKC').replace(/\p{M}/gu, '').toLowerCase();
        for (const piece of forbiddenPieces) {
          expect(normalized, `sample #${i} (${item.kind}) leaked "${piece}" from "${item.secretText}"`).not.toContain(
            piece,
          );
        }
      }
    }

    expect(performance.now() - t0).toBeLessThan(30_000);
  }, 30_000);

  describe('explicit 10-category degradation regression samples', () => {
    const assertHidden = (samples: readonly [string, string, string][]) => {
      for (const [input, hostname, secret] of samples) {
        for (const fn of [modelTitle, modelText]) {
          const out = fn(input, hostname).normalize('NFKC').replace(/\p{M}/gu, '').toLowerCase();
          expect(out, `${fn.name}(${JSON.stringify(input)}) leaked ${secret}`).not.toContain(secret.toLowerCase());
        }
      }
    };

    it('M1: rejects 2-segment domains including unlisted TLDs without other structural chars', () => {
      assertHidden([
        ['open zqvx-node.com', 'fixture-host', 'zqvx-node'],
        ['open zqvx-corp.nz', 'fixture-host', 'zqvx-corp'],
        ['connect zqvx-db.prod', 'fixture-host', 'prod'],
        ['visit zqvx-wiki.intra', 'fixture-host', 'intra'],
        ['open zqvx-portal.app', 'fixture-host', 'zqvx-portal'],
        ['ssh zqvx-auth.sh', 'fixture-host', 'zqvx-auth'],
        ['open /Volumes/zqvx-corp.nz', 'fixture-host', 'zqvx-corp'],
      ]);
    });

    it('M2: rejects Zone-ID / percent tokens without :: or brackets', () => {
      assertHidden([
        ['ping zqvx-fe80%eth0', 'fixture-host', 'eth0'],
        ['ping zqvx-link%en0', 'fixture-host', 'en0'],
        ['ping zqvx-id％eth0', 'fixture-host', 'eth0'],
        ['open host%eth0/README.md', 'fixture-host', 'eth0'],
      ]);
      // M2a: path containing % before / must be rejected as host rather than stripped to basename README.md
      for (const fn of [modelTitle, modelText]) {
        expect(fn('open host%eth0/README.md', 'fixture-host')).not.toContain('README.md');
      }
    });

    it('M3: rejects bracketed host/address tokens without :: or /', () => {
      assertHidden([
        ['open [zqvx-node]', 'fixture-host', 'zqvx-node'],
        ['open [198-51]', 'fixture-host', '198-51'],
        ['open ［zqvx-box］', 'fixture-host', 'zqvx-box'],
        ['open [secret-org]/repo/README.md', 'fixture-host', 'secret-org'],
      ]);
      // M3a: bracketed endpoint in path must redact the whole path instead of keeping README.md
      for (const fn of [modelTitle, modelText]) {
        expect(fn('open [secret-org]/repo/README.md', 'fixture-host')).not.toContain('README.md');
      }
    });

    it('M4: rejects colon host:port, standalone :port, and host: port tokens', () => {
      assertHidden([
        ['connect zqvx-node:8443', 'fixture-host', '8443'],
        ['listen :8080', 'fixture-host', '8080'],
        ['connect host: 8080', 'fixture-host', '8080'],
        ['connect zqvx-node：8443', 'fixture-host', '8443'],
        ['connect zqvx-node∶8080', 'fixture-host', '8080'],
        ['connect foo:zqvx.corp:8080', 'fixture-host', 'zqvx'],
        ['connect host\uff1a 8443', 'fixture-host', '8443'],
        ['connect host\u2236 9090', 'fixture-host', '9090'],
      ]);
      // M10b & M11: fullwidth/ratio colon before space still triggers port redaction and NFKC colon output
      expect(modelTitle('connect host\uff1a 8443', 'fixture-host')).toBe('connect host: <host>');
      expect(modelText('connect host\uff1a 8443', 'fixture-host')).toBe('connect host: [host]');
      expect(modelTitle('connect host\u2236 9090', 'fixture-host')).toBe('connect host: <host>');
      expect(modelText('connect host\u2236 9090', 'fixture-host')).toBe('connect host: [host]');
    });

    it('M5: rejects 1-2 segment UNC and //server paths including mixed slashes', () => {
      assertHidden([
        ['open \\\\zqvx-srv\\mkgp-share', 'fixture-host', 'mkgp-share'],
        ['open //zqvx-srv/mkgp-share', 'fixture-host', 'mkgp-share'],
        ['open //zqvx-srv', 'fixture-host', 'zqvx-srv'],
        ['open \\/zqvx-srv/mkgp-share', 'fixture-host', 'mkgp-share'],
        ['open /\\zqvx-srv\\mkgp-share', 'fixture-host', 'mkgp-share'],
      ]);
      // M5b: modelPath must redact UNC/server paths and mid-dot hostnames rather than exposing basename
      expect(modelPath('//corp-fs/secret-share')).toBe('[path]');
      expect(modelPath('\\\\corp-fs\\secret-share')).toBe('[path]');
      expect(modelPath('//corp-fs')).toBe('[path]');
      expect(modelPath('/Users/alice/dir/secret\u00b7corp\u00b7internal')).toBe('[path]');
    });

    it('M6: rejects :: IPv6/colon tokens without dots or brackets', () => {
      assertHidden([
        ['ssh 2001:db8::8a2e', 'fixture-host', '8a2e'],
        ['connect zqvx::1', 'fixture-host', 'zqvx'],
        ['connect zqvx∶∶1', 'fixture-host', 'zqvx'],
      ]);
    });

    it('M7: rejects 3+ dot segments without :// or : unless valid multi-dot safe filename', () => {
      assertHidden([
        ['visit zqvx.mkgp.internal', 'fixture-host', 'zqvx'],
        ['ping 198.51.100.42', 'fixture-host', '198.51'],
        ['ping 198．51．100．42', 'fixture-host', '198.51'],
        ['ping 198․51․100․42', 'fixture-host', '198.51'],
        ['open secret.corp.nz', 'fixture-host', 'secret'],
        ['open 192.168.1.1.md', 'fixture-host', '192.168'],
        ['open a.b.c.d.md', 'fixture-host', 'a.b.c.d'],
        ['open secret\u00b7corp\u00b7md', 'fixture-host', 'secret'],
        ['open .secret.md', 'fixture-host', 'secret'],
      ]);
      expect(modelTitle('open report.final.pdf', 'fixture-host')).toBe('open report.final.pdf');
    });

    it('M8: rejects :// scheme tokens without extra dots or ports', () => {
      assertHidden([
        ['open https://zqvx-internal', 'fixture-host', 'zqvx-internal'],
        ['open ssh://zqvx-box', 'fixture-host', 'zqvx-box'],
        ['open https：//zqvx-db', 'fixture-host', 'zqvx-db'],
        ['open https：∕∕zqvx-db', 'fixture-host', 'zqvx-db'],
        ['open c://secret-host/dir/file.md', 'fixture-host', 'secret-host'],
      ]);
      // M8: drive-letter scheme form must redact the whole endpoint instead of exposing file.md
      expect(modelTitle('open c://secret-host/dir/file.md', 'fixture-host')).toBe('open <host>');
      expect(modelText('open c://secret-host/dir/file.md', 'fixture-host')).toBe('open [endpoint]');
    });

    it('M9: splits on non-ASCII Unicode whitespace and strips zero-width bypasses', () => {
      assertHidden([
        ['open\u00a0Zqvx Node', 'Zqvx Node', 'zqvx'],
        ['open\u3000Zqvx\u3000Node', 'Zqvx Node', 'zqvx'],
        ['open\u2028Zqvx\u00a0Node', 'Zqvx Node', 'node'],
        ['open zqvx\u200b-node', 'zqvx-node', 'zqvx'],
        ['ping 198\u200b.51\u200c.100\ufeff.42', 'fixture-host', '198.51'],
        ['on build-host', 'build\u200b-host', 'build'],
      ]);
      // M9a: Unicode whitespace collapses and splits tokens rather than treating the whole run as opaque
      expect(modelTitle('open\u00a0README.md\u3000ok', 'fixture-host')).toBe('open README.md ok');
      expect(modelText('open\u00a0Zqvx Node', 'Zqvx Node')).toBe('open [host]');
      // M9b: default-ignorable code points are stripped from both input and hostname
      expect(modelTitle('on a\u200bb', 'fixture-host')).toBe('on ab');
      expect(modelTitle('on build-host', 'build\u200b-host')).toBe('on <host>');
    });

    it('M10: enforces full Unicode case folding and NFC/NFD/NFKC hostname equivalence', () => {
      assertHidden([
        ['on vbrnß', 'vbrnSS', 'vbrn'],
        ['on \u03a5\u0308\u0301-mkgp', '\u03b0-mkgp', 'mkgp'],
        ['on \u0130-zqvx', 'i\u0307-zqvx', 'zqvx'],
        ['on CAFÉ-MKGP', 'cafe\u0301-mkgp', 'mkgp'],
        ['on ｚｑｖｘ－ｈｏｓｔ', 'zqvx-host', 'zqvx'],
      ]);
    });
  });
});
