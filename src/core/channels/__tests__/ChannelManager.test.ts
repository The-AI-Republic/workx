/**
 * Unit tests for ChannelManager
 *
 * Tests channel registration, unregistration, event dispatch,
 * broadcast, agent handler routing, and singleton access.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ChannelManager, getChannelManager } from '../ChannelManager';
import type { ChannelAdapter } from '../ChannelAdapter';
import type { Op, EventMsg } from '@/core/protocol/types';
import type { SubmissionContext } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockChannel(id: string, type: string = 'test'): ChannelAdapter {
  return {
    channelId: id,
    channelType: type,
    onSubmission: vi.fn(),
    initialize: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),
    sendEvent: vi.fn().mockResolvedValue(undefined),
    getCapabilities: vi.fn().mockReturnValue(['text', 'events']),
  } as any;
}

function makeEvent(label: string): EventMsg {
  return { type: 'AgentMessage', data: { message: label } } as any;
}

function makeOp(): Op {
  return { type: 'Interrupt' } as Op;
}

function makeContext(channelId: string): SubmissionContext {
  return {
    channelId,
    channelType: 'sidepanel',
  } as SubmissionContext;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ChannelManager', () => {
  let manager: ChannelManager;

  beforeEach(() => {
    manager = new ChannelManager();
  });

  // -----------------------------------------------------------------------
  // registerChannel
  // -----------------------------------------------------------------------

  describe('registerChannel', () => {
    it('registers a channel successfully and calls initialize()', async () => {
      const channel = createMockChannel('ch-1');

      await manager.registerChannel(channel);

      expect(channel.initialize).toHaveBeenCalledOnce();
      expect(manager.getChannel('ch-1')).toBe(channel);
    });

    it('sets up onSubmission handler during registration', async () => {
      const channel = createMockChannel('ch-1');

      await manager.registerChannel(channel);

      expect(channel.onSubmission).toHaveBeenCalledOnce();
      expect(channel.onSubmission).toHaveBeenCalledWith(expect.any(Function));
    });

    it('throws when registering a duplicate channel ID', async () => {
      const channel1 = createMockChannel('ch-dup');
      const channel2 = createMockChannel('ch-dup');

      await manager.registerChannel(channel1);

      await expect(manager.registerChannel(channel2)).rejects.toThrow(
        'Channel already registered: ch-dup',
      );
    });
  });

  // -----------------------------------------------------------------------
  // unregisterChannel
  // -----------------------------------------------------------------------

  describe('unregisterChannel', () => {
    it('calls shutdown() and removes the channel', async () => {
      const channel = createMockChannel('ch-rm');
      await manager.registerChannel(channel);

      await manager.unregisterChannel('ch-rm');

      expect(channel.shutdown).toHaveBeenCalledOnce();
      expect(manager.getChannel('ch-rm')).toBeUndefined();
    });

    it('does not throw when unregistering a non-existent channel', async () => {
      await expect(manager.unregisterChannel('no-such-channel')).resolves.toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // setAgentHandler
  // -----------------------------------------------------------------------

  describe('setAgentHandler', () => {
    it('routes submissions from a channel to the agent handler', async () => {
      const channel = createMockChannel('ch-agent');
      const agentHandler = vi.fn().mockResolvedValue(undefined);

      await manager.registerChannel(channel);
      manager.setAgentHandler(agentHandler);

      // Extract the submission callback that was passed to onSubmission
      const submissionCallback = (channel.onSubmission as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as (op: Op, context: SubmissionContext) => Promise<void>;

      const op = makeOp();
      const ctx = makeContext('ch-agent');
      await submissionCallback(op, ctx);

      expect(agentHandler).toHaveBeenCalledOnce();
      expect(agentHandler).toHaveBeenCalledWith(op, ctx);
    });

    it('drops submission with a warning when no agent handler is set', async () => {
      const channel = createMockChannel('ch-no-handler');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await manager.registerChannel(channel);
      // Do NOT set an agent handler

      const submissionCallback = (channel.onSubmission as ReturnType<typeof vi.fn>).mock
        .calls[0][0] as (op: Op, context: SubmissionContext) => Promise<void>;

      await submissionCallback(makeOp(), makeContext('ch-no-handler'));

      expect(warnSpy).toHaveBeenCalledWith(
        'No agent handler registered, dropping submission',
      );

      warnSpy.mockRestore();
    });
  });

  // -----------------------------------------------------------------------
  // dispatchEvent
  // -----------------------------------------------------------------------

  describe('dispatchEvent', () => {
    it('sends an event to a specific channel', async () => {
      const channel = createMockChannel('ch-dispatch');
      await manager.registerChannel(channel);

      const event = makeEvent('hello');
      await manager.dispatchEvent(event, 'ch-dispatch');

      expect(channel.sendEvent).toHaveBeenCalledOnce();
      expect(channel.sendEvent).toHaveBeenCalledWith(event, undefined);
    });

    it('forwards the clientId parameter to sendEvent', async () => {
      const channel = createMockChannel('ch-client');
      await manager.registerChannel(channel);

      const event = makeEvent('targeted');
      await manager.dispatchEvent(event, 'ch-client', 'client-42');

      expect(channel.sendEvent).toHaveBeenCalledWith(event, 'client-42');
    });

    it('does not throw when dispatching to a non-existent channel', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await expect(
        manager.dispatchEvent(makeEvent('lost'), 'no-channel'),
      ).resolves.toBeUndefined();

      expect(warnSpy).toHaveBeenCalledWith('Channel not found: no-channel');
      warnSpy.mockRestore();
    });
  });

  // -----------------------------------------------------------------------
  // broadcastEvent
  // -----------------------------------------------------------------------

  describe('broadcastEvent', () => {
    it('sends an event to all registered channels', async () => {
      const ch1 = createMockChannel('ch-b1');
      const ch2 = createMockChannel('ch-b2');
      const ch3 = createMockChannel('ch-b3');

      await manager.registerChannel(ch1);
      await manager.registerChannel(ch2);
      await manager.registerChannel(ch3);

      const event = makeEvent('broadcast');
      await manager.broadcastEvent(event);

      expect(ch1.sendEvent).toHaveBeenCalledWith(event);
      expect(ch2.sendEvent).toHaveBeenCalledWith(event);
      expect(ch3.sendEvent).toHaveBeenCalledWith(event);
    });

    it('continues broadcasting even if one channel throws', async () => {
      const ch1 = createMockChannel('ch-ok');
      const ch2 = createMockChannel('ch-fail');
      (ch2.sendEvent as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('send failed'),
      );
      const ch3 = createMockChannel('ch-ok2');

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await manager.registerChannel(ch1);
      await manager.registerChannel(ch2);
      await manager.registerChannel(ch3);

      const event = makeEvent('partial-broadcast');
      await manager.broadcastEvent(event);

      expect(ch1.sendEvent).toHaveBeenCalledOnce();
      expect(ch2.sendEvent).toHaveBeenCalledOnce();
      expect(ch3.sendEvent).toHaveBeenCalledOnce();
      expect(errorSpy).toHaveBeenCalledWith(
        'Failed to send event to ch-fail:',
        expect.any(Error),
      );

      errorSpy.mockRestore();
    });

    it('resolves immediately when no channels are registered', async () => {
      await expect(manager.broadcastEvent(makeEvent('empty'))).resolves.toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // getChannel
  // -----------------------------------------------------------------------

  describe('getChannel', () => {
    it('returns the channel when it exists', async () => {
      const channel = createMockChannel('ch-get');
      await manager.registerChannel(channel);

      expect(manager.getChannel('ch-get')).toBe(channel);
    });

    it('returns undefined for an unknown channel ID', () => {
      expect(manager.getChannel('nonexistent')).toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // getChannelIds
  // -----------------------------------------------------------------------

  describe('getChannelIds', () => {
    it('returns an empty array when no channels are registered', () => {
      expect(manager.getChannelIds()).toEqual([]);
    });

    it('returns IDs of all registered channels', async () => {
      await manager.registerChannel(createMockChannel('a'));
      await manager.registerChannel(createMockChannel('b'));
      await manager.registerChannel(createMockChannel('c'));

      const ids = manager.getChannelIds();
      expect(ids).toHaveLength(3);
      expect(ids).toContain('a');
      expect(ids).toContain('b');
      expect(ids).toContain('c');
    });
  });

  // -----------------------------------------------------------------------
  // getChannelInfo
  // -----------------------------------------------------------------------

  describe('getChannelInfo', () => {
    it('returns info for all registered channels', async () => {
      await manager.registerChannel(createMockChannel('info-1', 'sidepanel'));
      await manager.registerChannel(createMockChannel('info-2', 'websocket'));

      const infos = manager.getChannelInfo();

      expect(infos).toHaveLength(2);

      const info1 = infos.find((i) => i.channelId === 'info-1');
      expect(info1).toBeDefined();
      expect(info1!.channelType).toBe('sidepanel');
      expect(info1!.capabilities).toEqual(['text', 'events']);
      expect(info1!.connectedAt).toBeTypeOf('number');

      const info2 = infos.find((i) => i.channelId === 'info-2');
      expect(info2).toBeDefined();
      expect(info2!.channelType).toBe('websocket');
    });

    it('returns an empty array when no channels are registered', () => {
      expect(manager.getChannelInfo()).toEqual([]);
    });
  });

  // -----------------------------------------------------------------------
  // shutdown
  // -----------------------------------------------------------------------

  describe('shutdown', () => {
    it('shuts down all channels and clears the channel map', async () => {
      const ch1 = createMockChannel('sh-1');
      const ch2 = createMockChannel('sh-2');
      await manager.registerChannel(ch1);
      await manager.registerChannel(ch2);

      await manager.shutdown();

      expect(ch1.shutdown).toHaveBeenCalledOnce();
      expect(ch2.shutdown).toHaveBeenCalledOnce();
      expect(manager.getChannelIds()).toEqual([]);
    });

    it('continues shutting down even if one channel throws', async () => {
      const ch1 = createMockChannel('sh-ok');
      const ch2 = createMockChannel('sh-fail');
      (ch2.shutdown as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('shutdown failed'),
      );
      const ch3 = createMockChannel('sh-ok2');

      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await manager.registerChannel(ch1);
      await manager.registerChannel(ch2);
      await manager.registerChannel(ch3);

      await manager.shutdown();

      expect(ch1.shutdown).toHaveBeenCalledOnce();
      expect(ch2.shutdown).toHaveBeenCalledOnce();
      expect(ch3.shutdown).toHaveBeenCalledOnce();
      expect(manager.getChannelIds()).toEqual([]);
      expect(errorSpy).toHaveBeenCalledWith(
        'Failed to shutdown sh-fail:',
        expect.any(Error),
      );

      errorSpy.mockRestore();
    });

    it('resolves cleanly when no channels are registered', async () => {
      await expect(manager.shutdown()).resolves.toBeUndefined();
    });
  });

  // -----------------------------------------------------------------------
  // getChannelManager singleton
  // -----------------------------------------------------------------------

  describe('getChannelManager', () => {
    it('returns the same instance on repeated calls', () => {
      const instance1 = getChannelManager();
      const instance2 = getChannelManager();

      expect(instance1).toBe(instance2);
    });

    it('returns a ChannelManager instance', () => {
      const instance = getChannelManager();

      expect(instance).toBeInstanceOf(ChannelManager);
    });
  });
});
