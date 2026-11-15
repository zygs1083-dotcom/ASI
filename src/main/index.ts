import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getProviders } from '@mariozechner/pi-ai';
import { app, BrowserWindow, nativeTheme } from 'electron';
import { registerIpc } from './ipc';
import { dataDir } from './paths';

if (process.env.ASI_DATA_DIR) {
  app.setPath('userData', dataDir());
}

function windowBackground(): string {
  return nativeTheme.shouldUseDarkColors ? '#1a1a1e' : '#f4f4f6';
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 900,
    minHeight: 600,
    titleBarStyle: 'hiddenInset',
    backgroundColor: windowBackground(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: fileURLToPath(new URL('../preload/index.cjs', import.meta.url)),
    },
  });

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(join(fileURLToPath(new URL('.', import.meta.url)), '../renderer/index.html'));
  }
  return win;
}

void app.whenReady().then(() => {
  registerIpc();
  console.log(`[ASI] pi-ai providers: ${getProviders().length}`);

  createWindow();

  nativeTheme.on('updated', () => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.setBackgroundColor(windowBackground());
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
