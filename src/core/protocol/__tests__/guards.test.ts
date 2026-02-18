import { describe, it, expect } from 'vitest';
import {
  isSubmission,
  isEvent,
  isOp,
  isInputItem,
  isEventMsg,
  isUserInputOp,
  isUserTurnOp,
  isInterruptOp,
  isTaskStartedEvent,
  isTaskCompleteEvent,
  isAgentMessageEvent,
  isErrorEvent,
} from '@/core/protocol/guards';

describe('guards', () => {
  // ── isSubmission ──────────────────────────────────────────────────────

  describe('isSubmission', () => {
    it('should return true for a valid Submission with Interrupt op', () => {
      expect(isSubmission({ id: 'sub-1', op: { type: 'Interrupt' } })).toBe(true);
    });

    it('should return true for a Submission with optional context', () => {
      expect(
        isSubmission({
          id: 'sub-2',
          op: { type: 'UserInput', items: [] },
          context: { tabId: 1, sessionId: 's1' },
        })
      ).toBe(true);
    });

    it('should return falsy for null', () => {
      expect(isSubmission(null)).toBeFalsy();
    });

    it('should return falsy for undefined', () => {
      expect(isSubmission(undefined)).toBeFalsy();
    });

    it('should return falsy for an empty object', () => {
      expect(isSubmission({})).toBeFalsy();
    });

    it('should return falsy when id is missing', () => {
      expect(isSubmission({ op: { type: 'Interrupt' } })).toBeFalsy();
    });

    it('should return falsy when id is not a string', () => {
      expect(isSubmission({ id: 123, op: { type: 'Interrupt' } })).toBeFalsy();
    });

    it('should return falsy when op is missing', () => {
      expect(isSubmission({ id: 'sub-3' })).toBeFalsy();
    });

    it('should return falsy when op is not an object', () => {
      expect(isSubmission({ id: 'sub-4', op: 'not-an-object' })).toBeFalsy();
    });

    it('should return falsy for primitive values', () => {
      expect(isSubmission(42)).toBeFalsy();
      expect(isSubmission('string')).toBeFalsy();
      expect(isSubmission(true)).toBeFalsy();
    });

    it('should return falsy when op is null', () => {
      expect(isSubmission({ id: 'sub-5', op: null })).toBeFalsy();
    });

    it('should return truthy when op is an array (typeof array is object)', () => {
      // Arrays pass the typeof === 'object' check, so the guard accepts them
      expect(isSubmission({ id: 'sub-6', op: [1, 2] })).toBeTruthy();
    });
  });

  // ── isEvent ───────────────────────────────────────────────────────────

  describe('isEvent', () => {
    it('should return true for a valid Event', () => {
      expect(isEvent({ id: 'evt-1', msg: { type: 'TaskStarted' } })).toBe(true);
    });

    it('should return true for an Event with data payload', () => {
      expect(
        isEvent({ id: 'evt-2', msg: { type: 'Error', data: { message: 'oops' } } })
      ).toBe(true);
    });

    it('should return falsy for null', () => {
      expect(isEvent(null)).toBeFalsy();
    });

    it('should return falsy for undefined', () => {
      expect(isEvent(undefined)).toBeFalsy();
    });

    it('should return falsy for an empty object', () => {
      expect(isEvent({})).toBeFalsy();
    });

    it('should return falsy when id is not a string', () => {
      expect(isEvent({ id: 999, msg: { type: 'Error' } })).toBeFalsy();
    });

    it('should return falsy when msg is missing', () => {
      expect(isEvent({ id: 'evt-3' })).toBeFalsy();
    });

    it('should return falsy when msg is not an object', () => {
      expect(isEvent({ id: 'evt-4', msg: 'not-an-object' })).toBeFalsy();
    });

    it('should return falsy for a numeric primitive', () => {
      expect(isEvent(0)).toBeFalsy();
    });

    it('should return falsy when msg is null', () => {
      expect(isEvent({ id: 'evt-5', msg: null })).toBeFalsy();
    });
  });

  // ── isOp ──────────────────────────────────────────────────────────────

  describe('isOp', () => {
    it('should return true for a minimal Op with a type string', () => {
      expect(isOp({ type: 'Interrupt' })).toBe(true);
    });

    it('should return true for a UserInput Op', () => {
      expect(isOp({ type: 'UserInput', items: [] })).toBe(true);
    });

    it('should return true for a Shutdown Op', () => {
      expect(isOp({ type: 'Shutdown' })).toBe(true);
    });

    it('should return true for an arbitrary type string', () => {
      expect(isOp({ type: 'CustomOp' })).toBe(true);
    });

    it('should return falsy for null', () => {
      expect(isOp(null)).toBeFalsy();
    });

    it('should return falsy for undefined', () => {
      expect(isOp(undefined)).toBeFalsy();
    });

    it('should return falsy for an empty object (no type)', () => {
      expect(isOp({})).toBeFalsy();
    });

    it('should return falsy when type is not a string', () => {
      expect(isOp({ type: 123 })).toBeFalsy();
    });

    it('should return falsy for an array', () => {
      expect(isOp([{ type: 'Interrupt' }])).toBeFalsy();
    });
  });

  // ── isInputItem ───────────────────────────────────────────────────────

  describe('isInputItem', () => {
    it('should return true for a text InputItem', () => {
      expect(isInputItem({ type: 'text', text: 'hello' })).toBe(true);
    });

    it('should return true for an image InputItem', () => {
      expect(isInputItem({ type: 'image', image_url: 'data:image/png;base64,...' })).toBe(true);
    });

    it('should return true for a clipboard InputItem', () => {
      expect(isInputItem({ type: 'clipboard', content: 'pasted' })).toBe(true);
    });

    it('should return true for a context InputItem', () => {
      expect(isInputItem({ type: 'context', path: '/some/path' })).toBe(true);
    });

    it('should return false for an unrecognized type string', () => {
      expect(isInputItem({ type: 'audio' })).toBe(false);
    });

    it('should return false for a type that is a valid Op type but not InputItem', () => {
      expect(isInputItem({ type: 'Interrupt' })).toBe(false);
    });

    it('should return false for an empty string type', () => {
      expect(isInputItem({ type: '' })).toBe(false);
    });

    it('should return falsy for null', () => {
      expect(isInputItem(null)).toBeFalsy();
    });

    it('should return falsy for undefined', () => {
      expect(isInputItem(undefined)).toBeFalsy();
    });

    it('should return falsy for an empty object', () => {
      expect(isInputItem({})).toBeFalsy();
    });

    it('should return falsy when type is not a string', () => {
      expect(isInputItem({ type: 42 })).toBeFalsy();
    });
  });

  // ── isEventMsg ────────────────────────────────────────────────────────

  describe('isEventMsg', () => {
    it('should return true for a valid EventMsg with data', () => {
      expect(isEventMsg({ type: 'TaskStarted', data: {} })).toBe(true);
    });

    it('should return true for ShutdownComplete (no data field)', () => {
      expect(isEventMsg({ type: 'ShutdownComplete' })).toBe(true);
    });

    it('should return true for an Interrupted EventMsg', () => {
      expect(isEventMsg({ type: 'Interrupted' })).toBe(true);
    });

    it('should return falsy for null', () => {
      expect(isEventMsg(null)).toBeFalsy();
    });

    it('should return falsy for undefined', () => {
      expect(isEventMsg(undefined)).toBeFalsy();
    });

    it('should return falsy for an empty object', () => {
      expect(isEventMsg({})).toBeFalsy();
    });

    it('should return falsy when type is not a string', () => {
      expect(isEventMsg({ type: true })).toBeFalsy();
    });
  });

  // ── isUserInputOp ─────────────────────────────────────────────────────

  describe('isUserInputOp', () => {
    it('should return true for a UserInput Op', () => {
      expect(isUserInputOp({ type: 'UserInput', items: [] } as any)).toBe(true);
    });

    it('should return false for an Interrupt Op', () => {
      expect(isUserInputOp({ type: 'Interrupt' } as any)).toBe(false);
    });

    it('should return false for a UserTurn Op', () => {
      expect(isUserInputOp({ type: 'UserTurn' } as any)).toBe(false);
    });

    it('should return false for a Shutdown Op', () => {
      expect(isUserInputOp({ type: 'Shutdown' } as any)).toBe(false);
    });
  });

  // ── isUserTurnOp ──────────────────────────────────────────────────────

  describe('isUserTurnOp', () => {
    it('should return true for a UserTurn Op', () => {
      expect(
        isUserTurnOp({
          type: 'UserTurn',
          items: [],
          tabId: 1,
          approval_policy: 'never',
          sandbox_policy: { mode: 'read-only' },
          model: 'gpt-4',
          summary: { enabled: false },
        } as any)
      ).toBe(true);
    });

    it('should return false for a UserInput Op', () => {
      expect(isUserTurnOp({ type: 'UserInput', items: [] } as any)).toBe(false);
    });

    it('should return false for an Interrupt Op', () => {
      expect(isUserTurnOp({ type: 'Interrupt' } as any)).toBe(false);
    });
  });

  // ── isInterruptOp ─────────────────────────────────────────────────────

  describe('isInterruptOp', () => {
    it('should return true for an Interrupt Op', () => {
      expect(isInterruptOp({ type: 'Interrupt' } as any)).toBe(true);
    });

    it('should return false for a UserInput Op', () => {
      expect(isInterruptOp({ type: 'UserInput', items: [] } as any)).toBe(false);
    });

    it('should return false for a Shutdown Op', () => {
      expect(isInterruptOp({ type: 'Shutdown' } as any)).toBe(false);
    });
  });

  // ── isTaskStartedEvent ────────────────────────────────────────────────

  describe('isTaskStartedEvent', () => {
    it('should return true for a TaskStarted EventMsg', () => {
      expect(isTaskStartedEvent({ type: 'TaskStarted', data: {} } as any)).toBe(true);
    });

    it('should return false for a TaskComplete EventMsg', () => {
      expect(isTaskStartedEvent({ type: 'TaskComplete', data: {} } as any)).toBe(false);
    });

    it('should return false for an Error EventMsg', () => {
      expect(isTaskStartedEvent({ type: 'Error', data: { message: '' } } as any)).toBe(false);
    });
  });

  // ── isTaskCompleteEvent ───────────────────────────────────────────────

  describe('isTaskCompleteEvent', () => {
    it('should return true for a TaskComplete EventMsg', () => {
      expect(isTaskCompleteEvent({ type: 'TaskComplete', data: {} } as any)).toBe(true);
    });

    it('should return false for a TaskStarted EventMsg', () => {
      expect(isTaskCompleteEvent({ type: 'TaskStarted', data: {} } as any)).toBe(false);
    });

    it('should return false for an AgentMessage EventMsg', () => {
      expect(
        isTaskCompleteEvent({ type: 'AgentMessage', data: { message: 'hi' } } as any)
      ).toBe(false);
    });
  });

  // ── isAgentMessageEvent ───────────────────────────────────────────────

  describe('isAgentMessageEvent', () => {
    it('should return true for an AgentMessage EventMsg', () => {
      expect(
        isAgentMessageEvent({ type: 'AgentMessage', data: { message: 'hi' } } as any)
      ).toBe(true);
    });

    it('should return false for a TaskStarted EventMsg', () => {
      expect(isAgentMessageEvent({ type: 'TaskStarted', data: {} } as any)).toBe(false);
    });

    it('should return false for an Error EventMsg', () => {
      expect(isAgentMessageEvent({ type: 'Error', data: { message: '' } } as any)).toBe(false);
    });
  });

  // ── isErrorEvent ──────────────────────────────────────────────────────

  describe('isErrorEvent', () => {
    it('should return true for an Error EventMsg', () => {
      expect(isErrorEvent({ type: 'Error', data: { message: 'fail' } } as any)).toBe(true);
    });

    it('should return false for a TaskStarted EventMsg', () => {
      expect(isErrorEvent({ type: 'TaskStarted', data: {} } as any)).toBe(false);
    });

    it('should return false for an AgentMessage EventMsg', () => {
      expect(
        isErrorEvent({ type: 'AgentMessage', data: { message: '' } } as any)
      ).toBe(false);
    });

    it('should return false for a TaskComplete EventMsg', () => {
      expect(isErrorEvent({ type: 'TaskComplete', data: {} } as any)).toBe(false);
    });
  });
});
