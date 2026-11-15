import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FAUX_PROVIDER_ID,
  ProviderStore,
  type StorageEncryption,
} from '../../src/main/stores/provider-store';
import type { ProviderInput } from '../../src/shared/types';

/** 可逆但非明文的假加密：密文 = "ENC|" + base64(明文) */
function fakeEncryption(available = true): StorageEncryption {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (value: string) =>
      Buffer.concat([Buffer.from('ENC|'), Buffer.from(Buffer.from(value, 'utf8').toString('base64'))]),
    decryptString: (value: Buffer) => {
      const raw = value.toString('utf8');
      if (!raw.startsWith('ENC|')) {
        throw new Error('bad cipher');
      }
      return Buffer.from(raw.slice(4), 'base64').toString('utf8');
    },
  };
}

function input(overrides: Partial<ProviderInput> = {}): ProviderInput {
  return {
    name: 'Test Provider',
    kind: 'builtin',
    builtinProvider: 'anthropic',
    enabled: true,
    customModels: [],
    ...overrides,
  };
}

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'asi-provider-store-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('ProviderStore', () => {
  it('starts empty when no files exist', () => {
    const store = new ProviderStore(tempDir(), fakeEncryption());
    expect(store.list()).toEqual([]);
  });

  it('creates a provider with a generated id and allowlisted fields only', () => {
    const store = new ProviderStore(tempDir(), fakeEncryption());
    const saved = store.save(input({ apiKey: 'sk-secret' }));
    expect(saved.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(saved.name).toBe('Test Provider');
    expect(saved.hasApiKey).toBe(true);
    expect(saved.createdAt).toBeGreaterThan(0);
    expect(saved).not.toHaveProperty('apiKey');
    expect(Object.keys(saved).sort()).toEqual(
      ['builtinProvider', 'createdAt', 'customModels', 'enabled', 'hasApiKey', 'id', 'kind', 'name'].sort(),
    );
  });

  it('does not persist the apiKey or unknown fields into providers.json', () => {
    const dir = tempDir();
    const store = new ProviderStore(dir, fakeEncryption());
    const saved = store.save(input({ apiKey: 'sk-topsecret' }));
    const raw = readFileSync(join(dir, 'providers.json'), 'utf8');
    expect(raw).not.toContain('sk-topsecret');
    expect(raw).not.toContain('apiKey');
    const parsed = JSON.parse(raw) as Record<string, unknown>[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe(saved.id);
    expect(parsed[0]).not.toHaveProperty('hasApiKey');
    expect(Object.keys(parsed[0]).sort()).toEqual(
      ['builtinProvider', 'createdAt', 'customModels', 'enabled', 'id', 'kind', 'name'].sort(),
    );
  });

  it('stores keys tagged as encrypted base64 in keys.json with mode 0600', () => {
    const dir = tempDir();
    const store = new ProviderStore(dir, fakeEncryption());
    const saved = store.save(input({ apiKey: 'sk-topsecret' }));
    const keysPath = join(dir, 'keys.json');
    const raw = readFileSync(keysPath, 'utf8');
    expect(raw).not.toContain('sk-topsecret');
    const keys = JSON.parse(raw) as Record<string, { encrypted: boolean; value: string }>;
    expect(keys[saved.id].encrypted).toBe(true);
    expect(() => Buffer.from(keys[saved.id].value, 'base64')).not.toThrow();
    expect(statSync(keysPath).mode & 0o777).toBe(0o600);
  });

  it('roundtrips the apiKey through getApiKey', () => {
    const store = new ProviderStore(tempDir(), fakeEncryption());
    const saved = store.save(input({ apiKey: 'sk-roundtrip' }));
    expect(store.getApiKey(saved.id)).toBe('sk-roundtrip');
    expect(store.getApiKey('missing')).toBeUndefined();
  });

  it('keeps createdAt and existing key on update when apiKey is undefined', () => {
    const store = new ProviderStore(tempDir(), fakeEncryption());
    const saved = store.save(input({ apiKey: 'sk-keep' }));
    const updated = store.save(input({ id: saved.id, name: 'Renamed', enabled: false }));
    expect(updated.createdAt).toBe(saved.createdAt);
    expect(updated.name).toBe('Renamed');
    expect(updated.enabled).toBe(false);
    expect(updated.hasApiKey).toBe(true);
    expect(store.getApiKey(saved.id)).toBe('sk-keep');
  });

  it('clears the key when apiKey is null', () => {
    const store = new ProviderStore(tempDir(), fakeEncryption());
    const saved = store.save(input({ apiKey: 'sk-clear-me' }));
    const updated = store.save(input({ id: saved.id, apiKey: null }));
    expect(updated.hasApiKey).toBe(false);
    expect(store.getApiKey(saved.id)).toBeUndefined();
  });

  it('replaces the key when apiKey is a non-empty string', () => {
    const store = new ProviderStore(tempDir(), fakeEncryption());
    const saved = store.save(input({ apiKey: 'sk-old' }));
    store.save(input({ id: saved.id, apiKey: 'sk-new' }));
    expect(store.getApiKey(saved.id)).toBe('sk-new');
  });

  it('rejects updates to a non-existent provider', () => {
    const store = new ProviderStore(tempDir(), fakeEncryption());
    expect(() => store.save(input({ id: 'no-such-id' }))).toThrow();
  });

  it('rejects an empty-string apiKey', () => {
    const store = new ProviderStore(tempDir(), fakeEncryption());
    expect(() => store.save(input({ apiKey: '  ' }))).toThrow();
  });

  it('remove deletes provider and key; removing a missing id is a no-op', () => {
    const dir = tempDir();
    const store = new ProviderStore(dir, fakeEncryption());
    const saved = store.save(input({ apiKey: 'sk-gone' }));
    store.remove(saved.id);
    expect(store.list()).toEqual([]);
    expect(store.get(saved.id)).toBeUndefined();
    const keys = JSON.parse(readFileSync(join(dir, 'keys.json'), 'utf8')) as Record<string, unknown>;
    expect(keys[saved.id]).toBeUndefined();
    expect(() => store.remove(saved.id)).not.toThrow();
  });

  it('reloads providers and keys from disk in a new instance', () => {
    const dir = tempDir();
    const first = new ProviderStore(dir, fakeEncryption());
    const saved = first.save(input({ apiKey: 'sk-persisted' }));
    const second = new ProviderStore(dir, fakeEncryption());
    expect(second.list()).toEqual([saved]);
    expect(second.getApiKey(saved.id)).toBe('sk-persisted');
  });

  it('throws on malformed providers.json instead of silently resetting', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'providers.json'), '{not json', 'utf8');
    expect(() => new ProviderStore(dir, fakeEncryption())).toThrow();
    expect(readFileSync(join(dir, 'providers.json'), 'utf8')).toBe('{not json');
  });

  it('throws on malformed keys.json entries', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'keys.json'), JSON.stringify({ p1: 'raw-string-not-tagged' }), 'utf8');
    expect(() => new ProviderStore(dir, fakeEncryption())).toThrow();
  });

  it('returns snapshots: mutating returned configs does not affect the store', () => {
    const store = new ProviderStore(tempDir(), fakeEncryption());
    const saved = store.save(input());
    saved.name = 'mutated';
    saved.customModels.push('evil');
    const listed = store.list();
    listed[0].enabled = false;
    const again = store.get(saved.id);
    expect(again?.name).toBe('Test Provider');
    expect(again?.customModels).toEqual([]);
    expect(again?.enabled).toBe(true);
  });

  it('wraps decrypt failures without leaking key material', () => {
    const dir = tempDir();
    const store = new ProviderStore(dir, fakeEncryption());
    const saved = store.save(input());
    const encoded = Buffer.from('GARBAGE-NOT-CIPHER').toString('base64');
    writeFileSync(
      join(dir, 'keys.json'),
      JSON.stringify({ [saved.id]: { encrypted: true, value: encoded } }),
    );
    const reloaded = new ProviderStore(dir, fakeEncryption());
    expect(() => reloaded.getApiKey(saved.id)).toThrow(/无法解密/);
    try {
      reloaded.getApiKey(saved.id);
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain('GARBAGE-NOT-CIPHER');
      expect((err as Error).message).not.toContain('bad cipher');
    }
  });

  it('does not leak secrets when encryptString or decryptString throws a secret-bearing error', () => {
    const dir = tempDir();
    const throwing: StorageEncryption = {
      isEncryptionAvailable: () => true,
      encryptString: () => {
        throw new Error('encrypt failed for sk-dummysecret');
      },
      decryptString: () => {
        throw new Error('decrypt failed for sk-dummysecret');
      },
    };
    const store = new ProviderStore(dir, throwing);
    try {
      store.save(input({ apiKey: 'sk-dummysecret' }));
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain('sk-dummysecret');
    }
    expect(store.list()).toEqual([]);

    // 构造一条带合法标记的密文条目，让 getApiKey 走到 decrypt 分支
    const ok = new ProviderStore(dir, fakeEncryption());
    const saved = ok.save(input({ name: 'Other' }));
    writeFileSync(
      join(dir, 'keys.json'),
      JSON.stringify({ [saved.id]: { encrypted: true, value: Buffer.from('ENC|x').toString('base64') } }),
    );
    const reloaded = new ProviderStore(dir, throwing);
    try {
      reloaded.getApiKey(saved.id);
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain('sk-dummysecret');
    }
  });

  it('does not leak file contents when keys.json is malformed', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'keys.json'), '{"k":"sk-dummysecret', 'utf8');
    try {
      new ProviderStore(dir, fakeEncryption());
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain('sk-dummysecret');
    }
  });

  it('strips unknown fields from legacy providers.json on hydration and on next save', () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, 'providers.json'),
      JSON.stringify([
        {
          id: 'legacy-1',
          name: 'Legacy',
          kind: 'builtin',
          builtinProvider: 'openai',
          enabled: true,
          customModels: [],
          createdAt: 1,
          apiKey: 'sk-legacysecret',
          extraField: 'junk',
        },
      ]),
      'utf8',
    );
    const store = new ProviderStore(dir, fakeEncryption());
    const listed = store.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).not.toHaveProperty('apiKey');
    expect(listed[0]).not.toHaveProperty('extraField');
    // 触发下一次写盘后，多余字段不得重新出现在文件里
    store.save(input({ id: 'legacy-1', name: 'Legacy', apiKey: 'sk-new' }));
    const raw = readFileSync(join(dir, 'providers.json'), 'utf8');
    expect(raw).not.toContain('sk-legacysecret');
    expect(raw).not.toContain('extraField');
  });

  it('rejects a keys.json that is a JSON array', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'keys.json'), '[]', 'utf8');
    expect(() => new ProviderStore(dir, fakeEncryption())).toThrow(/损坏/);
  });

  it('leaves memory unchanged and no tmp files when providers.json write fails', () => {
    const dir = tempDir();
    const store = new ProviderStore(dir, fakeEncryption());
    // 用同名目录让 renameSync 失败
    mkdirSync(join(dir, 'providers.json'));
    expect(() => store.save(input({ name: 'Nope' }))).toThrow();
    expect(store.list()).toEqual([]);
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('leaves memory and providers.json untouched when keys.json write fails', () => {
    const dir = tempDir();
    const store = new ProviderStore(dir, fakeEncryption());
    mkdirSync(join(dir, 'keys.json'));
    expect(() => store.save(input({ apiKey: 'sk-x' }))).toThrow();
    expect(store.list()).toEqual([]);
    // keys 先写、失败后 providers 不应已落盘
    expect(existsSync(join(dir, 'providers.json'))).toBe(false);
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('leaves memory unchanged when remove cannot write providers.json', () => {
    const dir = tempDir();
    const store = new ProviderStore(dir, fakeEncryption());
    const saved = store.save(input({ apiKey: 'sk-stay' }));
    const file = join(dir, 'providers.json');
    rmSync(file);
    mkdirSync(file);
    expect(() => store.remove(saved.id)).toThrow();
    expect(store.get(saved.id)?.name).toBe('Test Provider');
    expect(store.getApiKey(saved.id)).toBe('sk-stay');
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('falls back to tagged plaintext keys only when ASI_DATA_DIR is set, warning once', async () => {
    vi.resetModules();
    vi.stubEnv('ASI_DATA_DIR', '/tmp/asi-test-data');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { ProviderStore: FreshStore } = await import('../../src/main/stores/provider-store');
    const dir = tempDir();
    const store = new FreshStore(dir, fakeEncryption(false));
    const a = store.save(input({ apiKey: 'sk-plain-a' }));
    const b = store.save(input({ name: 'Second', apiKey: 'sk-plain-b' }));
    expect(store.getApiKey(a.id)).toBe('sk-plain-a');
    expect(store.getApiKey(b.id)).toBe('sk-plain-b');
    const keys = JSON.parse(readFileSync(join(dir, 'keys.json'), 'utf8')) as Record<
      string,
      { encrypted: boolean; value: string }
    >;
    expect(keys[a.id]).toEqual({ encrypted: false, value: 'sk-plain-a' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.flat().join(' ')).not.toContain('sk-plain');
  });

  it('rejects saving a key when encryption is unavailable and ASI_DATA_DIR is unset', async () => {
    vi.resetModules();
    vi.stubEnv('ASI_DATA_DIR', '');
    const { ProviderStore: FreshStore } = await import('../../src/main/stores/provider-store');
    const store = new FreshStore(tempDir(), fakeEncryption(false));
    expect(() => store.save(input({ apiKey: 'sk-no' }))).toThrow();
    expect(store.list()).toEqual([]);
  });

  it('exposes a synthetic faux provider under ASI_FAUX=1, never persisted, immutable', () => {
    vi.stubEnv('ASI_FAUX', '1');
    const dir = tempDir();
    const store = new ProviderStore(dir, fakeEncryption());
    const faux = store.get(FAUX_PROVIDER_ID);
    expect(faux).toEqual({
      id: FAUX_PROVIDER_ID,
      name: 'Faux (测试)',
      kind: 'builtin',
      builtinProvider: 'faux',
      hasApiKey: true,
      enabled: true,
      customModels: [],
      createdAt: 0,
    });
    expect(store.list().map((p) => p.id)).toContain(FAUX_PROVIDER_ID);
    expect(store.getApiKey(FAUX_PROVIDER_ID)).toBeUndefined();
    expect(existsSync(join(dir, 'providers.json'))).toBe(false);
    expect(() => store.save(input({ id: FAUX_PROVIDER_ID }))).toThrow();
    expect(() => store.remove(FAUX_PROVIDER_ID)).toThrow();

    // 返回的是快照：改返回值不得污染全局 faux 常量
    faux?.customModels.push('mutated');
    const listedFaux = store.list().find((p) => p.id === FAUX_PROVIDER_ID);
    if (listedFaux) {
      listedFaux.customModels.push('mutated-too');
      listedFaux.enabled = false;
    }
    expect(store.get(FAUX_PROVIDER_ID)?.customModels).toEqual([]);
    expect(store.get(FAUX_PROVIDER_ID)?.enabled).toBe(true);
  });

  it('does not list the faux provider without ASI_FAUX', () => {
    vi.stubEnv('ASI_FAUX', '');
    const store = new ProviderStore(tempDir(), fakeEncryption());
    expect(store.get(FAUX_PROVIDER_ID)).toBeUndefined();
    expect(store.list()).toEqual([]);
  });
});
