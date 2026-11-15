import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, nativeTheme, shell } from 'electron';

/** 应用自己创建的唯一主窗口；不用 getAllWindows 推断可信窗口 */
let mainWindow: BrowserWindow | undefined;

export function getMainWindow(): BrowserWindow | undefined {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) {
    return undefined;
  }
  return mainWindow;
}

export function windowBackground(): string {
  return nativeTheme.shouldUseDarkColors ? '#1a1a1e' : '#f4f4f6';
}

/** 只允许 http/https 经系统浏览器打开；其它协议与非法 URL 静默忽略 */
function openExternalIfSafe(rawUrl: string): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return;
  }
  void shell.openExternal(url.toString()).catch(() => {});
}

/** dev server URL 只允许 loopback：远程页面会在带 preload 的主窗口里拿到 window.asi */
function isLoopbackDevUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return false;
  }
  const host = url.hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

export function createMainWindow(): BrowserWindow {
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
  mainWindow = win;
  win.on('closed', () => {
    if (mainWindow === win) {
      mainWindow = undefined;
    }
  });

  win.webContents.on('will-navigate', (event, url) => {
    // 应用不提供任何页内导航；外链一律交给系统浏览器
    event.preventDefault();
    openExternalIfSafe(url);
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalIfSafe(url);
    return { action: 'deny' };
  });

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (!app.isPackaged && devUrl && isLoopbackDevUrl(devUrl)) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(join(fileURLToPath(new URL('.', import.meta.url)), '../renderer/index.html'));
  }
  return win;
}
