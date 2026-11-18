import { describe, expect, it } from 'vitest';
import { modelText, modelTitle } from '../../src/host/dsh/tool-output.ts';

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

function collectFourCharSlices(value: string): string[] {
  const clean = value.replace(/\p{M}/gu, '').toLowerCase();
  const chars = [...clean];
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
  kind: 'hostname' | 'ipv4' | 'ipv6' | 'email' | 'path' | 'endpoint';
}

const PAD_DELIMS = [' ', '\t', '\n', '\u00a0', ',', ';', '(', ')', '|', '"', "'", '<', '>'] as const;
const PAD_PUNCT = ['!', '?', '-', '_', '[', ']', '~', '+', '*'] as const;
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
    else if (roll < 0.6) parts.push(pick(rng, PAD_DELIMS));
    else if (roll < 0.78) parts.push(pick(rng, PAD_PUNCT));
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
  const category = Math.floor(rng() * 6);
  if (category === 0) {
    const variants: [string, string, string[]][] = [
      ['zqvx-build-node', 'ZqVx-BuIlD-NoDe', ['zqvx-build-node']],
      ['zqvx-db.corp.invalid', 'zqvx-db.corp.invalid', ['zqvx-db', 'corp', 'invalid']],
      ['Zqvx Node', 'zqvX NoDe', ['zqvx node']],
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
      ['198.51', ['198.51']],
      ['(203.0.113.77)', ['203.0', '0.113', '113.77']],
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
      ['[fe80::1%en0]:2222', ['fe80', '2222']],
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
      ['\\\\zqvx-srv\\mkgp-share', ['zqvx-srv', 'mkgp-share']],
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
    ['ssh://zqvxuser@mkgp-box:2222/vbrn-path', ['zqvxuser', 'mkgp-box', '2222', 'vbrn-path']],
  ];
  const [secretText, forbidden] = pick(rng, variants);
  return { hostname: 'fixture-host', secretText, forbidden, kind: 'endpoint' };
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
      const prefixMode = prefixRoll < 0.005 ? 'huge' : prefixRoll < 0.085 ? 'long' : 'normal';
      const suffixMode = suffixRoll < 0.005 ? 'huge' : suffixRoll < 0.085 ? 'long' : 'normal';
      // Avoid merging a trailing combining mark onto a plain hostname without delimiter.
      const before = makePadding(rng, prefixMode, item.kind !== 'hostname');
      const after = makePadding(rng, suffixMode, item.kind !== 'hostname');
      const sepBefore = item.kind === 'hostname' ? (rng() < 0.5 ? ' ' : '') : '';
      const sepAfter = item.kind === 'hostname' ? (rng() < 0.5 ? ' ' : '') : '';
      const input = `visible ${before}${sepBefore}${item.secretText}${sepAfter}${after} tail`;

      const forbiddenPieces = item.forbidden.flatMap(collectFourCharSlices);

      for (const [fn, limit] of [
        [modelTitle, 512],
        [modelText, 32_768],
      ] as const) {
        const out = fn(input, item.hostname);
        expect(out.length).toBeGreaterThan(0);
        expect([...out].length).toBeLessThanOrEqual(limit);
        expect(out).not.toMatch(LONE_SURROGATE_RE);

        const normalized = out.normalize('NFC').replace(/\p{M}/gu, '').toLowerCase();
        for (const piece of forbiddenPieces) {
          expect(normalized, `sample #${i} leaked "${piece}" from "${item.secretText}"`).not.toContain(piece);
        }
      }
    }

    expect(performance.now() - t0).toBeLessThan(30_000);
  }, 30_000);
});
