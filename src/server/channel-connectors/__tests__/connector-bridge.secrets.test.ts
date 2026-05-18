/**
 * Track 24.5 — connector-reply fail-closed gate.
 *
 * The highest-stakes egress path: agent text → external Slack/Telegram from an
 * unattended job. A secret must never be forwarded; the original must never
 * reach `outbound.sendText`.
 */

import { describe, it, expect, vi } from 'vitest';
import { ConnectorBridge } from '../connector-bridge';
import { BLOCKED_OUTBOUND_MESSAGE } from '@/core/security/secretScanner';
import type { ChannelConnector } from '../types';
import type { ChannelEvent } from '@/core/channels/types';

function makeConnector(sendText: ReturnType<typeof vi.fn>): ChannelConnector {
  return {
    id: 'test',
    config: { listAccountIds: () => ['acct'] },
    gateway: { start: async () => {}, stop: async () => {} },
    outbound: { sendText },
  };
}

function agentMessage(message: string): ChannelEvent {
  return { msg: { type: 'AgentMessage', data: { message } } } as ChannelEvent;
}

describe('ConnectorBridge outbound secret gate', () => {
  it('withholds a reply containing a secret and sends the safe string', async () => {
    const sendText = vi.fn().mockResolvedValue(undefined);
    const bridge = new ConnectorBridge(makeConnector(sendText), 'acct');

    await bridge.sendEvent(agentMessage('your key is sk-abcdef0123456789ABCDEF ok'));

    expect(sendText).toHaveBeenCalledTimes(1);
    const sent = sendText.mock.calls[0][1] as string;
    expect(sent).toBe(BLOCKED_OUTBOUND_MESSAGE);
    expect(sent).not.toContain('sk-abcdef0123456789ABCDEF');
  });

  it('passes clean replies through unchanged', async () => {
    const sendText = vi.fn().mockResolvedValue(undefined);
    const bridge = new ConnectorBridge(makeConnector(sendText), 'acct');

    await bridge.sendEvent(agentMessage('Done — exported the table to results.csv'));

    expect(sendText).toHaveBeenCalledWith(
      expect.anything(),
      'Done — exported the table to results.csv',
    );
  });
});
