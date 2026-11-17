import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Settings } from '../src/host/runtime/settings.ts';

describe('quality gate and privacy documentation', () => {
  it('includes both workspace packages in the Biome gate', () => {
    const config = JSON.parse(readFileSync(new URL('../../../biome.json', import.meta.url), 'utf8'));
    expect(config.files.includes).toEqual(expect.arrayContaining(['packages/body-probe/**', 'packages/sense-ui/**']));
  });

  it('documents the actual window-title sharing default and the opt-out', () => {
    const settings = new Settings({ load: async () => undefined, save: async () => {} });
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    expect(settings.sendTitles).toBe(true);
    expect(readme).toContain('「窗口标题发给模型」默认开启');
    expect(readme).toContain('关闭该开关');
  });
});
