import type { Op } from '@/core/protocol/types';
import type { ChannelEvent, SubmissionContext } from '@/core/channels/types';

export interface ParityBinding {
  name: string;
  submit(op: Op, context?: Partial<SubmissionContext>): Promise<void>;
  drainEvents(): Promise<ChannelEvent[]>;
  shutdown?(): Promise<void>;
}

export interface ParityScenario {
  name: string;
  steps: Array<{
    op: Op;
    context?: Partial<SubmissionContext>;
  }>;
}

export interface ParityRunResult {
  scenario: string;
  binding: string;
  events: ChannelEvent[];
}

export interface ParityMismatch {
  scenario: string;
  baseline: string;
  candidate: string;
  baselineEvents: ChannelEvent[];
  candidateEvents: ChannelEvent[];
}

export interface ParityReport {
  ok: boolean;
  results: ParityRunResult[];
  mismatches: ParityMismatch[];
}

export type EventNormalizer = (event: ChannelEvent) => unknown;

function defaultNormalize(event: ChannelEvent): unknown {
  return {
    msg: event.msg,
    sessionId: event.sessionId,
  };
}

function normalizeEvents(events: ChannelEvent[], normalizer: EventNormalizer): unknown[] {
  return events.map(normalizer);
}

export async function runParityHarness(
  bindings: ParityBinding[],
  scenarios: ParityScenario[],
  normalizer: EventNormalizer = defaultNormalize,
): Promise<ParityReport> {
  if (bindings.length < 2) {
    throw new Error('Parity harness requires at least two bindings');
  }

  const results: ParityRunResult[] = [];
  const mismatches: ParityMismatch[] = [];

  for (const scenario of scenarios) {
    for (const binding of bindings) {
      for (const step of scenario.steps) {
        await binding.submit(step.op, step.context);
      }
      results.push({
        scenario: scenario.name,
        binding: binding.name,
        events: await binding.drainEvents(),
      });
    }

    const scenarioResults = results.filter((result) => result.scenario === scenario.name);
    const baseline = scenarioResults[0];
    const baselineNormalized = normalizeEvents(baseline.events, normalizer);

    for (const candidate of scenarioResults.slice(1)) {
      const candidateNormalized = normalizeEvents(candidate.events, normalizer);
      if (JSON.stringify(candidateNormalized) !== JSON.stringify(baselineNormalized)) {
        mismatches.push({
          scenario: scenario.name,
          baseline: baseline.binding,
          candidate: candidate.binding,
          baselineEvents: baseline.events,
          candidateEvents: candidate.events,
        });
      }
    }
  }

  await Promise.all(bindings.map((binding) => binding.shutdown?.()));

  return {
    ok: mismatches.length === 0,
    results,
    mismatches,
  };
}
