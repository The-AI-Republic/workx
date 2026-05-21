/**
 * Parity-harness scenario library (Track 43, P1/P2 scaffolding).
 *
 * @deprecated for use against the real desktop runtime.
 *
 * The Op shapes below now type-check honestly against
 * `src/core/protocol/types.ts` (lowercase `'text'` InputItem
 * discriminant; bare `Op` shape without an envelope; no
 * `as unknown as Op` cast). Prior to that fix the helpers built an
 * envelope `{ id, op: { type: 'UserInput', items: [{ type: 'Text', text }] } }`
 * with uppercase `'Text'` and bypassed type checking.
 *
 * However, this library is still **not** ready to drive a real
 * sidecar end-to-end:
 *
 *   1. `ServerAgentBootstrap` rejects submissions without
 *      `context.sessionId` (see
 *      `src/server/agent/ServerAgentBootstrap.ts:428` — "No sessionId
 *      in submission context"). None of the scenarios below populate
 *      one. Any binding that submits these Ops at the real runtime
 *      must inject a sessionId via `step.context.sessionId`.
 *   2. `SCENARIO_EVENT_SEQUENCES` (below) are synthetic placeholders
 *      (`text: 'hi back'`, `turnId: 't-1'`, `evt-<random>`,
 *      hardcoded `sessionId: 'session-test'`). The real sidecar emits
 *      real model output through `RepublicAgent`, real session IDs,
 *      real timestamps. A direct `toEqual(...)` comparison cannot
 *      pass — the canonical sequences were authored as scaffolding,
 *      not as recordings of actual runtime output.
 *
 * Fixing both gaps requires a deterministic agent stack (fake model
 * client, fake services, fake storage). That work is out of scope for
 * Track 45 and belongs to a separate, larger track.
 *
 * Existing consumers (the tautological `__tests__/scenarios.test.ts`)
 * only read the scenario names and the canonical-sequence keys, so
 * the type-correctness fix above is non-breaking for them.
 */

import type { Op } from '@/core/protocol/types';
import type { ChannelEvent, SubmissionContext } from '@/core/channels/types';
import type { ParityScenario } from './ParityHarness';

const sub = (op: Op, context?: Partial<SubmissionContext>): ParityScenario['steps'][number] => ({ op, context });

/** Build a UserInput Op the runtime accepts (bare Op, lowercase `'text'`). */
function userInputOp(text: string): Op {
  return { type: 'UserInput', items: [{ type: 'text', text }] };
}

function interruptOp(): Op {
  return { type: 'Interrupt' };
}

function shutdownOp(): Op {
  return { type: 'Shutdown' };
}

export const PARITY_SCENARIOS: ParityScenario[] = [
  {
    name: 'chat: request → response',
    steps: [sub(userInputOp('hello'))],
  },
  {
    name: 'chat: streaming delta events arrive in order',
    steps: [sub(userInputOp('write a haiku'))],
  },
  {
    name: 'tool call: emits begin → end pair',
    steps: [sub(userInputOp('run a tool'))],
  },
  {
    name: 'MCP stdio: list_tools succeeds',
    steps: [sub(userInputOp('list mcp tools'))],
  },
  {
    name: 'config: read → write round-trip',
    steps: [sub(userInputOp('set preference X'))],
  },
  {
    name: 'rollout: read → write round-trip',
    steps: [sub(userInputOp('continue from rollout'))],
  },
  {
    name: 'auth mode update: backend → own-key → backend',
    steps: [sub(userInputOp('switch auth mode'))],
  },
  {
    name: 'scheduler: schedule + trigger',
    steps: [sub(userInputOp('schedule a job'))],
  },
  {
    name: 'cancellation: interrupt mid-turn',
    steps: [sub(userInputOp('long task')), sub(interruptOp())],
  },
  {
    name: 'reconnect: pause then resume submissions',
    steps: [sub(userInputOp('first')), sub(userInputOp('second'))],
  },
  {
    name: 'graceful shutdown',
    steps: [sub(userInputOp('final')), sub(shutdownOp())],
  },
];

/**
 * Synthetic event sequences keyed by scenario name. Used by the
 * existing tautological `__tests__/scenarios.test.ts` where two fake
 * bindings both read from this lookup, so the equality assertion is
 * `JSON.stringify(X) === JSON.stringify(X)`.
 *
 * These are **not** recordings of actual runtime output — the
 * payloads (`text: 'hi back'`, `turnId: 't-1'`, random `evt-*` ids,
 * hardcoded `sessionId: 'session-test'`) are placeholders authored
 * when the parity library was scaffolded. A real `toEqual(...)`
 * comparison against the spawned sidecar would never pass.
 * See the file header for the full deprecation note.
 */
export const SCENARIO_EVENT_SEQUENCES: Record<string, ChannelEvent[]> = {
  'chat: request → response': [
    evt({ type: 'TurnStarted', data: { turnId: 't-1' } }),
    evt({ type: 'AgentMessage', data: { text: 'hi back' } }),
    evt({ type: 'TurnComplete', data: { turnId: 't-1' } }),
  ],
  'chat: streaming delta events arrive in order': [
    evt({ type: 'TurnStarted', data: { turnId: 't-2' } }),
    evt({ type: 'AgentMessageDelta', data: { delta: 'autumn ' } }),
    evt({ type: 'AgentMessageDelta', data: { delta: 'leaves ' } }),
    evt({ type: 'AgentMessageDelta', data: { delta: 'fall' } }),
    evt({ type: 'TurnComplete', data: { turnId: 't-2' } }),
  ],
  'tool call: emits begin → end pair': [
    evt({ type: 'ToolExecutionStart', data: { tool: 'read_file' } }),
    evt({ type: 'ToolExecutionEnd', data: { tool: 'read_file', ok: true } }),
  ],
  'MCP stdio: list_tools succeeds': [
    evt({ type: 'McpListToolsResponse', data: { tools: [] } }),
  ],
  'config: read → write round-trip': [
    evt({ type: 'ServiceResponse', data: { method: 'config.get', ok: true } }),
    evt({ type: 'ServiceResponse', data: { method: 'config.set', ok: true } }),
  ],
  'rollout: read → write round-trip': [
    evt({ type: 'ServiceResponse', data: { method: 'rollout.list', ok: true } }),
    evt({ type: 'ServiceResponse', data: { method: 'rollout.append', ok: true } }),
  ],
  'auth mode update: backend → own-key → backend': [
    evt({ type: 'ServiceResponse', data: { method: 'auth.setMode', ok: true, mode: 'own-key' } }),
    evt({ type: 'ServiceResponse', data: { method: 'auth.setMode', ok: true, mode: 'backend' } }),
  ],
  'scheduler: schedule + trigger': [
    evt({ type: 'ServiceResponse', data: { method: 'scheduler.schedule', ok: true, jobId: 'job-1' } }),
    evt({ type: 'ServiceResponse', data: { method: 'scheduler.trigger', ok: true } }),
  ],
  'cancellation: interrupt mid-turn': [
    evt({ type: 'TurnStarted', data: { turnId: 't-3' } }),
    evt({ type: 'Interrupted' }),
    evt({ type: 'TurnAborted', data: { reason: 'interrupt' } }),
  ],
  'reconnect: pause then resume submissions': [
    evt({ type: 'TurnStarted', data: { turnId: 't-4' } }),
    evt({ type: 'TurnComplete', data: { turnId: 't-4' } }),
    evt({ type: 'TurnStarted', data: { turnId: 't-5' } }),
    evt({ type: 'TurnComplete', data: { turnId: 't-5' } }),
  ],
  'graceful shutdown': [
    evt({ type: 'TurnStarted', data: { turnId: 't-6' } }),
    evt({ type: 'TurnComplete', data: { turnId: 't-6' } }),
    evt({ type: 'ShutdownComplete' }),
  ],
};

function evt(msg: unknown): ChannelEvent {
  return {
    id: `evt-${Math.random().toString(36).slice(2, 8)}`,
    sessionId: 'session-test',
    msg: msg as never,
  } as unknown as ChannelEvent;
}
