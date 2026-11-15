import { describe, expect, it } from 'vitest';
import { cpuWithinBudget, REQUIRED_OK, smokeProgressOk } from '../scripts/smoke-check.js';

describe('smoke acceptance', () => {
  it('requires at least 90% of expected samples', () => {
    const ok = new Set(REQUIRED_OK);
    expect(smokeProgressOk(0, ok, 30)).toBe(false);
    expect(smokeProgressOk(26, ok, 30)).toBe(false);
    expect(smokeProgressOk(27, ok, 30)).toBe(true);
    expect(smokeProgressOk(30, ok, 30)).toBe(true);
  });

  it.each(REQUIRED_OK)('rejects a run without an ok %s fact', (missing) => {
    expect(smokeProgressOk(30, new Set(REQUIRED_OK.filter((key) => key !== missing)), 30)).toBe(false);
  });

  it('includes both user and child-inclusive system CPU in the inclusive 0.6% budget', () => {
    expect(cpuWithinBudget(0.18, 0.18, 60)).toBe(true);
    expect(cpuWithinBudget(0.181, 0.18, 60)).toBe(false);
    expect(cpuWithinBudget(0, 0, 0)).toBe(false);
    expect(cpuWithinBudget(Number.NaN, 0, 60)).toBe(false);
  });
});
