import { describe, expect, it } from 'vitest';
import { parsePsTable, sampleTopProcesses } from '../../src/needs/host/process-top.js';
import { T0 } from './fixtures.js';

describe('轻量 MIT 方案 Top CPU/内存进程只读采样器', () => {
  it('解析 POSIX ps 表并提取可执行文件基名、转换字节单位且按 CPU/RSS 精确排序脱敏', async () => {
    const fakeSecret = ['sk', '-proj-1234567890abcdefghijklmnop'].join('');
    const psOutput = [
      '  101     1   51200   4.2  0.3 /System/Library/CoreServices/WindowServer',
      ' 4820   101 2097152 185.6 12.5 /Applications/Xcode.app/Contents/MacOS/Xcode',
      ' 5912  4820 4194304  42.0 25.0 /opt/homebrew/Cellar/node/22.12.0/bin/node',
      ` 6001     1   16384  91.4  0.1 /tmp/custom-${fakeSecret}`,
      ' 7002     1    8192  12.0  0.2 /Users/secretuser/private-dir/',
      ' 7003     2       0   3.5  0.0 kworker/u16:2-events',
      'malformed line without numbers',
      '   -1     0     100   1.0  0.1 invalid-pid',
      '',
    ].join('\n');

    const rows = parsePsTable(psOutput);
    expect(rows).toHaveLength(6);
    expect(rows.find((p) => p.pid === 7002)?.name).toBe('private-dir');
    expect(rows.find((p) => p.pid === 7003)?.name).toBe('kworker/u16:2-events');

    const report = await sampleTopProcesses({
      now: T0,
      limit: 3,
      exec: async () => psOutput,
    });

    expect(report.totalProcesses).toBe(6);
    expect(report.byCpu.map((p) => p.pid)).toEqual([4820, 6001, 5912]);
    expect(report.byCpu[0]?.name).toBe('Xcode');
    expect(report.byMemory.map((p) => p.pid)).toEqual([5912, 4820, 101]);
    expect(report.byMemory[0]?.rssBytes).toBe(4194304 * 1024);

    // 验证进程名不包含目录路径（含尾部斜杠路径）且敏感凭据已被打码
    const serialized = JSON.stringify({ rows, report });
    expect(serialized).not.toContain('/Applications/');
    expect(serialized).not.toContain('secretuser');
    expect(serialized).not.toContain(fakeSecret);
    expect(serialized).toContain('[redacted]');
  });

  it('ps 命令异常或超时时优雅降级返回空列表与脱敏错误说明，绝不抛未捕获异常', async () => {
    const fakeSecret = ['ghp', '_', 'x'.repeat(36)].join('');
    const report = await sampleTopProcesses({
      now: T0,
      exec: async () => {
        throw new Error(`spawn EACCES token=${fakeSecret}`);
      },
    });
    expect(report.totalProcesses).toBe(0);
    expect(report.byCpu).toEqual([]);
    expect(report.byMemory).toEqual([]);
    expect(report.error).toBeDefined();
    expect(report.error).not.toContain(fakeSecret);
  });
});
