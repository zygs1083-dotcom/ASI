import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { temporaryProfile } from '../../scripts/e2e-support.ts';
import { syntheticBundle, syntheticFrame } from '../../scripts/e2e-synthetic.ts';

describe('synthetic screenshot fixture', () => {
  it('uses invented observations and replaces the real host entry before plugin installation', async () => {
    await using profile = await temporaryProfile();
    const pkg = fileURLToPath(new URL('../..', import.meta.url));
    const bundle = await syntheticBundle(profile.root, pkg);
    const manifest = JSON.parse(await readFile(`${bundle}/package.json`, 'utf8'));
    const host = await readFile(`${bundle}/fixture.js`, 'utf8');
    const frame = JSON.parse(await readFile(`${bundle}/frame.json`, 'utf8'));
    expect(manifest.main).toBe('./fixture.js');
    expect(manifest.exports['.'].default).toBe('./fixture.js');
    expect(host).toContain('new AsiSenseRemote');
    expect(host).not.toMatch(/createSenseRuntime|BodyProbe|helperPath/);
    expect(frame.state.env.frontApp.value.name).toBe('Demo Editor');
    expect(frame.state.env.where.toolExec.value.cwd).toBe('/demo/project');
    expect(frame.state.self.body.disks.value[0].mount).toBe('/demo/volume');
    expect(frame.sendTitles).toBe(false);
    expect(syntheticFrame().state.env.focusedWindow.value?.title).toBe('example.ts — demo');
  });

  it('uses the synthetic runtime and isolated storage for dangerous-action screenshots', async () => {
    await using profile = await temporaryProfile();
    const pkg = fileURLToPath(new URL('../..', import.meta.url));
    const bundle = await syntheticBundle(profile.root, pkg, `${profile.root}/storage`);
    const host = await readFile(`${bundle}/fixture.js`, 'utf8');
    const runtime = await readFile(`${pkg}/scripts/e2e-synthetic-runtime.ts`, 'utf8');
    expect(host).toContain('syntheticDanger');
    expect(host).toContain(`${profile.root}/storage`);
    expect(runtime).toContain("platform: 'linux'");
    expect(runtime).toContain('spawn: () => undefined');
    expect(runtime).toContain('onSample: () => () => {}');
  });
});
