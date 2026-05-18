/**
 * Track 14: the `plan_artifact` RolloutItem variant is persisted (durability
 * + Track 15 rewind anchor) and recognized by its type guard.
 */

import { describe, it, expect } from 'vitest';
import { isPersistedRolloutItem } from '@/storage/rollout/policy';
import { isPlanArtifactItem } from '@/storage/rollout/types';
import type { RolloutItem } from '@/storage/rollout/types';

const planArtifact: RolloutItem = {
  type: 'plan_artifact',
  payload: {
    planId: 'plan_s_1',
    sessionId: 's',
    turnId: 't',
    createdAt: 1,
    status: 'approved',
    plan: { summary: 'do the thing', steps: [{ description: 'click', mutating: true }] },
    prePlanSequence: 0,
  },
};

describe('plan_artifact rollout variant', () => {
  it('is always persisted', () => {
    expect(isPersistedRolloutItem(planArtifact)).toBe(true);
  });

  it('is recognized by its type guard, and the guard is exclusive', () => {
    expect(isPlanArtifactItem(planArtifact)).toBe(true);
    expect(
      isPlanArtifactItem({ type: 'event_msg', payload: {} } as unknown as RolloutItem),
    ).toBe(false);
  });
});
