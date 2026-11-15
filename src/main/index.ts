import { getProviders } from '@mariozechner/pi-ai';
import { app, BrowserWindow, nativeTheme } from 'electron';
import { registerIpc } from './ipc';
import { createMainWindow, windowBackground } from './main-window';
import { dataDir } from './paths';

if (process.env.ASI_DATA_DIR) {
  app.setPath('userData', dataDir());
}

void app.whenReady().then(() => {
  registerIpc();
  console.log(`[ASI] pi-ai providers: ${getProviders().length}`);

  createMainWindow();

  nativeTheme.on('updated', () => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.setBackgroundColor(windowBackground());
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
