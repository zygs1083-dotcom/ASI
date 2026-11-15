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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FAUX_PROVIDER_ID,
  ProviderStore,
  type StorageEncryption,
} from '../../src/main/stores/provider-store';
import type { ProviderInput } from '../../src/shared/types';

/** 写盘故障注入队列：writeJsonAtomic 调用路径匹配队首时出队并抛错 */
const writeFail = vi.hoisted(() => ({ plan: [] as string[] }));

vi.mock('../../src/main/stores/json-file', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/stores/json-file')>();
  return {
    ...actual,
    writeJsonAtomic: vi.fn((path: string, value: unknown) => {
      if (writeFail.plan.length > 0 && writeFail.plan[0] === path) {
        writeFail.plan.shift();
        throw new Error('模拟磁盘写入失败');
      }
      return actual.writeJsonAtomic(path, value);
    }),
  };
});

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

beforeEach(() => {
  // 隔离环境：需要 ASI_FAUX/ASI_DATA_DIR 的用例自行 stub，afterEach 统一 unstub
  vi.stubEnv('ASI_FAUX', '');
  vi.stubEnv('ASI_DATA_DIR', '');
});

afterEach(() => {
  writeFail.plan.length = 0;
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
    const saved = store.save(input({ apiKey: 'sk-keep-aa' }));
    const updated = store.save(input({ id: saved.id, name: 'Renamed', enabled: false }));
    expect(updated.createdAt).toBe(saved.createdAt);
    expect(updated.name).toBe('Renamed');
    expect(updated.enabled).toBe(false);
    expect(updated.hasApiKey).toBe(true);
    expect(store.getApiKey(saved.id)).toBe('sk-keep-aa');
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
    const saved = store.save(input({ apiKey: 'sk-old-aa' }));
    store.save(input({ id: saved.id, apiKey: 'sk-new-aa' }));
    expect(store.getApiKey(saved.id)).toBe('sk-new-aa');
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
    const saved = store.save(input({ apiKey: 'sk-gone-aa' }));
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
    store.save(input({ id: 'legacy-1', name: 'Legacy', apiKey: 'sk-new-aa' }));
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
    expect(() => store.save(input({ apiKey: 'sk-x-aaaa' }))).toThrow();
    expect(store.list()).toEqual([]);
    // keys 先写、失败后 providers 不应已落盘
    expect(existsSync(join(dir, 'providers.json'))).toBe(false);
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('leaves memory unchanged when remove cannot write providers.json', () => {
    const dir = tempDir();
    const store = new ProviderStore(dir, fakeEncryption());
    const saved = store.save(input({ apiKey: 'sk-stay-aa' }));
    const file = join(dir, 'providers.json');
    rmSync(file);
    mkdirSync(file);
    expect(() => store.remove(saved.id)).toThrow();
    expect(store.get(saved.id)?.name).toBe('Test Provider');
    expect(store.getApiKey(saved.id)).toBe('sk-stay-aa');
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
    expect(() => store.save(input({ apiKey: 'sk-no-aaa' }))).toThrow();
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

function fakeCipher(value: string): string {
  return Buffer.concat([
    Buffer.from('ENC|'),
    Buffer.from(Buffer.from(value, 'utf8').toString('base64')),
  ]).toString('base64');
}

/** 统计每个密文 decryptString 次数：断言快照对每条密文恰好解密一次 */
function countingEncryption(available = true): {
  enc: StorageEncryption;
  perCipher: Map<string, number>;
} {
  const base = fakeEncryption(available);
  const perCipher = new Map<string, number>();
  return {
    enc: {
      isEncryptionAvailable: base.isEncryptionAvailable,
      encryptString: base.encryptString,
      decryptString: (value: Buffer) => {
        const cipher = value.toString('base64');
        perCipher.set(cipher, (perCipher.get(cipher) ?? 0) + 1);
        return base.decryptString(value);
      },
    },
    perCipher,
  };
}

function providerRecord(id: string): Record<string, unknown> {
  return {
    id,
    name: `P-${id}`,
    kind: 'builtin',
    builtinProvider: 'anthropic',
    enabled: true,
    customModels: [],
    createdAt: 1,
  };
}

describe('ProviderStore plaintext key migration', () => {
  it('migrates legacy plaintext entries to encrypted ones on non-test startup', () => {
    vi.stubEnv('ASI_DATA_DIR', '');
    const dir = tempDir();
    writeFileSync(
      join(dir, 'providers.json'),
      JSON.stringify([providerRecord('p1'), providerRecord('p2')]),
      'utf8',
    );
    writeFileSync(
      join(dir, 'keys.json'),
      JSON.stringify({
        p1: { encrypted: false, value: 'sk-legacy-plain' },
        p2: { encrypted: true, value: fakeCipher('sk-legacy-enc') },
      }),
      'utf8',
    );
    const store = new ProviderStore(dir, fakeEncryption());
    // 迁移发生在构造返回之前：内存与盘上都是密文
    expect(store.getApiKey('p1')).toBe('sk-legacy-plain');
    const keys = JSON.parse(readFileSync(join(dir, 'keys.json'), 'utf8')) as Record<
      string,
      { encrypted: boolean; value: string }
    >;
    expect(keys.p1.encrypted).toBe(true);
    expect(keys.p2.encrypted).toBe(true);
    expect(readFileSync(join(dir, 'keys.json'), 'utf8')).not.toContain('sk-legacy-plain');
    // 重载后两把 key 都能用
    const reloaded = new ProviderStore(dir, fakeEncryption());
    expect(reloaded.getApiKey('p1')).toBe('sk-legacy-plain');
    expect(reloaded.getApiKey('p2')).toBe('sk-legacy-enc');
  });

  it('drops plaintext entries from memory only when encryption is unavailable, warning once', async () => {
    vi.resetModules();
    vi.stubEnv('ASI_DATA_DIR', '');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { ProviderStore: FreshStore } = await import('../../src/main/stores/provider-store');
    const dir = tempDir();
    writeFileSync(
      join(dir, 'providers.json'),
      JSON.stringify([providerRecord('p1'), providerRecord('p2')]),
      'utf8',
    );
    writeFileSync(
      join(dir, 'keys.json'),
      JSON.stringify({
        p1: { encrypted: false, value: 'sk-plain-drop' },
        p2: { encrypted: true, value: fakeCipher('sk-enc-keep') },
      }),
      'utf8',
    );
    const store = new FreshStore(dir, fakeEncryption(false));
    // 明文条目被丢弃：hasApiKey false、getApiKey undefined；加密条目保留
    expect(store.get('p1')?.hasApiKey).toBe(false);
    expect(store.getApiKey('p1')).toBeUndefined();
    expect(store.get('p2')?.hasApiKey).toBe(true);
    expect(store.getApiKey('p2')).toBe('sk-enc-keep');
    // 盘上文件原样保留（只从内存丢弃）
    const raw = JSON.parse(readFileSync(join(dir, 'keys.json'), 'utf8')) as Record<
      string,
      { encrypted: boolean }
    >;
    expect(raw.p1.encrypted).toBe(false);
    // 第二个实例不再重复告警，告警内容不含任何 key
    new FreshStore(dir, fakeEncryption(false));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.flat().join(' ')).not.toContain('sk-');
  });

  it('keeps tagged plaintext entries usable in test mode (ASI_DATA_DIR set)', () => {
    vi.stubEnv('ASI_DATA_DIR', '/tmp/asi-test-data');
    const dir = tempDir();
    writeFileSync(
      join(dir, 'keys.json'),
      JSON.stringify({ p1: { encrypted: false, value: 'sk-test-plain' } }),
      'utf8',
    );
    const store = new ProviderStore(dir, fakeEncryption(false));
    expect(store.getApiKey('p1')).toBe('sk-test-plain');
  });

  it('fails construction without touching the file when the migration write fails', () => {
    vi.stubEnv('ASI_DATA_DIR', '');
    const dir = tempDir();
    const keysPath = join(dir, 'keys.json');
    writeFileSync(keysPath, JSON.stringify({ p1: { encrypted: false, value: 'sk-migrate-me' } }), 'utf8');
    writeFail.plan = [keysPath];
    expect(() => new ProviderStore(dir, fakeEncryption())).toThrow();
    // 构造失败：没有可用实例，原文件未被破坏
    const raw = JSON.parse(readFileSync(keysPath, 'utf8')) as Record<string, unknown>;
    expect(raw.p1).toEqual({ encrypted: false, value: 'sk-migrate-me' });
  });

  it('fails construction without leaking content when migration encryption fails', () => {
    vi.stubEnv('ASI_DATA_DIR', '');
    const dir = tempDir();
    const keysPath = join(dir, 'keys.json');
    writeFileSync(keysPath, JSON.stringify({ p1: { encrypted: false, value: 'sk-migrate-me' } }), 'utf8');
    const throwing: StorageEncryption = {
      isEncryptionAvailable: () => true,
      encryptString: () => {
        throw new Error('encrypt blew up with sk-migrate-me');
      },
      decryptString: () => {
        throw new Error('decrypt blew up');
      },
    };
    try {
      new ProviderStore(dir, throwing);
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain('sk-migrate-me');
    }
    const raw = JSON.parse(readFileSync(keysPath, 'utf8')) as Record<string, unknown>;
    expect(raw.p1).toEqual({ encrypted: false, value: 'sk-migrate-me' });
  });
});

describe('ProviderStore two-file rollback', () => {
  it('restores the old keys.json when the providers.json write fails after setting a new key', () => {
    const dir = tempDir();
    const store = new ProviderStore(dir, fakeEncryption());
    const saved = store.save(input({ apiKey: 'sk-old-aa' }));
    // 调用前的完整盘上快照：回滚必须逐字节恢复原文件
    const keysBefore = readFileSync(join(dir, 'keys.json'), 'utf8');
    const providersBefore = readFileSync(join(dir, 'providers.json'), 'utf8');
    writeFail.plan = [join(dir, 'providers.json')];
    expect(() => store.save(input({ id: saved.id, name: 'Renamed', apiKey: 'sk-new-aa' }))).toThrow();
    // keys.json 已回滚到旧内容，providers.json 未被更新
    expect(readFileSync(join(dir, 'keys.json'), 'utf8')).toBe(keysBefore);
    expect(readFileSync(join(dir, 'providers.json'), 'utf8')).toBe(providersBefore);
    const reloaded = new ProviderStore(dir, fakeEncryption());
    expect(reloaded.getApiKey(saved.id)).toBe('sk-old-aa');
    expect(reloaded.get(saved.id)?.name).toBe('Test Provider');
    expect(reloaded.list()).toEqual(store.list());
    expect(store.getApiKey(saved.id)).toBe('sk-old-aa');
    expect(store.get(saved.id)?.name).toBe('Test Provider');
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('restores keys.json with the key when the providers.json write fails after clearing a key', () => {
    const dir = tempDir();
    const store = new ProviderStore(dir, fakeEncryption());
    const saved = store.save(input({ apiKey: 'sk-stay-aa' }));
    const keysBefore = readFileSync(join(dir, 'keys.json'), 'utf8');
    const providersBefore = readFileSync(join(dir, 'providers.json'), 'utf8');
    writeFail.plan = [join(dir, 'providers.json')];
    expect(() => store.save(input({ id: saved.id, apiKey: null }))).toThrow();
    expect(readFileSync(join(dir, 'keys.json'), 'utf8')).toBe(keysBefore);
    expect(readFileSync(join(dir, 'providers.json'), 'utf8')).toBe(providersBefore);
    const reloaded = new ProviderStore(dir, fakeEncryption());
    expect(reloaded.getApiKey(saved.id)).toBe('sk-stay-aa');
    expect(reloaded.get(saved.id)?.hasApiKey).toBe(true);
    expect(reloaded.list()).toEqual(store.list());
    expect(store.getApiKey(saved.id)).toBe('sk-stay-aa');
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('removes the just-created keys.json when a new provider save fails on the second write', () => {
    const dir = tempDir();
    const store = new ProviderStore(dir, fakeEncryption());
    writeFail.plan = [join(dir, 'providers.json')];
    expect(() => store.save(input({ apiKey: 'sk-new-aa' }))).toThrow();
    expect(existsSync(join(dir, 'keys.json'))).toBe(false);
    expect(existsSync(join(dir, 'providers.json'))).toBe(false);
    expect(store.list()).toEqual([]);
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('restores providers.json when the keys.json write fails during remove', () => {
    const dir = tempDir();
    const store = new ProviderStore(dir, fakeEncryption());
    const saved = store.save(input({ apiKey: 'sk-stay-aa' }));
    const keysBefore = readFileSync(join(dir, 'keys.json'), 'utf8');
    const providersBefore = readFileSync(join(dir, 'providers.json'), 'utf8');
    writeFail.plan = [join(dir, 'keys.json')];
    expect(() => store.remove(saved.id)).toThrow();
    expect(readFileSync(join(dir, 'providers.json'), 'utf8')).toBe(providersBefore);
    expect(readFileSync(join(dir, 'keys.json'), 'utf8')).toBe(keysBefore);
    const reloaded = new ProviderStore(dir, fakeEncryption());
    expect(reloaded.get(saved.id)?.name).toBe('Test Provider');
    expect(reloaded.getApiKey(saved.id)).toBe('sk-stay-aa');
    expect(reloaded.list()).toEqual(store.list());
    expect(store.get(saved.id)?.name).toBe('Test Provider');
    expect(store.getApiKey(saved.id)).toBe('sk-stay-aa');
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('surfaces a clear rollback failure when the restore also fails', () => {
    const dir = tempDir();
    const store = new ProviderStore(dir, fakeEncryption());
    const saved = store.save(input({ apiKey: 'sk-old-aa' }));
    // providers 写失败、随后 keys 回滚也失败：必须明确报错而不是默默吞掉
    writeFail.plan = [join(dir, 'providers.json'), join(dir, 'keys.json')];
    expect(() => store.save(input({ id: saved.id, apiKey: 'sk-new-aa' }))).toThrow(/回滚/);
    // 内存保持调用前状态
    expect(store.getApiKey(saved.id)).toBe('sk-old-aa');
    expect(store.get(saved.id)?.name).toBe('Test Provider');
  });

  it('preserves disk-only plaintext entries when rolling back a failed update', () => {
    // 非测试环境 + 加密不可用：明文条目从内存被丢弃但盘上原样保留。
    // 回滚必须用盘上真实快照，否则被丢弃的明文条目会被回滚静默删掉
    vi.stubEnv('ASI_DATA_DIR', '');
    const dir = tempDir();
    writeFileSync(
      join(dir, 'providers.json'),
      JSON.stringify([providerRecord('p1'), providerRecord('p2')]),
      'utf8',
    );
    // 用 writeJsonAtomic 相同的格式落种子，保证回滚后的内容逐字节一致
    const keysBefore = `${JSON.stringify(
      {
        p1: { encrypted: false, value: 'sk-refused-plain' },
        p2: { encrypted: true, value: fakeCipher('sk-keep-enc') },
      },
      null,
      2,
    )}\n`;
    writeFileSync(join(dir, 'keys.json'), keysBefore, 'utf8');
    const providersBefore = readFileSync(join(dir, 'providers.json'), 'utf8');
    const store = new ProviderStore(dir, fakeEncryption(false));
    expect(store.getApiKey('p1')).toBeUndefined();
    writeFail.plan = [join(dir, 'providers.json')];
    expect(() => store.save(input({ id: 'p2', apiKey: null }))).toThrow();
    // keys.json 回滚到调用前的真实盘上内容：明文条目一字不差地还在
    expect(readFileSync(join(dir, 'keys.json'), 'utf8')).toBe(keysBefore);
    expect(readFileSync(join(dir, 'providers.json'), 'utf8')).toBe(providersBefore);
    // 重载后的可观察状态与调用前一致，明文依旧被拒绝
    const reloaded = new ProviderStore(dir, fakeEncryption(false));
    expect(reloaded.getApiKey('p1')).toBeUndefined();
    expect(reloaded.get('p1')?.hasApiKey).toBe(false);
    expect(reloaded.getApiKey('p2')).toBe('sk-keep-enc');
    expect(reloaded.get('p2')?.hasApiKey).toBe(true);
    expect(reloaded.list()).toEqual(store.list());
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('still completes successful save/remove round-trips with the failure hook installed', () => {
    const dir = tempDir();
    const store = new ProviderStore(dir, fakeEncryption());
    const saved = store.save(input({ apiKey: 'sk-ok-aaa' }));
    expect(store.getApiKey(saved.id)).toBe('sk-ok-aaa');
    store.save(input({ id: saved.id, name: 'Renamed' }));
    expect(store.get(saved.id)?.name).toBe('Renamed');
    store.remove(saved.id);
    expect(store.get(saved.id)).toBeUndefined();
    const reloaded = new ProviderStore(dir, fakeEncryption());
    expect(reloaded.get(saved.id)).toBeUndefined();
  });
});

describe('ProviderStore apiKey validation', () => {
  it('rejects keys shorter than 8 chars after trim and never echoes the value', () => {
    const store = new ProviderStore(tempDir(), fakeEncryption());
    for (const bad of ['sk-tiny', '  a  ', '1234567']) {
      try {
        store.save(input({ apiKey: bad }));
        expect.unreachable();
      } catch (err) {
        expect((err as Error).message).toMatch(/至少 8/);
        expect((err as Error).message).not.toContain(bad.trim());
      }
    }
    expect(store.list()).toEqual([]);
  });

  it.each([
    ['内部空格', 'abcd 1234'],
    ['内部制表符', 'abcd\t1234'],
    ['内部换行', 'abcd\n1234'],
    ['非 ASCII 字符', 'abcdé1234'],
    ['emoji', 'abcd😀1234'],
    ['DEL 字符', 'abcd1234\x7F'],
    ['控制字符', 'ab\x01cd1234'],
    ['旧掩码占位符', 'sk-abc[已隐藏]xyz'],
  ])('rejects a key containing %s and never echoes the value', (_label, bad) => {
    const store = new ProviderStore(tempDir(), fakeEncryption());
    try {
      store.save(input({ apiKey: bad }));
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).toContain('可打印 ASCII');
      expect((err as Error).message).not.toContain(bad.trim());
    }
    expect(store.list()).toEqual([]);
  });

  it.each(['!!!!!!!!', '~~~~~~~~', '12345678', '  padded-ok9  '])(
    'accepts the boundary-valid key %j',
    (ok) => {
      const store = new ProviderStore(tempDir(), fakeEncryption());
      const saved = store.save(input({ apiKey: ok }));
      expect(saved.hasApiKey).toBe(true);
      expect(store.getApiKey(saved.id)).toBe(ok.trim());
    },
  );

  it('trims a valid key before persisting and using it', () => {
    const store = new ProviderStore(tempDir(), fakeEncryption());
    const saved = store.save(input({ apiKey: '  sk-padded-9  ' }));
    expect(store.getApiKey(saved.id)).toBe('sk-padded-9');
  });
});

describe('ProviderStore legacy invalid keys', () => {
  it('loads an invalid encrypted key as unusable and warns once without value or id', async () => {
    vi.resetModules();
    vi.stubEnv('ASI_DATA_DIR', '/tmp/asi-test-data');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { ProviderStore: FreshStore } = await import('../../src/main/stores/provider-store');
    const dir = tempDir();
    writeFileSync(
      join(dir, 'providers.json'),
      JSON.stringify([providerRecord('p-bad'), providerRecord('p-ok')]),
      'utf8',
    );
    writeFileSync(
      join(dir, 'keys.json'),
      JSON.stringify({
        'p-bad': { encrypted: true, value: fakeCipher('tiny') },
        'p-ok': { encrypted: true, value: fakeCipher('sk-valid-zz') },
      }),
      'utf8',
    );
    const store = new FreshStore(dir, fakeEncryption());
    expect(store.get('p-bad')?.hasApiKey).toBe(false);
    expect(store.getApiKey('p-bad')).toBeUndefined();
    expect(store.getApiKey('p-ok')).toBe('sk-valid-zz');
    // 第二个实例不再重复告警；告警不含 key 内容与条目 id
    new FreshStore(dir, fakeEncryption());
    expect(warn).toHaveBeenCalledTimes(1);
    const text = warn.mock.calls.flat().join(' ');
    expect(text).not.toContain('tiny');
    expect(text).not.toContain('p-bad');
  });

  it('marks invalid plaintext entries unusable in test mode when encryption is unavailable', async () => {
    vi.resetModules();
    vi.stubEnv('ASI_DATA_DIR', '/tmp/asi-test-data');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { ProviderStore: FreshStore } = await import('../../src/main/stores/provider-store');
    const dir = tempDir();
    writeFileSync(join(dir, 'providers.json'), JSON.stringify([providerRecord('p1')]), 'utf8');
    writeFileSync(
      join(dir, 'keys.json'),
      JSON.stringify({ p1: { encrypted: false, value: 'tiny' } }),
      'utf8',
    );
    const store = new FreshStore(dir, fakeEncryption(false));
    expect(store.get('p1')?.hasApiKey).toBe(false);
    expect(store.getApiKey('p1')).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.flat().join(' ')).not.toContain('tiny');
  });

  // 加密可用时 ASI_DATA_DIR 不再豁免迁移：无效/孤儿明文一律加密，原值字节原样保留
  it.each(['', '/tmp/asi-test-data'])(
    'encrypts invalid plaintext during migration while keeping it unavailable (ASI_DATA_DIR=%j)',
    async (dataDir) => {
      vi.resetModules();
      vi.stubEnv('ASI_DATA_DIR', dataDir);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { ProviderStore: FreshStore } = await import('../../src/main/stores/provider-store');
      const dir = tempDir();
      writeFileSync(
        join(dir, 'providers.json'),
        JSON.stringify([providerRecord('bad'), providerRecord('good')]),
        'utf8',
      );
      // padded 无效值：迁移必须原样加密保留原始字节（不 trim/不改写）
      writeFileSync(
        join(dir, 'keys.json'),
        JSON.stringify({
          bad: { encrypted: false, value: ' tiny ' },
          good: { encrypted: false, value: 'sk-mig-valid' },
        }),
        'utf8',
      );
      const store = new FreshStore(dir, fakeEncryption());
      expect(store.getApiKey('bad')).toBeUndefined();
      expect(store.get('bad')?.hasApiKey).toBe(false);
      expect(store.getApiKey('good')).toBe('sk-mig-valid');
      // 有效与无效明文都迁移为密文：盘上不留明文
      const raw = JSON.parse(readFileSync(join(dir, 'keys.json'), 'utf8')) as Record<
        string,
        { encrypted: boolean; value: string }
      >;
      expect(raw.good.encrypted).toBe(true);
      expect(raw.bad.encrypted).toBe(true);
      expect(fakeEncryption().decryptString(Buffer.from(raw.bad.value, 'base64'))).toBe(' tiny ');
      expect(readFileSync(join(dir, 'keys.json'), 'utf8')).not.toContain('tiny');
      // 重载后无效密文仍然不可用，恢复的原值仍是 padded 字节序列；告警全进程一次且不含 key/id
      const reloaded = new FreshStore(dir, fakeEncryption());
      expect(reloaded.getApiKey('bad')).toBeUndefined();
      expect(reloaded.get('bad')?.hasApiKey).toBe(false);
      expect(reloaded.getApiKey('good')).toBe('sk-mig-valid');
      expect(reloaded.getRedactionKeys()).toContain(' tiny ');
      expect(warn).toHaveBeenCalledTimes(1);
      const text = warn.mock.calls.flat().join(' ');
      expect(text).not.toContain('tiny');
      expect(text).not.toContain('bad');
    },
  );

  it.each(['', '/tmp/asi-test-data'])(
    'writes the migrated file even when every plaintext entry is invalid or orphaned (ASI_DATA_DIR=%j)',
    async (dataDir) => {
      vi.resetModules();
      vi.stubEnv('ASI_DATA_DIR', dataDir);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { ProviderStore: FreshStore } = await import('../../src/main/stores/provider-store');
      const dir = tempDir();
      writeFileSync(join(dir, 'providers.json'), JSON.stringify([providerRecord('bad')]), 'utf8');
      writeFileSync(
        join(dir, 'keys.json'),
        JSON.stringify({
          bad: { encrypted: false, value: ' tiny ' },
          orphan: { encrypted: false, value: 'xx yy' },
        }),
        'utf8',
      );
      const store = new FreshStore(dir, fakeEncryption());
      expect(store.getApiKey('bad')).toBeUndefined();
      expect(store.getApiKey('orphan')).toBeUndefined();
      // 没有任何合法邻居也照样重写：盘上不留明文
      const raw = JSON.parse(readFileSync(join(dir, 'keys.json'), 'utf8')) as Record<
        string,
        { encrypted: boolean; value: string }
      >;
      expect(raw.bad.encrypted).toBe(true);
      expect(raw.orphan.encrypted).toBe(true);
      const onDisk = readFileSync(join(dir, 'keys.json'), 'utf8');
      expect(onDisk).not.toContain('tiny');
      expect(onDisk).not.toContain('xx yy');
      expect(fakeEncryption().decryptString(Buffer.from(raw.bad.value, 'base64'))).toBe(' tiny ');
      // 重载后依旧不可用；无效原值仍可解密枚举
      const reloaded = new FreshStore(dir, fakeEncryption());
      expect(reloaded.getApiKey('bad')).toBeUndefined();
      expect(reloaded.get('bad')?.hasApiKey).toBe(false);
      expect(reloaded.getRedactionKeys()).toEqual(expect.arrayContaining([' tiny ', 'xx yy']));
      expect(warn).toHaveBeenCalledTimes(1);
      const text = warn.mock.calls.flat().join(' ');
      expect(text).not.toContain('tiny');
      expect(text).not.toContain('xx yy');
    },
  );

  it('marks plaintext entries unusable rather than deleting them when encryption is unavailable', async () => {
    vi.resetModules();
    vi.stubEnv('ASI_DATA_DIR', '');
    const { ProviderStore: FreshStore } = await import('../../src/main/stores/provider-store');
    const dir = tempDir();
    writeFileSync(join(dir, 'providers.json'), JSON.stringify([providerRecord('p1')]), 'utf8');
    writeFileSync(
      join(dir, 'keys.json'),
      JSON.stringify({ p1: { encrypted: false, value: 'sk-plain-ok' } }),
      'utf8',
    );
    const store = new FreshStore(dir, fakeEncryption(false));
    expect(store.get('p1')?.hasApiKey).toBe(false);
    expect(store.getApiKey('p1')).toBeUndefined();
    // 条目仍留在内存/盘上：对其它厂商的成功 save 不会把它抹掉
    store.save(input({ name: 'Other' }));
    const raw = JSON.parse(readFileSync(join(dir, 'keys.json'), 'utf8')) as Record<string, unknown>;
    expect(raw.p1).toEqual({ encrypted: false, value: 'sk-plain-ok' });
  });

  it('a successful explicit set or clear lifts the unavailable marker only after writes succeed', () => {
    vi.stubEnv('ASI_DATA_DIR', '/tmp/asi-test-data');
    const dir = tempDir();
    writeFileSync(
      join(dir, 'providers.json'),
      JSON.stringify([providerRecord('p1'), providerRecord('p2')]),
      'utf8',
    );
    writeFileSync(
      join(dir, 'keys.json'),
      JSON.stringify({ p1: { encrypted: false, value: 'tiny' } }),
      'utf8',
    );
    const store = new ProviderStore(dir, fakeEncryption());
    expect(store.getApiKey('p1')).toBeUndefined();
    // providers.json 写失败：标记不得被清掉
    writeFail.plan = [join(dir, 'providers.json')];
    expect(() => store.save(input({ id: 'p1', apiKey: 'sk-fresh-ok' }))).toThrow();
    expect(store.getApiKey('p1')).toBeUndefined();
    // 成功写入后才解除不可用标记
    const saved = store.save(input({ id: 'p1', apiKey: 'sk-fresh-ok' }));
    expect(saved.hasApiKey).toBe(true);
    expect(store.getApiKey('p1')).toBe('sk-fresh-ok');
    // 显式清除同样解除标记
    store.save(input({ id: 'p1', apiKey: null }));
    expect(store.get('p1')?.hasApiKey).toBe(false);
    // 清掉后再次设置正常工作
    store.save(input({ id: 'p1', apiKey: 'sk-fresh-ok' }));
    expect(store.getApiKey('p1')).toBe('sk-fresh-ok');
  });

  it('remove deletes a provider whose key is unusable', () => {
    vi.stubEnv('ASI_DATA_DIR', '/tmp/asi-test-data');
    const dir = tempDir();
    writeFileSync(join(dir, 'providers.json'), JSON.stringify([providerRecord('p1')]), 'utf8');
    writeFileSync(
      join(dir, 'keys.json'),
      JSON.stringify({ p1: { encrypted: false, value: 'tiny' } }),
      'utf8',
    );
    const store = new ProviderStore(dir, fakeEncryption());
    expect(store.get('p1')?.hasApiKey).toBe(false);
    store.remove('p1');
    expect(store.get('p1')).toBeUndefined();
    const keys = JSON.parse(readFileSync(join(dir, 'keys.json'), 'utf8')) as Record<string, unknown>;
    expect(keys.p1).toBeUndefined();
  });

  it('getRedactionKeys returns every nonempty decryptable value including invalid and ignored ones', () => {
    vi.stubEnv('ASI_DATA_DIR', '/tmp/asi-test-data');
    const dir = tempDir();
    writeFileSync(
      join(dir, 'keys.json'),
      JSON.stringify({
        'p-enc': { encrypted: true, value: fakeCipher('sk-valid-zz') },
        'p-inv': { encrypted: true, value: fakeCipher('tiny') },
        'p-plain': { encrypted: false, value: 'sk-plain-zz' },
        'p-bad': { encrypted: true, value: Buffer.from('GARBAGE-NOT-CIPHER').toString('base64') },
        'p-empty': { encrypted: false, value: '' },
      }),
      'utf8',
    );
    const store = new ProviderStore(dir, fakeEncryption());
    const keys = store.getRedactionKeys();
    expect(keys).toEqual(expect.arrayContaining(['sk-valid-zz', 'tiny', 'sk-plain-zz']));
    expect(keys).not.toContain('GARBAGE-NOT-CIPHER');
    expect(keys).not.toContain('');
    expect(keys).toHaveLength(3);
    // 密文损坏的条目只在枚举时被跳过，getApiKey 仍抛统一解密错误
    expect(() => store.getApiKey('p-bad')).toThrow(/无法解密/);
  });
});

describe('ProviderStore getKeySnapshot', () => {
  it('decrypts each ciphertext exactly once per snapshot, including corrupt entries', () => {
    vi.stubEnv('ASI_DATA_DIR', '/tmp/asi-test-data');
    const dir = tempDir();
    writeFileSync(join(dir, 'providers.json'), JSON.stringify([providerRecord('p-ok')]), 'utf8');
    writeFileSync(
      join(dir, 'keys.json'),
      JSON.stringify({
        'p-ok': { encrypted: true, value: fakeCipher('sk-valid-zz') },
        'p-corrupt': { encrypted: true, value: Buffer.from('GARBAGE').toString('base64') },
        'p-plain': { encrypted: false, value: 'sk-plain-zz' },
      }),
      'utf8',
    );
    // 加密不可用的测试回退：明文条目保持明文，快照枚举时不经过解密
    const counting = countingEncryption(false);
    const store = new ProviderStore(dir, counting.enc);
    // 构造期的分类解密与本次断言无关：清零后只看快照枚举
    counting.perCipher.clear();
    const snapshot = store.getKeySnapshot();
    // 两条密文（含损坏的）各恰好解密一次；明文条目不经过解密
    expect(counting.perCipher.size).toBe(2);
    for (const n of counting.perCipher.values()) {
      expect(n).toBe(1);
    }
    expect(snapshot.redactionKeys).toEqual(expect.arrayContaining(['sk-valid-zz', 'sk-plain-zz']));
    expect(snapshot.redactionKeys).toHaveLength(2);
  });

  it('collects every decryptable raw value for redaction while unavailable entries stay unusable', () => {
    // 加密不可用的测试回退：明文条目保留为明文，非法条目标记不可用但仍可枚举
    vi.stubEnv('ASI_DATA_DIR', '/tmp/asi-test-data');
    const dir = tempDir();
    writeFileSync(
      join(dir, 'providers.json'),
      JSON.stringify([
        providerRecord('p-ok'),
        providerRecord('p-bad'),
        providerRecord('p-plain'),
        providerRecord('p-corrupt'),
      ]),
      'utf8',
    );
    writeFileSync(
      join(dir, 'keys.json'),
      JSON.stringify({
        'p-ok': { encrypted: true, value: fakeCipher('sk-valid-zz') },
        'p-bad': { encrypted: true, value: fakeCipher('tiny') },
        'p-plain': { encrypted: false, value: 'sk-plain-zz' },
        'p-orphan': { encrypted: false, value: ' tiny ' },
        'p-corrupt': { encrypted: true, value: Buffer.from('GARBAGE').toString('base64') },
      }),
      'utf8',
    );
    const store = new ProviderStore(dir, fakeEncryption(false));
    const snapshot = store.getKeySnapshot();
    // 全部可解密的非空原值都进脱敏集合：含非法值、被忽略的孤儿与明文遗留
    expect(snapshot.redactionKeys).toEqual(
      expect.arrayContaining(['sk-valid-zz', 'tiny', 'sk-plain-zz', ' tiny ']),
    );
    expect(snapshot.redactionKeys).toHaveLength(4);
    expect(snapshot.getApiKey('p-ok')).toBe('sk-valid-zz');
    expect(snapshot.getApiKey('p-plain')).toBe('sk-plain-zz');
    // 不可用（非法内容/被忽略）条目不可被取用
    expect(snapshot.getApiKey('p-bad')).toBeUndefined();
    expect(snapshot.getApiKey('p-orphan')).toBeUndefined();
    // 缺失条目返回 undefined
    expect(snapshot.getApiKey('missing')).toBeUndefined();
    // 损坏密文抛与独立 getApiKey 相同的脱敏错误
    expect(() => snapshot.getApiKey('p-corrupt')).toThrow('无法解密已保存的 API Key');
    try {
      snapshot.getApiKey('p-corrupt');
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain('GARBAGE');
      expect((err as Error).message).not.toContain('bad cipher');
    }
  });

  it('keeps captured values and eligibility frozen across later store changes, without re-decrypting', () => {
    vi.stubEnv('ASI_DATA_DIR', '/tmp/asi-test-data');
    const dir = tempDir();
    writeFileSync(
      join(dir, 'providers.json'),
      JSON.stringify([providerRecord('p1'), providerRecord('p2'), providerRecord('p3')]),
      'utf8',
    );
    writeFileSync(
      join(dir, 'keys.json'),
      JSON.stringify({
        p1: { encrypted: true, value: fakeCipher('sk-first-88') },
        p2: { encrypted: true, value: fakeCipher('sk-second-9') },
        p3: { encrypted: true, value: fakeCipher('tiny') },
      }),
      'utf8',
    );
    const counting = countingEncryption();
    const store = new ProviderStore(dir, counting.enc);
    counting.perCipher.clear();
    const snapshot = store.getKeySnapshot();
    const baseline = new Map(counting.perCipher);
    // 快照之后：轮换 p1 的 key、删除 p2、给不可用的 p3 换上合法 key
    store.save(input({ id: 'p1', apiKey: 'sk-rotated-7' }));
    store.remove('p2');
    store.save(input({ id: 'p3', apiKey: 'sk-fixed-999' }));
    // 快照冻结：值与可用性都停留在捕获时刻，且不触发任何新的解密
    expect(snapshot.getApiKey('p1')).toBe('sk-first-88');
    expect(snapshot.getApiKey('p2')).toBe('sk-second-9');
    expect(snapshot.getApiKey('p3')).toBeUndefined();
    expect(snapshot.redactionKeys).toEqual(expect.arrayContaining(['sk-first-88', 'sk-second-9', 'tiny']));
    expect(counting.perCipher).toEqual(baseline);
    // store 的独立视图已按变更后状态工作
    expect(store.getApiKey('p1')).toBe('sk-rotated-7');
    expect(store.getApiKey('p2')).toBeUndefined();
    expect(store.getApiKey('p3')).toBe('sk-fixed-999');
  });
});

describe('ProviderStore ignored entries survive successful rewrites', () => {
  for (const op of ['clear-key', 'remove', 'replace-key'] as const) {
    it(`keeps ignored plaintext and invalid orphan entries after a successful ${op}`, async () => {
      vi.resetModules();
      vi.stubEnv('ASI_DATA_DIR', '');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const { ProviderStore: FreshStore } = await import('../../src/main/stores/provider-store');
      const dir = tempDir();
      writeFileSync(
        join(dir, 'providers.json'),
        JSON.stringify([providerRecord('p1'), providerRecord('p2')]),
        'utf8',
      );
      const p1Entry = { encrypted: false, value: 'sk-plain-p1' };
      const orphanEntry = { encrypted: false, value: 'tiny' };
      writeFileSync(
        join(dir, 'keys.json'),
        JSON.stringify({
          p1: p1Entry,
          p2: { encrypted: true, value: fakeCipher('sk-p2-key000') },
          orphan: orphanEntry,
        }),
        'utf8',
      );
      let encAvailable = false;
      const enc = fakeEncryption(false);
      enc.isEncryptionAvailable = () => encAvailable;
      const store = new FreshStore(dir, enc);
      // p1 明文因加密不可用被忽略；orphan 是无主无效密文
      expect(store.getApiKey('p1')).toBeUndefined();
      expect(store.get('p1')?.hasApiKey).toBe(false);
      expect(store.getApiKey('p2')).toBe('sk-p2-key000');

      if (op === 'clear-key') {
        store.save(input({ id: 'p2', apiKey: null }));
      } else if (op === 'remove') {
        store.remove('p2');
      } else {
        // 加密转为可用后显式替换 key
        encAvailable = true;
        store.save(input({ id: 'p2', apiKey: 'sk-p2-fresh9' }));
      }

      const raw = JSON.parse(readFileSync(join(dir, 'keys.json'), 'utf8')) as Record<string, unknown>;
      // 重写 keys.json 后：被忽略的明文条目与无效 orphan 条目原样保留
      expect(raw.p1).toEqual(p1Entry);
      expect(raw.orphan).toEqual(orphanEntry);
      if (op === 'replace-key') {
        expect((raw.p2 as { encrypted: boolean }).encrypted).toBe(true);
        expect(store.getApiKey('p2')).toBe('sk-p2-fresh9');
      } else {
        expect(raw.p2).toBeUndefined();
      }
      // p1 在同一实例内依旧不可用
      expect(store.getApiKey('p1')).toBeUndefined();
      expect(store.get('p1')?.hasApiKey).toBe(false);

      // 加密可用后重载：p1 明文迁移为密文并可用；无效 orphan 明文同样被加密迁移
      // （原值原样可解密、不可用标记保持、盘上无明文），而不是原样留明文
      const reloaded = new FreshStore(dir, fakeEncryption());
      expect(reloaded.getApiKey('p1')).toBe('sk-plain-p1');
      const migrated = JSON.parse(readFileSync(join(dir, 'keys.json'), 'utf8')) as Record<
        string,
        { encrypted: boolean; value: string }
      >;
      expect(migrated.p1.encrypted).toBe(true);
      expect(migrated.orphan.encrypted).toBe(true);
      expect(fakeEncryption().decryptString(Buffer.from(migrated.orphan.value, 'base64'))).toBe('tiny');
      expect(readFileSync(join(dir, 'keys.json'), 'utf8')).not.toContain('tiny');
      expect(reloaded.getApiKey('orphan')).toBeUndefined();
      expect(reloaded.getRedactionKeys()).toContain('tiny');
      const warnText = warn.mock.calls.flat().join(' ');
      expect(warnText).not.toContain('tiny');
      expect(warnText).not.toContain('orphan');
      expect(warnText).not.toContain('sk-plain-p1');
    });
  }
});
