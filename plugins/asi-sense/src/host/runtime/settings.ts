import type { WatchRule } from '@asi/sense-types';
import { createWatchRule, DEFAULT_RULES, validateRule } from '../attention/rules.ts';
import { defaultBodyRules } from '../body/index.ts';
import {
  DEFAULT_FILE_EXCLUSIONS,
  exclusionKey,
  MAX_FILE_EXCLUSIONS,
  normalizeFileExclusion,
} from '../sources/file-exclusions.ts';
import type { StoragePort } from './ports.ts';

interface SavedSettings {
  version: 1;
  paused: boolean;
  sendTitles: boolean;
  rules: WatchRule[];
  disabled: string[];
  globalFileWatch?: boolean;
  fileExclusions?: string[];
}

export class Settings {
  paused = false;
  sendTitles = true;
  globalFileWatch = true;
  private exclusions: string[] = [...DEFAULT_FILE_EXCLUSIONS];
  private all: WatchRule[];
  private disabled = new Set<string>();
  private tail = Promise.resolve();

  constructor(
    private readonly storage: StoragePort,
    initial?: WatchRule[],
    private readonly platform: string = process.platform,
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
  fileExclusions(): string[] {
    return [...this.exclusions];
  }
  async restore(): Promise<void> {
    const text = await this.storage.load('settings');
    if (text === undefined) return;
    const data = JSON.parse(text) as SavedSettings;
    if (
      data.version !== 1 ||
      typeof data.paused !== 'boolean' ||
      typeof data.sendTitles !== 'boolean' ||
      (data.globalFileWatch !== undefined && typeof data.globalFileWatch !== 'boolean') ||
      (data.fileExclusions !== undefined && !Array.isArray(data.fileExclusions)) ||
      !Array.isArray(data.rules) ||
      !Array.isArray(data.disabled) ||
      !data.disabled.every((id) => typeof id === 'string')
    )
      throw new TypeError('invalid sense settings');
    this.validate(data.rules);
    const exclusions =
      data.fileExclusions === undefined ? [...DEFAULT_FILE_EXCLUSIONS] : this.normalizeExclusions(data.fileExclusions);
    this.all = structuredClone(data.rules);
    this.disabled = new Set(data.disabled);
    this.paused = data.paused;
    this.sendTitles = data.sendTitles;
    this.globalFileWatch = data.globalFileWatch ?? true;
    this.exclusions = exclusions;
  }
  update(change: (draft: SavedSettings) => void): Promise<void> {
    const run = this.tail.then(async () => {
      const draft: SavedSettings = {
        version: 1,
        paused: this.paused,
        sendTitles: this.sendTitles,
        rules: this.list(),
        disabled: [...this.disabled],
        globalFileWatch: this.globalFileWatch,
        fileExclusions: [...this.exclusions],
      };
      change(draft);
      this.validate(draft.rules);
      if (typeof draft.globalFileWatch !== 'boolean') throw new TypeError('invalid globalFileWatch');
      const exclusions = this.normalizeExclusions(draft.fileExclusions ?? []);
      draft.fileExclusions = exclusions;
      await this.storage.save('settings', JSON.stringify(draft));
      this.all = draft.rules;
      this.disabled = new Set(draft.disabled);
      this.paused = draft.paused;
      this.sendTitles = draft.sendTitles;
      this.globalFileWatch = draft.globalFileWatch;
      this.exclusions = exclusions;
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
  private normalizeExclusions(items: unknown[]): string[] {
    if (!Array.isArray(items)) throw new TypeError('invalid fileExclusions');
    const out: string[] = [];
    const seen = new Set<string>();
    for (const item of items) {
      const norm = normalizeFileExclusion(item as string);
      const key = exclusionKey(norm, this.platform);
      if (!seen.has(key)) {
        seen.add(key);
        out.push(norm);
        if (out.length > MAX_FILE_EXCLUSIONS) {
          throw new RangeError(`Maximum of ${MAX_FILE_EXCLUSIONS} exclusion patterns allowed`);
        }
      }
    }
    return out;
  }
  private validate(rules: WatchRule[]): void {
    const ids = new Set<string>();
    for (const rule of rules) {
      if (validateRule(rule).length || ids.has(rule.id)) throw new TypeError('invalid or duplicate watch rule');
      ids.add(rule.id);
    }
  }
}
