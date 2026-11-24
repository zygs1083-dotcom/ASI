/**
 * Tier 3: On-Demand Crying for Help (`<asi-cry>`).
 * - Formats concise, credential-redacted `<asi-cry>` notifications for the
 *   active foreground user conversation ONLY when self-rescue fails or hits a
 *   physical/permission/connectivity boundary.
 * - Deduplicates strictly once per distress episode per `NeedKey` until that
 *   need recovers to `comfortable` (`driveActive === false`).
 */

import { type HelpCard, type ModelConnectivity, sanitizeForModel } from '@asi/sense-types';
import { NEED_LABELS } from './evaluator.js';

export type CryDeliveryMode = 'wakeup' | 'parked-offline';

function escapeAttr(value: string): string {
  return value.replace(/[&"<>\r\n]/g, ' ').trim();
}

export function formatCryMessage(card: HelpCard): string {
  const safeTitle = String(sanitizeForModel(card.title)).trim();
  const safeSummary = String(sanitizeForModel(card.summary)).trim();
  const safeAction = card.proposedAction ? String(sanitizeForModel(card.proposedAction)).trim() : '';
  const needAttr = card.need ?? card.driveKey ?? 'drive';
  const needLabel = card.need ? NEED_LABELS[card.need] : (card.driveLabel ?? card.driveKey ?? '高阶看护');

  const lines = [
    `<asi-cry need="${escapeAttr(needAttr)}" severity="${escapeAttr(card.severity)}" card="${escapeAttr(card.id)}">`,
    `【生存求助 · ${needLabel}】${safeTitle}`,
    safeSummary,
    ...(safeAction ? [`建议操作：${safeAction}`] : []),
    '（详细体征与一键处理见左侧「ASI 稳态」面板；此消息仅在危急或自救受阻时发送一次。）',
    '</asi-cry>',
  ];
  return lines.join('\n');
}

export function chooseCryDeliveryMode(connectivity: ModelConnectivity): CryDeliveryMode {
  return connectivity === 'offline' ? 'parked-offline' : 'wakeup';
}
