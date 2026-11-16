import path from 'node:path';
import type { Signal, WatchRule } from '@asi/sense-types';
import { matchesRule } from '../attention/rules.ts';
import type { RuntimeAttention } from '../runtime/attention.ts';
import type { Clock, FileChange, FileWatcher } from '../runtime/ports.ts';
import type { DshSource } from './dsh.ts';

const source = { id: 'files', api: 'watch', host: 'local' };

function root(pattern: string): string | undefined {
  if (!path.isAbsolute(pattern)) return undefined;
  const wildcard = pattern.search(/[*?]/);
  if (wildcard < 0) return path.normalize(pattern);
  const prefix = pattern.slice(0, wildcard);
  return prefix.endsWith(path.sep) ? path.normalize(prefix) : path.dirname(prefix);
}

export class FileSource {
  private readonly watches = new Map<string, { close(): void | Promise<void> }>();
  private active = false;
  constructor(
    private readonly watcher: FileWatcher,
    private readonly clock: Clock,
    private readonly attention: RuntimeAttention,
    private readonly dsh: DshSource,
    private readonly rules: () => WatchRule[],
    private readonly paused: () => boolean,
    private readonly burst: (signal: Signal) => Promise<void>,
    private readonly setRoots: (roots: string[]) => void,
  ) {}
  async refresh(): Promise<void> {
    this.active = !this.paused();
    const patterns = (this.paused() ? [] : this.rules())
      .filter((r) => r.match.kind === 'file.changed' && r.match.subject)
      .map((r) => r.match.subject as string);
    const roots = new Set(patterns.map(root).filter((value): value is string => value !== undefined));
    this.setRoots([...roots]);
    for (const [watched, handle] of this.watches) {
      if (!roots.has(watched)) {
        this.watches.delete(watched);
        await handle.close();
      }
    }
    for (const watched of roots) {
      if (!this.watches.has(watched))
        this.watches.set(
          watched,
          this.watcher.watch(watched, (event) => {
            void this.accept(event).catch(() => {});
          }),
        );
    }
  }
  async stop(): Promise<void> {
    this.active = false;
    await Promise.all([...this.watches.values()].map((handle) => handle.close()));
    this.watches.clear();
  }
  private async accept(event: FileChange): Promise<void> {
    if (!this.active || this.paused() || !path.isAbsolute(event.path)) return;
    const signal = this.dsh.classify({
      id: this.attention.id(),
      kind: 'file.changed',
      at: event.at ?? this.clock.wall(),
      source,
      subject: path.normalize(event.path),
      data: { path: path.normalize(event.path), change: event.change },
    });
    if (
      !this.rules().some(
        (r) => r.match.kind === signal.kind && r.match.subject && matchesRule(r, signal, this.clock.wall()),
      )
    )
      return;
    await this.attention.accept(signal);
    if (this.active) await this.burst(signal);
  }
}
