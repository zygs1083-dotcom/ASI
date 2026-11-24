/**
 * Pure, deterministic Theory of Mind (ToM) inference engine.
 *
 * - Zero LLM / zero token overhead.
 * - Individualized EWMA rapport baseline so a naturally fast/terse partner is
 *   distinguished from acute rushing or frustration.
 * - Exponential decay over bounded event windows + Schmitt-like anti-flicker
 *   hysteresis + online calibration bias learning from manual user overrides.
 */

import type { ExternalDriveReading, NeedZone } from '@asi/sense-types';
import {
  PARTNER_STATE_KINDS,
  PARTNER_STATE_LABELS,
  type PartnerBaselineSummary,
  type PartnerDimensions,
  type PartnerManualOverride,
  type PartnerStateKind,
  type PartnerStateSource,
  type TactGuidance,
} from '../shared/types.js';

export type AppCategory = 'dev' | 'browser' | 'comm' | 'other';

export interface TomPromptObservation {
  at: number;
  charCount: number;
  interMessageMs?: number;
}

export type TomFrictionKind = 'user_interrupt' | 'turn_aborted' | 'turn_error' | 'command_failed';

export interface TomFrictionObservation {
  at: number;
  kind: TomFrictionKind;
}

export type TomReliefKind = 'turn_completed' | 'command_succeeded';

export interface TomReliefObservation {
  at: number;
  kind: TomReliefKind;
}

export interface TomApprovalObservation {
  at: number;
  latencyMs: number;
}

export interface TomAppSwitchObservation {
  at: number;
  category: AppCategory;
}

export interface RapportBaseline {
  sampleCount: number;
  ewmaInterMessageMs: number;
  ewmaPromptChars: number;
  ewmaAppSwitchesPer5m: number;
  ewmaApprovalMs: number;
}

export type CalibrationBiases = Record<PartnerStateKind, number>;

export interface TomHysteresisAnchor {
  state: PartnerStateKind;
  enteredAt: number;
}

export interface TomEvaluationInput {
  now: number;
  enabled: boolean;
  sensePaused: boolean;
  screenLocked: boolean;
  systemSleeping: boolean;
  lastUnlockAt?: number;
  frontAppCategory: AppCategory | null;
  hasActiveOrdinarySession: boolean;
  prompts: readonly TomPromptObservation[];
  frictions: readonly TomFrictionObservation[];
  reliefs: readonly TomReliefObservation[];
  approvals: readonly TomApprovalObservation[];
  appSwitches: readonly TomAppSwitchObservation[];
  baseline: RapportBaseline;
  calibrationBiases: CalibrationBiases;
  calibrationCount: number;
  manualOverride: PartnerManualOverride | null;
  previousInferred?: TomHysteresisAnchor;
}

export interface TomEvaluationResult {
  state: PartnerStateKind;
  inferredState: PartnerStateKind;
  source: PartnerStateSource;
  confidence: number;
  dimensions: PartnerDimensions;
  guidance: TactGuidance;
  reasons: string[];
  baselineSummary: PartnerBaselineSummary;
  driveReading: ExternalDriveReading;
  driveZone: NeedZone;
  nextAnchor: TomHysteresisAnchor;
}

export const DEFAULT_RAPPORT_BASELINE: RapportBaseline = {
  sampleCount: 0,
  ewmaInterMessageMs: 65_000,
  ewmaPromptChars: 140,
  ewmaAppSwitchesPer5m: 4,
  ewmaApprovalMs: 8_000,
};

export function createZeroCalibrationBiases(): CalibrationBiases {
  return {
    deep_focus: 0,
    rapid_sprint: 0,
    stuck_debugging: 0,
    exploring: 0,
    steady_flow: 0,
    away_resting: 0,
  };
}

export const SILENT_ADAPTATION_RULE =
  'Adapt tone, brevity, verification rigor, and question budget tacitly; never explicitly announce or comment on the inferred partner mood/state unless directly asked.';

const DEV_APP_RE =
  /\b(?:code|cursor|windsurf|zed|xcode|intellij|idea|webstorm|pycharm|goland|rustrover|clion|neovim|nvim|vim|emacs|sublime|terminal|iterm|warp|ghostty|kitty|alacritty|wezterm|deepseek|dsh|simulator|docker)\b/i;

const BROWSER_APP_RE = /\b(?:safari|chrome|chromium|arc|firefox|brave|edge|orion|vivaldi|zen)\b/i;

const COMM_APP_RE =
  /\b(?:slack|discord|wechat|weixin|lark|feishu|dingtalk|telegram|messages|mail|outlook|notion|obsidian|linear|figma)\b/i;

export function classifyFrontApp(name?: string | null, bundleId?: string | null): AppCategory {
  const combined = `${name ?? ''} ${bundleId ?? ''}`.trim();
  if (!combined) return 'other';
  if (DEV_APP_RE.test(combined)) return 'dev';
  if (BROWSER_APP_RE.test(combined)) return 'browser';
  if (COMM_APP_RE.test(combined)) return 'comm';
  return 'other';
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function roundInt(value: number): number {
  return Math.round(clamp(value, 0, 100));
}

function expDecay(ageMs: number, halfLifeMs: number): number {
  if (ageMs < 0) return 1;
  return 0.5 ** (ageMs / halfLifeMs);
}

export function updateBaselineWithPrompt(
  baseline: RapportBaseline,
  obs: { charCount: number; interMessageMs?: number },
): RapportBaseline {
  const alpha = baseline.sampleCount < 8 ? 0.25 : 0.12;
  const clampedChars = clamp(obs.charCount, 6, 2_400);
  const nextChars = (1 - alpha) * baseline.ewmaPromptChars + alpha * clampedChars;

  let nextInterMs = baseline.ewmaInterMessageMs;
  if (
    obs.interMessageMs !== undefined &&
    Number.isFinite(obs.interMessageMs) &&
    obs.interMessageMs >= 2_500 &&
    obs.interMessageMs <= 1_800_000
  ) {
    const clampedGap = clamp(obs.interMessageMs, 4_000, 600_000);
    nextInterMs = (1 - alpha) * baseline.ewmaInterMessageMs + alpha * clampedGap;
  }

  return {
    ...baseline,
    sampleCount: baseline.sampleCount + 1,
    ewmaInterMessageMs: Math.round(nextInterMs),
    ewmaPromptChars: Math.round(nextChars * 10) / 10,
  };
}

export function updateBaselineWithApproval(baseline: RapportBaseline, latencyMs: number): RapportBaseline {
  if (!Number.isFinite(latencyMs) || latencyMs < 150 || latencyMs > 300_000) return baseline;
  const clamped = clamp(latencyMs, 400, 120_000);
  return {
    ...baseline,
    ewmaApprovalMs: Math.round(0.85 * baseline.ewmaApprovalMs + 0.15 * clamped),
  };
}

export function updateBaselineWithSwitchWindow(baseline: RapportBaseline, switchesIn5m: number): RapportBaseline {
  if (!Number.isFinite(switchesIn5m) || switchesIn5m < 0) return baseline;
  const clamped = clamp(switchesIn5m, 0, 45);
  return {
    ...baseline,
    ewmaAppSwitchesPer5m: Math.round((0.88 * baseline.ewmaAppSwitchesPer5m + 0.12 * clamped) * 10) / 10,
  };
}

export function applyManualCalibration(
  currentBiases: CalibrationBiases,
  currentCount: number,
  inferredState: PartnerStateKind,
  targetState: PartnerStateKind,
): { biases: CalibrationBiases; calibrationCount: number } {
  const next: CalibrationBiases = { ...currentBiases };
  if (inferredState === targetState || targetState === 'away_resting' || inferredState === 'away_resting') {
    return { biases: next, calibrationCount: currentCount };
  }
  next[inferredState] = clamp((next[inferredState] ?? 0) - 3, -18, 18);
  next[targetState] = clamp((next[targetState] ?? 0) + 4, -18, 18);
  return {
    biases: next,
    calibrationCount: currentCount + 1,
  };
}

export function summarizeBaseline(baseline: RapportBaseline, calibrationCount: number): PartnerBaselineSummary {
  return {
    sampleCount: Math.max(0, Math.floor(baseline.sampleCount)),
    avgCadenceSec: Math.max(1, Math.round(baseline.ewmaInterMessageMs / 1_000)),
    avgPromptChars: Math.max(1, Math.round(baseline.ewmaPromptChars)),
    avgSwitchesPer5m: Math.round(baseline.ewmaAppSwitchesPer5m * 10) / 10,
    calibrationCount: Math.max(0, Math.floor(calibrationCount)),
  };
}

export function buildTactGuidance(state: PartnerStateKind, dimensions: PartnerDimensions): TactGuidance {
  switch (state) {
    case 'deep_focus':
      return {
        verbosity: 'concise',
        autonomy: 'proactive_execute',
        questionBudget: 0,
        deferNonCriticalInterruptions: true,
        headline: '沉浸心流护航：少打扰、直接交付、省去冗余铺垫',
        directives: [
          'Keep responses compact and code/action-first; omit boilerplate intros and recaps.',
          'Execute safe verification steps directly instead of pausing to ask trivial confirmations.',
          'Defer tangential refactoring ideas unless they block correctness.',
        ],
        silentAdaptationRule: SILENT_ADAPTATION_RULE,
      };

    case 'rapid_sprint':
      return {
        verbosity: 'ultra_concise',
        autonomy: 'proactive_execute',
        questionBudget: 0,
        deferNonCriticalInterruptions: true,
        headline: '高频冲刺配合：结论置顶、极简要点、小步快跑闭环',
        directives: [
          'Lead with the concrete outcome or diff summary in 1-3 tight bullets.',
          'Match the partner’s high-cadence iteration speed; batch reads/edits/checks in minimal turns.',
          'Avoid multi-option essays unless an irreversible trade-off blocks progress.',
        ],
        silentAdaptationRule: SILENT_ADAPTATION_RULE,
      };

    case 'stuck_debugging':
      return {
        verbosity: 'structured',
        autonomy: 'verify_first',
        questionBudget: dimensions.friction >= 72 ? 0 : 1,
        deferNonCriticalInterruptions: false,
        headline: '排障攻坚模式：停止盲猜重试，先钉死根因证据再落刀修复',
        directives: [
          'Stop repeating similar speculative fixes; isolate the exact root cause with file:line and command output first.',
          'Verify fixes with real tests/commands before claiming completion.',
          'If requirements are ambiguous after an interruption, ask at most one crisp disambiguating question.',
        ],
        silentAdaptationRule: SILENT_ADAPTATION_RULE,
      };

    case 'exploring':
      return {
        verbosity: 'thorough',
        autonomy: 'collaborative_options',
        questionBudget: 2,
        deferNonCriticalInterruptions: false,
        headline: '探索发散共创：呈现关键权衡、边界影响与推荐方案',
        directives: [
          'Lay out clear trade-offs, architectural boundaries, and a recommended default option.',
          'Surface hidden edge cases early before committing to large implementation diffs.',
          'Up to 2 focused alignment questions are welcome when design branches diverge.',
        ],
        silentAdaptationRule: SILENT_ADAPTATION_RULE,
      };

    case 'away_resting':
      return {
        verbosity: 'handoff_summary',
        autonomy: 'safe_autonomous',
        questionBudget: 0,
        deferNonCriticalInterruptions: true,
        headline: '离线静默收尾：护栏内完成当前检查，留存清晰归来交接摘要',
        directives: [
          'Partner is away or screen-locked: never block on interactive questions unless safety requires stopping.',
          'Finish safe read/test/verification work cleanly and leave a scannable handoff summary for their return.',
        ],
        silentAdaptationRule: SILENT_ADAPTATION_RULE,
      };

    default:
      return {
        verbosity: 'balanced',
        autonomy: 'balanced',
        questionBudget: 1,
        deferNonCriticalInterruptions: false,
        headline: '平稳默契协作：结论清晰、验证闭环、有疑直问',
        directives: [
          'Maintain a clear, direct engineering collaboration style with verified results.',
          'Ask a single targeted question only when intent or risk boundaries are genuinely unclear.',
        ],
        silentAdaptationRule: SILENT_ADAPTATION_RULE,
      };
  }
}

const FRICTION_WEIGHTS: Record<TomFrictionKind, number> = {
  user_interrupt: 35,
  turn_aborted: 28,
  turn_error: 22,
  command_failed: 20,
};

const RELIEF_WEIGHTS: Record<TomReliefKind, number> = {
  turn_completed: 16,
  command_succeeded: 7,
};

const FRICTION_HALF_LIFE_MS = 360_000; // 6 minutes
const AWAY_IDLE_THRESHOLD_MS = 15 * 60_000; // 15 minutes

export function evaluatePartnerState(input: TomEvaluationInput): TomEvaluationResult {
  const { now, baseline, calibrationBiases, calibrationCount, manualOverride } = input;
  const baselineSummary = summarizeBaseline(baseline, calibrationCount);

  if (!input.enabled || input.sensePaused) {
    const dimensions: PartnerDimensions = { focus: 50, friction: 0, pace: 50, presence: 50 };
    const guidance = buildTactGuidance('steady_flow', dimensions);
    const reason = !input.enabled
      ? '搭档状态感知已手动关闭，保持默认均衡协作策略。'
      : '全局感知已暂停，心智状态推断已冻结。';
    return {
      state: 'steady_flow',
      inferredState: 'steady_flow',
      source: 'paused',
      confidence: 0.5,
      dimensions,
      guidance,
      reasons: [reason],
      baselineSummary,
      driveReading: {
        key: 'social_tact',
        label: '搭档协作默契',
        satisfaction: 100,
        summary: reason,
        autoMaintain: false,
        evidence: {
          partnerState: 'steady_flow',
          source: 'paused',
          friction: 0,
          focus: 50,
        },
      },
      driveZone: 'comfortable',
      nextAnchor: input.previousInferred ?? { state: 'steady_flow', enteredAt: now },
    };
  }

  // 1. Presence dimension (0..100)
  const lastPromptAt = input.prompts.at(-1)?.at;
  const lastSwitchAt = input.appSwitches.at(-1)?.at;
  const lastApprovalAt = input.approvals.at(-1)?.at;
  const activityTimestamps = [lastPromptAt, lastSwitchAt, lastApprovalAt, input.lastUnlockAt].filter(
    (v): v is number => typeof v === 'number' && Number.isFinite(v) && v <= now + 5_000,
  );
  const lastHumanAt = activityTimestamps.length > 0 ? Math.max(...activityTimestamps) : undefined;
  const idleMs = lastHumanAt !== undefined ? Math.max(0, now - lastHumanAt) : undefined;

  let presence: number;
  if (input.screenLocked || input.systemSleeping) {
    presence = 4;
  } else if (idleMs === undefined) {
    presence = input.hasActiveOrdinarySession ? 74 : 62;
  } else if (idleMs <= 60_000) {
    presence = 96;
  } else if (idleMs >= AWAY_IDLE_THRESHOLD_MS) {
    const overMs = idleMs - AWAY_IDLE_THRESHOLD_MS;
    presence = roundInt(18 * expDecay(overMs, 600_000));
  } else {
    const ratio = (idleMs - 60_000) / (AWAY_IDLE_THRESHOLD_MS - 60_000);
    presence = roundInt(96 - ratio * 76);
  }

  // 2. Friction dimension (0..100)
  let rawFriction = 0;
  let recentInterrupts = 0;
  let recentFailures = 0;
  let earliestActiveFrictionAt = Number.POSITIVE_INFINITY;

  for (const f of input.frictions) {
    const age = now - f.at;
    if (age < -2_000 || age > 20 * 60_000) continue;
    const w = FRICTION_WEIGHTS[f.kind] * expDecay(Math.max(0, age), FRICTION_HALF_LIFE_MS);
    rawFriction += w;
    if (age <= 8 * 60_000) {
      earliestActiveFrictionAt = Math.min(earliestActiveFrictionAt, f.at);
      if (f.kind === 'user_interrupt' || f.kind === 'turn_aborted') recentInterrupts += 1;
      else recentFailures += 1;
    }
  }

  // Rapid terse follow-ups within 3 minutes amplify friction when paired with any recent trouble or >= 3 micro-bursts
  const prompts3m = input.prompts.filter((p) => now - p.at <= 180_000);
  const terseBurstCount = prompts3m.filter(
    (p) => p.interMessageMs !== undefined && p.interMessageMs < 22_000 && p.charCount <= 48,
  ).length;
  if (terseBurstCount >= 2 && (recentInterrupts + recentFailures > 0 || terseBurstCount >= 3)) {
    rawFriction += Math.min(20, terseBurstCount * 7);
  }

  // Dev <-> Browser rapid ping-pong during active errors
  const switches3m = input.appSwitches.filter((s) => now - s.at <= 180_000);
  let devBrowserBounce = 0;
  for (let i = 1; i < switches3m.length; i += 1) {
    const a = switches3m[i - 1]?.category;
    const b = switches3m[i]?.category;
    if ((a === 'dev' && b === 'browser') || (a === 'browser' && b === 'dev')) {
      devBrowserBounce += 1;
    }
  }
  if (devBrowserBounce >= 4 && recentInterrupts + recentFailures > 0) {
    rawFriction += 10;
  }

  let reliefPoints = 0;
  if (rawFriction > 0 && Number.isFinite(earliestActiveFrictionAt)) {
    for (const r of input.reliefs) {
      if (r.at < earliestActiveFrictionAt) continue;
      const age = now - r.at;
      if (age < -2_000 || age > 15 * 60_000) continue;
      reliefPoints += RELIEF_WEIGHTS[r.kind] * expDecay(Math.max(0, age), FRICTION_HALF_LIFE_MS);
    }
  }
  const friction = roundInt(Math.max(0, rawFriction - reliefPoints));

  // 3. Pace dimension (0..100, normalized against individualized EWMA baseline)
  const prompts6m = input.prompts.filter((p) => now - p.at <= 360_000);
  let pace = 50;
  let cadenceRatio = 1;
  let brevityRatio = 1;
  let recentAvgGapMs: number | undefined;
  let recentAvgChars: number | undefined;

  if (prompts6m.length >= 1) {
    recentAvgChars = prompts6m.reduce((acc, p) => acc + p.charCount, 0) / prompts6m.length;
    brevityRatio = clamp(baseline.ewmaPromptChars / Math.max(12, recentAvgChars), 0.35, 3.2);
  }
  const recentGaps = prompts6m
    .map((p) => p.interMessageMs)
    .filter((g): g is number => g !== undefined && g >= 1_500 && g <= 600_000);

  if (recentGaps.length >= 1) {
    recentAvgGapMs = recentGaps.reduce((a, b) => a + b, 0) / recentGaps.length;
    cadenceRatio = clamp(baseline.ewmaInterMessageMs / Math.max(4_000, recentAvgGapMs), 0.3, 3.5);
  }

  if (prompts6m.length >= 2 && recentAvgGapMs !== undefined) {
    // Relative speed boost + gentle absolute fast-tempo recognition
    const relativeDelta = (cadenceRatio - 1) * 20 + (brevityRatio - 1) * 10;
    const absoluteFastBoost =
      recentAvgGapMs <= 18_000 && (recentAvgChars ?? 100) <= 55
        ? 16
        : recentAvgGapMs <= 30_000 && (recentAvgChars ?? 100) <= 75
          ? 8
          : 0;
    pace = 50 + relativeDelta + absoluteFastBoost;
  } else if (prompts6m.length === 1 && recentAvgChars !== undefined) {
    if (recentAvgChars > Math.max(260, baseline.ewmaPromptChars * 1.75)) {
      pace = 36;
    } else if (recentAvgChars <= 32) {
      pace = 58;
    }
  }

  const approvals6m = input.approvals.filter((a) => now - a.at <= 360_000);
  if (approvals6m.length > 0) {
    const avgAppMs = approvals6m.reduce((acc, a) => acc + a.latencyMs, 0) / approvals6m.length;
    if (avgAppMs <= Math.min(4_500, baseline.ewmaApprovalMs * 0.7)) {
      pace += 12;
    } else if (avgAppMs >= Math.max(25_000, baseline.ewmaApprovalMs * 1.8)) {
      pace -= 8;
    }
  }
  pace = roundInt(pace);

  // 4. Focus dimension (0..100)
  const switches5m = input.appSwitches.filter((s) => now - s.at <= 300_000);
  const distinctCategories5m = new Set(switches5m.map((s) => s.category));
  if (input.frontAppCategory) distinctCategories5m.add(input.frontAppCategory);

  let focus: number;
  if (presence <= 20) {
    focus = 10;
  } else {
    const inDev = input.frontAppCategory === 'dev';
    const switchCount = switches5m.length;
    const lowSwitchThreshold = Math.max(2, baseline.ewmaAppSwitchesPer5m * 0.75);
    const highSwitchThreshold = Math.max(7, baseline.ewmaAppSwitchesPer5m * 1.75);

    if (inDev && switchCount <= lowSwitchThreshold) {
      focus = 84 + (prompts6m.length > 0 ? 6 : 0);
    } else if (inDev && distinctCategories5m.size <= 1 && switchCount <= highSwitchThreshold) {
      focus = 78;
    } else if (switchCount >= highSwitchThreshold || distinctCategories5m.size >= 3) {
      focus = Math.max(24, 54 - (switchCount - lowSwitchThreshold) * 3.5 - (distinctCategories5m.size - 2) * 8);
    } else if (input.frontAppCategory === 'browser') {
      focus = 56;
    } else if (input.frontAppCategory === 'comm') {
      focus = 42;
    } else {
      focus = input.hasActiveOrdinarySession ? 64 : 58;
    }

    if (friction >= 48) {
      focus -= (friction - 45) * 0.42;
    }
    focus = roundInt(focus);
  }

  const dimensions: PartnerDimensions = { focus, friction, pace, presence };

  // 5. Score 6 candidate states (posterior-style scoring + calibration biases + anti-flicker hysteresis)
  let inferredState: PartnerStateKind;
  let inferredConfidence: number;

  if (presence <= 20) {
    inferredState = 'away_resting';
    inferredConfidence = input.screenLocked || input.systemSleeping ? 0.98 : 0.86;
  } else {
    const longExploratoryPrompt =
      recentAvgChars !== undefined && recentAvgChars >= Math.max(240, baseline.ewmaPromptChars * 1.65);
    const highCrossSwitching =
      switches5m.length >= Math.max(5, baseline.ewmaAppSwitchesPer5m * 1.4) ||
      (input.frontAppCategory === 'browser' && switches5m.length >= 3);

    const scores: Record<PartnerStateKind, number> = {
      away_resting: 0,
      steady_flow: 54 + (calibrationBiases.steady_flow ?? 0),
      stuck_debugging:
        (friction >= 48 ? 56 + (friction - 48) * 1.15 : friction * 0.75) +
        (recentInterrupts > 0 ? 8 : 0) +
        (calibrationBiases.stuck_debugging ?? 0),
      rapid_sprint:
        (pace >= 66 && friction < 48 ? 55 + (pace - 66) * 1.2 + Math.max(0, 42 - friction) * 0.15 : pace * 0.62) +
        (calibrationBiases.rapid_sprint ?? 0),
      deep_focus:
        (focus >= 72 && friction < 40 && pace < 70
          ? 55 + (focus - 72) * 1.25 + Math.max(0, 36 - friction) * 0.2
          : focus * 0.64) + (calibrationBiases.deep_focus ?? 0),
      exploring:
        ((longExploratoryPrompt || highCrossSwitching) && friction < 45 && focus < 72
          ? 56 + (longExploratoryPrompt ? 11 : 0) + (highCrossSwitching ? 9 : 0)
          : 26 + Math.max(0, 65 - focus) * 0.3) + (calibrationBiases.exploring ?? 0),
    };

    // Hysteresis: preserve previous inferred state unless an urgent interrupt/friction spike occurred
    const prev = input.previousInferred;
    if (prev && prev.state !== 'away_resting' && !(recentInterrupts > 0 && scores.stuck_debugging >= 60)) {
      const dwellMs = Math.max(0, now - prev.enteredAt);
      const inertiaBonus = dwellMs < 45_000 ? 9 : 5;
      scores[prev.state] += inertiaBonus;
    }

    const candidates = PARTNER_STATE_KINDS.filter((k) => k !== 'away_resting')
      .map((k) => ({ kind: k, score: scores[k] }))
      .sort((a, b) => b.score - a.score);

    const best = candidates[0] ?? { kind: 'steady_flow' as const, score: 54 };
    const runnerUp = candidates[1] ?? { kind: 'steady_flow' as const, score: 54 };
    inferredState = best.kind;
    const margin = Math.max(0, best.score - runnerUp.score);
    const signalRichness = Math.min(1, (prompts6m.length + switches5m.length * 0.5 + recentInterrupts * 2) / 6);
    inferredConfidence = Math.round(clamp(0.58 + margin * 0.014 + signalRichness * 0.12, 0.56, 0.96) * 100) / 100;
  }

  const nextAnchor: TomHysteresisAnchor =
    input.previousInferred?.state === inferredState ? input.previousInferred : { state: inferredState, enteredAt: now };

  // 6. Apply active manual override if unexpired
  const activeOverride =
    manualOverride && Number.isFinite(manualOverride.expiresAt) && now < manualOverride.expiresAt
      ? manualOverride
      : null;

  const effectiveState: PartnerStateKind = activeOverride ? activeOverride.state : inferredState;
  const source: PartnerStateSource = activeOverride ? 'manual_override' : 'inferred';
  const confidence = activeOverride ? 1 : inferredConfidence;
  const guidance = buildTactGuidance(effectiveState, dimensions);

  // 7. Build human-readable, privacy-safe explainable reasons
  const reasons: string[] = [];
  if (activeOverride) {
    const remainMins = Math.max(1, Math.ceil((activeOverride.expiresAt - now) / 60_000));
    reasons.push(
      `已手动锁定为「${PARTNER_STATE_LABELS[activeOverride.state]}」（剩余 ${remainMins} 分钟自动恢复推断）。`,
    );
  }
  if (input.screenLocked || input.systemSleeping) {
    reasons.push('检测到本机锁屏或休眠，自动转入免打扰与归来交接摘要姿态。');
  } else if (presence <= 20 && idleMs !== undefined) {
    reasons.push(`会话与前台窗口已静默 ${Math.floor(idleMs / 60_000)} 分钟，判定为暂时离开休息。`);
  }
  if (recentInterrupts > 0 || recentFailures > 0) {
    const parts: string[] = [];
    if (recentInterrupts > 0) parts.push(`${recentInterrupts} 次主动打断/中止`);
    if (recentFailures > 0) parts.push(`${recentFailures} 次命令/回合报错`);
    reasons.push(`近期出现 ${parts.join(' 与 ')}（摩擦度 ${friction}%），优先收敛根因与实测验证。`);
  }
  if (effectiveState === 'rapid_sprint' && recentAvgGapMs !== undefined) {
    reasons.push(
      `近期平均发信间隔 ${Math.max(1, Math.round(recentAvgGapMs / 1_000))}s（个人基线 ${baselineSummary.avgCadenceSec}s），处于快节奏迭代收敛。`,
    );
  } else if (effectiveState === 'deep_focus') {
    reasons.push(`持续驻留开发环境且应用切换低熵（专注度 ${focus}%），自动收紧追问与冗余解释。`);
  } else if (effectiveState === 'exploring') {
    reasons.push('检测到跨文档/窗口调研或长上下文探讨，开放方案对比与设计边界对齐。');
  }
  if (reasons.length === 0) {
    reasons.push(
      `交互节奏与环境信号平稳（个人基线 ${baselineSummary.avgCadenceSec}s/条 · 约 ${baselineSummary.avgPromptChars} 字）。`,
    );
  }

  // 8. Map to Maslow Tier-3 silent drive (`autoMaintain: false`, bounded >= 26 so never triggers false L1-like critical panic)
  const driveSatisfaction = roundInt(clamp(95 - friction * 0.76, 26, 96));
  const driveZone: NeedZone = driveSatisfaction < 60 ? 'uncomfortable' : 'comfortable';
  const stateLabel = PARTNER_STATE_LABELS[effectiveState];
  const driveSummary = `${stateLabel}（专注 ${focus}% · 摩擦 ${friction}% · 节奏 ${pace}%）— ${guidance.headline}`;

  return {
    state: effectiveState,
    inferredState,
    source,
    confidence,
    dimensions,
    guidance,
    reasons: reasons.slice(0, 4),
    baselineSummary,
    driveReading: {
      key: 'social_tact',
      label: '搭档协作默契',
      satisfaction: driveSatisfaction,
      summary: driveSummary,
      autoMaintain: false,
      evidence: {
        partnerState: effectiveState,
        source,
        confidence,
        focus,
        friction,
        pace,
        presence,
        deferInterruptions: guidance.deferNonCriticalInterruptions,
      },
    },
    driveZone,
    nextAnchor,
  };
}
