import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_CHANNELS } from '../../src/shared/ipc';
import type { AsiApi, ChatEvent } from '../../src/shared/types';

const mocks = vi.hoisted(() => ({
  exposeInMainWorld: vi.fn(),
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
}));

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: mocks.exposeInMainWorld },
  ipcRenderer: { invoke: mocks.invoke, on: mocks.on, removeListener: mocks.removeListener },
}));

let api: AsiApi;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  await import('../../src/preload/index');
  expect(mocks.exposeInMainWorld).toHaveBeenCalledTimes(1);
  expect(mocks.exposeInMainWorld).toHaveBeenCalledWith('asi', expect.any(Object));
  api = mocks.exposeInMainWorld.mock.calls[0][1] as AsiApi;
});

type AnyFn = (...args: never[]) => unknown;

const INVOKE_CASES: ReadonlyArray<{
  name: string;
  channel: string;
  call: (a: AsiApi) => Promise<unknown>;
  args: unknown[];
}> = [
  { name: 'providers.catalog', channel: 'providers:catalog', call: (a) => a.providers.catalog(), args: [] },
  { name: 'providers.list', channel: 'providers:list', call: (a) => a.providers.list(), args: [] },
  {
    name: 'providers.save',
    channel: 'providers:save',
    call: (a) => a.providers.save({ name: 'P', kind: 'builtin', enabled: true, customModels: [] }),
    args: [{ name: 'P', kind: 'builtin', enabled: true, customModels: [] }],
  },
  {
    name: 'providers.remove',
    channel: 'providers:remove',
    call: (a) => a.providers.remove('p1'),
    args: ['p1'],
  },
  {
    name: 'providers.models',
    channel: 'providers:models',
    call: (a) => a.providers.models('p1'),
    args: ['p1'],
  },
  {
    name: 'providers.allModels',
    channel: 'providers:allModels',
    call: (a) => a.providers.allModels(),
    args: [],
  },
  {
    name: 'providers.test',
    channel: 'providers:test',
    call: (a) => a.providers.test('p1', 'm1'),
    args: ['p1', 'm1'],
  },
  {
    name: 'conversations.list',
    channel: 'conversations:list',
    call: (a) => a.conversations.list(),
    args: [],
  },
  {
    name: 'conversations.get',
    channel: 'conversations:get',
    call: (a) => a.conversations.get('c1'),
    args: ['c1'],
  },
  {
    name: 'conversations.create',
    channel: 'conversations:create',
    call: (a) => a.conversations.create(),
    args: [],
  },
  {
    name: 'conversations.rename',
    channel: 'conversations:rename',
    call: (a) => a.conversations.rename('c1', 't'),
    args: ['c1', 't'],
  },
  {
    name: 'conversations.remove',
    channel: 'conversations:remove',
    call: (a) => a.conversations.remove('c1'),
    args: ['c1'],
  },
  {
    name: 'conversations.setModel',
    channel: 'conversations:setModel',
    call: (a) => a.conversations.setModel('c1', { providerId: 'p1', modelId: 'm1' }),
    args: ['c1', { providerId: 'p1', modelId: 'm1' }],
  },
  { name: 'chat.send', channel: 'chat:send', call: (a) => a.chat.send('c1', 'hi'), args: ['c1', 'hi'] },
  { name: 'chat.retry', channel: 'chat:retry', call: (a) => a.chat.retry('c1'), args: ['c1'] },
  { name: 'chat.abort', channel: 'chat:abort', call: (a) => a.chat.abort('c1'), args: ['c1'] },
  { name: 'settings.get', channel: 'settings:get', call: (a) => a.settings.get(), args: [] },
  {
    name: 'settings.set',
    channel: 'settings:set',
    call: (a) => a.settings.set({ theme: 'dark' }),
    args: [{ theme: 'dark' }],
  },
];

describe('preload bridge', () => {
  it.each(INVOKE_CASES)(
    '$name invokes $channel with positional args',
    async ({ name, channel, call, args }) => {
      mocks.invoke.mockResolvedValueOnce(undefined);
      await call(api);
      expect(mocks.invoke, name).toHaveBeenCalledTimes(1);
      expect(mocks.invoke).toHaveBeenCalledWith(channel, ...args);
    },
  );

  it('chat.onEvent forwards only the ChatEvent payload and unsubscribes the same listener', () => {
    const received: ChatEvent[] = [];
    const off = api.chat.onEvent((e) => received.push(e));

    expect(mocks.on).toHaveBeenCalledTimes(1);
    expect(mocks.on).toHaveBeenCalledWith(IPC_CHANNELS.chat.onEvent, expect.any(Function));
    const listener = mocks.on.mock.calls[0][1] as (event: unknown, payload: ChatEvent) => void;

    const payload: ChatEvent = {
      type: 'delta',
      conversationId: 'c1',
      messageId: 'm1',
      delta: '你',
      text: '你好',
    };
    listener({ sender: 'ipcRenderer internals must not leak' }, payload);
    expect(received).toEqual([payload]);

    off();
    expect(mocks.removeListener).toHaveBeenCalledWith(IPC_CHANNELS.chat.onEvent, listener);
  });

  it('does not expose ipcRenderer or generic invoke on the api', () => {
    const exposed = mocks.exposeInMainWorld.mock.calls[0][1] as Record<string, unknown>;
    expect('ipcRenderer' in exposed).toBe(false);
    expect('invoke' in exposed).toBe(false);
    const fns = Object.values(exposed).flatMap((g) => Object.values(g as Record<string, AnyFn>));
    expect(fns).toHaveLength(19);
  });
});
