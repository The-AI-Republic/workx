/**
 * Comprehensive tests for protocol schemas (schemas.ts) and config messages (config-messages.ts)
 */

import { describe, it, expect } from 'vitest';
import {
  InputItemSchema,
  ReviewDecisionSchema,
  ReasoningEffortConfigSchema,
  ReasoningSummaryConfigSchema,
  AskForApprovalSchema,
  SandboxPolicySchema,
  ReviewRequestSchema,
  OpSchema,
  SubmissionSchema,
  EventSchema,
  validateSubmission,
  parseSubmission,
  validateEvent,
  parseEvent,
} from '@/core/protocol/schemas';
import {
  generateMessageId,
  createConfigRequest,
  createConfigResponse,
  createConfigUpdate,
  createConfigChangeNotification,
} from '@/core/protocol/config-messages';
import type { IConfigChangeEvent } from '@/config/types';

// ============================================================================
// InputItemSchema
// ============================================================================
describe('InputItemSchema', () => {
  it('should parse a valid text input item', () => {
    const result = InputItemSchema.safeParse({ type: 'text', text: 'hello' });
    expect(result.success).toBe(true);
  });

  it('should parse a valid image input item', () => {
    const result = InputItemSchema.safeParse({ type: 'image', image_url: 'data:image/png;base64,abc' });
    expect(result.success).toBe(true);
  });

  it('should parse a valid clipboard input item with content', () => {
    const result = InputItemSchema.safeParse({ type: 'clipboard', content: 'pasted text' });
    expect(result.success).toBe(true);
  });

  it('should parse a clipboard input item without content (optional)', () => {
    const result = InputItemSchema.safeParse({ type: 'clipboard' });
    expect(result.success).toBe(true);
  });

  it('should parse a valid context input item with path', () => {
    const result = InputItemSchema.safeParse({ type: 'context', path: '/some/path' });
    expect(result.success).toBe(true);
  });

  it('should parse a context input item without path (optional)', () => {
    const result = InputItemSchema.safeParse({ type: 'context' });
    expect(result.success).toBe(true);
  });

  it('should reject an unknown input type', () => {
    const result = InputItemSchema.safeParse({ type: 'audio', data: 'bytes' });
    expect(result.success).toBe(false);
  });

  it('should reject text input missing the text field', () => {
    const result = InputItemSchema.safeParse({ type: 'text' });
    expect(result.success).toBe(false);
  });

  it('should reject image input missing the image_url field', () => {
    const result = InputItemSchema.safeParse({ type: 'image' });
    expect(result.success).toBe(false);
  });

  it('should reject an empty object', () => {
    const result = InputItemSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('should reject null', () => {
    const result = InputItemSchema.safeParse(null);
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// ReviewDecisionSchema
// ============================================================================
describe('ReviewDecisionSchema', () => {
  it('should parse "approve"', () => {
    expect(ReviewDecisionSchema.safeParse('approve').success).toBe(true);
  });

  it('should parse "reject"', () => {
    expect(ReviewDecisionSchema.safeParse('reject').success).toBe(true);
  });

  it('should parse "request_change"', () => {
    expect(ReviewDecisionSchema.safeParse('request_change').success).toBe(true);
  });

  it('should reject an invalid decision string', () => {
    expect(ReviewDecisionSchema.safeParse('maybe').success).toBe(false);
  });

  it('should reject a number', () => {
    expect(ReviewDecisionSchema.safeParse(42).success).toBe(false);
  });
});

// ============================================================================
// ReasoningEffortConfigSchema
// ============================================================================
describe('ReasoningEffortConfigSchema', () => {
  it('should parse { effort: "low" }', () => {
    expect(ReasoningEffortConfigSchema.safeParse({ effort: 'low' }).success).toBe(true);
  });

  it('should parse { effort: "medium" }', () => {
    expect(ReasoningEffortConfigSchema.safeParse({ effort: 'medium' }).success).toBe(true);
  });

  it('should parse { effort: "high" }', () => {
    expect(ReasoningEffortConfigSchema.safeParse({ effort: 'high' }).success).toBe(true);
  });

  it('should reject an invalid effort level', () => {
    expect(ReasoningEffortConfigSchema.safeParse({ effort: 'extreme' }).success).toBe(false);
  });

  it('should reject missing effort field', () => {
    expect(ReasoningEffortConfigSchema.safeParse({}).success).toBe(false);
  });
});

// ============================================================================
// ReasoningSummaryConfigSchema
// ============================================================================
describe('ReasoningSummaryConfigSchema', () => {
  it('should parse { enabled: true }', () => {
    expect(ReasoningSummaryConfigSchema.safeParse({ enabled: true }).success).toBe(true);
  });

  it('should parse { enabled: false }', () => {
    expect(ReasoningSummaryConfigSchema.safeParse({ enabled: false }).success).toBe(true);
  });

  it('should reject non-boolean enabled', () => {
    expect(ReasoningSummaryConfigSchema.safeParse({ enabled: 'yes' }).success).toBe(false);
  });

  it('should reject missing enabled field', () => {
    expect(ReasoningSummaryConfigSchema.safeParse({}).success).toBe(false);
  });
});

// ============================================================================
// AskForApprovalSchema
// ============================================================================
describe('AskForApprovalSchema', () => {
  const validValues = ['untrusted', 'on-failure', 'on-request', 'never'] as const;

  validValues.forEach((val) => {
    it(`should parse "${val}"`, () => {
      expect(AskForApprovalSchema.safeParse(val).success).toBe(true);
    });
  });

  it('should reject an invalid approval policy', () => {
    expect(AskForApprovalSchema.safeParse('always').success).toBe(false);
  });
});

// ============================================================================
// SandboxPolicySchema
// ============================================================================
describe('SandboxPolicySchema', () => {
  it('should parse danger-full-access mode', () => {
    const result = SandboxPolicySchema.safeParse({ mode: 'danger-full-access' });
    expect(result.success).toBe(true);
  });

  it('should parse read-only mode', () => {
    const result = SandboxPolicySchema.safeParse({ mode: 'read-only' });
    expect(result.success).toBe(true);
  });

  it('should parse workspace-write mode with all options', () => {
    const result = SandboxPolicySchema.safeParse({
      mode: 'workspace-write',
      writable_roots: ['/tmp', '/var'],
      network_access: true,
      exclude_tmpdir_env_var: false,
      exclude_slash_tmp: true,
    });
    expect(result.success).toBe(true);
  });

  it('should parse workspace-write mode without optional fields', () => {
    const result = SandboxPolicySchema.safeParse({ mode: 'workspace-write' });
    expect(result.success).toBe(true);
  });

  it('should reject an unknown mode', () => {
    const result = SandboxPolicySchema.safeParse({ mode: 'sandbox' });
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// ReviewRequestSchema
// ============================================================================
describe('ReviewRequestSchema', () => {
  it('should parse a valid review request with type', () => {
    const result = ReviewRequestSchema.safeParse({ id: 'r1', content: 'review this', type: 'code' });
    expect(result.success).toBe(true);
  });

  it('should parse a valid review request without type (optional)', () => {
    const result = ReviewRequestSchema.safeParse({ id: 'r2', content: 'please review' });
    expect(result.success).toBe(true);
  });

  it('should accept all valid review types', () => {
    for (const t of ['code', 'document', 'general']) {
      expect(ReviewRequestSchema.safeParse({ id: 'r', content: 'c', type: t }).success).toBe(true);
    }
  });

  it('should reject invalid review type', () => {
    const result = ReviewRequestSchema.safeParse({ id: 'r', content: 'c', type: 'unknown' });
    expect(result.success).toBe(false);
  });

  it('should reject missing id', () => {
    const result = ReviewRequestSchema.safeParse({ content: 'c' });
    expect(result.success).toBe(false);
  });

  it('should reject missing content', () => {
    const result = ReviewRequestSchema.safeParse({ id: 'r' });
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// OpSchema  (discriminated union on "type")
// ============================================================================
describe('OpSchema', () => {
  it('should parse Interrupt op', () => {
    expect(OpSchema.safeParse({ type: 'Interrupt' }).success).toBe(true);
  });

  it('should parse UserInput op', () => {
    const result = OpSchema.safeParse({
      type: 'UserInput',
      items: [{ type: 'text', text: 'hi' }],
    });
    expect(result.success).toBe(true);
  });

  it('should parse UserTurn op with all required fields', () => {
    const result = OpSchema.safeParse({
      type: 'UserTurn',
      items: [{ type: 'text', text: 'do something' }],
      tabId: 1,
      approval_policy: 'never',
      sandbox_policy: { mode: 'read-only' },
      model: 'gpt-4',
      summary: { enabled: true },
    });
    expect(result.success).toBe(true);
  });

  it('should parse UserTurn op with optional effort', () => {
    const result = OpSchema.safeParse({
      type: 'UserTurn',
      items: [],
      tabId: 2,
      approval_policy: 'untrusted',
      sandbox_policy: { mode: 'danger-full-access' },
      model: 'o3',
      effort: { effort: 'high' },
      summary: { enabled: false },
    });
    expect(result.success).toBe(true);
  });

  it('should reject UserTurn missing required model field', () => {
    const result = OpSchema.safeParse({
      type: 'UserTurn',
      items: [],
      tabId: 1,
      approval_policy: 'never',
      sandbox_policy: { mode: 'read-only' },
      summary: { enabled: true },
    });
    expect(result.success).toBe(false);
  });

  it('should parse OverrideTurnContext op with no optional fields', () => {
    expect(OpSchema.safeParse({ type: 'OverrideTurnContext' }).success).toBe(true);
  });

  it('should parse OverrideTurnContext op with effort set to null', () => {
    const result = OpSchema.safeParse({
      type: 'OverrideTurnContext',
      effort: null,
    });
    expect(result.success).toBe(true);
  });

  it('should parse ExecApproval op', () => {
    const result = OpSchema.safeParse({
      type: 'ExecApproval',
      id: 'exec-1',
      decision: 'approve',
      remember: true,
      alternativeText: 'run ls instead',
    });
    expect(result.success).toBe(true);
  });

  it('should parse PatchApproval op', () => {
    const result = OpSchema.safeParse({
      type: 'PatchApproval',
      id: 'patch-1',
      decision: 'reject',
    });
    expect(result.success).toBe(true);
  });

  it('should parse AddToHistory op', () => {
    expect(OpSchema.safeParse({ type: 'AddToHistory', text: 'note' }).success).toBe(true);
  });

  it('should parse GetHistoryEntryRequest op', () => {
    const result = OpSchema.safeParse({
      type: 'GetHistoryEntryRequest',
      offset: 0,
      log_id: 42,
    });
    expect(result.success).toBe(true);
  });

  it('should parse GetPath op', () => {
    expect(OpSchema.safeParse({ type: 'GetPath' }).success).toBe(true);
  });

  it('should parse ListMcpTools op', () => {
    expect(OpSchema.safeParse({ type: 'ListMcpTools' }).success).toBe(true);
  });

  it('should parse ListCustomPrompts op', () => {
    expect(OpSchema.safeParse({ type: 'ListCustomPrompts' }).success).toBe(true);
  });

  it('should parse Compact op', () => {
    expect(OpSchema.safeParse({ type: 'Compact' }).success).toBe(true);
  });

  it('should parse Review op', () => {
    const result = OpSchema.safeParse({
      type: 'Review',
      review_request: { id: 'rev1', content: 'check this' },
    });
    expect(result.success).toBe(true);
  });

  it('should parse Shutdown op', () => {
    expect(OpSchema.safeParse({ type: 'Shutdown' }).success).toBe(true);
  });

  it('should reject an unknown op type', () => {
    expect(OpSchema.safeParse({ type: 'DoNothing' }).success).toBe(false);
  });
});

// ============================================================================
// SubmissionSchema
// ============================================================================
describe('SubmissionSchema', () => {
  it('should parse a valid submission with Interrupt op', () => {
    const result = SubmissionSchema.safeParse({
      id: 'sub-1',
      op: { type: 'Interrupt' },
    });
    expect(result.success).toBe(true);
  });

  it('should reject a submission missing id', () => {
    const result = SubmissionSchema.safeParse({
      op: { type: 'Interrupt' },
    });
    expect(result.success).toBe(false);
  });

  it('should reject a submission missing op', () => {
    const result = SubmissionSchema.safeParse({ id: 'sub-2' });
    expect(result.success).toBe(false);
  });

  it('should reject a submission with invalid op', () => {
    const result = SubmissionSchema.safeParse({
      id: 'sub-3',
      op: { type: 'Invalid' },
    });
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// EventSchema
// ============================================================================
describe('EventSchema', () => {
  it('should parse a valid event', () => {
    const result = EventSchema.safeParse({
      id: 'evt-1',
      msg: { type: 'some_event' },
    });
    expect(result.success).toBe(true);
  });

  it('should parse an event with msg.data', () => {
    const result = EventSchema.safeParse({
      id: 'evt-2',
      msg: { type: 'data_event', data: { key: 'value' } },
    });
    expect(result.success).toBe(true);
  });

  it('should reject an event missing id', () => {
    const result = EventSchema.safeParse({
      msg: { type: 'x' },
    });
    expect(result.success).toBe(false);
  });

  it('should reject an event missing msg', () => {
    const result = EventSchema.safeParse({ id: 'e1' });
    expect(result.success).toBe(false);
  });

  it('should reject an event where msg.type is missing', () => {
    const result = EventSchema.safeParse({ id: 'e2', msg: {} });
    expect(result.success).toBe(false);
  });
});

// ============================================================================
// validateSubmission / parseSubmission
// ============================================================================
describe('validateSubmission', () => {
  it('should return true for a valid submission', () => {
    expect(validateSubmission({ id: 's1', op: { type: 'Compact' } })).toBe(true);
  });

  it('should return false for an invalid submission', () => {
    expect(validateSubmission({ id: 123, op: {} })).toBe(false);
  });

  it('should return false for null', () => {
    expect(validateSubmission(null)).toBe(false);
  });
});

describe('parseSubmission', () => {
  it('should return parsed data for a valid submission', () => {
    const result = parseSubmission({ id: 'ps1', op: { type: 'GetPath' } });
    expect(result).toEqual({ id: 'ps1', op: { type: 'GetPath' } });
  });

  it('should throw for an invalid submission', () => {
    expect(() => parseSubmission({ bad: true })).toThrow();
  });
});

// ============================================================================
// validateEvent / parseEvent
// ============================================================================
describe('validateEvent', () => {
  it('should return true for a valid event', () => {
    expect(validateEvent({ id: 'e1', msg: { type: 'test' } })).toBe(true);
  });

  it('should return false for an invalid event', () => {
    expect(validateEvent({})).toBe(false);
  });
});

describe('parseEvent', () => {
  it('should return parsed data for a valid event', () => {
    const result = parseEvent({ id: 'pe1', msg: { type: 'hello' } });
    expect(result).toEqual({ id: 'pe1', msg: { type: 'hello' } });
  });

  it('should throw for an invalid event', () => {
    expect(() => parseEvent('not an object')).toThrow();
  });
});

// ============================================================================
// config-messages.ts helpers
// ============================================================================
describe('generateMessageId', () => {
  it('should return a non-empty string', () => {
    const id = generateMessageId();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
  });

  it('should produce unique ids on successive calls', () => {
    const ids = new Set(Array.from({ length: 20 }, () => generateMessageId()));
    expect(ids.size).toBe(20);
  });
});

describe('createConfigRequest', () => {
  it('should create a CONFIG_REQUEST with required fields', () => {
    const msg = createConfigRequest('background');
    expect(msg.type).toBe('CONFIG_REQUEST');
    expect(msg.source).toBe('background');
    expect(msg.messageId).toBeTruthy();
    expect(typeof msg.timestamp).toBe('number');
  });

  it('should include sections when provided', () => {
    const msg = createConfigRequest('sidepanel', ['model', 'providers']);
    expect(msg.sections).toEqual(['model', 'providers']);
  });

  it('should leave sections undefined when not provided', () => {
    const msg = createConfigRequest('popup');
    expect(msg.sections).toBeUndefined();
  });
});

describe('createConfigResponse', () => {
  it('should create a CONFIG_RESPONSE with config and requestId', () => {
    const cfg = { version: '1.0' };
    const msg = createConfigResponse('background', cfg as any, 'req-123');
    expect(msg.type).toBe('CONFIG_RESPONSE');
    expect(msg.source).toBe('background');
    expect(msg.config).toEqual(cfg);
    expect(msg.requestId).toBe('req-123');
    expect(msg.messageId).toBeTruthy();
    expect(typeof msg.timestamp).toBe('number');
  });
});

describe('createConfigUpdate', () => {
  it('should create a CONFIG_UPDATE with broadcast default true', () => {
    const changes = { version: '2.0' };
    const msg = createConfigUpdate('content', changes as any);
    expect(msg.type).toBe('CONFIG_UPDATE');
    expect(msg.source).toBe('content');
    expect(msg.changes).toEqual(changes);
    expect(msg.broadcast).toBe(true);
  });

  it('should allow overriding broadcast to false', () => {
    const msg = createConfigUpdate('popup', {} as any, false);
    expect(msg.broadcast).toBe(false);
  });
});

describe('createConfigChangeNotification', () => {
  it('should create a CONFIG_CHANGE notification from an event', () => {
    const event: IConfigChangeEvent = {
      type: 'config-changed',
      generation: 1,
      section: 'model',
      oldValue: 'gpt-4',
      newValue: 'gpt-5',
      timestamp: 1000,
    };
    const msg = createConfigChangeNotification('background', event);
    expect(msg.type).toBe('CONFIG_CHANGE');
    expect(msg.source).toBe('background');
    expect(msg.section).toBe('model');
    expect(msg.changeType).toBe('updated');
    expect(msg.oldValue).toBe('gpt-4');
    expect(msg.newValue).toBe('gpt-5');
    expect(msg.messageId).toBeTruthy();
    expect(typeof msg.timestamp).toBe('number');
  });

  it('should handle event without oldValue', () => {
    const event: IConfigChangeEvent = {
      type: 'config-changed',
      generation: 2,
      section: 'provider',
      newValue: { id: 'openai' },
      timestamp: 2000,
    };
    const msg = createConfigChangeNotification('sidepanel', event);
    expect(msg.oldValue).toBeUndefined();
    expect(msg.newValue).toEqual({ id: 'openai' });
  });
});
