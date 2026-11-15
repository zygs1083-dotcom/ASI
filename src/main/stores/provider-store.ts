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

/**
 * 请求级 key 快照：一次枚举 keys 得到。
 * - redactionKeys：全部可解密的非空已存 key 原值（含不可用/孤儿条目），供脱敏枚举；
 * - getApiKey：与独立 getApiKey 同语义（解密失败抛统一错误、缺失/不可用返回
 *   undefined），但只读快照内捕获的数据——之后 save/remove/轮换不回看，
 *   也不再触碰 store 或解密器。
 */
export interface ProviderKeySnapshot {
  redactionKeys: string[];
  getApiKey(id: string): string | undefined;
}

// safeStorage 不可用时明文回退的告警，整个进程只报一次（告警不含任何 key 内容）
let warnedPlaintextKeys = false;

// 非测试环境加载到明文 key 且无法加密迁移时的告警，整个进程只报一次
let warnedPlaintextDropped = false;

// 历史遗留的非法 key 条目被标记为不可用时的告警，整个进程只报一次（不含 key 内容与条目 id）
let warnedInvalidKeys = false;

const MIN_API_KEY_LENGTH = 8;

/** 合法 key 字符集：无空白的可打印 ASCII（'!' 0x21 ~ '~' 0x7E），trim 后至少 8 位 */
const API_KEY_PATTERN = /^[\x21-\x7E]+$/;

type ApiKeyProblem = 'empty' | 'short' | 'charset';

/** 与渲染进程一致的 key 校验：trim 后为空 / 过短 / 含空白或非可打印 ASCII */
function apiKeyProblem(value: string): ApiKeyProblem | null {
  const trimmed = value.trim();
  if (trimmed === '') {
    return 'empty';
  }
  if (trimmed.length < MIN_API_KEY_LENGTH) {
    return 'short';
  }
  if (!API_KEY_PATTERN.test(trimmed)) {
    return 'charset';
  }
  return null;
}

const API_KEY_ERRORS: Record<ApiKeyProblem, string> = {
  empty: 'API Key 不能为空字符串',
  short: `API Key 长度至少 ${MIN_API_KEY_LENGTH} 个字符`,
  charset: 'API Key 只能包含无空白的可打印 ASCII 字符',
};

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
  /** 保留盘上全部条目（含被判定不可用的），保证 save/remove 写回时不丢无关条目 */
  private keys: Record<string, KeyEntry> = {};
  /** 加载时被判定不可用的 key 条目（非法内容、或生产环境无法加密的明文）：hasApiKey=false、getApiKey=undefined */
  private readonly unavailableKeys = new Set<string>();

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
    this.classifyLoadedKeys();
    this.migratePlaintextKeys();
  }

  private warnInvalidKey(): void {
    if (!warnedInvalidKeys) {
      warnedInvalidKeys = true;
      console.warn('[ASI] keys.json 中存在不符合校验规则的 API Key 条目，已标记为不可用');
    }
  }

  /**
   * 加载的条目逐个分类：可解密但内容非法的标记为不可用（密文原样保留、不可被 getApiKey 读到）；
   * 密文本身不可读的跳过——保留既有行为：构造照常，getApiKey 时才抛统一解密错误。
   */
  private classifyLoadedKeys(): void {
    for (const [id, entry] of Object.entries(this.keys)) {
      if (entry.encrypted) {
        let value: string;
        try {
          value = this.encryption.decryptString(Buffer.from(entry.value, 'base64'));
        } catch {
          continue;
        }
        if (apiKeyProblem(value) !== null) {
          this.unavailableKeys.add(id);
          this.warnInvalidKey();
        }
      } else if (process.env.ASI_DATA_DIR) {
        // 加密不可用的测试回退里明文条目可用，但内容仍须通过同一校验；
        // 加密可用时这些明文条目随后由 migratePlaintextKeys 全部迁移
        if (apiKeyProblem(entry.value) !== null) {
          this.unavailableKeys.add(id);
          this.warnInvalidKey();
        }
      }
      // 其余明文条目由 migratePlaintextKeys 处置
    }
  }

  /**
   * 加密可用时盘上不留明文 key（生产与 ASI_DATA_DIR 测试模式一致迁移）：
   * - 加密可用：把全部 encrypted:false 条目转成密文（含内容非法的与孤儿条目），
   *   构造返回前原子重写一次；非法条目原值原样加密保留（不 trim/不改写），
   *   同时标记为不可用；迁移加密/写盘失败直接让构造失败，
   *   明文绝不可被 getApiKey 读到。
   * - 加密不可用：生产环境全部明文条目标记为不可用（内存与盘上都不删），
   *   进程级告警一次；仅 ASI_DATA_DIR 测试模式允许明文回退投入使用，
   *   条目保持可用（合法性已在 classifyLoadedKeys 分类）。
   */
  private migratePlaintextKeys(): void {
    const plaintextIds = Object.keys(this.keys).filter((id) => !this.keys[id].encrypted);
    if (plaintextIds.length === 0) {
      return;
    }
    if (this.encryption.isEncryptionAvailable()) {
      const migrated = { ...this.keys };
      for (const id of plaintextIds) {
        if (apiKeyProblem(this.keys[id].value) === null) {
          migrated[id] = this.encodeKey(this.keys[id].value.trim());
        } else {
          // 非法条目也加密：盘上不留明文；原值原样保留以便重载/脱敏枚举恢复同一字节序列
          migrated[id] = this.encodeKey(this.keys[id].value);
          this.unavailableKeys.add(id);
          this.warnInvalidKey();
        }
      }
      writeJsonAtomic(this.keysPath, migrated);
      this.keys = migrated;
      return;
    }
    if (process.env.ASI_DATA_DIR) {
      // 仅加密不可用时允许的测试明文回退：条目保持可用，盘上仍是明文
      return;
    }
    for (const id of plaintextIds) {
      this.unavailableKeys.add(id);
      if (apiKeyProblem(this.keys[id].value) !== null) {
        this.warnInvalidKey();
      }
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
      hasApiKey: this.keys[record.id] !== undefined && !this.unavailableKeys.has(record.id),
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
    if (typeof input.apiKey === 'string') {
      const problem = apiKeyProblem(input.apiKey);
      if (problem !== null) {
        // 校验错误信息不得回显 key 内容
        throw new Error(API_KEY_ERRORS[problem]);
      }
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
      nextKeys = { ...this.keys, [record.id]: this.encodeKey(input.apiKey.trim()) };
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
      // 显式设置/清除成功后才解除该条目的不可用标记（写盘失败时保持原状）
      this.unavailableKeys.delete(record.id);
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
    this.unavailableKeys.delete(id);
  }

  getApiKey(id: string): string | undefined {
    if (this.unavailableKeys.has(id)) {
      return undefined;
    }
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

  /**
   * 请求级 key 快照：单次枚举 keys，每条密文恰好解密一次（含失败尝试），
   * 一次调用同时产出脱敏集合与冻结的 getApiKey：
   * - redactionKeys 收集全部可解密的非空原值，含被标记不可用/被忽略的
   *   遗留与孤儿条目（与 getRedactionKeys 语义一致）；
   * - usable 只收不可用条目之外的值，decryptFailed 同样排除不可用条目，
   *   与 getApiKey 的判定顺序一致（不可用 → undefined 优先于解密错误）；
   * - 返回的闭包只读这两份捕获数据，不引用 this.unavailableKeys 等可变
   *   状态，后续 save/remove/轮换不影响快照。
   */
  getKeySnapshot(): ProviderKeySnapshot {
    const redactionKeys: string[] = [];
    const usable = new Map<string, string>();
    const decryptFailed = new Set<string>();
    for (const [id, entry] of Object.entries(this.keys)) {
      const unavailable = this.unavailableKeys.has(id);
      let value: string;
      if (entry.encrypted) {
        try {
          value = this.encryption.decryptString(Buffer.from(entry.value, 'base64'));
        } catch {
          // 单条损坏只跳过：枚举绝不因一条坏数据泄漏或中断
          if (!unavailable) {
            decryptFailed.add(id);
          }
          continue;
        }
      } else {
        value = entry.value;
      }
      if (value !== '') {
        redactionKeys.push(value);
      }
      if (!unavailable) {
        usable.set(id, value);
      }
    }
    return {
      redactionKeys,
      getApiKey: (id: string) => {
        if (decryptFailed.has(id)) {
          // 与独立 getApiKey 一致：底层错误信息可能携带 key/密文内容，不向外透传
          throw new Error('无法解密已保存的 API Key');
        }
        return usable.get(id);
      },
    };
  }

  /**
   * 主进程内部使用：返回全部可解密的非空持久化 key 值（含被标记不可用的/被忽略的遗留条目），
   * 供流式输出脱敏枚举。已接受边界（架构 §6）：不可解密的条目被有意排除——解不出来的值
   * 应用不会发给本次请求的目标厂商，契约明确将其排除（而非承诺该值不可能出现在模型
   * 输出里）；请求中途新保存的 key 从下一次请求起生效。
   * 单条密文损坏只跳过该条，不影响其余，也不改变 getApiKey 的行为。
   */
  getRedactionKeys(): string[] {
    return this.getKeySnapshot().redactionKeys;
  }
}
