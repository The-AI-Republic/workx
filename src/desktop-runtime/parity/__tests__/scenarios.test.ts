/**
 * Parity-harness scenario coverage (Track 43 P1/P2 exit gate).
 *
 * Asserts:
 *  - All design-mandated scenarios are present in PARITY_SCENARIOS.
 *  - Each scenario has a canonical event sequence in
 *    SCENARIO_EVENT_SEQUENCES.
 *  - The harness reports a green result when two bindings emit the
 *    canonical sequence for the full scenario set.
 *  - The harness flags a mismatch when one binding deviates from the
 *    canonical sequence (negative test for false-greens).
 *
 * The bindings here are in-process simulators. The same scenario list
 * powers the real-sidecar integration test (P2 exit, follow-up) — see
 * scenarios.ts for the contract.
 */

import { describe, expect, it } from 'vitest';
import { runParityHarness, type ParityBinding } from '../ParityHarness';
import { PARITY_SCENARIOS, SCENARIO_EVENT_SEQUENCES } from '../scenarios';

const REQUIRED_SCENARIOS = [
  'chat: request → response',
  'chat: streaming delta events arrive in order',
  'tool call: emits begin → end pair',
  'MCP stdio: list_tools succeeds',
  'config: read → write round-trip',
  'rollout: read → write round-trip',
  'auth mode update: backend → own-key → backend',
  'scheduler: schedule + trigger',
  'cancellation: interrupt mid-turn',
  'reconnect: pause then resume submissions',
  'graceful shutdown',
];

/**
 * Build a binding whose drainEvents() yields the canonical sequence for
 * each scenario the harness processes, in order. The harness calls submit
 * for every step of a scenario then drainEvents once per (scenario,
 * binding). We track a per-binding scenario cursor that advances on the
 * first submit of each scenario and resets at drainEvents.
 *
 * Optional `divergence` lets a test make one specific scenario emit a
 * different event stream so we can verify mismatch detection.
 */
function makeBinding(
  name: string,
  scenarios: typeof PARITY_SCENARIOS,
  divergence?: { scenario: string; events: ParityEvents },
): ParityBinding {
  let cursor = 0;
  let primed = false;
  return {
    name,
    async submit() {
      // The first submit for a scenario primes the binding to that
      // scenario's canonical sequence. Subsequent submits in the same
      // scenario (Interrupt, second UserInput, Shutdown) are no-ops.
      primed = true;
    },
    async drainEvents() {
      if (!primed) return [];
      primed = false;
      const idx = Math.min(cursor, scenarios.length - 1);
      const scenarioName = scenarios[idx]?.name;
      cursor++;
      if (!scenarioName) return [];
      if (divergence && scenarioName === divergence.scenario) {
        return divergence.events;
      }
      return SCENARIO_EVENT_SEQUENCES[scenarioName] ?? [];
    },
  };
}

type ParityEvents = Awaited<ReturnType<ParityBinding['drainEvents']>>;

describe('Parity-harness scenario coverage', () => {
  it('PARITY_SCENARIOS covers every design-mandated scenario', () => {
    const names = PARITY_SCENARIOS.map((s) => s.name);
    for (const required of REQUIRED_SCENARIOS) {
      expect(names).toContain(required);
    }
  });

  it('every scenario has a canonical event sequence', () => {
    for (const scenario of PARITY_SCENARIOS) {
      expect(
        SCENARIO_EVENT_SEQUENCES[scenario.name],
        `missing canonical events for "${scenario.name}"`,
      ).toBeDefined();
      expect(SCENARIO_EVENT_SEQUENCES[scenario.name]!.length).toBeGreaterThan(0);
    }
  });

  it('reports a green result when both bindings emit the canonical sequences', async () => {
    const report = await runParityHarness(
      [makeBinding('websocket', PARITY_SCENARIOS), makeBinding('stdio', PARITY_SCENARIOS)],
      PARITY_SCENARIOS,
    );
    if (!report.ok) {
      console.error('Mismatches:', JSON.stringify(report.mismatches, null, 2));
    }
    expect(report.ok).toBe(true);
    expect(report.mismatches).toHaveLength(0);
    // Sanity: results recorded for every (scenario, binding) pair.
    expect(report.results).toHaveLength(PARITY_SCENARIOS.length * 2);
  });

  it('flags a mismatch when one binding drops events from the canonical sequence', async () => {
    const streamingScenario = PARITY_SCENARIOS.find((s) => s.name === 'chat: streaming delta events arrive in order')!;
    const broken = makeBinding('stdio', [streamingScenario], {
      scenario: 'chat: streaming delta events arrive in order',
      events: SCENARIO_EVENT_SEQUENCES['chat: streaming delta events arrive in order']!.slice(0, 2),
    });
    const report = await runParityHarness(
      [makeBinding('websocket', [streamingScenario]), broken],
      [streamingScenario],
    );
    expect(report.ok).toBe(false);
    expect(report.mismatches).toHaveLength(1);
    expect(report.mismatches[0]).toMatchObject({
      scenario: 'chat: streaming delta events arrive in order',
      baseline: 'websocket',
      candidate: 'stdio',
    });
  });

  it('flags a mismatch when one binding reorders events', async () => {
    const original = SCENARIO_EVENT_SEQUENCES['tool call: emits begin → end pair']!;
    const reordered = [original[1], original[0]];
    const toolScenario = PARITY_SCENARIOS.find((s) => s.name === 'tool call: emits begin → end pair')!;
    const broken = makeBinding('stdio', [toolScenario], {
      scenario: 'tool call: emits begin → end pair',
      events: reordered as never,
    });
    const report = await runParityHarness(
      [makeBinding('websocket', [toolScenario]), broken],
      [toolScenario],
    );
    expect(report.ok).toBe(false);
    expect(report.mismatches).toHaveLength(1);
  });

  it('runs all scenarios across two bindings without throwing', async () => {
    // Smoke: the harness must drive all 11 scenarios + drain to completion
    // even if the bindings emit minimal events.
    const report = await runParityHarness(
      [makeBinding('websocket', PARITY_SCENARIOS), makeBinding('stdio', PARITY_SCENARIOS)],
      PARITY_SCENARIOS,
    );
    expect(report.results.map((r) => r.scenario)).toEqual(
      PARITY_SCENARIOS.flatMap((s) => [s.name, s.name]),
    );
  });
});
