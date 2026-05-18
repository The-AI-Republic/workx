import { describe, expect, it } from 'vitest';
import type { Op } from '@/core/protocol/types';
import type { ChannelEvent } from '@/core/channels/types';
import {
  runParityHarness,
  type ParityBinding,
  type ParityScenario,
} from '../ParityHarness';

function binding(name: string, eventForOp: (op: Op) => ChannelEvent): ParityBinding {
  const events: ChannelEvent[] = [];
  return {
    name,
    async submit(op) {
      events.push(eventForOp(op));
    },
    async drainEvents() {
      return events.splice(0);
    },
  };
}

const scenario: ParityScenario = {
  name: 'chat request response',
  steps: [
    {
      op: {
        type: 'Interrupt',
      },
    },
  ],
};

describe('desktop runtime parity harness', () => {
  it('passes when two bindings emit the same normalized events for a scenario', async () => {
    const event = (op: Op): ChannelEvent => ({
      sessionId: op.type,
      msg: { type: 'TaskComplete', last_agent_message: 'done' } as any,
    });

    const report = await runParityHarness([
      binding('server-websocket', event),
      binding('desktop-runtime-stdio', event),
    ], [scenario]);

    expect(report.ok).toBe(true);
    expect(report.mismatches).toEqual([]);
  });

  it('fails when the runtime binding diverges from the baseline binding', async () => {
    const report = await runParityHarness([
      binding('server-websocket', (op) => ({
        sessionId: op.type,
        msg: { type: 'TaskComplete', last_agent_message: 'done' } as any,
      })),
      binding('desktop-runtime-stdio', (op) => ({
        sessionId: op.type,
        msg: { type: 'Error', message: 'failed' } as any,
      })),
    ], [scenario]);

    expect(report.ok).toBe(false);
    expect(report.mismatches).toHaveLength(1);
    expect(report.mismatches[0].scenario).toBe('chat request response');
  });
});
