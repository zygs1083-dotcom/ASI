import { join } from 'node:path';
import type { AppSettings, ModelRef } from '../../shared/types';
import { ensureDir, readJsonFile, writeJsonAtomic } from './json-file';

export interface NativeThemeLike {
  themeSource: 'system' | 'light' | 'dark';
}

const THEMES = new Set<AppSettings['theme']>(['system', 'light', 'dark']);

function isTheme(value: unknown): value is AppSettings['theme'] {
  return THEMES.has(value as AppSettings['theme']);
}

function isModelRef(value: unknown): value is ModelRef {
  const m = value as ModelRef;
  return (
    typeof m === 'object' && m !== null && typeof m.providerId === 'string' && typeof m.modelId === 'string'
  );
}

export class SettingsStore {
  private readonly path: string;
  private settings: AppSettings;

  constructor(
    dataDirectory: string,
    private readonly nativeTheme: NativeThemeLike,
  ) {
    ensureDir(dataDirectory);
    this.path = join(dataDirectory, 'settings.json');
    const raw = readJsonFile<Partial<AppSettings>>(this.path);
    this.settings = {
      defaultModel: isModelRef(raw?.defaultModel) ? structuredClone(raw.defaultModel) : null,
      theme: isTheme(raw?.theme) ? raw.theme : 'system',
    };
    this.nativeTheme.themeSource = this.settings.theme;
  }

  get(): AppSettings {
    return structuredClone(this.settings);
  }

  set(patch: Partial<AppSettings>): AppSettings {
    const next: AppSettings = {
      defaultModel: patch.defaultModel === undefined ? this.settings.defaultModel : patch.defaultModel,
      theme: patch.theme === undefined ? this.settings.theme : patch.theme,
    };
    if (!isTheme(next.theme)) {
      throw new Error(`无效的主题：${String(patch.theme)}`);
    }
    if (next.defaultModel !== null && !isModelRef(next.defaultModel)) {
      throw new Error('无效的默认模型');
    }
    const snapshot = structuredClone(next);
    writeJsonAtomic(this.path, snapshot);
    this.settings = snapshot;
    this.nativeTheme.themeSource = snapshot.theme;
    return structuredClone(snapshot);
  }
}
