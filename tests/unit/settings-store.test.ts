import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type NativeThemeLike, SettingsStore } from '../../src/main/stores/settings-store';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'asi-settings-store-'));
  dirs.push(dir);
  return dir;
}

function fakeTheme(): NativeThemeLike & { themeSource: 'system' | 'light' | 'dark' } {
  return { themeSource: 'system' };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('SettingsStore', () => {
  it('returns defaults and applies theme when no file exists', () => {
    const theme = fakeTheme();
    const store = new SettingsStore(tempDir(), theme);
    expect(store.get()).toEqual({ defaultModel: null, theme: 'system' });
    expect(theme.themeSource).toBe('system');
  });

  it('applies a persisted theme at construction', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ theme: 'dark' }), 'utf8');
    const theme = fakeTheme();
    new SettingsStore(dir, theme);
    expect(theme.themeSource).toBe('dark');
  });

  it('set merges a patch, persists atomically, then applies the theme', () => {
    const dir = tempDir();
    const theme = fakeTheme();
    const store = new SettingsStore(dir, theme);
    const model = { providerId: 'p', modelId: 'm' };
    const result = store.set({ defaultModel: model });
    expect(result.defaultModel).toEqual(model);
    expect(result.theme).toBe('system');
    expect(theme.themeSource).toBe('system');
    model.modelId = 'mutated';
    expect(store.get().defaultModel).toEqual({ providerId: 'p', modelId: 'm' });

    store.set({ theme: 'light' });
    expect(theme.themeSource).toBe('light');
    const raw = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'));
    expect(raw).toEqual({ defaultModel: { providerId: 'p', modelId: 'm' }, theme: 'light' });
  });

  it('rejects an invalid theme patch without persisting or touching the theme', () => {
    const dir = tempDir();
    const theme = fakeTheme();
    const store = new SettingsStore(dir, theme);
    store.set({ theme: 'light' });
    expect(() => store.set({ theme: 'neon' as 'light' })).toThrow();
    expect(theme.themeSource).toBe('light');
    expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).theme).toBe('light');
  });

  it('reloads persisted settings in a new instance', () => {
    const dir = tempDir();
    const first = new SettingsStore(dir, fakeTheme());
    first.set({ defaultModel: { providerId: 'p1', modelId: 'm1' }, theme: 'dark' });
    const theme = fakeTheme();
    const second = new SettingsStore(dir, theme);
    expect(second.get()).toEqual({ defaultModel: { providerId: 'p1', modelId: 'm1' }, theme: 'dark' });
    expect(theme.themeSource).toBe('dark');
  });

  it('falls back to defaults for invalid persisted values', () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({ theme: 'neon', defaultModel: 'oops' }),
      'utf8',
    );
    const theme = fakeTheme();
    const store = new SettingsStore(dir, theme);
    expect(store.get()).toEqual({ defaultModel: null, theme: 'system' });
    expect(theme.themeSource).toBe('system');
  });

  it('throws on malformed settings.json instead of silently resetting', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'settings.json'), 'not-json', 'utf8');
    expect(() => new SettingsStore(dir, fakeTheme())).toThrow();
    expect(readFileSync(join(dir, 'settings.json'), 'utf8')).toBe('not-json');
  });

  it('returns snapshots so caller mutations cannot alter stored state', () => {
    const store = new SettingsStore(tempDir(), fakeTheme());
    store.set({ defaultModel: { providerId: 'p', modelId: 'm' } });
    const got = store.get();
    got.theme = 'dark';
    if (got.defaultModel) {
      got.defaultModel.providerId = 'mutated';
    }
    expect(store.get()).toEqual({ defaultModel: { providerId: 'p', modelId: 'm' }, theme: 'system' });
  });
});
