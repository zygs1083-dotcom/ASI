import { z } from 'zod';
import { PresenceEmotionSchema } from './avatar.ts';

/** Native TypeSafe AI System One (`POST /v1/systemone`) question primitives. */
export const JevNoulQuestionSchema = z.object({
  type: z.literal('noul'),
  instructions: z.string().min(1),
});

export const JevChoiceQuestionSchema = z.object({
  type: z.literal('choice'),
  instructions: z.string().min(1),
  criteria: z.record(z.string().min(1), z.string().min(1)),
});

export const JevScoreQuestionSchema = z.object({
  type: z.literal('score'),
  instructions: z.string().min(1),
  criteria: z.union([z.array(z.string().min(1)).min(2).max(10), z.record(z.string(), z.string())]),
});

export const JevBoxQuestionSchema = z.object({
  type: z.literal('box'),
  instructions: z.string().min(1),
});

export const JevQuestionSchema = z.discriminatedUnion('type', [
  JevNoulQuestionSchema,
  JevChoiceQuestionSchema,
  JevScoreQuestionSchema,
  JevBoxQuestionSchema,
]);
export type JevQuestion = z.infer<typeof JevQuestionSchema>;

export const JevRequestSchema = z.object({
  model: z.string().min(1).default('jev-latest'),
  state: z.union([z.string(), z.record(z.string(), z.unknown())]),
  questions: z.record(z.string().min(1), JevQuestionSchema),
});
export type JevRequest = z.infer<typeof JevRequestSchema>;

export const JevNormalizedBoxSchema = z.object({
  top: z.number().min(0).max(1),
  bottom: z.number().min(0).max(1),
  left: z.number().min(0).max(1),
  right: z.number().min(0).max(1),
});
export type JevNormalizedBox = z.infer<typeof JevNormalizedBoxSchema>;

export const JevAnswerSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('noul'),
    noul: z.number().min(0).max(1),
  }),
  z.object({
    type: z.literal('choice'),
    choice: z.string(),
    probabilities: z.record(z.string(), z.number().min(0).max(1)).optional(),
    confidence: z.number().min(0).max(1).optional(),
  }),
  z.object({
    type: z.literal('score'),
    score: z.number(),
    probabilities: z.record(z.string(), z.number().min(0).max(1)).optional(),
    confidence: z.number().min(0).max(1).optional(),
  }),
  z.object({
    type: z.literal('box'),
    box: JevNormalizedBoxSchema.optional(),
    top: z.number().min(0).max(1).optional(),
    bottom: z.number().min(0).max(1).optional(),
    left: z.number().min(0).max(1).optional(),
    right: z.number().min(0).max(1).optional(),
    confidence: z.number().min(0).max(1).optional(),
  }),
]);
export type JevAnswer = z.infer<typeof JevAnswerSchema>;

export const JevResponseSchema = z.object({
  model: z.string().optional(),
  answers: z.record(z.string(), JevAnswerSchema),
  usage: z
    .object({
      input_tokens: z.number().nonnegative().optional(),
      output_tokens: z.number().nonnegative().optional(),
    })
    .optional(),
});
export type JevResponse = z.infer<typeof JevResponseSchema>;

export const SYSTEM_ONE_ROUTES = ['fast_reply', 'recall_memory', 'inspect_screen', 'delegate_dsh'] as const;
export const SystemOneRouteSchema = z.enum(SYSTEM_ONE_ROUTES);
export type SystemOneRoute = z.infer<typeof SystemOneRouteSchema>;

export const SYSTEM_ONE_BACKENDS = ['typesafe-jev', 'magpie-fallback', 'heuristic-fallback'] as const;
export const SystemOneBackendSchema = z.enum(SYSTEM_ONE_BACKENDS);
export type SystemOneBackend = z.infer<typeof SystemOneBackendSchema>;

export const SystemOneDecisionSchema = z.object({
  route: SystemOneRouteSchema,
  routeConfidence: z.number().min(0).max(1),
  emotion: PresenceEmotionSchema,
  /** 0..100 kinetic energy / enthusiasm level modulating avatar brightness & voice cadence. */
  energy: z.number().min(0).max(100),
  /** Probability [0, 1] that the companion should proactively elaborate or offer a gentle follow-up. */
  initiative: z.number().min(0).max(1),
  needMemory: z.boolean(),
  needScreen: z.boolean(),
  needDshDelegation: z.boolean(),
  memoryQuery: z.string().optional(),
  focusBox: JevNormalizedBoxSchema.optional(),
  backend: SystemOneBackendSchema,
  latencyMs: z.number().nonnegative(),
  reason: z.string().optional(),
});
export type SystemOneDecision = z.infer<typeof SystemOneDecisionSchema>;
