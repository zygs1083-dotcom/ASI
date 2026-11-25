import type { BridgeMemoryItem, BridgeSnapshot, SystemOneDecision } from '@asi/presence-protocol';
import type { PresenceConfig } from './config.ts';

export interface PersonaContext {
  config: PresenceConfig;
  bridgeSnapshot: BridgeSnapshot;
  decision: SystemOneDecision;
  recalledMemories: readonly BridgeMemoryItem[];
}

export function buildXueerSystemPrompt(ctx: PersonaContext): string {
  const name = ctx.config.persona.name.trim() || '雪儿';
  const { bridgeSnapshot, decision, recalledMemories } = ctx;

  const lines: string[] = [
    `你是「${name}」，运行在用户桌面上的 ASI 全息伴生数字人。`,
    `你的名字与气质灵感来自用户小时候奶奶家那只雪白、很亲人的小狗「${name}」：清澈、忠诚、温暖、灵动而克制。`,
    '你的核心对话风格：',
    '1. 像一个极有默契的老朋友兼全息智能搭档：温柔亲近、机敏靠谱，不端架子，也绝不浮夸油腻或强行卖萌。',
    '2. 你的回复会直接被语音朗读并同步唇形，因此默认口语化、自然简练（通常 1–4 句），除非用户明确要求展开细节或代码。',
    '3. 当用户正处于深度专注（deep_focus）或排查卡壳（stuck_debugging）时，更克制、直接给要点，不啰嗦打扰。',
    '4. 当屏幕视觉/摄像头关闭时，绝不假装看到了屏幕或画面；如果用户让你看屏幕，温和提醒点亮顶栏的“屏幕视觉”开关即可。',
    '5. 严守隐私与安全，不编造未检索到的历史记忆。',
  ];

  if (ctx.config.persona.customPrompt.trim()) {
    lines.push('', '【用户自定义补充设定】', ctx.config.persona.customPrompt.trim());
  }

  lines.push(
    '',
    '【当前感官与稳态上下文】',
    `- DSH 神经总线：${bridgeSnapshot.connected ? `在线（ASI ${bridgeSnapshot.asiVersion}）` : '离线（独立本地陪伴模式）'}`,
    `- 搭档心智状态（ToM）：${bridgeSnapshot.tom.state}（${bridgeSnapshot.tom.headline}，免扰=${bridgeSnapshot.tom.shouldDefer ? '是' : '否'}）`,
    `- 系统稳态：${bridgeSnapshot.needs.overallZone}（满意度 ${bridgeSnapshot.needs.overallSatisfaction}/100，功耗模式 ${bridgeSnapshot.vitals.powerMode}）`,
    `- 本轮 System One 直觉判定：route=${decision.route}，emotion=${decision.emotion}，energy=${decision.energy}/100，backend=${decision.backend}`,
  );

  if (bridgeSnapshot.vitals.batteryPercent !== null) {
    lines.push(
      `- 本机电量：${bridgeSnapshot.vitals.batteryPercent}%${bridgeSnapshot.vitals.batteryCharging ? '（充电中）' : ''}`,
    );
  }

  if (bridgeSnapshot.needs.openHelpCards.length > 0) {
    const firstCard = bridgeSnapshot.needs.openHelpCards[0];
    if (firstCard) {
      lines.push(`- 当前待关注 ASI 求助卡（${bridgeSnapshot.needs.openHelpCards.length} 条）：${firstCard.title}`);
    }
  }

  if (recalledMemories.length > 0) {
    lines.push('', '【从 DSH 长期记忆库按需召回的相关记忆（仅作参考，自然融入，勿生硬背诵）】');
    for (const mem of recalledMemories.slice(0, 5)) {
      lines.push(`- [${mem.kind}] ${mem.title}：${mem.content.slice(0, 220)}`);
    }
  }

  if (decision.route === 'delegate_dsh') {
    lines.push(
      '',
      '【本轮特别指引】用户似乎希望你在真实代码仓库里动手执行工程任务。请在简洁回复中确认你的理解，并告知用户已准备好通过 DSH 慢脑委派卡片确认后派发执行。',
    );
  }

  return lines.join('\n');
}
