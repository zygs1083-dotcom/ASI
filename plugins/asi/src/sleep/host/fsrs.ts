/**
 * FSRS Spaced-Repetition Retention, Recall Strengthening, and Forgetting Decay Model.
 *
 * Open-Source MIT Attribution:
 * - Powered by `open-spaced-repetition/ts-fsrs` (MIT License, Copyright (c) Open Spaced Repetition).
 */

import {
  type Card,
  createEmptyCard,
  FSRS5_DEFAULT_DECAY,
  forgetting_curve,
  fsrs,
  generatorParameters,
  Rating,
  type State,
} from 'ts-fsrs';
import type { FsrsCardState, MemoryKind } from '../shared/types.js';

const MS_PER_DAY = 86_400_000;
const MAX_STABILITY_DAYS = 3_650;

const params = generatorParameters({
  request_retention: 0.9,
  maximum_interval: MAX_STABILITY_DAYS,
  enable_fuzz: false,
  enable_short_term: false,
});

const scheduler = fsrs(params);

/** Unpinned memories below these FSRS retrievability thresholds are pruned during REM sleep. */
export const PRUNE_RETENTION_THRESHOLDS: Record<MemoryKind, number> = {
  preference: 0.12,
  decision: 0.12,
  pitfall: 0.12,
  episode: 0.22,
};

function fromCard(card: Card, fallbackReviewMs: number): FsrsCardState {
  const lastReview = card.last_review instanceof Date ? card.last_review.getTime() : fallbackReviewMs;
  return {
    stability: Number(Math.max(0.1, Math.min(MAX_STABILITY_DAYS, card.stability)).toFixed(4)),
    difficulty: Number(Math.max(1, Math.min(10, card.difficulty)).toFixed(4)),
    elapsedDays: card.elapsed_days,
    scheduledDays: card.scheduled_days,
    learningSteps: card.learning_steps,
    reps: card.reps,
    lapses: card.lapses,
    state: Number(card.state),
    due: card.due.getTime(),
    lastReview,
  };
}

function toCard(state: FsrsCardState): Card {
  return {
    due: new Date(state.due),
    stability: Math.max(0.1, state.stability),
    difficulty: Math.max(1, Math.min(10, state.difficulty)),
    elapsed_days: Math.max(0, state.elapsedDays),
    scheduled_days: Math.max(0, state.scheduledDays),
    learning_steps: Math.max(0, state.learningSteps),
    reps: Math.max(0, state.reps),
    lapses: Math.max(0, state.lapses),
    state: state.state as State,
    last_review: new Date(state.lastReview),
  };
}

export function createInitialFsrsState(kind: MemoryKind, now: number): FsrsCardState {
  const empty = createEmptyCard(new Date(now));
  const initialGrade = kind === 'episode' ? Rating.Hard : Rating.Good;
  const scheduled = scheduler.next(empty, new Date(now), initialGrade).card;
  const tunedStability = kind === 'episode' ? Math.min(scheduled.stability, 2.2) : Math.max(scheduled.stability, 4.5);
  return {
    ...fromCard(scheduled, now),
    stability: Number(tunedStability.toFixed(4)),
    due: Math.round(now + tunedStability * MS_PER_DAY),
  };
}

/**
 * Computes continuous FSRS power-law retrievability in `[0, 1]`.
 * Pinned items ALWAYS lock at `1.0` (`100%`) and never decay.
 */
export function computeMemoryRetention(state: FsrsCardState, pinned: boolean, now: number): number {
  if (pinned) return 1;
  if (!Number.isFinite(now) || now <= state.lastReview) return 1;
  const elapsedDays = Math.max(0, (now - state.lastReview) / MS_PER_DAY);
  const stability = Math.max(0.1, state.stability);
  const raw = forgetting_curve(FSRS5_DEFAULT_DECAY, elapsedDays, stability);
  if (!Number.isFinite(raw)) return 1;
  return Number(Math.max(0, Math.min(1, raw)).toFixed(4));
}

/**
 * Strengthens an FSRS memory trace when hit by `memory_recall` or reinforced during REM consolidation.
 */
export function strengthenFsrsState(
  state: FsrsCardState,
  now: number,
  grade: 'recall' | 'consolidate' = 'recall',
): FsrsCardState {
  const effectiveNow = Math.max(now, state.lastReview);
  const rating = grade === 'consolidate' ? Rating.Easy : Rating.Good;
  const nextCard = scheduler.next(toCard(state), new Date(effectiveNow), rating).card;
  const minBoostFactor = grade === 'consolidate' ? 1.25 : 1.15;
  const boostedStability = Math.min(MAX_STABILITY_DAYS, Math.max(nextCard.stability, state.stability * minBoostFactor));
  return {
    ...fromCard(nextCard, effectiveNow),
    stability: Number(boostedStability.toFixed(4)),
    lastReview: effectiveNow,
    due: Math.round(effectiveNow + boostedStability * MS_PER_DAY),
  };
}

export function shouldPruneMemory(state: FsrsCardState, kind: MemoryKind, pinned: boolean, now: number): boolean {
  if (pinned) return false;
  const retention = computeMemoryRetention(state, false, now);
  return retention < PRUNE_RETENTION_THRESHOLDS[kind];
}
