import { readFile } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AvatarForm, WindowMode } from '@asi/presence-protocol';
import { BrowserWindow, globalShortcut, Menu, nativeImage, protocol, screen, Tray } from 'electron';
import { createSnowPawTrayPngBuffer } from './tray-icon.ts';

export interface WindowManagerCallbacks {
  onToggleForm: () => void;
  onSelectForm: (form: AvatarForm) => void;
  onToggleParticleMode: () => void;
  onToggleKillSwitch: () => void;
  onModeChanged: (mode: WindowMode) => void;
  onQuit: () => void;
}

const currentDir = dirname(fileURLToPath(import.meta.url));
const preloadPath = join(currentDir, '../preload/index.cjs');
const rendererDir = resolve(currentDir, '../renderer');

const ASSET_MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};

/**
 * Registers the privileged `app://` scheme before `app.whenReady()` so production Electron
 * runs in a secure context with working ES module dynamic imports, AudioWorklet, ONNX WASM,
 * and local Silero VAD v5 model fetches (all of which break under opaque `file://` origin).
 */
export function registerPresenceAssetScheme(): void {
  protocol?.registerSchemesAsPrivileged?.([
    {
      scheme: 'app',
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

export function registerPresenceAssetProtocol(): void {
  protocol.handle('app', async (request) => {
    const parsed = new URL(request.url);
    if (parsed.hostname !== 'presence') {
      return new Response('Forbidden', { status: 403 });
    }
    const rawRel = decodeURIComponent(parsed.pathname).replace(/^\/+/, '') || 'index.html';
    const targetPath = resolve(rendererDir, rawRel);
    if (targetPath !== rendererDir && !targetPath.startsWith(`${rendererDir}${sep}`)) {
      return new Response('Forbidden', { status: 403 });
    }
    try {
      const data = await readFile(targetPath);
      const mime = ASSET_MIME_TYPES[extname(targetPath).toLowerCase()] ?? 'application/octet-stream';
      return new Response(new Uint8Array(data), {
        status: 200,
        headers: { 'Content-Type': mime },
      });
    } catch {
      return new Response('Not Found', { status: 404 });
    }
  });
}

function createSnowPawTrayIcon(): Electron.NativeImage {
  // Real 36x36 (@2x Retina = 18x18pt) RGBA PNG template icon so macOS Menu Bar renders it crisply
  // in both Light and Dark themes (Electron nativeImage does not rasterize SVG data URLs on macOS).
  const pngBuffer = createSnowPawTrayPngBuffer(36);
  const img = nativeImage.createFromBuffer(pngBuffer, { width: 36, height: 36, scaleFactor: 2.0 });
  if (process.platform === 'darwin') {
    img.setTemplateImage(true);
  }
  return img;
}

/**
 * Coordinates the dual-window architecture for 雪儿 (ASI Presence):
 * 1. Frameless transparent click-through floating companion window (`floating`).
 * 2. Expanded holographic stage console window (`stage`).
 * Plus macOS menu bar tray & global hotkeys.
 */
export class PresenceWindowManager {
  private floatingWin: BrowserWindow | null = null;
  private stageWin: BrowserWindow | null = null;
  private tray: Tray | null = null;
  private mode: WindowMode = 'floating';
  private readonly callbacks: WindowManagerCallbacks;
  private readonly devServerUrl: string | undefined;

  constructor(callbacks: WindowManagerCallbacks) {
    this.callbacks = callbacks;
    this.devServerUrl = process.env.ASI_PRESENCE_DEV_URL;
  }

  getMode(): WindowMode {
    return this.mode;
  }

  initialize(): void {
    this.createFloatingWindow();
    this.createStageWindow();
    this.setupTray();
    this.registerShortcuts();
    this.setMode('floating');
  }

  private loadWindowUrl(win: BrowserWindow, role: 'floating' | 'stage'): void {
    if (this.devServerUrl) {
      const sepChar = this.devServerUrl.includes('?') ? '&' : '?';
      void win.loadURL(`${this.devServerUrl}${sepChar}window=${role}`);
    } else {
      void win.loadURL(`app://presence/index.html?window=${role}`);
    }
  }

  private createFloatingWindow(): void {
    const display = screen.getPrimaryDisplay();
    const width = 340;
    const height = 390;
    const x = Math.max(24, display.workArea.x + display.workArea.width - width - 28);
    const y = Math.max(24, display.workArea.y + display.workArea.height - height - 28);

    const win = new BrowserWindow({
      width,
      height,
      x,
      y,
      transparent: true,
      frame: false,
      hasShadow: false,
      resizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        additionalArguments: ['--asi-window-role=floating'],
      },
    });

    win.setAlwaysOnTop(true, 'floating');
    if (process.platform === 'darwin') {
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    }
    // Start with click-through enabled on transparent regions; renderer toggles interactively on hit-zone hover
    win.setIgnoreMouseEvents(true, { forward: true });

    win.on('closed', () => {
      this.floatingWin = null;
    });

    this.loadWindowUrl(win, 'floating');
    this.floatingWin = win;
  }

  private createStageWindow(): void {
    const win = new BrowserWindow({
      width: 1200,
      height: 760,
      minWidth: 880,
      minHeight: 600,
      show: false,
      title: '雪儿 · ASI 全息舞台控制台',
      backgroundColor: '#060c18',
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
      vibrancy: process.platform === 'darwin' ? 'under-window' : undefined,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        additionalArguments: ['--asi-window-role=stage'],
      },
    });

    win.on('close', (event) => {
      // Closing stage returns gracefully to floating companion unless quitting
      if (this.floatingWin && !this.floatingWin.isDestroyed()) {
        event.preventDefault();
        this.setMode('floating');
      }
    });

    win.on('closed', () => {
      this.stageWin = null;
    });

    this.loadWindowUrl(win, 'stage');
    this.stageWin = win;
  }

  setMode(next: WindowMode): void {
    this.mode = next;
    if (next === 'floating') {
      this.stageWin?.hide();
      if (!this.floatingWin || this.floatingWin.isDestroyed()) {
        this.createFloatingWindow();
      }
      if (this.floatingWin && !this.floatingWin.isDestroyed()) {
        this.floatingWin.showInactive();
      }
    } else if (next === 'stage') {
      this.floatingWin?.hide();
      if (!this.stageWin || this.stageWin.isDestroyed()) {
        this.createStageWindow();
      }
      if (this.stageWin && !this.stageWin.isDestroyed()) {
        this.stageWin.show();
        this.stageWin.focus();
      }
    } else {
      this.floatingWin?.hide();
      this.stageWin?.hide();
    }
    this.callbacks.onModeChanged(next);
  }

  setFloatingIgnoreMouseEvents(ignore: boolean): void {
    if (!this.floatingWin || this.floatingWin.isDestroyed()) return;
    if (ignore) {
      this.floatingWin.setIgnoreMouseEvents(true, { forward: true });
    } else {
      this.floatingWin.setIgnoreMouseEvents(false);
    }
  }

  moveFloatingBy(deltaX: number, deltaY: number): void {
    if (!this.floatingWin || this.floatingWin.isDestroyed()) return;
    const [x, y] = this.floatingWin.getPosition();
    this.floatingWin.setPosition(Math.round((x ?? 0) + deltaX), Math.round((y ?? 0) + deltaY));
  }

  broadcast(channel: string, payload: unknown): void {
    for (const win of [this.floatingWin, this.stageWin]) {
      if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send(channel, payload);
      }
    }
  }

  private setupTray(): void {
    try {
      const tray = new Tray(createSnowPawTrayIcon());
      tray.setToolTip('雪儿 · ASI Presence');
      const menu = Menu.buildFromTemplate([
        { label: '显示悬浮伴生窗（雪儿）', click: () => this.setMode('floating') },
        { label: '展开全息舞台控制台', click: () => this.setMode('stage') },
        { label: '隐身待命', click: () => this.setMode('hidden') },
        { type: 'separator' },
        { label: '◉ 贾维斯纯粒子核心', click: () => this.callbacks.onSelectForm('jarvis-core') },
        { label: '🐾 Q 版雪儿', click: () => this.callbacks.onSelectForm('chibi') },
        { label: '✨ 真人雪儿', click: () => this.callbacks.onSelectForm('realistic') },
        { label: '✦ 切换粒子形态 (实体 ↔ 粒子)', click: () => this.callbacks.onToggleParticleMode() },
        { type: 'separator' },
        { label: '物理级静音断眼开关', click: () => this.callbacks.onToggleKillSwitch() },
        { type: 'separator' },
        { label: '退出 ASI Presence', click: () => this.callbacks.onQuit() },
      ]);
      tray.setContextMenu(menu);
      tray.on('click', () => {
        this.setMode(this.mode === 'hidden' ? 'floating' : this.mode === 'floating' ? 'stage' : 'floating');
      });
      this.tray = tray;
    } catch {
      // Tray creation can fail in headless environments
    }
  }

  private registerShortcuts(): void {
    try {
      globalShortcut.register('CommandOrControl+Shift+Space', () => {
        this.setMode(this.mode === 'hidden' ? 'floating' : 'hidden');
      });
      globalShortcut.register('CommandOrControl+Shift+A', () => {
        this.setMode(this.mode === 'stage' ? 'floating' : 'stage');
      });
      globalShortcut.register('CommandOrControl+Shift+M', () => {
        this.callbacks.onToggleParticleMode();
      });
      globalShortcut.register('CommandOrControl+Shift+X', () => {
        this.callbacks.onToggleKillSwitch();
      });
    } catch {
      // Ignore global shortcut contention
    }
  }

  dispose(): void {
    globalShortcut.unregisterAll();
    this.tray?.destroy();
    this.tray = null;
    if (this.stageWin && !this.stageWin.isDestroyed()) {
      this.stageWin.removeAllListeners('close');
      this.stageWin.close();
    }
    if (this.floatingWin && !this.floatingWin.isDestroyed()) {
      this.floatingWin.close();
    }
  }
}
