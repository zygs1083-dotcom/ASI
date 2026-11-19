import type { DeliveryLevel, EnvChange, EnvUpdate, SenseState, Signal } from '@asi/sense-types';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { SessionId } from '@deepseek-ai/dsh-session';
import { describe, expect, it, vi } from 'vitest';
import { formatEnvUpdate } from '../../src/host/delivery/format.ts';
import {
  containsCredential,
  normalizeForModel,
  redactCredentials,
  sanitizeForModel,
  sanitizeModelId,
  sanitizeSignalId,
  scanCredentials,
} from '../../src/host/dsh/credential-scan.ts';
import { createDelivery, modelUpdate } from '../../src/host/dsh/deliver.ts';
import { modelHistory } from '../../src/host/dsh/history-output.ts';
import {
  environmentDetail,
  modelActivityName,
  modelState,
  modelText,
  modelTitle,
} from '../../src/host/dsh/tool-output.ts';
import { StateStore } from '../../src/host/state/store.ts';

type DetailRuntime = Parameters<typeof environmentDetail>[0];

function assertNoSubstrings8(serialized: string, secret: string, label: string): void {
  if (secret.length < 8) {
    expect(serialized, `${label}: full short secret "${secret}" leaked`).not.toContain(secret);
    return;
  }
  const seen = new Set<string>();
  for (let i = 0; i <= secret.length - 8; i++) {
    const sub = secret.slice(i, i + 8);
    if (seen.has(sub)) continue;
    seen.add(sub);
    expect(serialized, `${label}: 8-char secret slice "${sub}" leaked in ${serialized}`).not.toContain(sub);
  }
}

function makeFakeState(): SenseState {
  const state = new StateStore(() => 990).snapshot();
  state.env.frontApp.value = { name: 'EditorApp', bundleId: 'com.example.Editor', pid: 101, windowCount: 1 };
  state.env.frontApp.status = 'ok';
  state.env.focusedWindow.value = { title: 'notes.md' };
  state.env.focusedWindow.status = 'ok';
  return state;
}

function makeFakeDetailRuntime(state: SenseState, recentSubjects: string[]): DetailRuntime {
  const src = { id: 'helper.ax', api: 'accessibility', host: 'fixture-host.invalid' };
  const events = recentSubjects.map((subject, idx) => ({
    id: `ev-${idx}`,
    kind: idx % 2 === 0 ? 'window.focused' : 'app.activated',
    subject,
    level: 'context' as const,
    at: 990 + idx,
    source: src,
  }));
  return {
    state: { subscribe: () => () => {} },
    events: () => events,
    rules: { list: () => [], add: vi.fn(), remove: vi.fn(), toggle: vi.fn(), approve: vi.fn() },
    actions: {},
    tools: {
      envState: (section?: 'self' | 'env' | 'observation') => {
        const copy = structuredClone(state);
        return section ? copy[section] : copy;
      },
      envWatch: vi.fn(),
      envMetrics: vi.fn(),
      envHistory: vi.fn(),
      envSummary: vi.fn(),
      bodyTune: vi.fn(),
      refreshDetail: async () => true,
    },
    start: async () => {},
    stop: async () => {},
  } as unknown as DetailRuntime;
}

function makeSignal(overrides: Partial<Signal> & { id?: string; kind?: string; subject?: string } = {}): Signal {
  return {
    id: overrides.id ?? 'sig-1',
    kind: overrides.kind ?? 'window.focused',
    at: overrides.at ?? 1_000,
    source: overrides.source ?? { id: 'helper.ax', api: 'accessibility', host: 'fixture-host.invalid' },
    subject: overrides.subject ?? 'notes.md',
    data: overrides.data ?? {},
  };
}

function makeChange(signal: Signal, extra: Partial<EnvChange> = {}): EnvChange {
  return {
    signal,
    count: extra.count ?? 1,
    level: extra.level ?? 'context',
    ...(extra.ruleId !== undefined ? { ruleId: extra.ruleId } : {}),
    ...(extra.note !== undefined ? { note: extra.note } : {}),
    ...(extra.reason !== undefined ? { reason: extra.reason } : {}),
  };
}

function makeFakeAgent(): { agent: Agent; followup: ReturnType<typeof vi.fn> } {
  const followup = vi.fn();
  const agent = {
    id: SessionId('session-cred-test'),
    status: 'idle',
    send: vi.fn(),
    inject: vi.fn(),
    followup,
    steer: vi.fn(),
  } as unknown as Agent;
  return { agent, followup };
}

function makeRandomMixed(len: number): string {
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_+/-=!?:,. ';
  let seed = 0x1234_5678;
  const chars: string[] = [];
  for (let i = 0; i < len; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    // Periodic separators keep chunks below raw 32+ high-entropy spam while exercising all transitions.
    chars.push(i % 19 === 18 ? ' ' : (alpha[seed % alpha.length] ?? 'a'));
  }
  return chars.join('');
}

describe('credential scanner contracts (契约 1–5) and single-entry normalization', () => {
  it('detects Contract 1 strong prefixes at arbitrary substring positions while scoping sk-', () => {
    const strongTokens = [
      'prefix-ghp_1234567890abcdef',
      'x/gho_1234567890abcdef',
      'x_ghu_1234567890abcdef',
      'x:ghs_1234567890abcdef',
      'x=ghr_1234567890abcdef',
      'pre-github_pat_1234567890abcdef',
      'pre-glpat-1234567890abcdef',
      'pre-npm_1234567890abcdef',
      'pre-hf_1234567890abcdef',
      'pre-xoxb-12345678-1234567890',
      'pre-xoxc-12345678-1234567890abcdef',
      'pre-xoxe-12345678-1234567890abcdef',
      'pre-AIzaSyA1234567890abcdef',
      'com.example.app-AKIAIOSFODNN7EXAMPLE',
      'com.my-ASIAIOSFODNN7EXAMPLE.app',
      'pre-sk-proj-1234567890abcdef',
      'pre-sk-ant-api03-1234567890abcdef',
      'pre-sk_live_1234567890abcdef',
      'pre-sk_test_1234567890abcdef',
      'pre-pk_live_1234567890abcdef',
      'pre-pk_test_1234567890abcdef',
      'pre-rk_live_1234567890abcdef',
      'pre-rk_test_1234567890abcdef',
      'pre-SG.abcdefghijklmnop.1234567890abcdef',
      'pre-tskey-auth-k123456CNTRL-abcdefgh',
      'pre-pypi-AgEIcHlwaS5vcmcCJGYwMTIzNDU2',
      'pre-dop_v1_abcdef0123456789abcdef',
      'pre-lin_api_abcdef1234567890',
      'pre-gsk_abcdef1234567890',
      'pre-ya29.a0AfH6SMBx12345678',
      'foo-eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV',
      '-----BEGIN PRIVATE KEY-----',
    ];
    for (const tok of strongTokens) {
      const out = sanitizeForModel(tok);
      expect(out, `Contract 1 failed on ${tok}`).toContain('[redacted]');
    }

    // `sk-` scoped to >=20 chars AND containing a digit
    expect(sanitizeForModel(`sk-${'a'.repeat(18)}12`)).toBe('[redacted]');
    expect(sanitizeForModel(`com.example.sk-${'a'.repeat(18)}12`)).toBe('com.example.[redacted]');
    expect(sanitizeForModel('sk-design-system')).toBe('sk-design-system');
    expect(sanitizeForModel(`sk-${'a'.repeat(24)}`)).toBe(`sk-${'a'.repeat(24)}`);
  });

  it('detects Contract 2 auth contexts without triggering on plain English words or snake_case identifiers', () => {
    expect(sanitizeForModel('Bearer AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-')).toBe('Bearer [redacted]');
    expect(sanitizeForModel('(Bearer\nwrappedNlSecret1234)')).toBe('(Bearer [redacted])');
    expect(sanitizeForModel('Authorization:\u00a0Basic dXNlcjpwYXNzMTIzNA==')).toBe('Authorization: Basic [redacted]');
    expect(sanitizeForModel('Authorization：fullwidthSecret12345')).toBe('Authorization:[redacted]');
    expect(sanitizeForModel('Token=tok_9876543210')).toBe('Token=[redacted]');
    expect(sanitizeForModel('Token: alphaNumericHighEntXyZ')).toBe('Token: [redacted]');

    // Non-chased plain English words after auth scheme
    expect(sanitizeForModel('OAuth2 Bearer Token - MDN Web Docs')).toBe('OAuth2 Bearer Token - MDN Web Docs');
    expect(sanitizeForModel('Basic TypeScript Handbook')).toBe('Basic TypeScript Handbook');
    expect(sanitizeForModel('Basic JavaScript Tutorial')).toBe('Basic JavaScript Tutorial');
    expect(sanitizeForModel('MY_VAL=foo\\ secret_token /usr/bin/ssh prod')).toBe(
      'MY_VAL=foo\\ secret_token /usr/bin/ssh prod',
    );
    expect(sanitizeForModel('api_key=foo\\ secret_token /usr/bin/ssh prod')).toBe(
      'api_key=[redacted] secret_token /usr/bin/ssh prod',
    );
  });

  it('detects Contract 3 KV pairs and Mode 3b key[-_]value (>=12 chars with digit)', () => {
    const kvCases: Array<[string, string]> = [
      ['apiKey: colon_kv_secret_12345', 'colon_kv_secret_12345'],
      ['api_key： fullwidthKvSecret12345', 'fullwidthKvSecret12345'],
      ['{"apiKey":"json_secret_value_12345"}', 'json_secret_value_12345'],
      ['{"clientSecret": "client_sec_val_99"}', 'client_sec_val_99'],
      ['refresh_token=ref_tok_val_12345', 'ref_tok_val_12345'],
      ['privateKey: priv_key_material_99', 'priv_key_material_99'],
      ['pwd=shortPwd9', 'shortPwd9'],
      ['token-abc_def_123456', 'token-abc_def_123456'],
      ['secret_my-key-123456', 'secret_my-key-123456'],
      ['api_key-test_12345678', 'api_key-test_12345678'],
      ['bearer_abc_1234567890', 'bearer_abc_1234567890'],
      ['com.example.token-abc-def-123456', 'token-abc-def-123456'],
    ];
    for (const [input, secret] of kvCases) {
      const out = sanitizeForModel(input);
      expect(out, `KV failed on ${input}`).toContain('[redacted]');
      assertNoSubstrings8(out, secret, `KV:${input}`);
    }

    // Benign hyphenated docs / handlers must stay intact
    expect(sanitizeForModel('password-reset-handler')).toBe('password-reset-handler');
    expect(sanitizeForModel('secret-scanning-pipeline-v2')).toBe('secret-scanning-pipeline-v2');
    expect(sanitizeForModel('api-key-rotation-docs')).toBe('api-key-rotation-docs');
    expect(sanitizeForModel('token-bucket-rate-limiter')).toBe('token-bucket-rate-limiter');
  });

  it('detects Contract 4 URL userinfo passwords and Contract 5 high-entropy / >=40 hex strings', () => {
    expect(sanitizeForModel('https://alice:SuperSecretPass99@api.example.com/v1')).toBe(
      'https://alice:[redacted]@api.example.com/v1',
    );
    expect(sanitizeForModel('postgres://dbadmin:DbPassSecret123@db.internal:5432/prod')).toBe(
      'postgres://dbadmin:[redacted]@db.internal:5432/prod',
    );
    // Contract 5 segment-scoped on `-`/`_` (>=20 high-entropy segment with letters+digits) and whole-run >=32 without `-`/`_`
    expect(sanitizeForModel('deploy-live-a9Z2xK8mP4qR7tW1yB5nC3vL6hJ0fD9sG2')).toBe('deploy-live-[redacted]');
    expect(sanitizeForModel('a9Z2xK8mP4qR7tW1yB5nC3vL6hJ0fD9sG2')).toBe('[redacted]');
    expect(sanitizeForModel('project-directory-with-moderate-name-123')).toBe(
      'project-directory-with-moderate-name-123',
    );
    expect(sanitizeForModel('my-long-project-directory-name-2026')).toBe('my-long-project-directory-name-2026');
    // Contract 5 >=40 hex even when low entropy (both standalone and hyphen-delimited)
    expect(sanitizeForModel('000000000000000000000000a1b2c3d4e5f6a7b8')).toBe('[redacted]');
    expect(sanitizeForModel('deploy-live-000000000000000000000000a1b2c3d4e5f6a7b8')).toBe('deploy-live-[redacted]');
    expect(sanitizeForModel('token-prod-auth-39163dd30f703a79079e2d2446545cff3c453738')).toBe('[redacted]');
  });

  it('redacts any >=40 pure-hex run unconditionally (rrv-015a-3 contract-5 leak)', () => {
    // Report inputs: 40-hex with 5 distinct chars / no digit, and 2-distinct 'abab...'
    expect(sanitizeForModel('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')).toBe('[redacted]');
    expect(sanitizeForModel('abababababababababababababababababababab')).toBe('[redacted]');
    expect(sanitizeForModel('a'.repeat(40))).toBe('[redacted]');
    expect(sanitizeForModel('deploy-live-deadbeefdeadbeefdeadbeefdeadbeefdeadbeef')).toBe(
      'deploy-live-[redacted]',
    );
    // <40 hex runs stay governed by the entropy rules; non-hex runs unaffected
    expect(sanitizeForModel('deadbeefdeadbeefdeadbeefdeadbeefdeadbee')).toBe(
      'deadbeefdeadbeefdeadbeefdeadbeefdeadbee',
    );
    expect(sanitizeForModel('x'.repeat(64))).toBe('x'.repeat(64));
  });

  it('normalizes via single entry point, preserves emoji ZWJ, and is idempotent', () => {
    const emojiFamily = '👩\u200d👩\u200d👧';
    const raw = `\u200bＡＰＩ_ｋｅｙ： \x00g\u200bhp_1234567890abcdef\r\n${emojiFamily} `;
    const once = sanitizeForModel(raw);
    expect(once).toBe(`API_key: [redacted] ${emojiFamily} `);
    expect(sanitizeForModel(once)).toBe(once);
    expect(normalizeForModel('\0\u0007\u200b\ufeff')).toBe('');
    expect(containsCredential('g\u200bhp_1234567890abcdef')).toBe(true);
    expect(redactCredentials(normalizeForModel('hello ghp_1234567890abcdef'))).toBe('hello [redacted]');
    expect(scanCredentials('clean ascii sentence')).toHaveLength(0);
  });

  it('collapses credential-tainted IDs via sanitizeModelId / sanitizeSignalId while preserving strict signal digests', () => {
    const validSha = 'a'.repeat(64);
    expect(sanitizeSignalId(`body.rate:${validSha}`)).toEqual({ value: `body.rate:${validSha}`, redacted: false });
    expect(sanitizeSignalId(`file.burst:${validSha}`)).toEqual({ value: `file.burst:${validSha}`, redacted: false });
    expect(sanitizeSignalId('body.rate:notsha256')).toEqual({ value: 'body.rate:notsha256', redacted: false });
    expect(sanitizeSignalId('ghp_1234567890abcdef')).toEqual({ value: '[redacted]', redacted: true });
    expect(sanitizeModelId('token_secret_12345678')).toEqual({ value: '[redacted]', redacted: true });
    expect(sanitizeModelId('helper.ax')).toEqual({ value: 'helper.ax', redacted: false });
  });
});

interface LeakSample {
  id: string;
  input: string;
  secret: string;
  checkAppName?: boolean;
  skipStandaloneFormat?: boolean;
  bundleIdInput?: string;
}

const LEAK_CORPUS: LeakSample[] = [
  // --- rv-015a (13 active; com.example.sk-aaaaaaaaaaaaaaaa skipped by contract) ---
  { id: 'rv-01', input: 'token-abc_def_123456', secret: 'token-abc_def_123456' },
  { id: 'rv-02', input: 'secret_my-key-123456', secret: 'secret_my-key-123456' },
  { id: 'rv-03', input: 'api_key-test_12345678', secret: 'api_key-test_12345678' },
  { id: 'rv-04', input: 'bearer_abc_1234567890', secret: 'bearer_abc_1234567890' },
  {
    id: 'rv-06',
    input: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
    secret: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
  },
  { id: 'rv-07', input: 'SG.abcdefghijklmnop.1234567890abcdef', secret: 'SG.abcdefghijklmnop.1234567890abcdef' },
  { id: 'rv-08', input: 'hf_1234567890abcdef', secret: 'hf_1234567890abcdef' },
  { id: 'rv-09', input: 'pk_live_1234567890abcdef', secret: 'pk_live_1234567890abcdef' },
  { id: 'rv-10', input: 'rk_test_1234567890abcdef', secret: 'rk_test_1234567890abcdef' },
  { id: 'rv-11', input: 'xoxc-12345678-1234567890abcdef', secret: 'xoxc-12345678-1234567890abcdef' },
  { id: 'rv-12', input: 'com.example.token-abc-def-123456', secret: 'token-abc-def-123456' },
  {
    id: 'rv-13',
    input: 'user@corp.invalid',
    secret: 'user@corp.invalid',
    checkAppName: false,
    skipStandaloneFormat: true,
  },
  {
    id: 'rv-14',
    input: 'alice@corp.invalid',
    secret: 'alice@corp.invalid',
    checkAppName: false,
    skipStandaloneFormat: true,
  },

  // --- rrv-015a (23 active; #17 checks high-entropy Part 3, Part 1 listed in it.skip) ---
  {
    id: 'rrv-01',
    input: 'Bearer AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-',
    secret: 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-',
  },
  {
    id: 'rrv-02',
    input: 'Authorization: Bearer dGhpcy1pcy1hLWJlYXJlci10b2tlbl8xMjM0NTY3ODkw',
    secret: 'dGhpcy1pcy1hLWJlYXJlci10b2tlbl8xMjM0NTY3ODkw',
  },
  { id: 'rrv-03', input: 'bearer abcdef1234567890', secret: 'abcdef1234567890' },
  { id: 'rrv-04', input: 'Bearer\tabcdef1234567890', secret: 'abcdef1234567890' },
  {
    id: 'rrv-05',
    input: 'dGhpcy1pcy1hLXZlcnktbG9uZy1zZWNyZXQtdmFsdWUtaW4tYmFzZTY0dXJsX2Zvcm1hdF8xMjM0NTY3ODkw',
    secret: 'dGhpcy1pcy1hLXZlcnktbG9uZy1zZWNyZXQtdmFsdWUtaW4tYmFzZTY0dXJsX2Zvcm1hdF8xMjM0NTY3ODkw',
  },
  {
    id: 'rrv-06',
    input: 'tskey-auth-k123456CNTRL-abcdefghijklmnopqrstuv',
    secret: 'tskey-auth-k123456CNTRL-abcdefghijklmnopqrstuv',
  },
  { id: 'rrv-07', input: 'pypi-AgEIcHlwaS5vcmcCJGYwMTIzNDU2Nzg5', secret: 'pypi-AgEIcHlwaS5vcmcCJGYwMTIzNDU2Nzg5' },
  { id: 'rrv-08', input: 'dop_v1_abcdef0123456789abcdef0123456789', secret: 'dop_v1_abcdef0123456789abcdef0123456789' },
  { id: 'rrv-09', input: 'lin_api_abcdef1234567890abcdef', secret: 'lin_api_abcdef1234567890abcdef' },
  { id: 'rrv-10', input: 'gsk_abcdef1234567890abcdef', secret: 'gsk_abcdef1234567890abcdef' },
  { id: 'rrv-11', input: 'A1b2C3d4'.repeat(36), secret: 'A1b2C3d4'.repeat(36) },
  { id: 'rrv-12', input: 'com.example.app-AKIAIOSFODNN7EXAMPLE', secret: 'AKIAIOSFODNN7EXAMPLE' },
  { id: 'rrv-13', input: 'com.my-AKIAIOSFODNN7EXAMPLE.app', secret: 'AKIAIOSFODNN7EXAMPLE' },
  { id: 'rrv-14', input: 'com.example.AKIAIOSFODNN7EXAMPLE-dev', secret: 'AKIAIOSFODNN7EXAMPLE' },
  {
    id: 'rrv-15',
    input: 'com.example.foo-eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV',
    secret: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV',
  },
  { id: 'rrv-16', input: 'ya29.a0AfH6SMBx1234567890abcdef', secret: 'ya29.a0AfH6SMBx1234567890abcdef' },
  {
    id: 'rrv-17-part3',
    input: 'MTIzNDU2Nzg5MDEyMzQ1Njc4.Gabcde.abcdefghijklmnopqrstuvwxyz1234567890',
    secret: 'abcdefghijklmnopqrstuvwxyz1234567890',
  },
  { id: 'rrv-18', input: '/tmp/key-AKIAIOSFODNN7EXAMPLE', secret: 'AKIAIOSFODNN7EXAMPLE' },
  { id: 'rrv-19', input: '/tmp/aws-AKIAIOSFODNN7EXAMPLE.json', secret: 'AKIAIOSFODNN7EXAMPLE' },
  { id: 'rrv-20', input: '~/key-ghp_1234567890abcdef', secret: 'ghp_1234567890abcdef' },
  { id: 'rrv-21', input: '~/key-ghp_1234567890abcdef.txt', secret: 'ghp_1234567890abcdef' },
  { id: 'rrv-22', input: 'prefix-ghp_1234567890abcdef', secret: 'ghp_1234567890abcdef' },
  { id: 'rrv-23', input: 'AKIAIOSFODNN7EXAMPLE_extra', secret: 'AKIAIOSFODNN7EXAMPLE' },

  // --- rrv-015a-2 covered by Contracts 1–5 ---
  { id: 'R10', input: 'https://alice:SuperSecretPass99@api.example.com/v1', secret: 'SuperSecretPass99' },
  { id: 'R11', input: 'postgres://dbadmin:DbPassSecret123@db.internal:5432', secret: 'DbPassSecret123' },
  { id: 'R12', input: '{"apiKey":"json_secret_value_12345"}', secret: 'json_secret_value_12345' },
  { id: 'R13', input: '{"apiKey": "json_spaced_secret_1234"}', secret: 'json_spaced_secret_1234' },
  { id: 'R14', input: 'apiKey: colon_kv_secret_12345', secret: 'colon_kv_secret_12345' },
  { id: 'R16', input: '(Bearer\nwrappedNlSecret1234)', secret: 'wrappedNlSecret1234' },
  { id: 'R17', input: 'Authorization：fullwidthSecret12345', secret: 'fullwidthSecret12345' },
  { id: 'R18', input: 'api_key： fullwidthKvSecret12345', secret: 'fullwidthKvSecret12345' },
  { id: 'R19', input: 'g\u200bhp_1234567890abcdef', secret: 'ghp_1234567890abcdef' },
  { id: 'R21', input: 'ghp_\x001234567890abcdef', secret: 'ghp_1234567890abcdef' },
  {
    id: 'R24',
    input: 'Z9xQ2mK7pR4tW8yB5nC3vL6hJ0fD9sG1A9bC4eF8gH2jK6mN0pQ4rS8tU2vW6xY0z'.repeat(5),
    secret: 'Z9xQ2mK7pR4tW8yB5nC3vL6hJ0fD9sG1A9bC4eF8gH2jK6mN0pQ4rS8tU2vW6xY0z',
  },
  {
    id: 'R25',
    input: `deploy-live-${'39163dd30f703a79079e2d2446545cff3c453738'.repeat(8)}`,
    secret: '39163dd30f703a79079e2d2446545cff3c453738',
  },
  {
    id: 'R28',
    input: 'deploy-live-39163dd30f703a79079e2d2446545cff3c453738',
    secret: '39163dd30f703a79079e2d2446545cff3c453738',
    bundleIdInput: 'com.example.deploy-live-39163dd30f703a79079e2d2446545cff3c453738',
  },
  {
    id: 'R29',
    input: 'token-prod-auth-39163dd30f703a79079e2d2446545cff3c453738',
    secret: '39163dd30f703a79079e2d2446545cff3c453738',
  },
  { id: 'R30', input: '000000000000000000000000a1b2c3d4e5f6a7b8', secret: '000000000000000000000000a1b2c3d4e5f6a7b8' },
  { id: 'R35', input: 'Bearer abc:ColonTailSecret1234', secret: 'abc:ColonTailSecret1234' },
  {
    id: 'R36-part3',
    input: 'MTIzNDU2Nzg5MDEyMzQ1Ng.Gabcde.abcdefghijklmnopqrstuvwxyz1234567890',
    secret: 'abcdefghijklmnopqrstuvwxyz1234567890',
  },
  {
    id: 'R37a',
    input: 'https://api.example.com/cb?accessToken=alpha_only_secret_val',
    secret: 'alpha_only_secret_val',
  },
  { id: 'R37b', input: 'https://api.example.com/cb?accessToken=sec_9', secret: 'sec_9' },
  { id: 'R37c', input: 'https://api.example.com/cb?secret_key=alpha_secret_val', secret: 'alpha_secret_val' },
  { id: 'R38', input: 'Bearer\nmy_secret_99', secret: 'my_secret_99' },
  { id: 'R39', input: '/tmp/ghp_\x001234567890abcdef', secret: 'ghp_1234567890abcdef' },
  { id: 'R40', input: 'apiKey: colon_kv_secret_12345', secret: 'colon_kv_secret_12345' },
  {
    id: 'R43',
    input: './deploy-live-39163dd30f703a79079e2d2446545cff3c453738',
    secret: '39163dd30f703a79079e2d2446545cff3c453738',
  },

  // --- rrv-015a-3: >=40 pure-hex runs redact unconditionally ---
  {
    id: 'f4-hex40',
    input: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    secret: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
  },
  {
    id: 'f4-hexab40',
    input: 'abababababababababababababababababababab',
    secret: 'abababababababababababababababababababab',
  },
];

describe('leak corpus across all 4 real model exits (env_detail, env_state, deliver, env_history)', () => {
  it.each(LEAK_CORPUS)(
    '$id does not leak secret across env_detail, env_state, deliver, or env_history',
    async (sample) => {
      const state = makeFakeState();
      state.env.frontApp.value = {
        name: sample.checkAppName === false ? 'MailApp' : sample.input,
        bundleId: sample.bundleIdInput ?? sample.input,
        pid: 101,
        windowCount: 1,
      };
      state.env.focusedWindow.value = { title: sample.input };
      const rt = makeFakeDetailRuntime(state, [sample.input, sample.checkAppName === false ? 'MailApp' : sample.input]);

      const detailJson = JSON.stringify(environmentDetail(rt));
      const stateJson = JSON.stringify(modelState(state, 990));
      assertNoSubstrings8(detailJson, sample.secret, `${sample.id}->env_detail`);
      assertNoSubstrings8(stateJson, sample.secret, `${sample.id}->env_state`);

      const { agent, followup } = makeFakeAgent();
      const deliver = createDelivery(
        () => agent,
        () => true,
        async () => false,
      );
      const changes: EnvChange[] = [
        makeChange(
          makeSignal({
            id: sample.input,
            kind: 'window.focused',
            subject: sample.input,
            data: { title: sample.input },
          }),
          {
            ruleId: sample.input,
          },
        ),
        makeChange(makeSignal({ id: `${sample.id}-err`, kind: 'source.error', subject: sample.input })),
      ];
      if (sample.checkAppName !== false) {
        changes.push(
          makeChange(
            makeSignal({
              id: `${sample.id}-app`,
              kind: 'app.activated',
              subject: sample.input,
              data: { name: sample.input },
            }),
          ),
        );
      }
      const update: EnvUpdate = { since: 900, at: 1_000, changes, suppressed: 0 };
      await deliver('session-cred-test', {
        kind: 'followup' satisfies Extract<DeliveryLevel | 'followup', 'followup'>,
        sessionId: 'session-cred-test',
        update,
      });
      const deliverJson = JSON.stringify(followup.mock.calls);
      assertNoSubstrings8(deliverJson, sample.secret, `${sample.id}->deliver`);

      if (!sample.skipStandaloneFormat) {
        const formattedStandalone = formatEnvUpdate({
          since: 900,
          at: 1_000,
          suppressed: 0,
          changes: [
            makeChange(
              makeSignal({
                id: sample.input,
                kind: 'window.focused',
                subject: sample.input,
                data: { title: sample.input, command: sample.input, feedbackAvailable: true },
              }),
              { ruleId: sample.input, note: sample.input },
            ),
          ],
        });
        assertNoSubstrings8(formattedStandalone, sample.secret, `${sample.id}->formatEnvUpdate`);
      }

      const histOut = JSON.stringify(
        modelHistory({
          available: true,
          from: 900,
          to: 2_000,
          limit: 50,
          total: 4,
          truncated: false,
          titlesAllowed: true,
          events: [
            {
              id: sample.input,
              kind: 'job.exited',
              subject: sample.input,
              level: 'context',
              ruleId: sample.input,
              at: 1_000,
              source: { id: 'jobs', api: 'process', host: 'fixture-host.invalid' },
            },
            {
              id: `${sample.id}-err`,
              kind: 'source.error',
              subject: sample.input,
              level: 'context',
              at: 1_002,
              source: { id: 'helper', api: 'process', host: 'fixture-host.invalid' },
            },
            ...(sample.checkAppName === false
              ? []
              : [
                  {
                    id: `${sample.id}-win`,
                    kind: 'window.focused',
                    subject: sample.input,
                    level: 'context' as const,
                    ruleId: sample.input,
                    at: 1_001,
                    source: { id: 'helper.ax', api: 'accessibility', host: 'fixture-host.invalid' },
                  },
                  {
                    id: `${sample.id}-app`,
                    kind: 'app.activated',
                    subject: sample.input,
                    level: 'record' as const,
                    at: 1_003,
                    source: { id: 'helper.ax', api: 'accessibility', host: 'fixture-host.invalid' },
                  },
                ]),
          ],
        }),
      );
      assertNoSubstrings8(histOut, sample.secret, `${sample.id}->env_history`);
    },
  );

  it('closes deliver ruleId/signal.id/alertId, env_history events[].id, and standalone formatEnvUpdate channels', async () => {
    const validHash = `body.rate:${'a'.repeat(64)}`;
    const projectedUp = modelUpdate({
      since: 900,
      at: 1_000,
      suppressed: 0,
      changes: [
        makeChange(
          makeSignal({
            id: 'ghp_1234567890abcdef',
            kind: 'body.threshold',
            subject: 'disk:/',
            data: {
              feedbackAvailable: true,
              metric: 'disk',
              severity: 'warn',
              value: 0.9,
            },
          }),
          { ruleId: 'ghp_1234567890abcdef', note: 'note https://u:PassWord99@h.invalid/x' },
        ),
        makeChange(
          makeSignal({
            id: validHash,
            kind: 'body.rate',
            subject: 'context',
            data: {
              metric: 'context',
              windowMs: 60_000,
              delta: 1,
              slope: 0.1,
              direction: 'up',
              ruleId: 'token_secret_12345678',
              feedbackAvailable: true,
              command: 'curl -H "Authorization: Bearer tok_secret_123"',
            },
          }),
        ),
      ],
    });
    expect(projectedUp.changes[0]?.ruleId).toBe('[redacted]');
    expect(projectedUp.changes[0]?.signal.id).toBe('[redacted]');
    expect(projectedUp.changes[0]?.signal.data.feedbackAvailable).toBe(false);
    expect((projectedUp.changes[1]?.signal.data as { ruleId?: string } | undefined)?.ruleId).toBe('[redacted]');
    expect(projectedUp.changes[1]?.signal.id).toBe(validHash);
    const renderedProjected = formatEnvUpdate(projectedUp);
    expect(renderedProjected).not.toContain('ghp_1234567890abcdef');
    expect(renderedProjected).not.toContain('token_secret_12345678');
    expect(renderedProjected).not.toContain('PassWord99');
    expect(renderedProjected).not.toContain('tok_secret_123');

    const standalone = formatEnvUpdate(
      {
        since: 900,
        at: 1_000,
        suppressed: 0,
        changes: [
          makeChange(
            makeSignal({
              id: 'ghp_1234567890abcdef',
              kind: 'window.focused',
              subject: 'ok',
              data: {
                title: 'api_key: secret_val_99',
                command: 'Bearer standalone_cmd_secret_99',
                feedbackAvailable: true,
              },
            }),
            { ruleId: 'token-abc_def_123456', note: 'https://u:StandalonePass9@example.com/a' },
          ),
        ],
      },
      { includeJobCommands: true },
    );
    expect(standalone).not.toContain('ghp_1234567890abcdef');
    expect(standalone).not.toContain('secret_val_99');
    expect(standalone).not.toContain('standalone_cmd_secret_99');
    expect(standalone).not.toContain('token-abc_def_123456');
    expect(standalone).not.toContain('StandalonePass9');

    const hist = modelHistory({
      available: true,
      from: 900,
      to: 2_000,
      limit: 50,
      total: 3,
      truncated: false,
      titlesAllowed: true,
      events: [
        {
          id: 'ghp_1234567890abcdef',
          kind: 'window.focused',
          subject: 'ok',
          level: 'context',
          at: 1_000,
          source: { id: 'helper.ax', api: 'accessibility', host: 'fixture-host.invalid' },
        },
        {
          id: validHash,
          kind: 'body.rate',
          subject: 'context',
          level: 'context',
          at: 1_001,
          source: { id: 'body', api: 'probe', host: 'fixture-host.invalid' },
        },
        {
          id: '11111111-2222-3333-4444-555555555555:7',
          kind: 'app.activated',
          subject: 'Editor',
          level: 'record',
          at: 1_002,
          source: { id: 'helper.ax', api: 'accessibility', host: 'fixture-host.invalid' },
        },
      ],
    }) as { events: Array<{ id: string }> };
    expect(hist.events.map((e) => e.id)).toEqual(['[redacted]', validHash, '11111111-2222-3333-4444-555555555555:7']);
  });
});

describe('out-of-scope contract exclusions (明确不追 — it.skip)', () => {
  it.skip('com.example.sk-aaaaaaaaaaaaaaaa (Contract 1 requires sk- >=20 chars with digit)', () => {
    expect(sanitizeForModel('com.example.sk-aaaaaaaaaaaaaaaa')).toBe('com.example.[redacted]');
  });

  it.skip('rrv-015a #17 Part1 MTIzNDU2Nzg5MDEyMzQ1Njc4 (24 chars <32 without eyJ JWT header)', () => {
    expect(sanitizeForModel('MTIzNDU2Nzg5MDEyMzQ1Njc4')).toBe('[redacted]');
  });

  it.skip('R36 Part1 MTIzNDU2Nzg5MDEyMzQ1Ng (22 chars <32 without eyJ JWT header)', () => {
    expect(sanitizeForModel('MTIzNDU2Nzg5MDEyMzQ1Ng')).toBe('[redacted]');
  });

  it.skip('R20 Bearer\\u200bzwspSecretToken1234 (no delimiter after removing \\p{Cf}; <32 chars)', () => {
    expect(sanitizeForModel('Bearer\u200bzwspSecretToken1234')).toContain('[redacted]');
  });

  it.skip('R22 cross-field split: subject="Bearer", title="crossFieldSecret1234" (cross-field excluded)', () => {
    expect(sanitizeForModel('Bearer')).toBe('[redacted]');
  });

  it.skip('R23 cross-field split: subject="ghp_1234", title="567890abcdef" (cross-field excluded)', () => {
    expect(sanitizeForModel('ghp_1234')).toBe('[redacted]');
  });

  it.skip('R32 aB3+dE6/gH9jK2mN5pQ8sT (<32 chars without prefix or auth/KV context)', () => {
    expect(sanitizeForModel('aB3+dE6/gH9jK2mN5pQ8sT')).toBe('[redacted]');
  });

  it.skip('R33 Abcdefgh/1vW4yZ7bC0eD3fG6hJ9kL (30 chars <32 without prefix or auth/KV context)', () => {
    expect(sanitizeForModel('Abcdefgh/1vW4yZ7bC0eD3fG6hJ9kL')).toBe('[redacted]');
  });

  it.skip('R34 AbCdEfGhIjKlMnOpQrStUvWxYz+/AbCdEfGh== (38 chars without digits; Contract 5 requires letters+digits)', () => {
    expect(sanitizeForModel('AbCdEfGhIjKlMnOpQrStUvWxYz+/AbCdEfGh==')).toBe('[redacted]');
  });
});

interface NormalSample {
  category: 'title' | 'filename' | 'version' | 'date' | 'kebab' | 'bundleId';
  text: string;
}

const NORMAL_50_SAMPLES: NormalSample[] = [
  // Window titles (10)
  { category: 'title', text: 'ASI-Sense - Visual Studio Code' },
  { category: 'title', text: 'Pull Request #142: Fix memory leak - GitHub' },
  { category: 'title', text: 'DESIGN.md — rrv-015a-2' },
  { category: 'title', text: 'OAuth2 Bearer Token - MDN Web Docs' },
  { category: 'title', text: 'Basic TypeScript Handbook' },
  { category: 'title', text: 'Basic JavaScript Tutorial' },
  { category: 'title', text: 'ASI-Sense-015a-Design-Doc-v2' },
  { category: 'title', text: 'Release Notes v0.1.5 (2026-11-19)' },
  { category: 'title', text: 'Slack | engineering-alerts' },
  { category: 'title', text: 'Inbox (12) - Mail' },
  // Filenames (10)
  { category: 'filename', text: 'README.md' },
  { category: 'filename', text: 'report-2026-11-19.txt' },
  { category: 'filename', text: 'IMG_0042.png' },
  { category: 'filename', text: 'screenshot_2026-11-19_18-02-34.png' },
  { category: 'filename', text: 'IMG_20261119_180234_final.jpg' },
  { category: 'filename', text: 'Screen_Recording_2026-11-19_v2.mov' },
  { category: 'filename', text: 'token-service-v2.ts' },
  { category: 'filename', text: 'secret-config-loader.ts' },
  { category: 'filename', text: 'password-reset-handler.ts' },
  { category: 'filename', text: 'build_arm64_darwin_20261119_v1.zip' },
  // Versions (6)
  { category: 'version', text: 'v0.1.5' },
  { category: 'version', text: '1.2.34' },
  { category: 'version', text: 'v22.14.0' },
  { category: 'version', text: 'node-v22.14.0-darwin-arm64' },
  { category: 'version', text: 'orca-ide-0.2.2-rc.3' },
  { category: 'version', text: 'Build_20261119_rc12_arm64_release' },
  // Dates (4)
  { category: 'date', text: '2026-11-19' },
  { category: 'date', text: '2026-11-19T18:02:28Z' },
  { category: 'date', text: '2026-11-19_18-02-28' },
  { category: 'date', text: 'November 19, 2026' },
  // Kebab phrases (10)
  { category: 'kebab', text: 'password-reset-handler' },
  { category: 'kebab', text: 'api-key-rotation-docs' },
  { category: 'kebab', text: 'token-bucket-rate-limiter' },
  { category: 'kebab', text: 'secret-scanning-pipeline-v2' },
  { category: 'kebab', text: 'token-service-v2' },
  { category: 'kebab', text: 'sk-design-system' },
  { category: 'kebab', text: 'sk-button-primary' },
  { category: 'kebab', text: 'asi-sense-v0-1-5-release-notes' },
  { category: 'kebab', text: 'files-global-denied' },
  { category: 'kebab', text: 'bearer-auth-middleware' },
  // Bundle IDs (10)
  { category: 'bundleId', text: 'com.apple.Safari' },
  { category: 'bundleId', text: 'com.microsoft.VSCode' },
  { category: 'bundleId', text: 'com.example.password-management-helper' },
  { category: 'bundleId', text: 'com.example.token-viewer' },
  { category: 'bundleId', text: 'com.example.token-service-v2' },
  { category: 'bundleId', text: 'com.example.secret-agent-2' },
  { category: 'bundleId', text: 'com.example.sk-terminal' },
  { category: 'bundleId', text: 'com.example.sk-devtools' },
  { category: 'bundleId', text: 'org.mozilla.firefox' },
  { category: 'bundleId', text: 'io.github.deepseek-harness' },
];

describe('50-sample normal corpus false positive rate (<= 2/50)', () => {
  it('hits at most 2 of 50 normal samples (0/50 under segmented Contract 5) and preserves long directory names', () => {
    expect(NORMAL_50_SAMPLES).toHaveLength(50);
    const state = makeFakeState();
    const rt = makeFakeDetailRuntime(state, []);
    const hits: string[] = [];
    for (const s of NORMAL_50_SAMPLES) {
      if (sanitizeForModel(s.text) !== s.text) {
        hits.push(s.text);
      }
      if (s.category === 'bundleId') {
        if (!state.env.frontApp.value) throw new Error('missing frontApp');
        state.env.frontApp.value.bundleId = s.text;
        const st = modelState(state, 990, 'env') as { frontApp: { value: { bundleId: string } } };
        const dt = environmentDetail(rt) as { app: { value: { bundleId: string } } };
        expect(st.frontApp.value.bundleId).toBe(s.text);
        expect(dt.app.value.bundleId).toBe(s.text);
      } else if (s.category === 'title') {
        expect(modelTitle(s.text, 'local')).not.toContain('[redacted]');
      } else if (s.category === 'filename') {
        const projected = modelActivityName(s.text, true);
        expect(projected).not.toContain('[redacted]');
      } else {
        expect(modelText(s.text, 'local')).not.toContain('[redacted]');
      }
    }
    expect(hits.length).toBeLessThanOrEqual(2);
    expect(hits).toEqual([]);

    const extraBenignDirs = ['my-long-project-directory-name-2026'];
    for (let i = 0; i < 600; i++) extraBenignDirs.push(`project-directory-with-moderate-name-${i}`);
    for (const dirName of extraBenignDirs) {
      expect(sanitizeForModel(dirName), dirName).toBe(dirName);
      expect(modelActivityName(dirName, true), dirName).toBe(dirName);
    }
  });
});

describe('linear O(N) performance on 4 worst-case patterns from rrv-015a-2', () => {
  const refTable = new Uint8Array(128).fill(1);
  function runLinearReferencePass(input: string, passes: number): number {
    let acc = 0;
    for (let p = 0; p < passes; p++) {
      for (let i = 0; i < input.length; i++) {
        const c = input.charCodeAt(i);
        acc = (acc + (c < 128 ? (refTable[c] ?? 0) : 0) + (c === 101 ? 3 : c === 97 ? 5 : 0)) | 0;
      }
    }
    return acc;
  }

  const cases: Array<{ name: string; build: (targetLen: number) => string }> = [
    { name: 'random-mixed', build: (n) => makeRandomMixed(n) },
    { name: "'-eyJ'.repeat(...)", build: (n) => '-eyJ'.repeat(Math.ceil(n / 4)).slice(0, n) },
    { name: "'api-key-'.repeat(...)", build: (n) => 'api-key-'.repeat(Math.ceil(n / 8)).slice(0, n) },
    { name: "'token-aaaa-bbbb-'.repeat(...) + '1'", build: (n) => `${'token-aaaa-bbbb-'.repeat(Math.floor(n / 16))}1` },
  ];

  it('processes 10k < 5ms and 100k < 50ms normalized linearly without quadratic blowup', () => {
    const refInput = makeRandomMixed(100_000);
    let refSink = 0;

    // Warm up JIT across all 4 worst-case patterns (both 10k and 100k) and the linear reference before timing.
    for (const c of cases) {
      const w10 = c.build(10_000);
      const w100 = c.build(100_000);
      for (let k = 0; k < 6; k++) {
        sanitizeForModel(w10);
        sanitizeForModel(w100);
        refSink ^= runLinearReferencePass(w10, 2);
      }
    }

    // Calibrate against an in-process linear 15x100k pass (nominal ~8ms on an idle CPU) paired per round.
    const nominalRefMs = 8.0;
    const report: string[] = [];
    for (const c of cases) {
      const s10k = c.build(10_000);
      const s100k = c.build(100_000);
      const raw10k: number[] = [];
      const raw100k: number[] = [];
      const norm10kSamples: number[] = [];
      const norm100kSamples: number[] = [];
      const refRuns: number[] = [];
      for (let r = 0; r < 9; r++) {
        const tRef0 = performance.now();
        refSink ^= runLinearReferencePass(refInput, 15);
        const refMs = performance.now() - tRef0;
        refRuns.push(refMs);

        const t10 = performance.now();
        sanitizeForModel(s10k);
        const ms10 = performance.now() - t10;
        raw10k.push(ms10);

        const t100 = performance.now();
        sanitizeForModel(s100k);
        const ms100 = performance.now() - t100;
        raw100k.push(ms100);

        const roundScale = Math.max(1, refMs / nominalRefMs);
        norm10kSamples.push(ms10 / roundScale);
        norm100kSamples.push(ms100 / roundScale);
      }
      raw10k.sort((a, b) => a - b);
      raw100k.sort((a, b) => a - b);
      refRuns.sort((a, b) => a - b);
      const min10k = raw10k[0] ?? 0;
      const med10k = raw10k[4] ?? 0;
      const min100k = raw100k[0] ?? 0;
      const med100k = raw100k[4] ?? 0;
      const refMed = refRuns[4] ?? nominalRefMs;
      const norm10k = Math.min(...norm10kSamples);
      const norm100k = Math.min(...norm100kSamples);
      const ratio = min100k / Math.max(min10k, 0.05);
      report.push(
        `${c.name}: 10k min=${min10k.toFixed(2)}ms (med=${med10k.toFixed(2)}ms, norm=${norm10k.toFixed(2)}ms), 100k min=${min100k.toFixed(2)}ms (med=${med100k.toFixed(2)}ms, norm=${norm100k.toFixed(2)}ms, ratio=${ratio.toFixed(1)}x, refMed=${refMed.toFixed(2)}ms)`,
      );
      expect(norm10k, `${c.name} 10k`).toBeLessThan(5);
      expect(norm100k, `${c.name} 100k`).toBeLessThan(50);
      expect(ratio, `${c.name} linear scaling`).toBeLessThan(25);
    }
    expect(refSink).not.toBe(Number.NaN);
    console.log(`[credential-scan perf]\n${report.join('\n')}`);
  });
});
