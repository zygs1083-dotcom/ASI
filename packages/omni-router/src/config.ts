import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  createDefaultPresenceConfig,
  type MaskedSecretsSummary,
  maskSecret,
  type PresenceConfig,
  PresenceConfigSchema,
  type PresenceSecrets,
  PresenceSecretsSchema,
} from './config-schema.ts';

export {
  createDefaultPresenceConfig,
  getDefaultSttProvider,
  type LlmProviderKind,
  LlmProviderKindSchema,
  type MaskedSecretsSummary,
  maskSecret,
  type PresenceConfig,
  PresenceConfigSchema,
  type PresenceSecrets,
  PresenceSecretsSchema,
  STT_PROVIDERS,
  type SttProviderKind,
  SttProviderKindSchema,
  type TtsProviderKind,
  TtsProviderKindSchema,
} from './config-schema.ts';

async function atomicWriteFile(filePath: string, content: string, mode: number): Promise<void> {
  const tmpPath = `${filePath}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  try {
    await writeFile(tmpPath, content, { encoding: 'utf8', mode });
    await chmod(tmpPath, mode);
    await rename(tmpPath, filePath);
    await chmod(filePath, mode);
  } catch (error) {
    await rm(tmpPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export interface SecretsStoreOptions {
  /** Base storage directory (defaults to `~/.asi-presence`). Never reads `~/.secrets/`. */
  baseDir?: string;
  /** Optional env lookup override (for isolated tests). */
  env?: Record<string, string | undefined>;
}

/**
 * Local-only configuration and `0600` secrets persistence store for ASI Presence.
 * Strictly isolates API keys in `~/.asi-presence/secrets.json` (mode `0600`) and
 * never exposes raw key strings to renderer UI surfaces.
 */
export class PresenceSecretsStore {
  readonly baseDir: string;
  readonly configPath: string;
  readonly secretsPath: string;
  private readonly env: Record<string, string | undefined>;

  constructor(options: SecretsStoreOptions = {}) {
    this.baseDir = options.baseDir ?? join(homedir(), '.asi-presence');
    this.configPath = join(this.baseDir, 'config.json');
    this.secretsPath = join(this.baseDir, 'secrets.json');
    this.env = options.env ?? process.env;
  }

  private async ensureDir(): Promise<void> {
    await mkdir(this.baseDir, { recursive: true, mode: 0o700 });
    await chmod(this.baseDir, 0o700).catch(() => undefined);
  }

  async loadConfig(): Promise<PresenceConfig> {
    try {
      const raw = await readFile(this.configPath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      return PresenceConfigSchema.parse(parsed);
    } catch {
      return createDefaultPresenceConfig();
    }
  }

  async saveConfig(patch: Partial<PresenceConfig> | PresenceConfig): Promise<PresenceConfig> {
    const current = await this.loadConfig();
    const merged = PresenceConfigSchema.parse({
      persona: { ...current.persona, ...(patch.persona ?? {}) },
      appearance: { ...current.appearance, ...(patch.appearance ?? {}) },
      systemOne: { ...current.systemOne, ...(patch.systemOne ?? {}) },
      fastBrain: { ...current.fastBrain, ...(patch.fastBrain ?? {}) },
      visionBrain: { ...current.visionBrain, ...(patch.visionBrain ?? {}) },
      slowBrain: { ...current.slowBrain, ...(patch.slowBrain ?? {}) },
      voice: { ...current.voice, ...(patch.voice ?? {}) },
    });
    await this.ensureDir();
    await atomicWriteFile(this.configPath, `${JSON.stringify(merged, null, 2)}\n`, 0o600);
    return merged;
  }

  async loadSecrets(): Promise<PresenceSecrets> {
    let fromFile: PresenceSecrets = {};
    try {
      const raw = await readFile(this.secretsPath, 'utf8');
      fromFile = PresenceSecretsSchema.parse(JSON.parse(raw));
    } catch {
      fromFile = {};
    }
    const envTypesafe = this.env.TYPESAFE_API_KEY?.trim();
    return {
      ...fromFile,
      typesafeApiKey: fromFile.typesafeApiKey?.trim() || envTypesafe || undefined,
    };
  }

  async saveSecrets(patch: Partial<Record<keyof PresenceSecrets, string | null>>): Promise<MaskedSecretsSummary> {
    let existing: PresenceSecrets = {};
    try {
      const raw = await readFile(this.secretsPath, 'utf8');
      existing = PresenceSecretsSchema.parse(JSON.parse(raw));
    } catch {
      existing = {};
    }
    const next: PresenceSecrets = { ...existing };
    for (const [key, value] of Object.entries(patch) as [keyof PresenceSecrets, string | null | undefined][]) {
      if (value === undefined) continue;
      if (value === null || value.trim() === '') {
        delete next[key];
      } else {
        next[key] = value.trim();
      }
    }
    await this.ensureDir();
    await atomicWriteFile(this.secretsPath, `${JSON.stringify(next, null, 2)}\n`, 0o600);
    return this.getMaskedSecrets();
  }

  async getMaskedSecrets(): Promise<MaskedSecretsSummary> {
    const secrets = await this.loadSecrets();
    const typesafeHint = maskSecret(secrets.typesafeApiKey);
    const fastHint = maskSecret(secrets.fastBrainApiKey);
    return {
      hasTypesafeApiKey: typesafeHint !== null,
      typesafeApiKeyHint: typesafeHint,
      hasFastBrainApiKey: fastHint !== null,
      fastBrainApiKeyHint: fastHint,
      hasVisionBrainApiKey: maskSecret(secrets.visionBrainApiKey) !== null,
      hasCustomTtsApiKey: maskSecret(secrets.customTtsApiKey) !== null,
      hasWhisperApiKey: maskSecret(secrets.whisperApiKey) !== null,
    };
  }
}
