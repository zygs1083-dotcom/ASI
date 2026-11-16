import type { WatchRule } from '@asi/sense-types';
import { createWatchRule, DEFAULT_RULES, validateRule } from '../attention/rules.ts';
import { defaultBodyRules } from '../body/index.ts';
import type { StoragePort } from './ports.ts';

interface SavedSettings {
  version: 1;
  paused: boolean;
  sendTitles: boolean;
  rules: WatchRule[];
  disabled: string[];
}

export class Settings {
  paused = false;
  sendTitles = true;
  private all: WatchRule[];
  private disabled = new Set<string>();
  private tail = Promise.resolve();

  constructor(
    private readonly storage: StoragePort,
    initial?: WatchRule[],
  ) {
    this.all = structuredClone(initial ?? [...DEFAULT_RULES, ...defaultBodyRules()]);
    this.validate(this.all);
  }

  list(): WatchRule[] {
    return structuredClone(this.all);
  }
  enabled(): WatchRule[] {
    return this.list().filter((rule) => !this.disabled.has(rule.id));
  }
  isEnabled(id: string): boolean {
    return !this.disabled.has(id);
  }
  async restore(): Promise<void> {
    const text = await this.storage.load('settings');
    if (text === undefined) return;
    const data = JSON.parse(text) as SavedSettings;
    if (
      data.version !== 1 ||
      typeof data.paused !== 'boolean' ||
      typeof data.sendTitles !== 'boolean' ||
      !Array.isArray(data.rules) ||
      !Array.isArray(data.disabled) ||
      !data.disabled.every((id) => typeof id === 'string')
    )
      throw new TypeError('invalid sense settings');
    this.validate(data.rules);
    this.all = structuredClone(data.rules);
    this.disabled = new Set(data.disabled);
    this.paused = data.paused;
    this.sendTitles = data.sendTitles;
  }
  update(change: (draft: SavedSettings) => void): Promise<void> {
    const run = this.tail.then(async () => {
      const draft: SavedSettings = {
        version: 1,
        paused: this.paused,
        sendTitles: this.sendTitles,
        rules: this.list(),
        disabled: [...this.disabled],
      };
      change(draft);
      this.validate(draft.rules);
      await this.storage.save('settings', JSON.stringify(draft));
      this.all = draft.rules;
      this.disabled = new Set(draft.disabled);
      this.paused = draft.paused;
      this.sendTitles = draft.sendTitles;
    });
    this.tail = run.catch(() => {});
    return run;
  }
  add(input: Omit<WatchRule, 'approved' | 'createdBy'>): Promise<void> {
    const rule = createWatchRule({ ...input, createdBy: 'agent', approved: input.level !== 'wake' });
    return this.update((draft) => {
      if (draft.rules.some((item) => item.id === rule.id)) throw new Error('rule id already exists');
      draft.rules.push(rule);
    });
  }
  async close(): Promise<void> {
    await this.tail;
  }
  private validate(rules: WatchRule[]): void {
    const ids = new Set<string>();
    for (const rule of rules) {
      if (validateRule(rule).length || ids.has(rule.id)) throw new TypeError('invalid or duplicate watch rule');
      ids.add(rule.id);
    }
  }
}
