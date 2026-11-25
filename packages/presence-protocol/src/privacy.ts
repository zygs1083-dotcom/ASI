import { z } from 'zod';
import { SystemOneDecisionSchema } from './jev.ts';

export const PrivacyStateSchema = z.object({
  microphoneEnabled: z.boolean().default(false),
  screenVisionEnabled: z.boolean().default(false),
  cameraEnabled: z.boolean().default(false),
  physicalKillSwitch: z.boolean().default(false),
  activeCapture: z
    .object({
      mic: z.boolean().default(false),
      screen: z.boolean().default(false),
      camera: z.boolean().default(false),
    })
    .default({ mic: false, screen: false, camera: false }),
});
export type PrivacyState = z.infer<typeof PrivacyStateSchema>;

export function createDefaultPrivacyState(): PrivacyState {
  return {
    microphoneEnabled: false,
    screenVisionEnabled: false,
    cameraEnabled: false,
    physicalKillSwitch: false,
    activeCapture: {
      mic: false,
      screen: false,
      camera: false,
    },
  };
}

export const DelegationProposalSchema = z.object({
  id: z.string(),
  summary: z.string(),
  suggestedPrompt: z.string(),
  workspaceHint: z.string().optional(),
  status: z.enum(['pending_confirmation', 'dispatched', 'dismissed']),
  createdAt: z.number(),
});
export type DelegationProposal = z.infer<typeof DelegationProposalSchema>;

export const ConversationMessageSchema = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant', 'system']),
  text: z.string(),
  createdAt: z.number(),
  streaming: z.boolean().optional(),
  interrupted: z.boolean().optional(),
  decision: SystemOneDecisionSchema.optional(),
  recalledMemoriesCount: z.number().int().nonnegative().optional(),
  delegationProposal: DelegationProposalSchema.optional(),
});
export type ConversationMessage = z.infer<typeof ConversationMessageSchema>;
