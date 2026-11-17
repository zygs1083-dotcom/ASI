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
  private readonly leases = new Map<string, number>();
  private readonly statuses = new Map<string, string>();
  private readonly failedWatches = new WeakSet<object>();
  private readonly dispatch = new Map<string, Map<string, number>>();
  private clearDispatch?: ReturnType<typeof setImmediate>;
  private expiryTimer?: ReturnType<typeof setTimeout>;
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
  private eligible(rule: WatchRule): boolean {
    return rule.approved && (rule.expiresAt === undefined || this.clock.wall() < rule.expiresAt);
  }
  private roots(): Set<string> {
    const patterns = (this.stopped || this.paused() ? [] : this.rules())
      .filter(
        (r) =>
          this.eligible(r) && (r.match.kind === 'file.changed' || r.match.kind === 'file.burst') && r.match.subject,
      )
      .map((r) => r.match.subject as string);
    return new Set(patterns.map(root).filter((value): value is string => value !== undefined));
  }
  private watch(watched: string): void {
    let handle: { close(): void | Promise<void> } | undefined;
    handle = this.watcher.watch(watched, (event) => {
      if (!handle || this.watches.get(watched) !== handle) return;
      if ('watchError' in event && event.watchError === true) {
        const current = handle;
        this.failedWatches.add(current);
        const run = this.tail.then(() => this.failed(watched, current));
        this.tail = run.catch(() => {});
      } else {
        void this.accept(event, watched).catch(() => {});
      }
    });
    this.watches.set(watched, handle);
  }
  private async failed(watched: string, handle: { close(): void | Promise<void> }): Promise<void> {
    if (this.watches.get(watched) !== handle) return;
    this.watches.delete(watched);
    try {
      await handle.close();
    } finally {
      if (this.active && !this.paused()) {
        for (const rule of this.rules()) {
          if (
            this.eligible(rule) &&
            (rule.match.kind === 'file.changed' || rule.match.kind === 'file.burst') &&
            rule.match.subject &&
            root(rule.match.subject) === watched
          ) {
            await this.status(rule, 'error');
          }
        }
      }
    }
  }
  private async status(rule: WatchRule, status: 'ok' | 'error'): Promise<void> {
    if (this.statuses.get(rule.id) === status) return;
    this.statuses.set(rule.id, status);
    await this.attention.accept({
      id: this.attention.id(),
      kind: 'source.status',
      at: this.clock.wall(),
      source: { ...source, id: `files:${rule.id}` },
      subject: rule.id,
      data: { status, ...(status === 'error' ? { error: 'watch-failed' } : {}) },
    });
  }
  async prepare(rule: WatchRule): Promise<{ check(): void; release(): Promise<void> }> {
    if ((rule.match.kind !== 'file.changed' && rule.match.kind !== 'file.burst') || rule.match.subject === undefined)
      return { check: () => {}, release: async () => {} };
    const watched = root(rule.match.subject);
    if (!watched) throw new TypeError('file watch subject must be an absolute path');
    if (!this.eligible(rule)) return { check: () => {}, release: async () => {} };
    let staged: { close(): void | Promise<void> } | undefined;
    const run = this.tail.then(async () => {
      if (this.stopped) throw new Error('stopped');
      if (this.paused()) {
        let failed = false;
        const temporary = this.watcher.watch(watched, (event) => {
          if ('watchError' in event && event.watchError === true) failed = true;
        });
        await temporary.close();
        if (failed) throw new Error('file watch activation failed');
      } else {
        if (!this.watches.has(watched)) this.watch(watched);
        this.leases.set(watched, (this.leases.get(watched) ?? 0) + 1);
        staged = this.watches.get(watched);
      }
    });
    this.tail = run.catch(() => {});
    await run;
    return {
      check: () => {
        if (staged && this.failedWatches.has(staged)) throw new Error('file watch activation failed');
      },
      release: async () => {
        if (staged) {
          const count = this.leases.get(watched) ?? 0;
          if (count <= 1) this.leases.delete(watched);
          else this.leases.set(watched, count - 1);
        }
        await this.refresh();
      },
    };
  }
  refresh(): Promise<void> {
    const run = this.tail.then(async () => {
      if (this.expiryTimer) clearTimeout(this.expiryTimer);
      this.expiryTimer = undefined;
      if (!this.stopped && !this.paused()) {
        const now = this.clock.wall();
        const next = Math.min(
          ...this.rules()
            .filter(
              (rule) =>
                this.eligible(rule) &&
                (rule.match.kind === 'file.changed' || rule.match.kind === 'file.burst') &&
                rule.match.subject &&
                rule.expiresAt !== undefined,
            )
            .map((rule) => rule.expiresAt as number),
        );
        if (Number.isFinite(next)) {
          this.expiryTimer = setTimeout(
            () => {
              void this.refresh().catch(() => {});
            },
            Math.min(2_147_483_647, Math.max(0, next - now)),
          );
          this.expiryTimer.unref?.();
        }
      }
      const failed = new Set<string>();
      for (;;) {
        this.active = !this.stopped && !this.paused();
        const roots = this.roots();
        this.setRoots([...roots]);
        const obsolete = [...this.watches].find(
          ([watched]) => !roots.has(watched) && (!this.active || !this.leases.has(watched)),
        );
        if (obsolete) {
          this.watches.delete(obsolete[0]);
          await obsolete[1].close();
          continue;
        }
        const missing = [...roots].find((watched) => !this.watches.has(watched) && !failed.has(watched));
        if (!missing) break;
        try {
          this.watch(missing);
        } catch {
          failed.add(missing);
        }
      }
      if (this.active) {
        for (const rule of this.rules()) {
          if (
            !this.eligible(rule) ||
            (rule.match.kind !== 'file.changed' && rule.match.kind !== 'file.burst') ||
            rule.match.subject === undefined
          )
            continue;
          const watched = root(rule.match.subject);
          const status = watched && this.watches.has(watched) ? 'ok' : 'error';
          await this.status(rule, status);
        }
      }
      if (!this.stopped && !this.attention.isStopped()) {
        const previous = this.attention.state().env.watchedPaths.value ?? {};
        const paths = this.rules()
          .filter(
            (rule) => this.eligible(rule) && rule.match.kind === 'file.changed' && rule.match.subject !== undefined,
          )
          .map((rule) => rule.match.subject as string);
        const value = Object.fromEntries(paths.map((path) => [path, previous[path] ?? { lastChange: 0, changes: 0 }]));
        this.attention.store.apply({
          id: this.attention.id(),
          kind: 'fact.updated',
          at: this.clock.wall(),
          source,
          subject: 'env.watchedPaths',
          data: { path: 'env.watchedPaths', value, ttlMs: 86_400_000 },
        });
        this.attention.changed();
      }
    });
    this.tail = run.catch(() => {});
    return run;
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.active = false;
    this.leases.clear();
    if (this.clearDispatch) clearImmediate(this.clearDispatch);
    this.dispatch.clear();
    await this.refresh();
  }
  private async accept(event: FileChange, watched: string): Promise<void> {
    if (!this.active || this.paused() || !path.isAbsolute(event.path) || !this.roots().has(watched)) return;
    const absolute = path.normalize(event.path);
    const watchRoot = path.normalize(watched).replace(/\/+$/, '') || '/';
    if (absolute !== watchRoot && !absolute.startsWith(watchRoot === '/' ? '/' : `${watchRoot}/`)) return;
    const key = JSON.stringify([path.normalize(event.path), event.change, event.at ?? this.clock.wall()]);
    const roots = this.dispatch.get(key) ?? new Map<string, number>();
    const count = (roots.get(watched) ?? 0) + 1;
    const duplicate = [...roots].some(([other, seen]) => other !== watched && seen >= count);
    roots.set(watched, count);
    this.dispatch.set(key, roots);
    if (this.dispatch.size > 5000) this.dispatch.delete(this.dispatch.keys().next().value as string);
    if (!this.clearDispatch)
      this.clearDispatch = setImmediate(() => {
        this.clearDispatch = undefined;
        this.dispatch.clear();
      });
    if (duplicate) return;
    const signal = this.dsh.classify({
      id: this.attention.id(),
      kind: 'file.changed',
      at: event.at ?? this.clock.wall(),
      source,
      subject: path.normalize(event.path),
      data: { path: path.normalize(event.path), change: event.change, ttlMs: 86_400_000 },
    });
    const matching = this.rules().filter(
      (r) =>
        this.eligible(r) &&
        r.match.kind === signal.kind &&
        r.match.subject &&
        matchesRule(r, signal, this.clock.wall()),
    );
    if (matching.length) {
      signal.data.watchedPaths = matching.map((rule) => rule.match.subject);
      await this.attention.accept(signal);
    }
    if (this.active && this.roots().has(watched)) await this.burst(signal);
  }
}
