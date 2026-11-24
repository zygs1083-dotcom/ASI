import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolRunContext } from '@deepseek-ai/dsh-tools';
import { afterEach, describe, expect, it } from 'vitest';
import { isHomeRoot, isHomeRootShape, toHomeRelative } from '../../src/sense/host/dsh/path.ts';
import { environmentDetail, modelState } from '../../src/sense/host/dsh/tool-output.ts';
import { createSenseTools } from '../../src/sense/host/dsh/tools.ts';
import { createSenseRuntime } from '../../src/sense/host/runtime/index.ts';
import { StateStore } from '../../src/sense/host/state/store.ts';

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'asi-home-alias-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function makeExec(tool: string): ToolRunContext {
  return {
    tool,
    callId: 'call-1',
    rootCallId: 'call-1',
    token: {} as ToolRunContext['token'],
    arguments: {},
    signal: new AbortController().signal,
    agent: { id: 'agent-test', mode: 'primary' },
    deferContext: () => {},
    concludesTurn: () => {},
  } as unknown as ToolRunContext;
}

describe('home aliases in pure sensory projection', () => {
  it('masks a symlinked home root, its realpath, and the home-root entry itself in env_state and env_detail', async () => {
    const base = await makeTempDir();
    const realHome = join(base, 'ext_vol', 'alice_real');
    const linkHome = join(base, 'links', 'alice_link');
    await mkdir(realHome, { recursive: true });
    await mkdir(join(base, 'links'), { recursive: true });
    await symlink(realHome, linkHome);

    const previousHome = process.env.HOME;
    process.env.HOME = linkHome;
    try {
      expect(isHomeRoot(linkHome)).toBe(true);
      expect(isHomeRoot(realHome)).toBe(true);
      expect(toHomeRelative(linkHome)).toBe('~');
      expect(toHomeRelative(realHome)).toBe('~');
      expect(toHomeRelative(join(realHome, 'workspace', 'proj'))).toBe('~/workspace/proj');
      expect(isHomeRootShape('/Users/alice_shape')).toBe(true);

      const state = new StateStore(() => 1_000).snapshot();
      state.env.where.toolExec = {
        value: { host: 'local', cwd: realHome },
        status: 'ok',
        source: { id: 'dsh', api: 'registry', host: 'local' },
        observedAt: 1_000,
        ttlMs: 30_000,
      };
      state.env.frontApp = {
        value: { name: 'Editor', bundleId: 'com.example.Editor', pid: 42 },
        status: 'ok',
        source: { id: 'helper', api: 'ndjson', host: 'local' },
        observedAt: 1_000,
        ttlMs: 60_000,
      };
      const projected = modelState(state, 1_000, 'env') as {
        where: { toolExec: { value: { cwd: string } } };
      };
      expect(projected.where.toolExec.value.cwd).toBe('~');
      expect(JSON.stringify(projected)).not.toContain('alice_real');
      expect(JSON.stringify(projected)).not.toContain('alice_link');

      const detail = environmentDetail({
        tools: {
          envState: () => structuredClone(state),
          refreshDetail: async () => true,
        },
        recentSignals: () => [
          {
            id: 's1',
            kind: 'app.activated',
            subject: realHome,
            at: 1_000,
            source: { id: 'helper', api: 'ndjson', host: 'local' },
            data: {},
          },
          {
            id: 's2',
            kind: 'window.focused',
            subject: linkHome,
            at: 1_001,
            source: { id: 'helper.ax', api: 'accessibility', host: 'local' },
            data: {},
          },
        ],
      });
      const detailJson = JSON.stringify(detail);
      expect(detailJson).toContain('"~"');
      expect(detailJson).not.toContain('alice_real');
      expect(detailJson).not.toContain('alice_link');
    } finally {
      process.env.HOME = previousHome;
    }
  });

  it('masks toolExec cwd when it matches the live HOME root via createSenseTools', async () => {
    const base = await makeTempDir();
    const fakeHome = join(base, 'home', 'alice_acct');
    await mkdir(fakeHome, { recursive: true });
    const previousHome = process.env.HOME;
    process.env.HOME = fakeHome;
    const runtime = createSenseRuntime(
      {
        clock: { wall: () => 1_700_000_000_000, mono: () => 1_000 },
        storage: { load: async () => undefined, save: async () => {} },
        dsh: {
          onAgentEvent: () => () => {},
          onTool: () => () => {},
          onJob: () => () => {},
          tokenSnapshot: async () => undefined,
          nowReadings: () => ({
            'env.where.toolExec': { value: { host: 'local', cwd: fakeHome } },
          }),
        } as never,
        helper: { spawn: () => undefined },
        probe: { create: () => ({ onSample: () => () => {}, start: () => {}, stop: async () => {} }) },
      },
      { platform: 'linux' },
    );
    try {
      await runtime.start();
      const tools = createSenseTools(runtime, () => 1_700_000_000_000);
      expect(tools.map((t) => t.name)).toEqual(['env_state', 'env_detail']);
      // Simulate active session so toolExec reading applies
      const state = modelState(
        {
          ...runtime.state(),
          env: {
            ...runtime.state().env,
            where: {
              ...runtime.state().env.where,
              toolExec: {
                value: { host: 'local', cwd: fakeHome },
                status: 'ok',
                source: { id: 'dsh', api: 'registry', host: 'local' },
                observedAt: 1_700_000_000_000,
                ttlMs: 30_000,
              },
            },
          },
        },
        1_700_000_000_000,
        'env',
      );
      expect(JSON.stringify(state)).not.toContain('alice_acct');
      const liveRes = await tools
        .find((t) => t.name === 'env_state')
        ?.execute({ section: 'env' }, makeExec('env_state'));
      expect(JSON.stringify(liveRes)).not.toContain('alice_acct');
    } finally {
      process.env.HOME = previousHome;
      await runtime.stop().catch(() => {});
    }
  });
});
