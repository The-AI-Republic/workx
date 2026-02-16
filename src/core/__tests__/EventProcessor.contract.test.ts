/**
 * EventProcessor Contract Tests (T017)
 *
 * These tests verify that the EventProcessor implementation conforms to the
 * IEventProcessor contract defined in the specification.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { EventProcessor } from '@/extension/sidepanel/components/event_display/EventProcessor';
import type { Event } from '@/protocol/types';

describe('EventProcessor Contract Tests', () => {
  let processor: EventProcessor;

  beforeEach(() => {
    processor = new EventProcessor();
  });

  it('should transform AgentMessage to ProcessedEvent with category message', () => {
    const event: Event = {
      id: 'evt_123',
      msg: {
        type: 'AgentMessage',
        data: { message: 'Test message' },
      },
    };

    const result = processor.processEvent(event);

    expect(result).not.toBeNull();
    expect(result?.category).toBe('message');
    expect(result?.title).toBe('browserx');
    expect(result?.content).toBe('Test message');
  });

  it('should accumulate AgentMessageDelta events', () => {
    // First delta - should return null (accumulating)
    const delta1: Event = {
      id: 'evt_200',
      msg: { type: 'AgentMessageDelta', data: { delta: 'Hello ' } },
    };
    const result1 = processor.processEvent(delta1);
    expect(result1).toBeNull();

    // Second delta - still accumulating
    const delta2: Event = {
      id: 'evt_201',
      msg: { type: 'AgentMessageDelta', data: { delta: 'world!' } },
    };
    const result2 = processor.processEvent(delta2);
    expect(result2).toBeNull();

    // Final message - should return accumulated content
    const final: Event = {
      id: 'evt_202',
      msg: { type: 'AgentMessage', data: { message: 'Hello world!' } },
    };
    const result3 = processor.processEvent(final);
    expect(result3).not.toBeNull();
    expect(result3?.content).toBe('Hello world!');
  });

  it('should correlate ExecCommand Begin/End events by call_id', () => {
    // Begin event
    const begin: Event = {
      id: 'evt_300',
      msg: {
        type: 'ExecCommandBegin',
        data: {
          session_id: 'exec_001',
          command: 'ls -la',
          cwd: '/home/user',
        },
      },
    };
    processor.processEvent(begin);

    // End event - should have metadata from Begin
    const end: Event = {
      id: 'evt_301',
      msg: {
        type: 'ExecCommandEnd',
        data: {
          session_id: 'exec_001',
          exit_code: 0,
          duration_ms: 42,
        },
      },
    };
    const result2 = processor.processEvent(end);

    expect(result2).not.toBeNull();
    expect(result2?.category).toBe('tool');
    expect(result2?.metadata?.command).toBe('ls -la');
    expect(result2?.metadata?.duration).toBe(42);
  });

  it('should process Error event with error category', () => {
    const event: Event = {
      id: 'evt_500',
      msg: {
        type: 'Error',
        data: { message: 'Something went wrong' },
      },
    };

    const result = processor.processEvent(event);

    expect(result).not.toBeNull();
    expect(result?.category).toBe('error');
    expect(result?.content).toContain('Something went wrong');
  });

  it('should process StreamError event with error field', () => {
    const event: Event = {
      id: 'evt_501',
      msg: {
        type: 'StreamError',
        data: {
          error: 'Stream connection failed',
          retrying: true,
          attempt: 2,
        },
      },
    };

    const result = processor.processEvent(event);

    expect(result).not.toBeNull();
    expect(result?.category).toBe('error');
    expect(result?.title).toBe('STREAM ERROR');
    expect(result?.content).toBe('Stream connection failed\nRetrying (attempt 2)');
    expect(result?.status).toBe('error');
  });

  it('should process StreamError event without retrying', () => {
    const event: Event = {
      id: 'evt_502',
      msg: {
        type: 'StreamError',
        data: {
          error: 'Stream terminated',
          retrying: false,
        },
      },
    };

    const result = processor.processEvent(event);

    expect(result).not.toBeNull();
    expect(result?.content).toBe('Stream terminated');
  });

  it('should clear state on reset', () => {
    // Create some state
    const delta: Event = {
      id: 'evt_600',
      msg: { type: 'AgentMessageDelta', data: { delta: 'Test' } },
    };
    processor.processEvent(delta);

    // Verify state exists
    const stateBefore = processor.getStreamingState();
    expect(stateBefore.size).toBeGreaterThan(0);

    // Reset
    processor.reset();

    // Verify state cleared
    const stateAfter = processor.getStreamingState();
    expect(stateAfter.size).toBe(0);
  });

  it('should handle unknown event types gracefully', () => {
    const event: Event = {
      id: 'evt_999',
      msg: {
        type: 'UnknownEventType' as any,
        data: {},
      },
    };

    // Should not throw
    const result = processor.processEvent(event);

    // Should return a system event
    expect(result).not.toBeNull();
    expect(result?.category).toBe('system');
  });

  // Additional tests for comprehensive coverage

  it('should handle TaskStarted events', () => {
    const event: Event = {
      id: 'evt_task_1',
      msg: {
        type: 'TaskStarted',
        data: {
          model: 'claude-sonnet-4-5',
          cwd: '/workspace',
        },
      },
    };

    const result = processor.processEvent(event);

    expect(result).not.toBeNull();
    expect(result?.category).toBe('task');
    expect(result?.status).toBe('running');
  });

  it('should handle TaskComplete events with token usage', () => {
    const event: Event = {
      id: 'evt_task_2',
      msg: {
        type: 'TaskComplete',
        data: {
          turn_count: 3,
          token_usage: {
            total: {
              input_tokens: 1234,
              output_tokens: 567,
              total_tokens: 1801,
            },
          },
        },
      },
    };

    const result = processor.processEvent(event);

    expect(result).not.toBeNull();
    expect(result?.category).toBe('task');
    expect(result?.status).toBe('success');
    expect(result?.metadata?.tokenUsage?.total).toBe(1801);
  });

  it('should handle reasoning events with showReasoning flag', () => {
    processor.setShowReasoning(false);

    const event: Event = {
      id: 'evt_reasoning_1',
      msg: {
        type: 'AgentReasoning',
        data: { reasoning: 'Thinking about the problem...' },
      },
    };

    const result = processor.processEvent(event);

    // Should return null when showReasoning is false
    expect(result).toBeNull();

    // Enable reasoning
    processor.setShowReasoning(true);
    const result2 = processor.processEvent(event);

    expect(result2).not.toBeNull();
    expect(result2?.category).toBe('reasoning');
  });

  it('should handle MCP tool calls', () => {
    const begin: Event = {
      id: 'evt_tool_1',
      msg: {
        type: 'McpToolCallBegin',
        data: {
          call_id: 'tool_001',
          tool_name: 'Read',
          params: { file_path: '/test.txt' },
        },
      },
    };
    processor.processEvent(begin);

    const end: Event = {
      id: 'evt_tool_2',
      msg: {
        type: 'McpToolCallEnd',
        data: {
          call_id: 'tool_001',
          result: 'File contents',
          duration_ms: 15,
        },
      },
    };

    const result = processor.processEvent(end);

    expect(result).not.toBeNull();
    expect(result?.category).toBe('tool');
    expect(result?.metadata?.toolName).toBe('Read');
    expect(result?.metadata?.duration).toBe(15);
  });

  it('should handle approval requests', () => {
    const event: Event = {
      id: 'evt_approval_1',
      msg: {
        type: 'ExecApprovalRequest',
        data: {
          command: 'rm -rf /',
          explanation: 'This will delete all files',
        },
      },
    };

    const result = processor.processEvent(event);

    expect(result).not.toBeNull();
    expect(result?.category).toBe('approval');
    expect(result?.requiresApproval).toBeDefined();
    expect(result?.requiresApproval?.type).toBe('exec');
    expect(result?.requiresApproval?.command).toBe('rm -rf /');
  });

  it('should handle TokenCount events', () => {
    const event: Event = {
      id: 'evt_token_1',
      msg: {
        type: 'TokenCount',
        data: {
          info: {
            total_token_usage: {
              input_tokens: 1234,
              cached_input_tokens: 500,
              output_tokens: 678,
              reasoning_output_tokens: 123,
              total_tokens: 2035,
            },
          },
        },
      },
    };

    const result = processor.processEvent(event);

    expect(result).not.toBeNull();
    expect(result?.category).toBe('system');
    expect(result?.content).toContain('2,035');
  });

  it('should handle orphaned End events gracefully', () => {
    // End event without corresponding Begin
    const end: Event = {
      id: 'evt_orphan_1',
      msg: {
        type: 'ExecCommandEnd',
        data: {
          session_id: 'unknown_session',
          exit_code: 0,
          duration_ms: 100,
        },
      },
    };

    const result = processor.processEvent(end);

    // Should still create an event even without Begin
    expect(result).not.toBeNull();
    expect(result?.category).toBe('tool');
  });

  it('should accumulate command output in operation state', () => {
    const begin: Event = {
      id: 'evt_cmd_1',
      msg: {
        type: 'ExecCommandBegin',
        data: {
          session_id: 'cmd_001',
          command: 'echo test',
          cwd: '/home',
        },
      },
    };
    processor.processEvent(begin);

    const output1: Event = {
      id: 'evt_cmd_2',
      msg: {
        type: 'ExecCommandOutputDelta',
        data: {
          session_id: 'cmd_001',
          output: 'line 1\n',
          stream: 'stdout',
        },
      },
    };
    processor.processEvent(output1);

    const output2: Event = {
      id: 'evt_cmd_3',
      msg: {
        type: 'ExecCommandOutputDelta',
        data: {
          session_id: 'cmd_001',
          output: 'line 2\n',
          stream: 'stdout',
        },
      },
    };
    processor.processEvent(output2);

    const end: Event = {
      id: 'evt_cmd_4',
      msg: {
        type: 'ExecCommandEnd',
        data: {
          session_id: 'cmd_001',
          exit_code: 0,
          duration_ms: 50,
        },
      },
    };

    const result = processor.processEvent(end);

    expect(result).not.toBeNull();
    expect(result?.content).toContain('line 1');
    expect(result?.content).toContain('line 2');
  });
});
