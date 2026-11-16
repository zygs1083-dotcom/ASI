/**
 * Time-ordered ring buffer for body/file event histories (DESIGN §2.2c).
 * Capacity doubles on demand — there is no sample-count cap; eviction is
 * purely by timestamp (`prune`). Callers feed items in non-decreasing `at`
 * order; the ring never reorders. No clocks, timers or IO.
 */
export class TimeWindow<T extends { at: number }> {
  private buf: (T | undefined)[];
  private head = 0;
  private n = 0;

  constructor(capacity = 8) {
    this.buf = new Array(Math.max(1, Math.floor(capacity)));
  }

  get size(): number {
    return this.n;
  }

  push(item: T): void {
    if (this.n === this.buf.length) this.grow();
    this.buf[(this.head + this.n) % this.buf.length] = item;
    this.n++;
  }

  /** Evicts every item with `at < cutoff`; items at the cutoff are retained. */
  prune(cutoff: number): void {
    while (this.n > 0) {
      const item = this.buf[this.head];
      if (item === undefined || item.at >= cutoff) break;
      this.buf[this.head] = undefined;
      this.head = (this.head + 1) % this.buf.length;
      this.n--;
    }
  }

  /** In-order snapshot; with `cutoff` only items with `at >= cutoff`. */
  values(cutoff?: number): T[] {
    const out: T[] = [];
    for (let i = 0; i < this.n; i++) {
      const item = this.buf[(this.head + i) % this.buf.length];
      if (item !== undefined && (cutoff === undefined || item.at >= cutoff)) out.push(item);
    }
    return out;
  }

  private grow(): void {
    const next = new Array<T | undefined>(this.buf.length * 2);
    for (const [i, item] of this.values().entries()) next[i] = item;
    this.buf = next;
    this.head = 0;
  }
}
