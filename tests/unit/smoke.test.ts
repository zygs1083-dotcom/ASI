import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { IPC_CHANNELS, IPC_INVOKE_CHANNELS } from '../../src/shared/ipc';
import type { AsiApi } from '../../src/shared/types';

const EXPECTED_CHANNELS = {
  providers: {
    catalog: 'providers:catalog',
    list: 'providers:list',
    save: 'providers:save',
    remove: 'providers:remove',
    models: 'providers:models',
    allModels: 'providers:allModels',
    test: 'providers:test',
  },
  conversations: {
    list: 'conversations:list',
    get: 'conversations:get',
    create: 'conversations:create',
    rename: 'conversations:rename',
    remove: 'conversations:remove',
    setModel: 'conversations:setModel',
  },
  chat: {
    send: 'chat:send',
    retry: 'chat:retry',
    abort: 'chat:abort',
    onEvent: 'chat:event',
  },
  settings: {
    get: 'settings:get',
    set: 'settings:set',
  },
} as const;

describe('IPC channel contract', () => {
  it('IPC_CHANNELS exposes exactly the AsiApi groups and methods', () => {
    expectTypeOf<keyof typeof IPC_CHANNELS>().toEqualTypeOf<keyof AsiApi>();
    expectTypeOf<keyof typeof IPC_CHANNELS.providers>().toEqualTypeOf<keyof AsiApi['providers']>();
    expectTypeOf<keyof typeof IPC_CHANNELS.conversations>().toEqualTypeOf<keyof AsiApi['conversations']>();
    expectTypeOf<keyof typeof IPC_CHANNELS.chat>().toEqualTypeOf<keyof AsiApi['chat']>();
    expectTypeOf<keyof typeof IPC_CHANNELS.settings>().toEqualTypeOf<keyof AsiApi['settings']>();

    for (const group of Object.keys(EXPECTED_CHANNELS) as (keyof typeof EXPECTED_CHANNELS)[]) {
      expect(Object.keys(IPC_CHANNELS[group]).sort()).toEqual(Object.keys(EXPECTED_CHANNELS[group]).sort());
      for (const [method, channel] of Object.entries(EXPECTED_CHANNELS[group])) {
        const groupChannels = IPC_CHANNELS[group] as Record<string, string>;
        expect(groupChannels[method], `${group}.${method}`).toBe(channel);
      }
    }
  });

  it('has 18 unique invoke channels, excluding the chat event channel', () => {
    expect(IPC_INVOKE_CHANNELS).toHaveLength(18);
    expect(new Set(IPC_INVOKE_CHANNELS).size).toBe(18);
    expect(IPC_INVOKE_CHANNELS).not.toContain(IPC_CHANNELS.chat.onEvent);
    const allInvoke = [
      ...Object.values(EXPECTED_CHANNELS.providers),
      ...Object.values(EXPECTED_CHANNELS.conversations),
      EXPECTED_CHANNELS.chat.send,
      EXPECTED_CHANNELS.chat.retry,
      EXPECTED_CHANNELS.chat.abort,
      ...Object.values(EXPECTED_CHANNELS.settings),
    ];
    expect([...IPC_INVOKE_CHANNELS].sort()).toEqual(allInvoke.sort());
  });
});

describe('shared types contract', () => {
  it('src/shared/types.ts is a byte copy of ARCHITECTURE.md section 3', () => {
    const doc = readFileSync(resolve('docs/ARCHITECTURE.md'), 'utf8');
    const section = doc.indexOf('## 3.');
    expect(section).toBeGreaterThan(-1);
    const fenceStart = doc.indexOf('```ts', section);
    const start = doc.indexOf('\n', fenceStart) + 1;
    const end = doc.indexOf('\n```', start);
    expect(end).toBeGreaterThan(start);
    const block = doc.slice(start, end);
    const file = readFileSync(resolve('src/shared/types.ts'), 'utf8');
    expect(file).toBe(`${block}\n`);
  });
});

describe('design tokens', () => {
  it('tokens.css carries the DESIGN.md palette', () => {
    const css = readFileSync(resolve('src/renderer/styles/tokens.css'), 'utf8');
    expect(css.startsWith(':root {')).toBe(true);
    expect(css).toContain('--bg:#f4f4f6');
    expect(css).toContain(':root[data-theme="dark"]');
  });
});

describe('dependency override', () => {
  it('pins basic-ftp to exactly 6.2.6 in package.json and the lockfile', () => {
    const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
      overrides?: Record<string, string>;
    };
    expect(pkg.overrides?.['basic-ftp']).toBe('6.2.6');
    const lock = JSON.parse(readFileSync(resolve('package-lock.json'), 'utf8')) as {
      packages?: Record<string, { version?: string }>;
    };
    expect(lock.packages?.['node_modules/basic-ftp']?.version).toBe('6.2.6');
  });
});
