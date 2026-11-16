import type { Signal } from '@asi/sense-types';

export type ApplyResult = 'applied' | 'duplicate' | 'older' | 'invalid';

export class SignalIntake {
  private readonly queue: { signal: Signal; afterApply?: (result: ApplyResult) => void; valid?: () => boolean }[] = [];
  private processing = false;
  private deferred?: Signal[];

  constructor(
    private readonly applyOne: (signal: Signal) => ApplyResult,
    private readonly commit: (signals: Signal[]) => void,
    private readonly emit: (signal: Signal) => void,
  ) {}

  apply(signal: Signal, afterApply?: (result: ApplyResult) => void, valid?: () => boolean): void {
    this.queue.push({ signal: structuredClone(signal), afterApply, valid });
    this.drain();
  }

  batch<T>(work: () => T, publish: () => void): T {
    if (this.deferred) return work();
    this.deferred = [];
    try {
      return work();
    } finally {
      const signals = this.deferred;
      this.deferred = undefined;
      this.processing = true;
      try {
        this.commit(signals);
        publish();
        for (const signal of signals) this.emit(signal);
      } finally {
        this.processing = false;
        this.drain();
      }
    }
  }

  private drain(): void {
    if (this.processing) return;
    this.processing = true;
    const errors: unknown[] = [];
    try {
      let next = this.queue.shift();
      while (next !== undefined) {
        const result = next.valid && !next.valid() ? 'invalid' : this.applyOne(next.signal);
        if (result === 'applied') {
          if (this.deferred) this.deferred.push(next.signal);
          else {
            this.commit([next.signal]);
            this.emit(next.signal);
          }
        }
        try {
          next.afterApply?.(result);
        } catch (error) {
          errors.push(error);
        }
        next = this.queue.shift();
      }
    } finally {
      this.processing = false;
    }
    if (errors.length) throw errors[0];
  }
}
