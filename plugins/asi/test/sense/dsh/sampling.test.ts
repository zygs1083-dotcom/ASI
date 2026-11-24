import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import LlmRuntime from '@deepseek-ai/dsh-llm';
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection';
import SystemPrompt from '@deepseek-ai/dsh-system-prompt';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import { NativeToolExecutor } from '@deepseek-ai/dsh-tool-executor-native';
import ToolsService from '@deepseek-ai/dsh-tools';
import { describe, expect, it } from 'vitest';
import * as AsiSensePlugin from '../../../src/sense/host/dsh/index.ts';

describe('AsiSenseService Cordis registration', () => {
  it('registers ctx.asiSense with thermal 30s sample interval and only env_state + env_detail tools', async () => {
    const root = await mkdtemp(join(tmpdir(), 'asi-sense-svc-'));
    const ctx = new Context();
    await ctx.plugin(SessionProjectionRegistry);
    await ctx.plugin(AgentRegistry);
    await ctx.plugin(LlmRuntime);
    await ctx.plugin(TokenMeter);
    await ctx.plugin(SystemPrompt);
    await ctx.plugin(ToolsService);
    ctx.tools.setExecutor(new NativeToolExecutor(ctx));
    ctx.provide('jobs', {
      list: () => [],
      events: { subscribe: () => () => {} },
    });
    ctx.provide('sessions', { list: () => [] });
    ctx.provide('profileContext', {
      name: 'fixture',
      dir: root,
      patchPath: '',
      installAnchor: '',
      cwd: '',
      home: '',
      startedBundles: [],
      overlays: [],
      telemetryDisabledEnv: undefined,
    });
    try {
      const fork = await ctx.plugin(AsiSensePlugin, {
        storageRoot: root,
        helperPath: join(root, 'missing-helper'),
        intervalMs: 5_000,
      });
      const snap = ctx.asiSense.snapshot();
      expect(snap.sampleIntervalsMs.thermal).toBe(30_000);
      expect(snap.settings).toMatchObject({ paused: false, sendTitles: true, powerMode: 'normal' });
      expect(
        ctx.tools
          .definitions()
          .map((t) => t.name)
          .sort(),
      ).toEqual(['env_detail', 'env_state']);
      await ctx.asiSense.setPowerMode('eco', 'low-battery');
      expect(ctx.asiSense.getSettings()).toMatchObject({ powerMode: 'eco', powerModeReason: 'low-battery' });
      await ctx.asiSense.setPowerMode('normal');
      expect(ctx.asiSense.getSettings()).toMatchObject({ powerMode: 'normal' });
      await fork.dispose();
    } finally {
      await ctx.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});
