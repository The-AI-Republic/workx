/**
 * Parity-harness scaffolding tests.
 *
 * IMPORTANT — read this before treating green results as parity proof:
 *
 * The "websocket" and "stdio" bindings used here are NOT real transports.
 * Both pull from the same `SCENARIO_EVENT_SEQUENCES` lookup table, so the
 * positive test ("both bindings emit the canonical sequences") is a
 * tautology — it proves `JSON.stringify(X) === JSON.stringify(X)`, not
 * that real websocket and stdio carriers behave equivalently.
 *
 * What this file DOES assert:
 *  - All design-mandated scenario names are present in PARITY_SCENARIOS.
 *  - Each scenario has at least one canonical event in
 *    SCENARIO_EVENT_SEQUENCES (the list the real bindings must match).
 *  - The harness mechanism (submit→drain loop, normalization, JSON
 *    comparison, mismatch reporting) works: negative tests inject a
 *    divergent binding and confirm the harness flags it.
 *
 * What this file does NOT assert:
 *  - That a real ServerChannel (websocket) produces these sequences.
 *  - That a real StdioRuntimeChannel produces these sequences.
 *  - That the two real channels produce equivalent sequences.
 *
 * The actual P1/P2 parity exit gate is a follow-up integration test that
 * spawns the runtime sidecar, runs PARITY_SCENARIOS against the real
 * StdioRuntimeChannel and a real ServerChannel, and compares — that test
 * does not exist yet. See tasks.md for the open box.
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

  // This test is tautological by design: both bindings pull from the
  // SAME hardcoded canonical sequence, so they must agree. It proves the
  // harness mechanism doesn't crash on a full scenario sweep and that
  // result accounting is correct — NOT that real bindings agree.
  it('harness mechanism completes a full sweep without crashing (NOT a parity proof)', async () => {
    const report = await runParityHarness(
      [makeBinding('canonical-A', PARITY_SCENARIOS), makeBinding('canonical-B', PARITY_SCENARIOS)],
      PARITY_SCENARIOS,
    );
    expect(report.ok).toBe(true);
    expect(report.mismatches).toHaveLength(0);
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
