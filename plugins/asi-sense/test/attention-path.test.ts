import { describe, expect, it } from 'vitest';
import { isHomeRoot } from '../src/host/attention/path.ts';
import { modelActivityName } from '../src/host/dsh/deliver.ts';
import { sanitizeDirPath } from '../src/host/runtime/history/types.ts';

describe('isHomeRoot', () => {
  it('recognizes Windows drive home roots case-insensitively', () => {
    expect(isHomeRoot('C:\\Users\\alice', 'win32')).toBe(true);
    expect(isHomeRoot('c:/users/alice', 'linux')).toBe(true);
    expect(isHomeRoot('C:\\Users', 'win32')).toBe(false);
    expect(isHomeRoot('C:\\Users\\alice\\Documents', 'win32')).toBe(false);
  });

  it('keeps POSIX home roots recognized and child paths untouched', () => {
    expect(isHomeRoot('/Users/alice', 'darwin')).toBe(true);
    expect(isHomeRoot('/home/bob-dev', 'linux')).toBe(true);
    expect(isHomeRoot('/Users/alice/src', 'darwin')).toBe(false);
  });

  it('masks Windows home roots in dir sanitization and activity names', () => {
    expect(sanitizeDirPath('C:\\Users\\alice')).toBe('~');
    expect(modelActivityName('C:\\Users\\alice', true)).toBe('~');
    expect(sanitizeDirPath('C:\\Users\\alice\\projects')).toBe('projects');
  });
});
