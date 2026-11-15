import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emitChatEvent, registerIpc } from '../../src/main/ipc';
import { dataDir } from '../../src/main/paths';
import { IPC_CHANNELS, IPC_INVOKE_CHANNELS } from '../../src/shared/ipc';
import type { ChatEvent, ChatMessage } from '../../src/shared/types';

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    handlers,
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
    getAllWindows: vi.fn((): Array<{ webContents: { send: ReturnType<typeof vi.fn> } }> => []),
    getPath: vi.fn(() => '/default/userData'),
    setPath: vi.fn(),
  };
});

vi.mock('electron', () => ({
  ipcMain: { handle: mocks.handle },
  BrowserWindow: { getAllWindows: mocks.getAllWindows },
  app: { getPath: mocks.getPath, setPath: mocks.setPath },
}));

const doneMessage: ChatMessage = {
  id: 'm1',
  role: 'assistant',
  text: 'ok',
  createdAt: 0,
  status: 'done',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.handlers.clear();
});

describe('registerIpc', () => {
  it('registers exactly the 17 request channels and no chat event handle', () => {
    registerIpc();
    expect(mocks.handle).toHaveBeenCalledTimes(17);
    expect([...mocks.handlers.keys()].sort()).toEqual([...IPC_INVOKE_CHANNELS].sort());
    expect(mocks.handlers.has(IPC_CHANNELS.chat.onEvent)).toBe(false);
  });

  it('every handler rejects with a not-implemented error', async () => {
    registerIpc();
    for (const [channel, handler] of mocks.handlers) {
      await expect(handler(), channel).rejects.toThrow('not implemented');
    }
  });
});

describe('emitChatEvent', () => {
  it('broadcasts the event to every window', () => {
    const sends = [vi.fn(), vi.fn(), vi.fn()];
    mocks.getAllWindows.mockReturnValue(sends.map((send) => ({ webContents: { send } })));
    const event: ChatEvent = { type: 'done', conversationId: 'c1', message: doneMessage };
    emitChatEvent(event);
    for (const send of sends) {
      expect(send).toHaveBeenCalledWith(IPC_CHANNELS.chat.onEvent, event);
    }
  });
});

describe('dataDir', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('prefers ASI_DATA_DIR when set', () => {
    vi.stubEnv('ASI_DATA_DIR', '/tmp/asi-test-data');
    expect(dataDir()).toBe('/tmp/asi-test-data');
  });

  it('falls back to app userData when unset or empty', () => {
    vi.stubEnv('ASI_DATA_DIR', undefined);
    expect(dataDir()).toBe('/default/userData');
    vi.stubEnv('ASI_DATA_DIR', '');
    expect(dataDir()).toBe('/default/userData');
    expect(mocks.getPath).toHaveBeenCalledWith('userData');
  });
});
