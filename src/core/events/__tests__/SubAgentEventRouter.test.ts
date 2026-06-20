/**
 * Tests for SubAgentEventRouter — sub-agent event routing, namespacing, and filtering
 */

import { describe, it, expect, vi } from 'vitest';
import { SubAgentEventRouter } from '@/core/events/SubAgentEventRouter';
import type { EngineEvent } from '@/core/engine/RepublicAgentEngineConfig';
import type { EventRoutingMetadata } from '@/core/events/IEventRouter';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<EngineEvent> & { msgType?: string } = {}): EngineEvent {
  const { msgType = 'AgentMessage', ...rest } = overrides;
  return {
    id: 'evt-1',
    msg: {
      type: msgType,
      data: { text: 'hello' },
    },
    ...rest,
  };
}

function makeMetadata(overrides: Partial<EventRoutingMetadata> = {}): EventRoutingMetadata {
  return {
    engineId: 'sub-engine-1',
    parentEngineId: 'parent-engine-1',
    depth: 2,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Constructor
// ---------------------------------------------------------------------------

describe('SubAgentEventRouter', () => {
  describe('constructor', () => {
    it('uses default suppressed types (AgentMessageDelta, AgentReasoningDelta)', () => {
      const router = new SubAgentEventRouter({
        parentEmitter: vi.fn(),
        engineId: 'eng-1',
      });

      expect(router.shouldEmit('AgentMessageDelta')).toBe(false);
      expect(router.shouldEmit('AgentReasoningDelta')).toBe(false);
    });

    it('overrides default suppressed types with custom list', () => {
      const router = new SubAgentEventRouter({
        parentEmitter: vi.fn(),
        engineId: 'eng-1',
        suppressedTypes: ['CustomType'],
      });

      // Custom type is suppressed
      expect(router.shouldEmit('CustomType')).toBe(false);

      // Default types are NOT suppressed when custom list is provided
      expect(router.shouldEmit('AgentMessageDelta')).toBe(true);
      expect(router.shouldEmit('AgentReasoningDelta')).toBe(true);
    });

    it('allows empty suppressed types array (nothing suppressed)', () => {
      const router = new SubAgentEventRouter({
        parentEmitter: vi.fn(),
        engineId: 'eng-1',
        suppressedTypes: [],
      });

      expect(router.shouldEmit('AgentMessageDelta')).toBe(true);
      expect(router.shouldEmit('AgentReasoningDelta')).toBe(true);
      expect(router.shouldEmit('AgentMessage')).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // shouldEmit
  // ---------------------------------------------------------------------------

  describe('shouldEmit', () => {
    it('returns true for non-suppressed event types', () => {
      const router = new SubAgentEventRouter({
        parentEmitter: vi.fn(),
        engineId: 'eng-1',
      });

      expect(router.shouldEmit('AgentMessage')).toBe(true);
      expect(router.shouldEmit('ToolCall')).toBe(true);
      expect(router.shouldEmit('AgentReasoning')).toBe(true);
      expect(router.shouldEmit('Error')).toBe(true);
    });

    it('returns false for suppressed event types', () => {
      const router = new SubAgentEventRouter({
        parentEmitter: vi.fn(),
        engineId: 'eng-1',
      });

      expect(router.shouldEmit('AgentMessageDelta')).toBe(false);
      expect(router.shouldEmit('AgentReasoningDelta')).toBe(false);
    });

    it('returns false for custom suppressed types', () => {
      const router = new SubAgentEventRouter({
        parentEmitter: vi.fn(),
        engineId: 'eng-1',
        suppressedTypes: ['ToolStart', 'ToolEnd'],
      });

      expect(router.shouldEmit('ToolStart')).toBe(false);
      expect(router.shouldEmit('ToolEnd')).toBe(false);
      expect(router.shouldEmit('AgentMessage')).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // routeEvent
  // ---------------------------------------------------------------------------

  describe('routeEvent', () => {
    it('namespaces event ID with engineId prefix', () => {
      const parentEmitter = vi.fn();
      const router = new SubAgentEventRouter({
        parentEmitter,
        engineId: 'sub-eng-42',
      });

      const event = makeEvent({ id: 'original-id' });
      const metadata = makeMetadata();

      router.routeEvent(event, metadata);

      expect(parentEmitter).toHaveBeenCalledTimes(1);
      const emitted = parentEmitter.mock.calls[0][0] as EngineEvent;
      expect(emitted.id).toBe('sub-eng-42:original-id');
    });

    it('adds _subAgent metadata with engineId, parentEngineId, and depth', () => {
      const parentEmitter = vi.fn();
      const router = new SubAgentEventRouter({
        parentEmitter,
        engineId: 'sub-eng-7',
      });

      const event = makeEvent();
      const metadata = makeMetadata({
        parentEngineId: 'parent-99',
        depth: 3,
      });

      router.routeEvent(event, metadata);

      const emitted = parentEmitter.mock.calls[0][0] as EngineEvent;
      expect(emitted.msg._subAgent).toEqual({
        engineId: 'sub-eng-7',
        parentEngineId: 'parent-99',
        depth: 3,
      });
    });

    it('uses default depth of 1 when metadata.depth is undefined', () => {
      const parentEmitter = vi.fn();
      const router = new SubAgentEventRouter({
        parentEmitter,
        engineId: 'sub-eng-1',
      });

      const event = makeEvent();
      const metadata = makeMetadata({ depth: undefined });

      router.routeEvent(event, metadata);

      const emitted = parentEmitter.mock.calls[0][0] as EngineEvent;
      expect(emitted.msg._subAgent!.depth).toBe(1);
    });

    it('preserves original event msg type and data', () => {
      const parentEmitter = vi.fn();
      const router = new SubAgentEventRouter({
        parentEmitter,
        engineId: 'sub-eng-1',
      });

      const event: EngineEvent = {
        id: 'evt-original',
        msg: {
          type: 'ToolResult',
          data: { toolName: 'search', result: 'found it' },
        },
      };
      const metadata = makeMetadata();

      router.routeEvent(event, metadata);

      const emitted = parentEmitter.mock.calls[0][0] as EngineEvent;
      expect(emitted.msg.type).toBe('ToolResult');
      expect(emitted.msg.data).toEqual({ toolName: 'search', result: 'found it' });
    });

    it('does not mutate the original event object', () => {
      const parentEmitter = vi.fn();
      const router = new SubAgentEventRouter({
        parentEmitter,
        engineId: 'sub-eng-1',
      });

      const event = makeEvent({ id: 'orig-id' });
      const metadata = makeMetadata();

      router.routeEvent(event, metadata);

      // Original event should be unchanged
      expect(event.id).toBe('orig-id');
      expect(event.msg._subAgent).toBeUndefined();
    });

    it('does NOT call parentEmitter for suppressed event types', () => {
      const parentEmitter = vi.fn();
      const router = new SubAgentEventRouter({
        parentEmitter,
        engineId: 'sub-eng-1',
      });

      const deltaEvent = makeEvent({ msgType: 'AgentMessageDelta' });
      const reasoningDeltaEvent = makeEvent({ msgType: 'AgentReasoningDelta' });
      const metadata = makeMetadata();

      router.routeEvent(deltaEvent, metadata);
      router.routeEvent(reasoningDeltaEvent, metadata);

      expect(parentEmitter).not.toHaveBeenCalled();
    });

    it('calls parentEmitter for non-suppressed event types', () => {
      const parentEmitter = vi.fn();
      const router = new SubAgentEventRouter({
        parentEmitter,
        engineId: 'sub-eng-1',
      });

      const event = makeEvent({ msgType: 'AgentMessage' });
      const metadata = makeMetadata();

      router.routeEvent(event, metadata);

      expect(parentEmitter).toHaveBeenCalledTimes(1);
    });

    it('handles parentEngineId being undefined in metadata', () => {
      const parentEmitter = vi.fn();
      const router = new SubAgentEventRouter({
        parentEmitter,
        engineId: 'sub-eng-1',
      });

      const event = makeEvent();
      const metadata: EventRoutingMetadata = {
        engineId: 'sub-eng-1',
        // parentEngineId is omitted
      };

      router.routeEvent(event, metadata);

      const emitted = parentEmitter.mock.calls[0][0] as EngineEvent;
      expect(emitted.msg._subAgent).toEqual({
        engineId: 'sub-eng-1',
        parentEngineId: undefined,
        depth: 1,
      });
    });

    it('routes multiple events independently', () => {
      const parentEmitter = vi.fn();
      const router = new SubAgentEventRouter({
        parentEmitter,
        engineId: 'sub-eng-1',
      });

      const event1 = makeEvent({ id: 'evt-1', msgType: 'AgentMessage' });
      const event2 = makeEvent({ id: 'evt-2', msgType: 'ToolCall' });
      const metadata = makeMetadata();

      router.routeEvent(event1, metadata);
      router.routeEvent(event2, metadata);

      expect(parentEmitter).toHaveBeenCalledTimes(2);
      expect((parentEmitter.mock.calls[0][0] as EngineEvent).id).toBe('sub-eng-1:evt-1');
      expect((parentEmitter.mock.calls[1][0] as EngineEvent).id).toBe('sub-eng-1:evt-2');
    });
  });
});
