/**
 * Host-provided atomic local persistence (DESIGN §2.2c). `load` returns the
 * previously saved snapshot text or `undefined` on a first install; `save`
 * resolves only after the new snapshot is installed and must reject only when
 * it was not installed. Write a temp file
 * and make atomic rename the final rejecting step; post-rename errors must
 * be recorded by the host without rejecting. Nothing here does IO itself.
 */
export interface BodyPersistence {
  load(): Promise<string | undefined>;
  save(data: string): Promise<void>;
  onRestoreFailure?(): Promise<void>;
}

/**
 * Write coalescer shared by Tuner and BodyMonitor: at most one write per
 * `intervalMs`, the snapshot is produced at execution time (never the text
 * staged at schedule time), writes are serialized so they cannot overlap,
 * and the timer is `unref`ed so it cannot hold the process open. Failures
 * go to `onError`; a {@link flush} write also rejects to its own caller
 * (still without breaking the queue). A flush is
 * always allowed — it is the shutdown path.
 */
export class PersistScheduler {
  private timer?: ReturnType<typeof setTimeout>;
  private tail: Promise<void> = Promise.resolve();
  private lastRun = Number.NEGATIVE_INFINITY;
  private closed = false;
  private saving = false;
  private dirty = false;

  constructor(
    private readonly save: () => Promise<void>,
    private readonly clock: () => number = () => performance.now(),
    private readonly intervalMs = 10_000,
    private readonly onError?: (err: unknown) => void | Promise<void>,
  ) {}

  /** Marks state dirty; the write happens within `intervalMs`, coalesced. */
  schedule(): void {
    if (this.closed) return;
    this.dirty = true;
    if (this.timer !== undefined || this.saving) return;
    const elapsed = this.clock() - this.lastRun;
    const wait = Number.isFinite(elapsed) ? Math.max(0, this.intervalMs - elapsed) : this.intervalMs;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.dirty = false;
      this.saving = true;
      const finished = () => {
        this.saving = false;
        if (this.dirty) this.schedule();
      };
      void this.enqueue().then(finished, finished);
    }, wait);
    this.timer.unref?.();
  }

  /** Serial writer: runs after the previous write settled — never overlaps. */
  private enqueue(save = this.save): Promise<void> {
    const p = this.tail.then(async () => {
      this.lastRun = this.clock();
      try {
        await save();
      } catch (err) {
        await this.onError?.(err);
        throw err;
      }
    });
    this.tail = p.catch(() => {});
    return p;
  }

  commit(save: () => Promise<void>, publish: () => void): Promise<void> {
    return this.enqueue(async () => {
      await save();
      publish();
    });
  }

  /** Forces a write now (cancels any pending coalesced one). */
  flush(): Promise<void> {
    this.dirty = false;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    return this.enqueue();
  }

  /** Cancels the pending write AND the timer without flushing (pre-restore shutdown). */
  cancel(): void {
    this.closed = true;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /** Cancels the pending write, then flushes the current snapshot. */
  async close(): Promise<void> {
    this.closed = true;
    await this.flush();
  }
}
