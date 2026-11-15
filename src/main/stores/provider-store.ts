import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderConfig, ProviderInput, ProviderKind } from '../../shared/types';
import { ensureDir, readJsonFile, writeJsonAtomic } from './json-file';

export interface StorageEncryption {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export const FAUX_PROVIDER_ID = 'faux';

const FAUX_PROVIDER: ProviderConfig = {
  id: FAUX_PROVIDER_ID,
  name: 'Faux (测试)',
  kind: 'builtin',
  builtinProvider: 'faux',
  hasApiKey: true,
  enabled: true,
  customModels: [],
  createdAt: 0,
};

interface ProviderRecord {
  id: string;
  name: string;
  kind: ProviderKind;
  builtinProvider?: string;
  baseUrl?: string;
  enabled: boolean;
  customModels: string[];
  createdAt: number;
}

interface KeyEntry {
  encrypted: boolean;
  value: string;
}

// safeStorage 不可用时明文回退的告警，整个进程只报一次（告警不含任何 key 内容）
let warnedPlaintextKeys = false;

// 非测试环境加载到明文 key 且无法加密迁移时的告警，整个进程只报一次
let warnedPlaintextDropped = false;

/** 恢复单个 JSON 文件到调用前状态：有旧快照则原子写回，原本不存在则删除刚创建的文件 */
function restoreFileSnapshot(path: string, snapshot: unknown): void {
  if (snapshot === undefined) {
    rmSync(path, { force: true });
  } else {
    writeJsonAtomic(path, snapshot);
  }
}

function isProviderRecord(value: unknown): value is ProviderRecord {
  const r = value as ProviderRecord;
  return (
    typeof r === 'object' &&
    r !== null &&
    typeof r.id === 'string' &&
    typeof r.name === 'string' &&
    (r.kind === 'builtin' || r.kind === 'openai-compatible') &&
    (r.builtinProvider === undefined || typeof r.builtinProvider === 'string') &&
    (r.baseUrl === undefined || typeof r.baseUrl === 'string') &&
    typeof r.enabled === 'boolean' &&
    Array.isArray(r.customModels) &&
    r.customModels.every((m) => typeof m === 'string') &&
    typeof r.createdAt === 'number'
  );
}

function isKeyEntry(value: unknown): value is KeyEntry {
  const e = value as KeyEntry;
  return (
    typeof e === 'object' && e !== null && typeof e.encrypted === 'boolean' && typeof e.value === 'string'
  );
}

export class ProviderStore {
  private readonly providersPath: string;
  private readonly keysPath: string;
  private providers: ProviderRecord[] = [];
  private keys: Record<string, KeyEntry> = {};

  constructor(
    dataDirectory: string,
    private readonly encryption: StorageEncryption,
  ) {
    ensureDir(dataDirectory);
    this.providersPath = join(dataDirectory, 'providers.json');
    this.keysPath = join(dataDirectory, 'keys.json');

    const rawProviders = readJsonFile<unknown>(this.providersPath);
    if (rawProviders !== undefined) {
      if (!Array.isArray(rawProviders) || !rawProviders.every(isProviderRecord)) {
        throw new Error(`数据文件损坏，厂商记录格式无效：${this.providersPath}`);
      }
      // 白名单重建：历史/不可信文件里的多余字段（如 apiKey）不得进入内存或随下次写盘泄漏
      this.providers = rawProviders.map((r) => {
        const record: ProviderRecord = {
          id: r.id,
          name: r.name,
          kind: r.kind,
          enabled: r.enabled,
          customModels: [...r.customModels],
          createdAt: r.createdAt,
        };
        if (r.builtinProvider !== undefined) {
          record.builtinProvider = r.builtinProvider;
        }
        if (r.baseUrl !== undefined) {
          record.baseUrl = r.baseUrl;
        }
        return record;
      });
    }

    const rawKeys = readJsonFile<unknown>(this.keysPath);
    if (rawKeys !== undefined) {
      if (
        typeof rawKeys !== 'object' ||
        rawKeys === null ||
        Array.isArray(rawKeys) ||
        !Object.values(rawKeys).every(isKeyEntry)
      ) {
        throw new Error(`数据文件损坏，密钥记录格式无效：${this.keysPath}`);
      }
      this.keys = rawKeys as Record<string, KeyEntry>;
    }
    this.migratePlaintextKeys();
  }

  /**
   * 非测试环境不允许明文 key 投入使用：
   * - 加密可用：用 encodeKey 把全部 encrypted:false 条目转成密文，构造返回前原子重写一次；
   *   迁移加密/写盘失败直接让构造失败，明文绝不可被 getApiKey 读到。
   * - 加密不可用：只从内存丢弃明文条目（盘上文件不动），保留加密条目，进程级告警一次。
   * ASI_DATA_DIR 测试模式下的明文条目保持可用。
   */
  private migratePlaintextKeys(): void {
    if (process.env.ASI_DATA_DIR) {
      return;
    }
    const plaintextIds = Object.keys(this.keys).filter((id) => !this.keys[id].encrypted);
    if (plaintextIds.length === 0) {
      return;
    }
    if (this.encryption.isEncryptionAvailable()) {
      const migrated = { ...this.keys };
      for (const id of plaintextIds) {
        migrated[id] = this.encodeKey(this.keys[id].value);
      }
      writeJsonAtomic(this.keysPath, migrated);
      this.keys = migrated;
      return;
    }
    for (const id of plaintextIds) {
      delete this.keys[id];
    }
    if (!warnedPlaintextDropped) {
      warnedPlaintextDropped = true;
      console.warn('[ASI] 系统加密不可用，已忽略 keys.json 中的明文 API Key 条目');
    }
  }

  private fauxEnabled(): boolean {
    return process.env.ASI_FAUX === '1';
  }

  private toConfig(record: ProviderRecord): ProviderConfig {
    const config: ProviderConfig = {
      id: record.id,
      name: record.name,
      kind: record.kind,
      hasApiKey: this.keys[record.id] !== undefined,
      enabled: record.enabled,
      customModels: [...record.customModels],
      createdAt: record.createdAt,
    };
    if (record.builtinProvider !== undefined) {
      config.builtinProvider = record.builtinProvider;
    }
    if (record.baseUrl !== undefined) {
      config.baseUrl = record.baseUrl;
    }
    return config;
  }

  private encodeKey(key: string): KeyEntry {
    if (this.encryption.isEncryptionAvailable()) {
      try {
        return { encrypted: true, value: this.encryption.encryptString(key).toString('base64') };
      } catch {
        // 底层错误信息可能携带 key 内容，不向外透传
        throw new Error('无法加密 API Key');
      }
    }
    if (!process.env.ASI_DATA_DIR) {
      throw new Error('系统加密不可用，无法安全保存 API Key');
    }
    if (!warnedPlaintextKeys) {
      warnedPlaintextKeys = true;
      console.warn(
        '[ASI] safeStorage 加密不可用，API Key 将以明文回退方式保存（仅限 ASI_DATA_DIR 测试环境）',
      );
    }
    return { encrypted: false, value: key };
  }

  list(): ProviderConfig[] {
    const configs = this.providers.map((r) => this.toConfig(r));
    if (this.fauxEnabled()) {
      configs.push(structuredClone(FAUX_PROVIDER));
    }
    return configs;
  }

  get(id: string): ProviderConfig | undefined {
    if (id === FAUX_PROVIDER_ID) {
      return this.fauxEnabled() ? structuredClone(FAUX_PROVIDER) : undefined;
    }
    const record = this.providers.find((p) => p.id === id);
    return record ? this.toConfig(record) : undefined;
  }

  save(input: ProviderInput): ProviderConfig {
    if (input.id === FAUX_PROVIDER_ID) {
      throw new Error('内置测试厂商不可修改');
    }
    if (typeof input.apiKey === 'string' && input.apiKey.trim() === '') {
      throw new Error('API Key 不能为空字符串');
    }

    let record: ProviderRecord;
    let nextProviders: ProviderRecord[];
    if (input.id === undefined) {
      record = {
        id: randomUUID(),
        name: input.name,
        kind: input.kind,
        enabled: input.enabled,
        customModels: [...input.customModels],
        createdAt: Date.now(),
      };
      if (input.builtinProvider !== undefined) {
        record.builtinProvider = input.builtinProvider;
      }
      if (input.baseUrl !== undefined) {
        record.baseUrl = input.baseUrl;
      }
      nextProviders = [...this.providers, record];
    } else {
      const existing = this.providers.find((p) => p.id === input.id);
      if (!existing) {
        throw new Error(`厂商不存在：${input.id}`);
      }
      record = {
        id: existing.id,
        name: input.name,
        kind: input.kind,
        enabled: input.enabled,
        customModels: [...input.customModels],
        createdAt: existing.createdAt,
      };
      if (input.builtinProvider !== undefined) {
        record.builtinProvider = input.builtinProvider;
      }
      if (input.baseUrl !== undefined) {
        record.baseUrl = input.baseUrl;
      }
      nextProviders = this.providers.map((p) => (p.id === record.id ? record : p));
    }

    // 先编码 key（可能因加密不可用而拒绝），两个候选快照都落盘成功后才提交内存
    let nextKeys: Record<string, KeyEntry> | undefined;
    if (input.apiKey === null) {
      nextKeys = { ...this.keys };
      delete nextKeys[record.id];
    } else if (typeof input.apiKey === 'string') {
      nextKeys = { ...this.keys, [record.id]: this.encodeKey(input.apiKey) };
    }

    if (nextKeys) {
      // 回滚快照必须是盘上实际内容：构造时被丢弃的明文条目仍留在盘上，
      // 用 this.keys 重建会把它们从回滚结果里抹掉
      const keysSnapshot = readJsonFile<unknown>(this.keysPath);
      writeJsonAtomic(this.keysPath, nextKeys);
      try {
        writeJsonAtomic(this.providersPath, nextProviders);
      } catch (err) {
        // 第二份文件写失败：把已写出的 keys.json 回滚到调用前状态，
        // 否则重启后 key 会被静默更新/清除
        try {
          restoreFileSnapshot(this.keysPath, keysSnapshot);
        } catch {
          throw new Error('厂商保存失败，且密钥数据回滚失败');
        }
        throw err;
      }
    } else {
      writeJsonAtomic(this.providersPath, nextProviders);
    }
    this.providers = nextProviders;
    if (nextKeys) {
      this.keys = nextKeys;
    }
    return this.toConfig(record);
  }

  remove(id: string): void {
    if (id === FAUX_PROVIDER_ID) {
      throw new Error('内置测试厂商不可删除');
    }
    const index = this.providers.findIndex((p) => p.id === id);
    if (index === -1) {
      return;
    }
    const nextProviders = this.providers.filter((p) => p.id !== id);
    const nextKeys = { ...this.keys };
    delete nextKeys[id];
    // 先写 providers 再写 keys：中途失败时盘上最多留下孤儿 key 条目，
    // 而不会是"key 被删掉但厂商还在"的不可用状态
    // 回滚快照取盘上实际内容，保证恢复原文件而非内存重建版本
    const providersSnapshot = readJsonFile<unknown>(this.providersPath);
    writeJsonAtomic(this.providersPath, nextProviders);
    if (this.keys[id] !== undefined) {
      try {
        writeJsonAtomic(this.keysPath, nextKeys);
      } catch (err) {
        // 第二份文件写失败：回滚 providers.json 到调用前快照，
        // 否则重启后厂商已消失但 key 留孤儿
        try {
          restoreFileSnapshot(this.providersPath, providersSnapshot);
        } catch {
          throw new Error('厂商删除失败，且厂商记录回滚失败');
        }
        throw err;
      }
    }
    this.providers = nextProviders;
    this.keys = nextKeys;
  }

  getApiKey(id: string): string | undefined {
    const entry = this.keys[id];
    if (!entry) {
      return undefined;
    }
    if (!entry.encrypted) {
      return entry.value;
    }
    try {
      return this.encryption.decryptString(Buffer.from(entry.value, 'base64'));
    } catch {
      // 底层错误信息可能携带 key/密文内容，不向外透传
      throw new Error('无法解密已保存的 API Key');
    }
  }
}
