import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyManualCalibration,
  classifyFrontApp,
  createZeroCalibrationBiases,
  DEFAULT_RAPPORT_BASELINE,
  evaluatePartnerState,
  type RapportBaseline,
  type TomEvaluationInput,
  updateBaselineWithApproval,
  updateBaselineWithPrompt,
  updateBaselineWithSwitchWindow,
} from '../../src/tom/host/evaluator.ts';
import { TomStateStore } from '../../src/tom/host/storage.ts';

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

function makeBaseInput(overrides: Partial<TomEvaluationInput> = {}): TomEvaluationInput {
  const now = 1_764_000_000_000;
  return {
    now,
    enabled: true,
    sensePaused: false,
    screenLocked: false,
    systemSleeping: false,
    frontAppCategory: 'dev',
    hasActiveOrdinarySession: true,
    prompts: [],
    frictions: [],
    reliefs: [],
    approvals: [],
    appSwitches: [],
    baseline: { ...DEFAULT_RAPPORT_BASELINE },
    calibrationBiases: createZeroCalibrationBiases(),
    calibrationCount: 0,
    manualOverride: null,
    ...overrides,
  };
}

describe('方向 B · 心智理论 (ToM) 确定性推断引擎与个体节律基线验证', () => {
  it('准确识别应用类别并在持续驻留开发环境、低切换熵且无摩擦时推断为 deep_focus（启用免扰避让与 0 追问预算）', () => {
    expect(classifyFrontApp('Cursor', 'com.todesktop.cursor')).toBe('dev');
    expect(classifyFrontApp('Google Chrome', 'com.google.Chrome')).toBe('browser');
    expect(classifyFrontApp('Feishu', 'com.electron.lark')).toBe('comm');
    expect(classifyFrontApp('Finder', 'com.apple.finder')).toBe('other');

    const now = 1_764_000_000_000;
    const res = evaluatePartnerState(
      makeBaseInput({
        now,
        frontAppCategory: 'dev',
        prompts: [{ at: now - 50_000, charCount: 135, interMessageMs: 70_000 }],
        appSwitches: [{ at: now - 120_000, category: 'dev' }],
      }),
    );

    expect(res.state).toBe('deep_focus');
    expect(res.source).toBe('inferred');
    expect(res.dimensions.focus).toBeGreaterThanOrEqual(80);
    expect(res.dimensions.friction).toBe(0);
    expect(res.guidance.verbosity).toBe('concise');
    expect(res.guidance.questionBudget).toBe(0);
    expect(res.guidance.deferNonCriticalInterruptions).toBe(true);
    expect(res.driveReading.autoMaintain).toBe(false);
    expect(res.driveZone).toBe('comfortable');
  });

  it('个体化 EWMA 节律基线归一化：慢基线搭档突发高频短指令触发 rapid_sprint，而天生快节奏基线搭档保持常态不误报', () => {
    const now = 1_764_000_000_000;
    let slowBaseline: RapportBaseline = { ...DEFAULT_RAPPORT_BASELINE };
    for (let i = 0; i < 10; i += 1) {
      slowBaseline = updateBaselineWithPrompt(slowBaseline, { charCount: 180, interMessageMs: 110_000 });
    }
    expect(slowBaseline.ewmaInterMessageMs).toBeGreaterThan(85_000);

    // 慢基线搭档突然以 12s 间隔连发精短指令并秒批确认
    const sprintRes = evaluatePartnerState(
      makeBaseInput({
        now,
        frontAppCategory: 'other',
        baseline: slowBaseline,
        prompts: [
          { at: now - 36_000, charCount: 28, interMessageMs: 14_000 },
          { at: now - 22_000, charCount: 24, interMessageMs: 14_000 },
          { at: now - 10_000, charCount: 22, interMessageMs: 12_000 },
        ],
        approvals: [{ at: now - 8_000, latencyMs: 1_200 }],
      }),
    );
    expect(sprintRes.state).toBe('rapid_sprint');
    expect(sprintRes.dimensions.pace).toBeGreaterThanOrEqual(75);
    expect(sprintRes.guidance.verbosity).toBe('ultra_concise');
    expect(sprintRes.guidance.deferNonCriticalInterruptions).toBe(true);

    // 另一位天生习惯 28s/条、60 字的搭档，按其本人常态节奏发信时 pace 不会虚高到极端
    let fastHabitBaseline: RapportBaseline = { ...DEFAULT_RAPPORT_BASELINE };
    for (let i = 0; i < 15; i += 1) {
      fastHabitBaseline = updateBaselineWithPrompt(fastHabitBaseline, { charCount: 60, interMessageMs: 28_000 });
    }
    fastHabitBaseline = updateBaselineWithApproval(fastHabitBaseline, 2_500);
    fastHabitBaseline = updateBaselineWithSwitchWindow(fastHabitBaseline, 6);

    const habitualRes = evaluatePartnerState(
      makeBaseInput({
        now,
        frontAppCategory: 'other',
        baseline: fastHabitBaseline,
        prompts: [
          { at: now - 40_000, charCount: 62, interMessageMs: 29_000 },
          { at: now - 11_000, charCount: 58, interMessageMs: 29_000 },
        ],
      }),
    );
    expect(habitualRes.dimensions.pace).toBeLessThan(sprintRes.dimensions.pace);
    expect(habitualRes.state).toBe('steady_flow');
  });

  it('检测到用户主动打断与命令非零退出时进入 stuck_debugging（根因验证优先），且问题解决后摩擦自然缓解恢复', () => {
    const now = 1_764_000_000_000;
    const stuckRes = evaluatePartnerState(
      makeBaseInput({
        now,
        frontAppCategory: 'dev',
        frictions: [
          { at: now - 45_000, kind: 'command_failed' },
          { at: now - 15_000, kind: 'user_interrupt' },
        ],
        prompts: [
          { at: now - 32_000, charCount: 25, interMessageMs: 18_000 },
          { at: now - 12_000, charCount: 18, interMessageMs: 20_000 },
        ],
        appSwitches: [
          { at: now - 40_000, category: 'dev' },
          { at: now - 35_000, category: 'browser' },
          { at: now - 28_000, category: 'dev' },
          { at: now - 20_000, category: 'browser' },
          { at: now - 14_000, category: 'dev' },
        ],
      }),
    );

    expect(stuckRes.state).toBe('stuck_debugging');
    expect(stuckRes.dimensions.friction).toBeGreaterThanOrEqual(55);
    expect(stuckRes.guidance.autonomy).toBe('verify_first');
    expect(stuckRes.driveZone).toBe('uncomfortable');
    // 绝不跌破 25 触发虚假的 L1 级 critical 恐慌
    expect(stuckRes.driveReading.satisfaction).toBeGreaterThanOrEqual(26);
    expect(stuckRes.driveReading.satisfaction).toBeLessThan(60);

    // 随后连续两轮顺利完成且命令退出码为 0，摩擦显著回落并恢复舒适区
    const relievedTime = now + 120_000;
    const relievedRes = evaluatePartnerState(
      makeBaseInput({
        now: relievedTime,
        frontAppCategory: 'dev',
        frictions: [
          { at: now - 45_000, kind: 'command_failed' },
          { at: now - 15_000, kind: 'user_interrupt' },
        ],
        reliefs: [
          { at: now + 30_000, kind: 'command_succeeded' },
          { at: now + 45_000, kind: 'turn_completed' },
          { at: now + 95_000, kind: 'command_succeeded' },
          { at: now + 110_000, kind: 'turn_completed' },
        ],
        prompts: [{ at: now + 60_000, charCount: 120, interMessageMs: 72_000 }],
      }),
    );
    expect(relievedRes.dimensions.friction).toBeLessThan(35);
    expect(relievedRes.state).not.toBe('stuck_debugging');
    expect(relievedRes.driveZone).toBe('comfortable');
  });

  it('区分跨窗口长输入探索 (exploring)、锁屏或长静默离开 (away_resting) 与全局暂停冻结 (paused)', () => {
    const now = 1_764_000_000_000;

    const exploringRes = evaluatePartnerState(
      makeBaseInput({
        now,
        frontAppCategory: 'browser',
        prompts: [{ at: now - 30_000, charCount: 420, interMessageMs: 120_000 }],
        appSwitches: [
          { at: now - 150_000, category: 'browser' },
          { at: now - 110_000, category: 'comm' },
          { at: now - 70_000, category: 'dev' },
          { at: now - 35_000, category: 'browser' },
        ],
      }),
    );
    expect(exploringRes.state).toBe('exploring');
    expect(exploringRes.guidance.verbosity).toBe('thorough');
    expect(exploringRes.guidance.questionBudget).toBe(2);

    const lockedRes = evaluatePartnerState(
      makeBaseInput({
        now,
        screenLocked: true,
        prompts: [{ at: now - 10_000, charCount: 80 }],
      }),
    );
    expect(lockedRes.state).toBe('away_resting');
    expect(lockedRes.dimensions.presence).toBeLessThanOrEqual(10);
    expect(lockedRes.guidance.verbosity).toBe('handoff_summary');

    const longIdleRes = evaluatePartnerState(
      makeBaseInput({
        now,
        prompts: [{ at: now - 20 * 60_000, charCount: 80 }],
      }),
    );
    expect(longIdleRes.state).toBe('away_resting');

    const pausedRes = evaluatePartnerState(
      makeBaseInput({
        now,
        enabled: false,
        frictions: [{ at: now - 5_000, kind: 'user_interrupt' }],
      }),
    );
    expect(pausedRes.source).toBe('paused');
    expect(pausedRes.driveReading.satisfaction).toBe(100);
  });

  it('支持搭档手动覆写、到期自动恢复、在线校准偏置学习以及 TomStateStore 原子持久化与坏文件自愈', async () => {
    const now = 1_764_000_000_000;
    const calibrated = applyManualCalibration(createZeroCalibrationBiases(), 0, 'steady_flow', 'deep_focus');
    expect(calibrated.calibrationCount).toBe(1);
    expect(calibrated.biases.deep_focus).toBeGreaterThan(0);
    expect(calibrated.biases.steady_flow).toBeLessThan(0);

    // 有效手动覆写优先生效，过期后自动回退推断
    const overridden = evaluatePartnerState(
      makeBaseInput({
        now,
        frontAppCategory: 'other',
        manualOverride: { state: 'rapid_sprint', setAt: now - 60_000, expiresAt: now + 600_000 },
      }),
    );
    expect(overridden.state).toBe('rapid_sprint');
    expect(overridden.source).toBe('manual_override');
    expect(overridden.confidence).toBe(1);

    const expired = evaluatePartnerState(
      makeBaseInput({
        now: now + 700_000,
        frontAppCategory: 'other',
        manualOverride: { state: 'rapid_sprint', setAt: now - 60_000, expiresAt: now + 600_000 },
      }),
    );
    expect(expired.source).toBe('inferred');

    // 验证磁盘原子存储与损坏 JSON 自动自愈
    const dir = await mkdtemp(join(tmpdir(), 'asi-tom-store-'));
    tempDirs.push(dir);
    const store = new TomStateStore(dir);

    await store.save({
      version: 1,
      enabled: true,
      manualOverride: { state: 'deep_focus', setAt: now, expiresAt: now + 3_600_000 },
      baseline: {
        sampleCount: 16,
        ewmaInterMessageMs: 42_000,
        ewmaPromptChars: 96,
        ewmaAppSwitchesPer5m: 2.5,
        ewmaApprovalMs: 3_200,
      },
      calibrationBiases: calibrated.biases,
      calibrationCount: 1,
      lastUpdatedAt: now,
    });

    const loaded = await store.load(now + 1_000);
    expect(loaded.baseline.sampleCount).toBe(16);
    expect(loaded.manualOverride?.state).toBe('deep_focus');
    expect(loaded.calibrationBiases.deep_focus).toBe(4);

    const rawDiskText = await readFile(join(dir, 'state.json'), 'utf8');
    expect(rawDiskText).not.toContain('userText');

    // 写入损坏文件后 load 安全回退默认状态不抛错
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'state.json'), '{corrupted-json');
    const recovered = await store.load(now);
    expect(recovered.enabled).toBe(true);
    expect(recovered.baseline.sampleCount).toBe(0);
  });
});
