import { buildTactGuidance } from './host/evaluator.ts';
import type { PartnerDimensions, PartnerStateKind, TomPanelModel } from './shared/types.ts';

export type TomScenarioName = 'deep-focus' | 'stuck-debugging' | 'suppressed-sprint' | 'steady-clean';

export function makeTomScenario(name: TomScenarioName, now = 1_764_000_000_000): TomPanelModel {
  const make = (
    state: PartnerStateKind,
    dimensions: PartnerDimensions,
    confidence: number,
    reasons: string[],
    opts?: {
      suppressed?: boolean;
      sampleCount?: number;
      calibrationCount?: number;
    },
  ): TomPanelModel => {
    const driveSatisfaction = Math.round(Math.min(96, Math.max(26, 95 - dimensions.friction * 0.76)));
    return {
      now,
      enabled: true,
      sensePaused: false,
      state,
      source: 'inferred',
      confidence,
      dimensions,
      guidance: buildTactGuidance(state, dimensions),
      reasons,
      manualOverride: null,
      baseline: {
        sampleCount: opts?.sampleCount ?? 24,
        avgCadenceSec: 58,
        avgPromptChars: 126,
        avgSwitchesPer5m: 3.5,
        calibrationCount: opts?.calibrationCount ?? 1,
      },
      driveSatisfaction,
      driveZone: driveSatisfaction < 60 ? 'uncomfortable' : 'comfortable',
      suppressed: Boolean(opts?.suppressed),
    };
  };

  if (name === 'stuck-debugging') {
    return make(
      'stuck_debugging',
      { focus: 56, friction: 68, pace: 64, presence: 94 },
      0.88,
      [
        '近期出现 1 次主动打断回复与 2 次命令非零退出（摩擦度 68%），优先收敛根因与实测验证。',
        '已自动收紧澄清问题预算（<= 1），先给可复现证据链再落刀修改。',
      ],
      { sampleCount: 32, calibrationCount: 2 },
    );
  }

  if (name === 'suppressed-sprint') {
    return make(
      'rapid_sprint',
      { focus: 74, friction: 18, pace: 82, presence: 92 },
      0.84,
      ['近期平均发信间隔 16s（个人基线 58s），处于快节奏迭代收敛。'],
      { suppressed: true, sampleCount: 19, calibrationCount: 1 },
    );
  }

  if (name === 'steady-clean') {
    return make(
      'steady_flow',
      { focus: 66, friction: 0, pace: 50, presence: 80 },
      0.64,
      ['交互节奏与环境信号平稳（个人基线 58s/条 · 约 126 字）。'],
      { sampleCount: 0, calibrationCount: 0 },
    );
  }

  return make(
    'deep_focus',
    { focus: 88, friction: 8, pace: 54, presence: 95 },
    0.89,
    [
      '持续驻留开发环境且应用切换低熵（专注度 88%），自动收紧追问与冗余解释。',
      '非紧急主动打扰已自动避让，代码与验证结论先行。',
    ],
    { sampleCount: 28, calibrationCount: 1 },
  );
}
