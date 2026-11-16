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
  private stopped = false;
  private tail = Promise.resolve();
  private readonly dispatch = new Set<string>();
  private clearDispatch?: ReturnType<typeof setImmediate>;
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
  private roots(): Set<string> {
    const patterns = (this.stopped || this.paused() ? [] : this.rules())
      .filter((r) => r.match.kind === 'file.changed' && r.match.subject)
      .map((r) => r.match.subject as string);
    return new Set(patterns.map(root).filter((value): value is string => value !== undefined));
  }
  refresh(): Promise<void> {
    const run = this.tail.then(async () => {
      for (;;) {
        this.active = !this.stopped && !this.paused();
        const roots = this.roots();
        this.setRoots([...roots]);
        const obsolete = [...this.watches].find(([watched]) => !roots.has(watched));
        if (obsolete) {
          this.watches.delete(obsolete[0]);
          await obsolete[1].close();
          continue;
        }
        const missing = [...roots].find((watched) => !this.watches.has(watched));
        if (!missing) break;
        this.watches.set(
          missing,
          this.watcher.watch(missing, (event) => {
            void this.accept(event).catch(() => {});
          }),
        );
      }
    });
    this.tail = run.catch(() => {});
    return run;
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.active = false;
    if (this.clearDispatch) clearImmediate(this.clearDispatch);
    this.dispatch.clear();
    await this.refresh();
  }
  private async accept(event: FileChange): Promise<void> {
    if (!this.active || this.paused() || !path.isAbsolute(event.path)) return;
    const key = JSON.stringify([path.normalize(event.path), event.change, event.at ?? this.clock.wall()]);
    if (this.dispatch.has(key)) return;
    this.dispatch.add(key);
    if (this.dispatch.size > 5000) this.dispatch.delete(this.dispatch.keys().next().value as string);
    if (!this.clearDispatch)
      this.clearDispatch = setImmediate(() => {
        this.clearDispatch = undefined;
        this.dispatch.clear();
      });
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
