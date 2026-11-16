import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Message } from './helper-events.ts';

export class HelperWriter {
  private child?: ChildProcessWithoutNullStreams;
  private writing = false;
  private title?: Message;
  private snapshot = false;
  constructor(private readonly fail: (child: ChildProcessWithoutNullStreams) => void) {}
  start(child: ChildProcessWithoutNullStreams): void {
    this.child = child;
    this.writing = false;
    this.title = undefined;
    this.snapshot = false;
  }
  stop(): void {
    this.child = undefined;
    this.title = undefined;
    this.snapshot = false;
  }
  write(command: Message): void {
    if (!this.child) return;
    if (command.cmd === 'titles') this.title = command;
    else this.snapshot = true;
    this.pump(this.child);
  }
  private pump(child: ChildProcessWithoutNullStreams): void {
    if (this.writing || this.child !== child) return;
    const command = this.title ?? (this.snapshot ? { cmd: 'snapshot' } : undefined);
    if (!command) return;
    if (this.title) this.title = undefined;
    else this.snapshot = false;
    this.writing = true;
    child.stdin.write(`${JSON.stringify(command)}\n`, (error) => {
      if (this.child !== child) return;
      this.writing = false;
      if (error) this.fail(child);
      else this.pump(child);
    });
  }
}
