import { BrowserWindow, ipcMain } from 'electron';
import { IPC_CHANNELS, IPC_INVOKE_CHANNELS } from '../shared/ipc';
import type { ChatEvent } from '../shared/types';

export function registerIpc(): void {
  for (const channel of IPC_INVOKE_CHANNELS) {
    ipcMain.handle(channel, async () => {
      throw new Error('not implemented');
    });
  }
}

export function emitChatEvent(e: ChatEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC_CHANNELS.chat.onEvent, e);
  }
}
