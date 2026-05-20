/**
 * Parity-harness scenario library (Track 43, P1/P2 scaffolding).
 *
 * Defines the set of scenarios both transports must agree on for the
 * future P2 exit gate: chat request/response, streaming events, tool
 * call, MCP stdio server, config R/W, rollout R/W, auth mode update,
 * scheduler create+trigger, cancellation, reconnect, graceful shutdown.
 *
 * **Not an exit gate yet.** The unit test in
 * `__tests__/scenarios.test.ts` exercises only the harness mechanism
 * against fake bindings — both fakes read from `SCENARIO_EVENT_SEQUENCES`
 * so the positive-path comparison is tautological. The actual exit gate
 * is a follow-up integration test that spawns the runtime sidecar and
 * runs the same scenarios against the real `StdioRuntimeChannel` and a
 * real `ServerChannel`; that test does not exist yet.
 *
 * The scenario list and canonical event sequences below are stable so
 * the integration test, when it lands, has nothing to wire up beyond
 * the bindings themselves.
 */

import type { Op } from '@/core/protocol/types';
import type { ChannelEvent, SubmissionContext } from '@/core/channels/types';
import type { ParityScenario } from './ParityHarness';

const sub = (op: Op, context?: Partial<SubmissionContext>): ParityScenario['steps'][number] => ({ op, context });

/** Build a UserInput Op the runtime accepts. */
function userInputOp(id: string, text: string): Op {
  return {
    id,
    op: { type: 'UserInput', items: [{ type: 'Text', text }] },
  } as unknown as Op;
}

function interruptOp(id: string): Op {
  return { id, op: { type: 'Interrupt' } } as unknown as Op;
}

function shutdownOp(id: string): Op {
  return { id, op: { type: 'Shutdown' } } as unknown as Op;
}

export const PARITY_SCENARIOS: ParityScenario[] = [
  {
    name: 'chat: request → response',
    steps: [sub(userInputOp('chat-1', 'hello'))],
  },
  {
    name: 'chat: streaming delta events arrive in order',
    steps: [sub(userInputOp('stream-1', 'write a haiku'))],
  },
  {
    name: 'tool call: emits begin → end pair',
    steps: [sub(userInputOp('tool-1', 'run a tool'))],
  },
  {
    name: 'MCP stdio: list_tools succeeds',
    steps: [sub(userInputOp('mcp-1', 'list mcp tools'))],
  },
  {
    name: 'config: read → write round-trip',
    steps: [sub(userInputOp('cfg-1', 'set preference X'))],
  },
  {
    name: 'rollout: read → write round-trip',
    steps: [sub(userInputOp('roll-1', 'continue from rollout'))],
  },
  {
    name: 'auth mode update: backend → own-key → backend',
    steps: [sub(userInputOp('auth-1', 'switch auth mode'))],
  },
  {
    name: 'scheduler: schedule + trigger',
    steps: [sub(userInputOp('sched-1', 'schedule a job'))],
  },
  {
    name: 'cancellation: interrupt mid-turn',
    steps: [sub(userInputOp('int-1', 'long task')), sub(interruptOp('int-2'))],
  },
  {
    name: 'reconnect: pause then resume submissions',
    steps: [sub(userInputOp('rc-1', 'first')), sub(userInputOp('rc-2', 'second'))],
  },
  {
    name: 'graceful shutdown',
    steps: [sub(userInputOp('sd-1', 'final')), sub(shutdownOp('sd-2'))],
  },
];

/**
 * Canonical event sequence per scenario name. Both bindings must produce
 * this exact normalized stream. The shapes are intentionally minimal — the
 * parity test asserts equivalence (across two binding implementations of
 * the same op pipeline), not richness of any single sequence.
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
