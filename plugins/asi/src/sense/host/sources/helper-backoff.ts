import { type Message, validApp } from './helper-events.ts';

export class SnapshotBackoff {
  deadline?: number;
  private attempts = 0;
  private exhausted = false;

  reset(): void {
    this.deadline = undefined;
    this.attempts = 0;
    this.exhausted = false;
  }

  failed(now: number): void {
    if (this.attempts < 10) {
      this.deadline = now + Math.min(60_000, 2_000 * 2 ** this.attempts++);
    } else {
      this.exhausted = true;
      this.deadline = now + 300_000;
    }
  }

  due(now: number): boolean {
    if (this.deadline === undefined || now < this.deadline) return false;
    if (this.exhausted) this.reset();
    else this.deadline = undefined;
    return true;
  }

  delta(event: Message): boolean {
    const trusted =
      (event.type === 'app.activated' && validApp(event)) ||
      ((event.type === 'window.focused' || event.type === 'window.title') && typeof event.title === 'string') ||
      (event.type === 'thermal' && ['nominal', 'fair', 'serious', 'critical'].includes(String(event.state)));
    if (!this.exhausted || !trusted) return false;
    this.reset();
    return true;
  }
}
