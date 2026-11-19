import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { redactCredentials, scanCredentials } from '../../src/host/dsh/credential-scan.ts';
import {
  environmentDetail,
  modelActivityName,
  modelPath,
  modelState,
  modelText,
  modelTitle,
} from '../../src/host/dsh/tool-output.ts';
import type { createSenseRuntime } from '../../src/host/runtime/index.ts';
import { StateStore } from '../../src/host/state/store.ts';

type DetailRuntime = Pick<ReturnType<typeof createSenseRuntime>, 'tools' | 'events' | 'rules'>;
type DetailEvent = ReturnType<DetailRuntime['events']>[number];

function makeProjectionRuntime(
  frontName: string,
  bundleId: string,
  windowTitle: string,
  events: DetailEvent[],
  sourceRef: { id: string; api: string; host: string },
) {
  const state = new StateStore(() => 990).snapshot();
  state.env.frontApp.value = { name: frontName, bundleId, pid: 421, windowCount: 2 };
  state.env.frontApp.status = 'ok';
  state.env.focusedWindow.value = { title: windowTitle };
  state.env.focusedWindow.status = 'ok';
  state.observation.sources[sourceRef.id] = { status: 'ok', lastSignalAt: 990 };
  const rt = {
    tools: { envState: (section?: 'self' | 'env' | 'observation') => (section ? state[section] : state) },
    events: () => events,
    rules: {},
  } as unknown as DetailRuntime;
  return { state, rt };
}

function assertNoSubstrings8(json: string, token: string, label: string): void {
  if (token.length < 8) {
    expect(json, label).not.toContain(token);
    return;
  }
  for (let i = 0; i <= token.length - 8; i++) {
    expect(json, `${label} leaked 8-char slice`).not.toContain(token.slice(i, i + 8));
  }
}

describe('unified credential scanner', () => {
  it('redacts all rule 1a strong prefixes, 1b contexts, and 1c high-entropy spans while keeping surrounding text', () => {
    const cases: readonly [string, string][] = [
      ['ghp=ghp_1234567890abcdef', 'ghp=[redacted]'],
      ['a gho_1234567890abcdef b', 'a [redacted] b'],
      ['ghu_1234567890abcdef', '[redacted]'],
      ['ghs_1234567890abcdef', '[redacted]'],
      ['ghr_1234567890abcdef', '[redacted]'],
      ['github_pat_11ABCDEF0123456789', '[redacted]'],
      ['glpat-abcdef1234567890', '[redacted]'],
      ['npm_abcdef1234567890', '[redacted]'],
      ['hf_abcdef1234567890', '[redacted]'],
      ['xoxb-12345678-abcdefgh', '[redacted]'],
      ['xoxa-12345678-abcdefgh', '[redacted]'],
      ['xoxp-12345678-abcdefgh', '[redacted]'],
      ['xoxr-12345678-abcdefgh', '[redacted]'],
      ['xoxs-12345678-abcdefgh', '[redacted]'],
      ['AIzaSyDummyKey1234567890', '[redacted]'],
      ['ASIAIOSFODNN7EXAMPLE', '[redacted]'],
      ['sk_live_1234567890abcdef', '[redacted]'],
      ['rk_live_1234567890abcdef', '[redacted]'],
      ['pk_test_1234567890abcdef', '[redacted]'],
      ['-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA7V5+9X/1aB2c3D4e5F6g7H8i9J0=', '[redacted]\n[redacted]'],
      ['Basic dXNlcjpwYXNz', 'Basic [redacted]'],
      ['Authorization: Basic dXNlcjpwYXNz', 'Authorization: Basic [redacted]'],
      ['token=secret123&ok=1', 'token=[redacted]&ok=1'],
      ['api_key="my secret key 123"', 'api_key="[redacted]"'],
      ['password=P@ssw0rd!123 done', 'password=[redacted] done'],
      ['secret=alpha99beta88', 'secret=[redacted]'],
      ['sha 39163dd30f703a79079e2d2446545cff3c453738 ok', 'sha [redacted] ok'],
      ['b64 aB3dE6gH9jK2mN5p/Q8sT1vW4yZ7bC0e ok', 'b64 [redacted] ok'],
      ['prefix-ghp_1234567890abcdef tail', 'prefix-[redacted] tail'],
    ];
    for (const [input, expected] of cases) {
      expect(redactCredentials(input), input).toBe(expected);
      expect(redactCredentials(expected), `idempotent: ${input}`).toBe(expected);
    }
    expect(scanCredentials('Authorization: Bearer dGhpcy1pcy1hLWJlYXJlci10b2tlbl8xMjM0NTY3ODkw')).toEqual([
      { start: 22, end: 66 },
    ]);
  });

  describe('rrv-015a discovery-1 and rv-015a round-1 corpus leaks across env_detail and env_state', () => {
    const long288 = `${'dGhpcy1pcy1hLXZlcnktbG9uZy1zZWNyZXQtdmFsdWUtaW4tYmFzZTY0dXJsX2Zvcm1hdF8xMjM0NTY3ODkw'.repeat(3)}aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0e4`;
    const corpus: readonly { raw: string; secret: string; checkAppName?: boolean }[] = [
      // rrv-015a Discovery 1 (all 23 leak cases)
      {
        raw: 'Bearer AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-',
        secret: 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-',
        checkAppName: true,
      },
      {
        raw: 'Authorization: Bearer dGhpcy1pcy1hLWJlYXJlci10b2tlbl8xMjM0NTY3ODkw',
        secret: 'dGhpcy1pcy1hLWJlYXJlci10b2tlbl8xMjM0NTY3ODkw',
        checkAppName: true,
      },
      { raw: 'bearer abcdef1234567890', secret: 'abcdef1234567890', checkAppName: true },
      { raw: 'Bearer\tabcdef1234567890', secret: 'abcdef1234567890', checkAppName: true },
      {
        raw: 'dGhpcy1pcy1hLXZlcnktbG9uZy1zZWNyZXQtdmFsdWUtaW4tYmFzZTY0dXJsX2Zvcm1hdF8xMjM0NTY3ODkw',
        secret: 'dGhpcy1pcy1hLXZlcnktbG9uZy1zZWNyZXQtdmFsdWUtaW4tYmFzZTY0dXJsX2Zvcm1hdF8xMjM0NTY3ODkw',
        checkAppName: true,
      },
      {
        raw: 'tskey-auth-k123456CNTRL-abcdefghijklmnopqrstuv',
        secret: 'tskey-auth-k123456CNTRL-abcdefghijklmnopqrstuv',
        checkAppName: true,
      },
      {
        raw: 'pypi-AgEIcHlwaS5vcmcCJGYwMTIzNDU2Nzg5',
        secret: 'pypi-AgEIcHlwaS5vcmcCJGYwMTIzNDU2Nzg5',
        checkAppName: true,
      },
      {
        raw: 'dop_v1_abcdef0123456789abcdef0123456789',
        secret: 'dop_v1_abcdef0123456789abcdef0123456789',
        checkAppName: true,
      },
      { raw: 'lin_api_abcdef1234567890abcdef', secret: 'lin_api_abcdef1234567890abcdef', checkAppName: true },
      { raw: 'gsk_abcdef1234567890abcdef', secret: 'gsk_abcdef1234567890abcdef', checkAppName: true },
      { raw: long288, secret: long288, checkAppName: true },
      { raw: 'com.example.app-AKIAIOSFODNN7EXAMPLE', secret: 'AKIAIOSFODNN7EXAMPLE', checkAppName: true },
      { raw: 'com.my-AKIAIOSFODNN7EXAMPLE.app', secret: 'AKIAIOSFODNN7EXAMPLE', checkAppName: true },
      { raw: 'com.example.AKIAIOSFODNN7EXAMPLE-dev', secret: 'AKIAIOSFODNN7EXAMPLE', checkAppName: true },
      {
        raw: 'com.example.foo-eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV',
        secret: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV',
        checkAppName: true,
      },
      { raw: 'ya29.a0AfH6SMBx1234567890abcdef', secret: 'ya29.a0AfH6SMBx1234567890abcdef', checkAppName: true },
      {
        raw: 'MTIzNDU2Nzg5MDEyMzQ1Njc4.Gabcde.abcdefghijklmnopqrstuvwxyz1234567890',
        secret: 'MTIzNDU2Nzg5MDEyMzQ1Njc4.Gabcde.abcdefghijklmnopqrstuvwxyz1234567890',
        checkAppName: true,
      },
      { raw: '/tmp/key-AKIAIOSFODNN7EXAMPLE', secret: 'AKIAIOSFODNN7EXAMPLE', checkAppName: true },
      { raw: '/tmp/aws-AKIAIOSFODNN7EXAMPLE.json', secret: 'AKIAIOSFODNN7EXAMPLE', checkAppName: true },
      { raw: '~/key-ghp_1234567890abcdef', secret: 'ghp_1234567890abcdef', checkAppName: true },
      { raw: '~/key-ghp_1234567890abcdef.txt', secret: 'ghp_1234567890abcdef', checkAppName: true },
      { raw: 'prefix-ghp_1234567890abcdef', secret: 'ghp_1234567890abcdef', checkAppName: true },
      { raw: 'AKIAIOSFODNN7EXAMPLE_extra', secret: 'AKIAIOSFODNN7EXAMPLE', checkAppName: true },
      // rv-015a Round 1 (all 14 cases)
      { raw: 'token-abc_def_123456', secret: 'token-abc_def_123456', checkAppName: true },
      { raw: 'secret_my-key-123456', secret: 'secret_my-key-123456', checkAppName: true },
      { raw: 'api_key-test_12345678', secret: 'api_key-test_12345678', checkAppName: true },
      { raw: 'bearer_abc_1234567890', secret: 'bearer_abc_1234567890', checkAppName: true },
      { raw: 'com.example.sk-aaaaaaaaaaaaaaaa', secret: 'sk-aaaaaaaaaaaaaaaa', checkAppName: true },
      {
        raw: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
        secret: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
        checkAppName: true,
      },
      {
        raw: 'SG.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb',
        secret: 'SG.aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb',
        checkAppName: true,
      },
      { raw: 'hf_cccccccccccccccc', secret: 'hf_cccccccccccccccc', checkAppName: true },
      { raw: 'pk_live_dddddddddddddddd', secret: 'pk_live_dddddddddddddddd', checkAppName: true },
      { raw: 'rk_test_eeeeeeeeeeeeeeee', secret: 'rk_test_eeeeeeeeeeeeeeee', checkAppName: true },
      { raw: 'xoxc-11111111-ffffffffffffffff', secret: 'xoxc-11111111-ffffffffffffffff', checkAppName: true },
      { raw: 'com.example.token-abc-def-123456', secret: 'token-abc-def-123456', checkAppName: true },
      { raw: 'user@corp.invalid', secret: 'user@corp.invalid', checkAppName: false },
      { raw: 'alice@corp.invalid', secret: 'alice@corp.invalid', checkAppName: false },
    ];

    it.each(corpus)(
      'never leaks $raw via env_detail, env_state, or direct model helpers',
      ({ raw, secret, checkAppName }) => {
        const src = { id: raw, api: raw, host: 'fixture-host.invalid' };
        const event: DetailEvent = {
          id: 'ev-1',
          kind: 'window.focused',
          subject: raw,
          level: 'record',
          at: 990,
          source: src,
        };
        const { state, rt } = makeProjectionRuntime(checkAppName ? raw : 'Mail', raw, raw, [event], src);

        const detailJson = JSON.stringify(environmentDetail(rt));
        const stateJson = JSON.stringify(modelState(state, 990));
        for (const [channel, json] of [
          ['env_detail', detailJson],
          ['env_state', stateJson],
        ] as const) {
          expect(json, channel).not.toContain(raw);
          assertNoSubstrings8(json, secret, `${channel}(${raw})`);
        }

        for (const [fnName, out] of [
          ['modelText', modelText(raw, 'fixture-host')],
          ['modelTitle', modelTitle(raw, 'fixture-host')],
          ['modelPath', modelPath(raw)],
          ['modelActivityName', modelActivityName(raw, true)],
        ] as const) {
          expect(out, fnName).not.toContain(raw);
          assertNoSubstrings8(out, secret, `${fnName}(${raw})`);
        }
      },
    );
  });

  it('preserves low-entropy phrases, normal filenames, and valid bundleIds without false positives', () => {
    const safeWords = [
      'password-reset-handler',
      'api-key-rotation-docs',
      'report-2026-11-19.txt',
      'IMG_0042.png',
      'SyntaxEditor',
      'app-activated',
      'token-count',
      'secret_note',
      'README.md',
      'password-reset-flow',
      'Bearer',
      'Basic settings',
    ];
    for (const word of safeWords) {
      expect(redactCredentials(word), word).toBe(word);
      expect(modelText(word, 'fixture-host'), `modelText(${word})`).toBe(word);
      expect(modelTitle(word, 'fixture-host'), `modelTitle(${word})`).toBe(word);
      const src = { id: 'helper.ax', api: 'accessibility', host: 'fixture-host' };
      const ev: DetailEvent = {
        id: 'ok',
        kind: 'window.focused',
        subject: word,
        level: 'record',
        at: 990,
        source: src,
      };
      const { state, rt } = makeProjectionRuntime('Demo App', 'com.example.App', word, [ev], src);
      const stateOut = modelState(state, 990, 'env') as { focusedWindow: { value: { title: string } } };
      const detailOut = environmentDetail(rt) as {
        window: { value: { title: string } };
        recentEvents: Array<{ subject: string }>;
      };
      expect(stateOut.focusedWindow.value.title).toBe(word);
      expect(detailOut.window.value.title).toBe(word);
      expect(detailOut.recentEvents[0]?.subject).toBe(word);
    }
    expect(modelActivityName(`${os.homedir()}/projects/asi/app.ts`, true)).toBe('app.ts');

    const safeBundleIds = [
      'com.example.password-management-helper',
      'com.example.App',
      'com.example.app-helper',
      'org.example.Browser2',
      'org.mozilla.firefox',
      'com.apple.Safari',
      'com.microsoft.VSCode',
      'com.example.token-viewer',
    ];
    for (const bundleId of safeBundleIds) {
      expect(redactCredentials(bundleId), bundleId).toBe(bundleId);
      const src = { id: 'helper.ax', api: 'accessibility', host: 'fixture-host' };
      const { state, rt } = makeProjectionRuntime('Demo App', bundleId, 'README.md', [], src);
      const stateOut = modelState(state, 990, 'env') as { frontApp: { value: { bundleId: string } } };
      const detailOut = environmentDetail(rt) as { app: { value: { bundleId: string } } };
      expect(stateOut.frontApp.value.bundleId).toBe(bundleId);
      expect(detailOut.app.value.bundleId).toBe(bundleId);
    }
  });

  it('scans 10k random characters in <5ms', () => {
    let seed = 0x5eed1000;
    const rng = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 4_294_967_296;
    };
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_+/=- .:/\\';
    const input = Array.from({ length: 10_000 }, () => alphabet[Math.floor(rng() * alphabet.length)]).join('');
    for (let i = 0; i < 60; i++) scanCredentials(input);
    const samples: number[] = [];
    for (let i = 0; i < 40; i++) {
      const t0 = performance.now();
      scanCredentials(input);
      samples.push(performance.now() - t0);
    }
    samples.sort((a, b) => a - b);
    expect(samples[Math.floor(samples.length / 2)]).toBeLessThan(5);
  });
});
