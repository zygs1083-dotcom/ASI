import { makeScenario } from '@asi/sense-ui';
import { makeGrowthScenario } from '../growth/mock-scenarios.ts';
import type { AsiPanelModel } from '../host/dsh/wire-types.ts';
import { makeIntuitionScenario } from '../intuition/mock-scenarios.ts';
import { makeSleepScenario } from '../sleep/mock-scenarios.ts';

export const ASI_UNIFIED_SCENARIOS = [
  'homeostasis-healthy',
  'pending-approvals',
  'critical-suppressed',
  'empty-clean',
] as const;

export type AsiUnifiedScenarioName = (typeof ASI_UNIFIED_SCENARIOS)[number];

export function makeUnifiedScenario(name: AsiUnifiedScenarioName): AsiPanelModel {
  if (name === 'pending-approvals') {
    const needs = makeScenario('external-cache-arbitration');
    needs.state.self.permissions = {
      ...needs.state.self.permissions,
      value: { 辅助功能: 'denied' },
    };
    const sleep = makeSleepScenario('sleepy-waiting');
    const growth = makeGrowthScenario('deep-quiet-waiting');
    const intuition = makeIntuitionScenario('intuition-surfaced');
    return { needs, sleep, growth, intuition };
  }

  if (name === 'critical-suppressed') {
    const needs = makeScenario('low-energy');
    const sleep = makeSleepScenario('suppressed-l1');
    const growth = makeGrowthScenario('suppressed-lower-tier');
    const intuition = makeIntuitionScenario('intuition-suppressed');
    return { needs, sleep, growth, intuition };
  }

  if (name === 'empty-clean') {
    const needs = makeScenario('healthy');
    needs.helpCards = [];
    needs.recentMaintenance = [];
    needs.actionLedger = [];
    const sleep = makeSleepScenario('empty-vault');
    const growth = makeGrowthScenario('empty-workshop');
    const intuition = makeIntuitionScenario('intuition-empty');
    return { needs, sleep, growth, intuition };
  }

  const needs = makeScenario('healthy');
  const sleep = makeSleepScenario('healthy-vault');
  const growth = makeGrowthScenario('workshop-ready');
  growth.drafts = [];
  growth.draftCount = 0;
  const intuition = makeIntuitionScenario('intuition-healthy');
  return { needs, sleep, growth, intuition };
}
