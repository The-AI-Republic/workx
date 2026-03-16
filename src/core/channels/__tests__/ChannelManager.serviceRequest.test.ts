import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChannelManager } from '../ChannelManager';
import type { ChannelAdapter } from '../ChannelAdapter';
import type { Op } from '@/core/protocol/types';
import type { SubmissionContext } from '../types';
import type { ChannelEvent } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockChannel(id: string): ChannelAdapter {
  return {
    channelId: id,
    channelType: 'sidepanel',
    onSubmission: vi.fn(),
    initialize: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
    sendEvent: vi.fn().mockResolvedValue(undefined),
    supportsStreaming: vi.fn().mockReturnValue(true),
    supportsApprovals: vi.fn().mockReturnValue(true),
    supportsMedia: vi.fn().mockReturnValue(true),
    supportsServices: vi.fn().mockReturnValue(true),
    getCapabilities: vi.fn().mockReturnValue({
      streaming: true,
      approvals: true,
      media: true,
      services: true,
    }),
  } as any;
}

function makeServiceRequestOp(
  service: string,
  params: Record<string, unknown> = {},
  requestId = 'req-123'
): Op {
  return {
    type: 'ServiceRequest',
    requestId,
    service,
    params,
  } as Op;
}

function makeContext(channelId: string, userId?: string): SubmissionContext {
  return {
    channelId,
    channelType: 'sidepanel',
    userId,
  } as SubmissionContext;
}

/** Extract the onSubmission callback registered during registerChannel */
function getSubmissionCallback(
  channel: ChannelAdapter
): (op: Op, context: SubmissionContext) => Promise<void> {
  return (channel.onSubmission as ReturnType<typeof vi.fn>).mock.calls[0][0];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ChannelManager — ServiceRequest routing', () => {
  let manager: ChannelManager;

  beforeEach(() => {
    manager = new ChannelManager();
  });

  it('routes ServiceRequest Ops to the ServiceRegistry, not the AgentHandler', async () => {
    const channel = createMockChannel('ch-1');
    const agentHandler = vi.fn().mockResolvedValue(undefined);

    await manager.registerChannel(channel);
    manager.setAgentHandler(agentHandler);

    manager.getServiceRegistry().register('mcp.getServers', async () => ['s1']);

    const callback = getSubmissionCallback(channel);
    await callback(makeServiceRequestOp('mcp.getServers'), makeContext('ch-1'));

    // Agent handler should NOT have been called
    expect(agentHandler).not.toHaveBeenCalled();

    // Channel should have received a ServiceResponse wrapped in ChannelEvent
    expect(channel.sendEvent).toHaveBeenCalledOnce();
    const envelope = (channel.sendEvent as ReturnType<typeof vi.fn>).mock.calls[0][0] as ChannelEvent;
    const sentEvent = envelope.msg;
    expect(sentEvent.type).toBe('ServiceResponse');
    expect((sentEvent as any).data.success).toBe(true);
    expect((sentEvent as any).data.data).toEqual(['s1']);
    expect((sentEvent as any).data.requestId).toBe('req-123');
    expect((sentEvent as any).data.service).toBe('mcp.getServers');
  });

  it('non-ServiceRequest Ops still route to the AgentHandler', async () => {
    const channel = createMockChannel('ch-2');
    const agentHandler = vi.fn().mockResolvedValue(undefined);

    await manager.registerChannel(channel);
    manager.setAgentHandler(agentHandler);

    const callback = getSubmissionCallback(channel);
    const op: Op = { type: 'Interrupt' };
    await callback(op, makeContext('ch-2'));

    expect(agentHandler).toHaveBeenCalledOnce();
    expect(agentHandler).toHaveBeenCalledWith(op, expect.objectContaining({ channelId: 'ch-2' }));
    expect(channel.sendEvent).not.toHaveBeenCalled();
  });

  it('sends success ServiceResponse with matching requestId', async () => {
    const channel = createMockChannel('ch-3');
    await manager.registerChannel(channel);

    manager.getServiceRegistry().register('vault.status', async () => ({
      locked: false,
      version: 2,
    }));

    const callback = getSubmissionCallback(channel);
    await callback(
      makeServiceRequestOp('vault.status', {}, 'req-456'),
      makeContext('ch-3')
    );

    const envelope = (channel.sendEvent as ReturnType<typeof vi.fn>).mock.calls[0][0] as ChannelEvent;
    expect(envelope.msg).toEqual({
      type: 'ServiceResponse',
      data: {
        requestId: 'req-456',
        service: 'vault.status',
        success: true,
        data: { locked: false, version: 2 },
      },
    });
  });

  it('sends error ServiceResponse when handler throws', async () => {
    const channel = createMockChannel('ch-4');
    await manager.registerChannel(channel);

    manager.getServiceRegistry().register('failing.op', async () => {
      throw new Error('database unavailable');
    });

    const callback = getSubmissionCallback(channel);
    await callback(
      makeServiceRequestOp('failing.op', {}, 'req-err'),
      makeContext('ch-4')
    );

    const envelope = (channel.sendEvent as ReturnType<typeof vi.fn>).mock.calls[0][0] as ChannelEvent;
    expect(envelope.msg).toEqual({
      type: 'ServiceResponse',
      data: {
        requestId: 'req-err',
        service: 'failing.op',
        success: false,
        error: 'database unavailable',
      },
    });
  });

  it('sends error ServiceResponse for unknown service', async () => {
    const channel = createMockChannel('ch-5');
    await manager.registerChannel(channel);

    const callback = getSubmissionCallback(channel);
    await callback(
      makeServiceRequestOp('no.such.service', {}, 'req-unknown'),
      makeContext('ch-5')
    );

    const envelope = (channel.sendEvent as ReturnType<typeof vi.fn>).mock.calls[0][0] as ChannelEvent;
    expect(envelope.msg).toEqual({
      type: 'ServiceResponse',
      data: {
        requestId: 'req-unknown',
        service: 'no.such.service',
        success: false,
        error: 'Unknown service: no.such.service',
      },
    });
  });

  it('passes userId as targetClientId when sending ServiceResponse', async () => {
    const channel = createMockChannel('ch-6');
    await manager.registerChannel(channel);

    manager.getServiceRegistry().register('test.svc', async () => 'ok');

    const callback = getSubmissionCallback(channel);
    await callback(
      makeServiceRequestOp('test.svc', {}, 'req-user'),
      makeContext('ch-6', 'user-42')
    );

    expect(channel.sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({ msg: expect.objectContaining({ type: 'ServiceResponse' }) }),
      'user-42'
    );
  });

  it('propagates sessionId from SubmissionContext into ChannelEvent envelope', async () => {
    const channel = createMockChannel('ch-7');
    await manager.registerChannel(channel);

    manager.getServiceRegistry().register('test.session', async () => 'ok');

    const callback = getSubmissionCallback(channel);
    const context = {
      channelId: 'ch-7',
      channelType: 'sidepanel',
      sessionId: 'session-abc-123',
    } as SubmissionContext;

    await callback(makeServiceRequestOp('test.session', {}, 'req-sid'), context);

    const envelope = (channel.sendEvent as ReturnType<typeof vi.fn>).mock.calls[0][0] as ChannelEvent;
    expect(envelope.sessionId).toBe('session-abc-123');
    expect(envelope.msg.type).toBe('ServiceResponse');
  });

  it('broadcastEvent sends ChannelEvent to all registered channels', async () => {
    const ch1 = createMockChannel('broadcast-1');
    const ch2 = createMockChannel('broadcast-2');
    await manager.registerChannel(ch1);
    await manager.registerChannel(ch2);

    const event: ChannelEvent = {
      msg: { type: 'AgentMessage', data: { message: 'broadcast test' } } as any,
      sessionId: 'session-broadcast',
    };

    await manager.broadcastEvent(event);

    expect(ch1.sendEvent).toHaveBeenCalledWith(event);
    expect(ch2.sendEvent).toHaveBeenCalledWith(event);
  });
});
