/**
 * Tail-Only Prompt-Cache-Safe `<asi-intuition>` Message Formatter (`message-format.ts`).
 *
 * - Never touches `systemPrompt` or historical messages; always appended at the
 *   conversation tail (`pre-step` admitted batch, `next-turn` inbox, or `inject`).
 * - Applies `sanitizeForModel` across every title, instruction, and caution.
 */

import { sanitizeForModel } from '@asi/sense-types';
import type { FlashbackMatch, ProspectiveIntention } from '../shared/types.js';

function escapeXmlAttr(raw: string): string {
  return raw.replace(/[&"<>\r\n]/g, ' ').trim();
}

function truncateClean(text: string, maxChars: number): string {
  const clean = sanitizeForModel(text).replace(/\s+/g, ' ').trim();
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, maxChars - 1)}…`;
}

const SOURCE_KIND_TAG: Record<FlashbackMatch['sourceKind'], string> = {
  pitfall: '历史踩坑',
  decision: '关键决策',
  preference: '用户偏好',
  episode: '近期轨迹',
  scar: '本轮重复报错疤痕',
};

export interface IntuitionMessagePayload {
  intentions?: readonly ProspectiveIntention[];
  flashbacks?: readonly FlashbackMatch[];
}

export function formatIntuitionMessage(payload: IntuitionMessagePayload): string | null {
  const intentions = payload.intentions ?? [];
  const flashbacks = payload.flashbacks ?? [];
  if (intentions.length === 0 && flashbacks.length === 0) return null;

  const mode =
    intentions.length > 0 && flashbacks.length > 0 ? 'combined' : intentions.length > 0 ? 'prospective' : 'flashback';

  const ids = [...intentions.map((i) => i.id), ...flashbacks.map((f) => f.sourceId)]
    .slice(0, 6)
    .map(escapeXmlAttr)
    .join(',');

  const lines: string[] = [`<asi-intuition mode="${mode}" refs="${ids}">`];

  if (intentions.length > 0) {
    lines.push('【前额叶前瞻记忆触发（Prospective Memory）】');
    for (const item of intentions.slice(0, 4)) {
      const prio = item.priority === 'high' ? ' [高优]' : '';
      const title = truncateClean(item.title, 100);
      const instr = truncateClean(item.instruction, 220);
      const trig = truncateClean(item.triggerSummary, 90);
      lines.push(`- (${escapeXmlAttr(item.id)})${prio} ${title}（${trig}）：${instr}`);
    }
    lines.push('（处理完毕后可调用 prospective_resolve 将对应 id 标记为 fulfill，或 snooze 延后。）');
  }

  if (flashbacks.length > 0) {
    lines.push('【前额叶直觉闪回预警（Gut-Feeling Somatic Marker）】');
    for (const fb of flashbacks.slice(0, 2)) {
      const kindLabel = SOURCE_KIND_TAG[fb.sourceKind];
      const pct = Math.round(fb.score * 100);
      const title = truncateClean(fb.title, 100);
      const caution = truncateClean(fb.caution, 220);
      const cues = fb.matchedCues.map((c) => truncateClean(c, 32)).join(', ');
      lines.push(`- [${kindLabel} · 置信 ${pct}% · 线索: ${cues}] ${title} —— ${caution}`);
    }
    lines.push('（此提示由本地躯体标记按需尾部挂载，执行前请留意避开上述已知陷阱。）');
  }

  lines.push('</asi-intuition>');
  return lines.join('\n');
}
