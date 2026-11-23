import type { StoragePort } from './ports.ts';

interface SavedSettings {
  version: 1;
  paused: boolean;
  sendTitles: boolean;
}

/**
 * Persisted sensory privacy and pause settings (`paused`, `sendTitles`).
 * Gracefully ignores legacy WatchRule/globalFileWatch fields when upgrading
 * from 0.1.x snapshots.
 */
export class Settings {
  paused = false;
  sendTitles = true;
  private tail = Promise.resolve();

  constructor(private readonly storage: StoragePort) {}

  async restore(): Promise<void> {
    const text = await this.storage.load('settings');
    if (text === undefined) return;
    let data: Partial<SavedSettings>;
    try {
      data = JSON.parse(text) as Partial<SavedSettings>;
    } catch {
      return;
    }
    if (
      !data ||
      typeof data !== 'object' ||
      data.version !== 1 ||
      typeof data.paused !== 'boolean' ||
      typeof data.sendTitles !== 'boolean'
    ) {
      throw new TypeError('invalid sense settings');
    }
    this.paused = data.paused;
    this.sendTitles = data.sendTitles;
  }

  update(change: (draft: SavedSettings) => void): Promise<void> {
    const run = this.tail.then(async () => {
      const draft: SavedSettings = {
        version: 1,
        paused: this.paused,
        sendTitles: this.sendTitles,
      };
      change(draft);
      if (typeof draft.paused !== 'boolean' || typeof draft.sendTitles !== 'boolean') {
        throw new TypeError('invalid sense settings');
      }
      await this.storage.save('settings', JSON.stringify(draft));
      this.paused = draft.paused;
      this.sendTitles = draft.sendTitles;
    });
    this.tail = run.catch(() => {});
    return run;
  }

  async close(): Promise<void> {
    await this.tail;
  }
}
