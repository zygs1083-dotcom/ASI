import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Message } from './helper-events.ts';

export class HelperWriter {
  private child?: ChildProcessWithoutNullStreams;
  private writing = false;
  private title?: Message;
  private snapshot = false;
  private recheck = false;
  constructor(private readonly fail: (child: ChildProcessWithoutNullStreams) => void) {}
  start(child: ChildProcessWithoutNullStreams): void {
    this.child = child;
    this.writing = false;
    this.title = undefined;
    this.snapshot = false;
    this.recheck = false;
  }
  stop(): void {
    this.child = undefined;
    this.title = undefined;
    this.snapshot = false;
    this.recheck = false;
  }
  write(command: Message): void {
    if (!this.child) return;
    if (command.cmd === 'titles') this.title = command;
    else if (command.cmd === 'recheck-permissions') this.recheck = true;
    else this.snapshot = true;
    this.pump(this.child);
  }
  private pump(child: ChildProcessWithoutNullStreams): void {
    if (this.writing || this.child !== child) return;
    const command =
      this.title ?? (this.recheck ? { cmd: 'recheck-permissions' } : this.snapshot ? { cmd: 'snapshot' } : undefined);
    if (!command) return;
    if (this.title) this.title = undefined;
    else if (this.recheck) this.recheck = false;
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
