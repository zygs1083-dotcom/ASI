import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function isEnoent(err: unknown): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === 'ENOENT';
}

export function readJsonFile<T>(path: string): T | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if (isEnoent(err)) {
      return undefined;
    }
    throw err;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    // 不带解析器原文：JSON.parse 的错误信息可能包含文件内容片段（如 key 材料）
    throw new Error(`数据文件损坏，无法解析：${path}`);
  }
}

export function writeJsonAtomic(path: string, value: unknown): void {
  ensureDir(dirname(path));
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}
