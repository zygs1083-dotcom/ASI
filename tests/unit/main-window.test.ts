import { beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeFrame {
  url: string;
}

interface FakeWebContents {
  mainFrame: FakeFrame;
  send: ReturnType<typeof vi.fn>;
  destroyed: boolean;
  isDestroyed: () => boolean;
  setWindowOpenHandler: (fn: (details: { url: string }) => { action: string }) => void;
  on: (event: string, cb: (...args: unknown[]) => void) => void;
  windowOpenHandler?: (details: { url: string }) => { action: string };
  listeners: Map<string, (...args: unknown[]) => void>;
}

interface FakeWindow {
  webContents: FakeWebContents;
  loadURL: ReturnType<typeof vi.fn>;
  loadFile: ReturnType<typeof vi.fn>;
  destroyed: boolean;
  isDestroyed: () => boolean;
  setBackgroundColor: ReturnType<typeof vi.fn>;
  on: (event: string, cb: (...args: unknown[]) => void) => void;
  listeners: Map<string, (...args: unknown[]) => void>;
  options: Record<string, unknown>;
}

const mocks = vi.hoisted(() => {
  const created: Array<Record<string, unknown>> = [];
  return {
    created,
    isPackaged: false,
    shouldUseDarkColors: false,
    openExternal: vi.fn((_url: string) => Promise.resolve()),
    getPath: vi.fn(() => '/userData'),
    setPath: vi.fn(),
    nativeThemeOn: vi.fn(),
    getAllWindows: vi.fn((): unknown[] => []),
  };
});

vi.mock('electron', () => {
  class FakeWC implements FakeWebContents {
    mainFrame: FakeFrame = { url: 'https://main.example/app' };
    send = vi.fn();
    destroyed = false;
    listeners = new Map<string, (...args: unknown[]) => void>();
    windowOpenHandler?: (details: { url: string }) => { action: string };
    isDestroyed(): boolean {
      return this.destroyed;
    }
    setWindowOpenHandler(fn: (details: { url: string }) => { action: string }): void {
      this.windowOpenHandler = fn;
    }
    on(event: string, cb: (...args: unknown[]) => void): void {
      this.listeners.set(event, cb);
    }
  }
  class FakeBW implements FakeWindow {
    webContents = new FakeWC();
    loadURL = vi.fn(() => Promise.resolve());
    loadFile = vi.fn();
    destroyed = false;
    setBackgroundColor = vi.fn();
    listeners = new Map<string, (...args: unknown[]) => void>();
    options: Record<string, unknown>;
    constructor(options: Record<string, unknown>) {
      this.options = options;
      mocks.created.push(this as unknown as Record<string, unknown>);
    }
    isDestroyed(): boolean {
      return this.destroyed;
    }
    on(event: string, cb: (...args: unknown[]) => void): void {
      this.listeners.set(event, cb);
    }
  }
  return {
    app: {
      get isPackaged() {
        return mocks.isPackaged;
      },
      getPath: mocks.getPath,
      setPath: mocks.setPath,
      on: vi.fn(),
      whenReady: vi.fn(() => Promise.resolve()),
      quit: vi.fn(),
    },
    BrowserWindow: Object.assign(FakeBW, { getAllWindows: mocks.getAllWindows }),
    nativeTheme: {
      get shouldUseDarkColors() {
        return mocks.shouldUseDarkColors;
      },
      on: mocks.nativeThemeOn,
    },
    shell: { openExternal: mocks.openExternal },
  };
});

type MainWindowModule = typeof import('../../src/main/main-window');

async function loadModule(): Promise<MainWindowModule> {
  vi.resetModules();
  return import('../../src/main/main-window');
}

function lastWindow(): FakeWindow {
  const win = mocks.created[mocks.created.length - 1] as unknown as FakeWindow;
  expect(win).toBeDefined();
  return win;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.created.length = 0;
  mocks.isPackaged = false;
  mocks.shouldUseDarkColors = false;
  mocks.openExternal.mockImplementation(() => Promise.resolve());
  vi.unstubAllEnvs();
});

describe('createMainWindow', () => {
  it('keeps the hardened webPreferences flags', async () => {
    const mod = await loadModule();
    mod.createMainWindow();
    const win = lastWindow();
    expect(win.options).toMatchObject({
      titleBarStyle: 'hiddenInset',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    expect((win.options.webPreferences as { preload: string }).preload).toContain('index.cjs');
  });

  it('loads the bundled file when packaged even if ELECTRON_RENDERER_URL is remote', async () => {
    mocks.isPackaged = true;
    vi.stubEnv('ELECTRON_RENDERER_URL', 'https://evil.example/pwn');
    const mod = await loadModule();
    mod.createMainWindow();
    const win = lastWindow();
    expect(win.loadFile).toHaveBeenCalledTimes(1);
    expect(win.loadURL).not.toHaveBeenCalled();
  });

  it.each(['http://localhost:5173', 'http://127.0.0.1:5173', 'http://[::1]:5173', 'https://localhost:8443'])(
    'loads the dev URL when unpackaged and the URL is loopback: %s',
    async (url) => {
      vi.stubEnv('ELECTRON_RENDERER_URL', url);
      const mod = await loadModule();
      mod.createMainWindow();
      const win = lastWindow();
      expect(win.loadURL).toHaveBeenCalledWith(url);
      expect(win.loadFile).not.toHaveBeenCalled();
    },
  );

  it.each([
    'https://evil.example/pwn',
    'http://169.254.169.254/latest',
    'http://localhost.evil.example',
    'ftp://localhost/x',
    'file:///etc/passwd',
    'not a url',
  ])('falls back to the bundled file for a remote or invalid dev URL: %s', async (url) => {
    vi.stubEnv('ELECTRON_RENDERER_URL', url);
    const mod = await loadModule();
    mod.createMainWindow();
    const win = lastWindow();
    expect(win.loadFile).toHaveBeenCalledTimes(1);
    expect(win.loadURL).not.toHaveBeenCalled();
  });

  it('loads the bundled file when unpackaged without a dev URL', async () => {
    const mod = await loadModule();
    mod.createMainWindow();
    expect(lastWindow().loadFile).toHaveBeenCalledTimes(1);
  });
});

describe('navigation and popup guards', () => {
  it('prevents every navigation and only opens http/https externally', async () => {
    const mod = await loadModule();
    mod.createMainWindow();
    const win = lastWindow();
    const willNavigate = win.webContents.listeners.get('will-navigate');
    expect(willNavigate).toBeDefined();
    const preventDefault = vi.fn();
    for (const url of [
      'https://example.com/a',
      'http://example.com/b',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,x',
      'asi-secret://x',
      'not a url',
    ]) {
      willNavigate?.({ preventDefault }, url);
    }
    expect(preventDefault).toHaveBeenCalledTimes(7);
    const opened = mocks.openExternal.mock.calls.map((c) => c[0]);
    expect(opened).toHaveLength(2);
    expect(opened[0]).toBe('https://example.com/a');
    expect(opened[1]).toBe('http://example.com/b');
  });

  it('denies every window-open request and only opens http/https externally', async () => {
    const mod = await loadModule();
    mod.createMainWindow();
    const win = lastWindow();
    const handler = win.webContents.windowOpenHandler;
    expect(handler).toBeDefined();
    for (const url of [
      'https://ok.example',
      'http://ok.example',
      'file:///x',
      'javascript:alert(1)',
      'asi-secret://x',
      'not a url',
    ]) {
      expect(handler?.({ url })).toEqual({ action: 'deny' });
    }
    const opened = mocks.openExternal.mock.calls.map((c) => c[0]);
    expect(opened).toHaveLength(2);
    expect(opened[0]).toBe('https://ok.example/');
    expect(opened[1]).toBe('http://ok.example/');
  });

  it('swallows a rejected shell.openExternal promise without throwing', async () => {
    mocks.openExternal.mockImplementation(() => Promise.reject(new Error('no browser')));
    const mod = await loadModule();
    mod.createMainWindow();
    const win = lastWindow();
    const handler = win.webContents.windowOpenHandler;
    expect(() => handler?.({ url: 'https://ok.example' })).not.toThrow();
    // 让拒绝的 promise 有机会传播：不应产生未处理拒绝
    await new Promise((r) => setTimeout(r, 10));
  });
});

describe('getMainWindow registry', () => {
  it('returns the created window and clears it when that window closes', async () => {
    const mod = await loadModule();
    expect(mod.getMainWindow()).toBeUndefined();
    const win = mod.createMainWindow() as unknown as FakeWindow;
    expect(mod.getMainWindow()).toBe(win);
    win.listeners.get('closed')?.();
    expect(mod.getMainWindow()).toBeUndefined();
  });

  it('does not clear the registry when a different window closes', async () => {
    const mod = await loadModule();
    const first = mod.createMainWindow() as unknown as FakeWindow;
    const second = mod.createMainWindow() as unknown as FakeWindow;
    first.listeners.get('closed')?.();
    expect(mod.getMainWindow()).toBe(second);
  });

  it('returns undefined for a destroyed window or destroyed webContents', async () => {
    const mod = await loadModule();
    const win = mod.createMainWindow() as unknown as FakeWindow;
    win.destroyed = true;
    expect(mod.getMainWindow()).toBeUndefined();
    win.destroyed = false;
    win.webContents.destroyed = true;
    expect(mod.getMainWindow()).toBeUndefined();
  });
});
