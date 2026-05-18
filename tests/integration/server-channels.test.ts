import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConnectorBridge } from '@/server/channel-connectors/connector-bridge';
import type {
  ChannelConnector,
  ChannelGatewayContext,
  ChannelOutboundContext,
  InboundMessage,
} from '@/server/channel-connectors/types';

vi.mock('@/server/config/server-config', () => ({
  getServerConfig: () => ({
    server: {
      channels: {
        slack: { accounts: { 'test-account': {} } }
      },
      owner: {
        identities: { slack: ['U_OWNER'], whatsapp: ['1234567890'] }
      }
    }
  })
}));

describe('Server Channels Integration (OpenClaw Plugins)', () => {
  let mockPlugin: ChannelConnector;
  let gatewayContext: ChannelGatewayContext | undefined;

  beforeEach(() => {
    mockPlugin = {
      id: 'slack',
      config: {
        listAccountIds: vi.fn().mockReturnValue(['test-account']),
      },
      gateway: {
        start: vi.fn().mockImplementation(async (ctx: ChannelGatewayContext) => {
          gatewayContext = ctx;
        }),
        stop: vi.fn().mockResolvedValue(undefined),
      },
      outbound: {
        sendText: vi.fn().mockResolvedValue(undefined),
      },
      security: {
        verifyOwner: vi.fn().mockImplementation((id: string) => id === 'U_OWNER'),
        extractSenderId: vi.fn().mockImplementation((msg: any) => msg.senderId),
      },
      messaging: {
        normalizeTarget: vi.fn().mockImplementation((t: any) => String(t)),
      }
    };
  });

  it('should initialize bridge and correctly translate inbound messages', async () => {
    const bridge = new ConnectorBridge(mockPlugin, 'test-account');
    await bridge.initialize();

    expect(mockPlugin.gateway.start).toHaveBeenCalled();
    expect(gatewayContext).toBeDefined();

    // Mock the agent's submission handler
    const mockSubmissionHandler = vi.fn().mockResolvedValue(undefined);
    bridge.onSubmission(mockSubmissionHandler);

    // Simulate inbound message from the plugin
    const inboundMsg: InboundMessage = {
      senderId: 'U_OWNER',
      senderName: 'Test Owner',
      text: 'Hello test',
      channelId: 'C123',
    };

    gatewayContext!.onMessage(inboundMsg);

    // Verify the bridge translated it to a SubmissionContext
    expect(mockSubmissionHandler).toHaveBeenCalled();
    const submissionCtx = mockSubmissionHandler.mock.calls[0][1];

    expect(submissionCtx.channelType).toBe('slack');
    expect(submissionCtx.channelId).toBe('slack:test-account');
    expect(submissionCtx.userId).toBe('U_OWNER');
    expect(submissionCtx.sessionId).toBe('slack:test-account:C123');

    // Simulate an outbound event via the replyCallback (ChannelEvent envelope)
    const replyEvent = {
      msg: { type: 'AgentMessage', data: { message: 'Hello from agent' } }
    };

    await submissionCtx.replyCallback(replyEvent as any);

    // Verify the plugin's outbound sendText was called with the correct channel target
    expect(mockPlugin.outbound.sendText).toHaveBeenCalled();
    const callArgs = (mockPlugin.outbound.sendText as any).mock.calls[0];
    const targetCtx = callArgs[0] as ChannelOutboundContext;
    expect(targetCtx.accountId).toBe('test-account');
    expect(targetCtx.target).toBe('C123');
    expect(callArgs[1]).toBe('Hello from agent');
  });
});
