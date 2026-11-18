import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isHomeAlias, isHomeRoot, setExtraHomes, toHomeRelative } from '../src/host/attention/path.ts';
import { modelActivityName } from '../src/host/dsh/deliver.ts';
import { sanitizeDirPath } from '../src/host/runtime/history/types.ts';

const tempDirs: string[] = [];

afterEach(async () => {
  setExtraHomes([]);
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

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

describe('home alias set', () => {
  it('folds a symlinked home, its realpath, and child paths into the alias set', async () => {
    const base = await mkdtemp(join(tmpdir(), 'asi-home-alias-unit-'));
    tempDirs.push(base);
    const real = join(base, 'vol', 'alice_real');
    const link = join(base, 'links', 'alice_link');
    await mkdir(real, { recursive: true });
    await mkdir(join(base, 'links'), { recursive: true });
    await symlink(real, link);

    setExtraHomes([link], 'darwin');
    expect(isHomeAlias(link, 'darwin')).toBe(true);
    expect(isHomeAlias(real, 'darwin')).toBe(true);
    expect(isHomeRoot(real, 'darwin')).toBe(true);
    expect(toHomeRelative(join(real, 'proj', 'a.ts'), 'darwin')).toBe('~/proj/a.ts');
    expect(modelActivityName(real, true)).toBe('~');
    expect(modelActivityName(join(real, 'proj'), true)).toBe('proj');

    setExtraHomes([], 'darwin');
    expect(isHomeAlias(real, 'darwin')).toBe(false);
  });

  it('masks a custom home outside the standard /Users and /home shapes', () => {
    setExtraHomes(['/srv/home/demo_acct'], 'linux');
    expect(isHomeRoot('/srv/home/demo_acct', 'linux')).toBe(true);
    expect(modelActivityName('/srv/home/demo_acct', true)).toBe('~');
    expect(toHomeRelative('/srv/home/demo_acct/proj/x.ts', 'linux')).toBe('~/proj/x.ts');
    expect(isHomeRoot('/srv/home/other', 'linux')).toBe(false);
  });
});
