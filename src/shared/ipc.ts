import type { AsiApi } from './types';

type ChannelShape = {
  [G in keyof AsiApi]: { [M in keyof AsiApi[G]]: string };
};

export const IPC_CHANNELS = {
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
    abort: 'chat:abort',
    onEvent: 'chat:event',
  },
  settings: {
    get: 'settings:get',
    set: 'settings:set',
  },
} as const satisfies ChannelShape;

export const IPC_INVOKE_CHANNELS: readonly string[] = [
  ...Object.values(IPC_CHANNELS.providers),
  ...Object.values(IPC_CHANNELS.conversations),
  IPC_CHANNELS.chat.send,
  IPC_CHANNELS.chat.abort,
  ...Object.values(IPC_CHANNELS.settings),
];
