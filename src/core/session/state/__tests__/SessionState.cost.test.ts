// File: src/core/session/state/__tests__/SessionState.cost.test.ts
//
// Track 18 — cumulative session cost: accumulation semantics, the estimated
// sticky flag, export/import round-trip (resume), and that a fresh state
// (a Track-15 fork is seeded fresh, not from this export) starts at zero.

import { describe, it, expect, beforeEach } from 'vitest';
import { SessionState } from '../SessionState';

describe('SessionState cost tracking (Track 18)', () => {
  let s: SessionState;
  beforeEach(() => {
    s = new SessionState();
  });

  it('starts at zero, not estimated', () => {
    expect(s.getCostInfo()).toEqual({ cumulativeCostUSD: 0, hasUnknownModelCost: false });
  });

  it('accumulates positive cost and ignores non-positive/non-finite', () => {
    s.addCost(0.5, false);
    s.addCost(0.25, false);
    s.addCost(0, false);
    s.addCost(-1, false);
    s.addCost(NaN, false);
    expect(s.getCostInfo().cumulativeCostUSD).toBeCloseTo(0.75, 10);
  });

  it('estimated is sticky once any task was estimated', () => {
    s.addCost(0.1, false);
    expect(s.getCostInfo().hasUnknownModelCost).toBe(false);
    s.addCost(0.2, true);
    s.addCost(0.3, false);
    expect(s.getCostInfo().hasUnknownModelCost).toBe(true);
  });

  it('round-trips cumulative cost through export -> import (resume)', () => {
    s.addCost(1.23, true);
    const restored = SessionState.import(s.export());
    expect(restored.getCostInfo()).toEqual({ cumulativeCostUSD: 1.23, hasUnknownModelCost: true });
  });

  it('a fresh state (fork-style) does NOT inherit a prior total', () => {
    s.addCost(5, false);
    const fresh = new SessionState();
    expect(fresh.getCostInfo().cumulativeCostUSD).toBe(0);
  });

  it('importing a pre-Track-18 export (no cost fields) defaults to zero', () => {
    const legacy = s.export();
    delete (legacy as { cumulativeCostUSD?: number }).cumulativeCostUSD;
    delete (legacy as { hasUnknownModelCost?: boolean }).hasUnknownModelCost;
    const restored = SessionState.import(legacy);
    expect(restored.getCostInfo()).toEqual({ cumulativeCostUSD: 0, hasUnknownModelCost: false });
  });
});
