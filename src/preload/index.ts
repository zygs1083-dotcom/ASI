import type { IpcRendererEvent } from 'electron';
import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from '../shared/ipc';
import type { AsiApi, ChatEvent } from '../shared/types';

const api: AsiApi = {
  providers: {
    catalog: () => ipcRenderer.invoke(IPC_CHANNELS.providers.catalog),
    list: () => ipcRenderer.invoke(IPC_CHANNELS.providers.list),
    save: (input) => ipcRenderer.invoke(IPC_CHANNELS.providers.save, input),
    remove: (id) => ipcRenderer.invoke(IPC_CHANNELS.providers.remove, id),
    models: (providerId) => ipcRenderer.invoke(IPC_CHANNELS.providers.models, providerId),
    allModels: () => ipcRenderer.invoke(IPC_CHANNELS.providers.allModels),
    test: (providerId, modelId) => ipcRenderer.invoke(IPC_CHANNELS.providers.test, providerId, modelId),
  },
  conversations: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS.conversations.list),
    get: (id) => ipcRenderer.invoke(IPC_CHANNELS.conversations.get, id),
    create: () => ipcRenderer.invoke(IPC_CHANNELS.conversations.create),
    rename: (id, title) => ipcRenderer.invoke(IPC_CHANNELS.conversations.rename, id, title),
    remove: (id) => ipcRenderer.invoke(IPC_CHANNELS.conversations.remove, id),
    setModel: (id, model) => ipcRenderer.invoke(IPC_CHANNELS.conversations.setModel, id, model),
  },
  chat: {
    send: (conversationId, text) => ipcRenderer.invoke(IPC_CHANNELS.chat.send, conversationId, text),
    retry: (conversationId) => ipcRenderer.invoke(IPC_CHANNELS.chat.retry, conversationId),
    abort: (conversationId) => ipcRenderer.invoke(IPC_CHANNELS.chat.abort, conversationId),
    onEvent: (cb) => {
      const listener = (_event: IpcRendererEvent, e: ChatEvent) => cb(e);
      ipcRenderer.on(IPC_CHANNELS.chat.onEvent, listener);
      return () => {
        ipcRenderer.removeListener(IPC_CHANNELS.chat.onEvent, listener);
      };
    },
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC_CHANNELS.settings.get),
    set: (patch) => ipcRenderer.invoke(IPC_CHANNELS.settings.set, patch),
  },
};

contextBridge.exposeInMainWorld('asi', api);
