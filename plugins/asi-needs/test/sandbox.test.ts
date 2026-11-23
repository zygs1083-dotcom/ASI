import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cleanSafeCaches,
  compactIdleContexts,
  DEFAULT_STUCK_JOB_MS,
  stopStuckJobs,
  upsertHelpCard,
} from '../src/host/sandbox.js';
import { T0 } from './fixtures.js';

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

describe('cleanSafeCaches 安全沙盒清理', () => {
  it('只清理白名单 tmp/cache 文件，保留 state.json，且拒绝跟随指向外部用户文件的符号链接', async () => {
    const root = await mkdtemp(join(tmpdir(), 'asi-needs-sandbox-'));
    tempDirs.push(root);

    const needsDir = join(root, 'asi-needs');
    const senseDir = join(root, 'asi-sense');
    const userDir = join(root, 'user-precious');
    await mkdir(join(needsDir, 'tmp', 'nested'), { recursive: true });
    await mkdir(join(needsDir, 'cache'), { recursive: true });
    await mkdir(join(senseDir, 'tmp'), { recursive: true });
    await mkdir(userDir, { recursive: true });

    const keepState = join(needsDir, 'state.json');
    const userFile = join(userDir, 'important.txt');
    const userSubdir = join(userDir, 'sub');
    await mkdir(userSubdir, { recursive: true });
    await writeFile(join(userSubdir, 'doc.md'), 'never delete me', 'utf8');
    await writeFile(keepState, '{"helpCards":[]}', 'utf8');
    await writeFile(userFile, 'precious user data', 'utf8');

    // 白名单内普通缓存文件
    await writeFile(join(needsDir, 'tmp', 'nested', 'chunk.bin'), Buffer.alloc(4096));
    await writeFile(join(needsDir, 'cache', 'temp.json'), '{}', 'utf8');
    await writeFile(join(senseDir, 'tmp', 'probe.tmp'), Buffer.alloc(1024));

    // 符号链接逃逸攻击：指向外部用户文件与外部用户目录
    await symlink(userFile, join(needsDir, 'tmp', 'escape-file.lnk'));
    await symlink(userSubdir, join(needsDir, 'cache', 'escape-dir'));

    const res = await cleanSafeCaches({
      needsStorageRoot: needsDir,
      senseStorageRoot: senseDir,
      now: T0,
    });

    expect(res.deletedEntries).toBe(3);
    expect(res.freedBytes).toBeGreaterThanOrEqual(5120);
    expect(res.skippedSymlinks).toBe(2);

    // 外部用户文件与目录完好无损，插件持久化 state.json 完好无损
    expect((await stat(userFile)).isFile()).toBe(true);
    expect((await stat(join(userSubdir, 'doc.md'))).isFile()).toBe(true);
    expect((await stat(keepState)).isFile()).toBe(true);
  });
});

describe('stopStuckJobs 仅结束超时或无主的 DSH 任务', () => {
  it('结束超时任务与无主残留任务，严格拒绝正在正常运行的活跃用户任务', () => {
    const killJob = vi.fn(() => 'requested' as const);
    const jobsPort = {
      listActiveJobs: () => [
        { id: 'job-normal', owner: 'user-1', status: 'running', startedAt: T0 - 10_000 },
        { id: 'job-stuck', owner: 'user-1', status: 'running', startedAt: T0 - DEFAULT_STUCK_JOB_MS - 5_000 },
        { id: 'job-orphan', owner: 'closed-session', status: 'running', startedAt: T0 - 5_000 },
      ],
      hasLiveOwner: (id: string) => id === 'user-1',
      killJob,
    };

    // 即使显式指定正常活跃任务 ID，也必须被拒绝
    const refused = stopStuckJobs({ jobsPort, now: T0, targetJobId: 'job-normal' });
    expect(refused.stoppedIds).toEqual([]);
    expect(refused.refusedActiveIds).toEqual(['job-normal']);
    expect(killJob).not.toHaveBeenCalled();

    // 批量清理只命中 stuck 与 orphan
    const cleaned = stopStuckJobs({ jobsPort, now: T0 });
    expect(cleaned.stoppedIds).toEqual(['job-stuck', 'job-orphan']);
    expect(killJob).toHaveBeenCalledTimes(2);
  });
});

describe('compactIdleContexts 空闲会话整理', () => {
  it('只压缩非内部空闲会话，并可触发自维护会话轮换回调', async () => {
    const compactIdleSession = vi.fn(async (id: string) => ({
      compacted: id === 'idle-1',
      tokensSaved: id === 'idle-1' ? 18_000 : 0,
    }));
    const res = await compactIdleContexts({
      compactionPort: {
        listIdleSessionIds: (exclude) => ['idle-1', 'idle-2', 'maint-1'].filter((id) => !exclude.has(id)),
        compactIdleSession,
      },
      excludeSessionIds: new Set(['maint-1']),
      signal: new AbortController().signal,
      rotateMaintainer: async () => true,
    });
    expect(res).toEqual({ compactedSessions: 1, tokensSaved: 18_000, rotatedMaintainer: true });
    expect(compactIdleSession).toHaveBeenCalledTimes(2);
  });
});

describe('upsertHelpCard 求助卡去重与凭据脱敏', () => {
  it('同需求同动作的 open 求助卡原位合并，且自动擦除潜在密钥字符串', () => {
    const fakeSecret = `sk-proj-1234567890${'a'.repeat(18)}`;
    const first = upsertHelpCard([], {
      need: 'space',
      severity: 'uncomfortable',
      title: `磁盘空间告警 ${fakeSecret}`,
      summary: `检测到缓存膨胀 token=${fakeSecret}`,
      now: T0,
    });
    expect(first.created).toBe(true);
    expect(first.card.title).not.toContain(fakeSecret);
    expect(first.card.summary).not.toContain(fakeSecret);

    const second = upsertHelpCard(first.cards, {
      need: 'space',
      severity: 'critical',
      title: '磁盘空间危急',
      summary: '升级为危急状态',
      now: T0 + 5_000,
    });
    expect(second.created).toBe(false);
    expect(second.cards).toHaveLength(1);
    expect(second.card.severity).toBe('critical');
  });
});
