// File: src/storage/__tests__/TokenUsageStore.cost.test.ts
//
// Track 18 — the read-time cost sum. Each engine (parent + every sub-agent)
// self-persists exactly one TokenUsageRecord with its own costUSD; the
// session grand total is the sum of those rows. This pins the "counted once"
// invariant: a parent + 2 sub-agents = 3 rows, summed = expected, with no
// overlap (the parent's tokens never include sub-agent tokens).

import { describe, it, expect } from 'vitest';
import { TokenUsageStore } from '../TokenUsageStore';
import type { TokenUsageRecord } from '../types';

const rec = (p: Partial<TokenUsageRecord>): TokenUsageRecord => ({
  id: Math.random().toString(36),
  sessionId: 's1',
  taskId: 't',
  model: 'gpt-5.1',
  provider_model: 'openai:gpt-5.1',
  timestamp: '2026-05-15T10:00:00.000Z',
  input_tokens: 0,
  cached_input_tokens: 0,
  output_tokens: 0,
  reasoning_output_tokens: 0,
  total_tokens: 0,
  costUSD: 0,
  costEstimated: false,
  turn_count: 1,
  ...p,
});

describe('TokenUsageStore cost aggregation (Track 18)', () => {
  it('sums costUSD across the parent + sub-agent records of a session (counted once)', () => {
    const records = [
      rec({ sessionId: 's1', taskId: 'parent', costUSD: 1.0 }),
      rec({ sessionId: 's1', taskId: 'sub-a', costUSD: 0.25 }),
      rec({ sessionId: 's1', taskId: 'sub-b', costUSD: 0.75, costEstimated: true }),
    ];
    const [summary] = TokenUsageStore.aggregateBySession(records);
    expect(summary.sessionId).toBe('s1');
    expect(summary.taskCount).toBe(3);
    expect(summary.costUSD).toBeCloseTo(2.0, 10);
    expect(summary.costEstimated).toBe(true); // any estimated row taints
  });

  it('treats pre-Track-18 rows (no costUSD) as zero', () => {
    const legacy = rec({ sessionId: 's2' });
    delete (legacy as { costUSD?: number }).costUSD;
    const [summary] = TokenUsageStore.aggregateBySession([legacy]);
    expect(summary.costUSD).toBe(0);
    expect(summary.costEstimated).toBe(false);
  });

  it('aggregates per-model cost keyed by provider-qualified id', () => {
    const records = [
      rec({ model: 'kimi-k2-thinking', provider_model: 'moonshot:kimi-k2-thinking', costUSD: 0.4 }),
      rec({ model: 'kimi-k2-thinking', provider_model: 'fireworks:accounts/fireworks/models/kimi-k2-thinking', costUSD: 0.6, costEstimated: true }),
      rec({ model: 'kimi-k2-thinking', provider_model: 'moonshot:kimi-k2-thinking', costUSD: 0.1 }),
    ];
    const byModel = TokenUsageStore.aggregateByModel(records);
    // Same raw model id, different providers -> attributed separately.
    expect(byModel['moonshot:kimi-k2-thinking'].costUSD).toBeCloseTo(0.5, 10);
    expect(byModel['moonshot:kimi-k2-thinking'].costEstimated).toBe(false);
    expect(byModel['fireworks:accounts/fireworks/models/kimi-k2-thinking'].costUSD).toBeCloseTo(0.6, 10);
    expect(byModel['fireworks:accounts/fireworks/models/kimi-k2-thinking'].costEstimated).toBe(true);
  });

  it('aggregates daily cost by date', () => {
    const records = [
      rec({ timestamp: '2026-05-15T01:00:00.000Z', costUSD: 1.5 }),
      rec({ timestamp: '2026-05-15T23:00:00.000Z', costUSD: 0.5 }),
      rec({ timestamp: '2026-05-16T05:00:00.000Z', costUSD: 2.0 }),
    ];
    const days = TokenUsageStore.aggregateByDate(records);
    const d15 = days.find((d) => d.date === '2026-05-15')!;
    const d16 = days.find((d) => d.date === '2026-05-16')!;
    expect(d15.costUSD).toBeCloseTo(2.0, 10);
    expect(d16.costUSD).toBeCloseTo(2.0, 10);
  });
});
