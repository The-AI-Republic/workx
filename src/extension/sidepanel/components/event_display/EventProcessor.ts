/**
 * EventProcessor - Transforms raw protocol events into UI-ready ProcessedEvent objects
 *
 * This class manages state for:
 * - Multi-event operations (Begin → Delta → End sequences)
 * - Streaming content accumulation (message and reasoning deltas)
 * - Event categorization and styling
 */

import type { Event } from '@/core/protocol/types';
import type { EventMsg } from '@/core/protocol/events';
import type {
  ProcessedEvent,
  EventDisplayCategory,
  OperationState,
  StreamingState,
  EventStyle,
  EventMetadata,
} from '@/types/ui';
import { STYLE_PRESETS } from '@/types/ui';

/**
 * EventProcessor Implementation
 */
export class EventProcessor {
  // State management
  private operationMetadata = new Map<string, OperationState>();
  private streamingStates = new Map<string, StreamingState>();

  // Configuration
  private showReasoning: boolean = true;
  private maxOutputLines: number = 20;

  /**
   * Process a single event and return a ProcessedEvent ready for UI display
   */
  processEvent(event: Event): ProcessedEvent | null {
    // Defensive check for event structure
    if (!event || !event.msg) {
      console.error('Invalid event structure:', event);
      return null;
    }

    const msg = event.msg;
    const category = this.getCategoryForEvent(msg);

    // Handle different categories
    switch (category) {
      case 'message':
        return this.processMessageEvent(event);
      case 'error':
        return this.processErrorEvent(event);
      case 'task':
        return this.processTaskEvent(event);
      case 'tool':
        return this.processToolEvent(event);
      case 'reasoning':
        return this.processReasoningEvent(event);
      case 'output':
        return this.processOutputEvent(event);
      case 'approval':
        return this.processApprovalEvent(event);
      case 'plan':
        return this.processPlanEvent(event);
      case 'system':
        return this.processSystemEvent(event);
      default:
        return this.processUnknownEvent(event);
    }
  }

  /**
   * Reset processor state (clear all operation and streaming state)
   */
  reset(): void {
    this.operationMetadata.clear();
    this.streamingStates.clear();
  }

  /**
   * Get current streaming state (for debugging/testing)
   */
  getStreamingState(): Map<string, StreamingState> {
    return new Map(this.streamingStates);
  }

  /**
   * Get current operation states (for debugging/testing)
   */
  getOperationState(): Map<string, OperationState> {
    return new Map(this.operationMetadata);
  }

  /**
   * Set whether to show agent reasoning events
   */
  setShowReasoning(show: boolean): void {
    this.showReasoning = show;
  }

  /**
   * Set maximum lines to display for command output
   */
  setMaxOutputLines(maxLines: number): void {
    this.maxOutputLines = maxLines;
  }

  /**
   * Determine event category based on event type
   */
  private getCategoryForEvent(msg: EventMsg): EventDisplayCategory {
    switch (msg.type) {
      // Task lifecycle
      case 'TaskStarted':
      case 'TaskComplete':
      case 'TaskFailed':
      case 'TurnAborted':
        return 'task';

      // Agent messages
      case 'AgentMessage':
      case 'AgentMessageDelta':
      case 'UserMessage':
        return 'message';

      // Agent reasoning
      case 'AgentReasoning':
      case 'AgentReasoningDelta':
      case 'AgentReasoningRawContent':
      case 'AgentReasoningRawContentDelta':
      case 'AgentReasoningSectionBreak':
        return 'reasoning';

      // Tool calls
      case 'McpToolCallBegin':
      case 'McpToolCallEnd':
      case 'ExecCommandBegin':
      case 'ExecCommandEnd':
      case 'WebSearchBegin':
      case 'WebSearchEnd':
      case 'PatchApplyBegin':
      case 'PatchApplyEnd':
      case 'ToolExecutionStart':
      case 'ToolExecutionEnd':
      case 'ToolExecutionError':
      case 'ToolExecutionTimeout':
        return 'tool';

      // Command output
      case 'ExecCommandOutputDelta':
        return 'output';

      // Errors
      case 'Error':
      case 'StreamError':
        return 'error';

      // Approvals
      case 'ExecApprovalRequest':
      case 'ApplyPatchApprovalRequest':
      case 'ApprovalRequested':
        return 'approval';

      // Plan events
      case 'PlanUpdate':
        return 'plan';

      // System events
      case 'TokenCount':
      case 'Notification':
      case 'SessionConfigured':
      case 'BackgroundEvent':
      case 'TurnDiff':
      case 'GetHistoryEntryResponse':
      case 'McpListToolsResponse':
      case 'ListCustomPromptsResponse':
      case 'ShutdownComplete':
      case 'ConversationPath':
      case 'EnteredReviewMode':
      case 'ExitedReviewMode':
      case 'Interrupted':
      case 'ToolRegistered':
      case 'ToolUnregistered':
        return 'system';

      default:
        console.warn(`Unknown event type: ${(msg as any).type}`);
        return 'system';
    }
  }

  /**
   * Process message category events
   */
  private processMessageEvent(event: Event): ProcessedEvent | null {
    const msg = event.msg;

    if (msg.type === 'AgentMessageDelta') {
      // Accumulate delta in streaming state
      const key = 'message';
      let state = this.streamingStates.get(key);

      if (!state) {
        state = {
          type: 'message',
          buffer: '',
          startTime: new Date(),
          lastUpdateTime: new Date(),
          headerShown: false,
        };
        this.streamingStates.set(key, state);
      }

      state.buffer += msg.data.delta || '';
      state.lastUpdateTime = new Date();

      // Return null - we'll create ProcessedEvent when final message arrives
      return null;
    }

    if (msg.type === 'AgentMessage') {
      // Final message - get accumulated content
      const key = 'message';
      const state = this.streamingStates.get(key);
      const content = msg.data.message || state?.buffer || '';

      // Clear streaming state
      this.streamingStates.delete(key);

      return {
        id: event.id,
        category: 'message',
        timestamp: new Date(),
        title: 'browserx',
        content: content,
        style: STYLE_PRESETS.agent_message,
        streaming: false,
        collapsible: false,
      };
    }

    if (msg.type === 'UserMessage') {
      return {
        id: event.id,
        category: 'message',
        timestamp: new Date(),
        title: 'user',
        content: msg.data.message || '',
        style: { textColor: 'text-cyan-400' },
        streaming: false,
        collapsible: false,
      };
    }

    return null;
  }

  /**
   * Process error category events
   */
  private processErrorEvent(event: Event): ProcessedEvent | null {
    const msg = event.msg;

    if (msg.type === 'Error') {
      return {
        id: event.id,
        category: 'error',
        timestamp: new Date(),
        title: 'ERROR',
        content: msg.data.message,
        style: STYLE_PRESETS.error,
        status: 'error',
        collapsible: false,
      };
    }

    if (msg.type === 'StreamError') {
      const lines: string[] = [msg.data.error];

      if (msg.data.retrying) {
        const hasRetryMetadata =
          typeof msg.data.attempt === 'number' ||
          typeof msg.data.delayMs === 'number' ||
          typeof msg.data.maxRetries === 'number';
        const mentionsRetry = /\bretry/i.test(msg.data.error);

        if (hasRetryMetadata) {
          let retryLine = 'Retrying';

          if (typeof msg.data.attempt === 'number') {
            if (typeof msg.data.maxRetries === 'number') {
              retryLine += ` (attempt ${msg.data.attempt}/${msg.data.maxRetries})`;
            } else {
              retryLine += ` (attempt ${msg.data.attempt})`;
            }
          }

          if (typeof msg.data.delayMs === 'number') {
            retryLine += ` in ${msg.data.delayMs}ms`;
          }

          lines.push(retryLine);
        } else if (!mentionsRetry) {
          lines.push('Retrying');
        }
      }

      return {
        id: event.id,
        category: 'error',
        timestamp: new Date(),
        title: 'STREAM ERROR',
        content: lines.join('\n'),
        style: STYLE_PRESETS.error,
        status: 'error',
        collapsible: false,
      };
    }

    return null;
  }

  /**
   * Process task lifecycle events
   */
  private processTaskEvent(event: Event): ProcessedEvent | null {
    const msg = event.msg;

    if (msg.type === 'TaskStarted') {
      const metadata: EventMetadata = {
        model: msg.data.model,
        tabId: msg.data.tabId, // Replaced workingDir/cwd with tabId
      };

      return {
        id: event.id,
        category: 'task',
        timestamp: new Date(),
        title: 'Task started',
        content: `Model: ${msg.data.model || 'unknown'}`,
        style: STYLE_PRESETS.task_started,
        status: 'running',
        metadata,
        collapsible: false,
      };
    }

    if (msg.type === 'TaskComplete') {
      const tokenUsage = msg.data.token_usage?.total;
      const metadata: EventMetadata = {
        turnCount: msg.data.turn_count,
        tokenUsage: tokenUsage
          ? {
              input: tokenUsage.input_tokens || 0,
              cached: tokenUsage.cached_input_tokens || 0,
              output: tokenUsage.output_tokens || 0,
              reasoning: tokenUsage.reasoning_output_tokens || 0,
              total: tokenUsage.total_tokens || 0,
            }
          : undefined,
      };

      let content = `Task completed in ${msg.data.turn_count || 0} turn(s)`;
      if (tokenUsage) {
        content += `\nTokens: ${tokenUsage.total_tokens?.toLocaleString() || 0}`;
      }

      return {
        id: event.id,
        category: 'task',
        timestamp: new Date(),
        title: 'Task complete',
        content,
        style: STYLE_PRESETS.task_complete,
        status: 'success',
        metadata,
        collapsible: false,
      };
    }

    if (msg.type === 'TaskFailed') {
      return {
        id: event.id,
        category: 'task',
        timestamp: new Date(),
        title: 'Task failed',
        content: msg.data.message || 'Task failed',
        style: STYLE_PRESETS.task_failed,
        status: 'error',
        collapsible: false,
      };
    }

    return null;
  }

  /**
   * Process tool call events
   */
  private processToolEvent(event: Event): ProcessedEvent | null {
    const msg = event.msg;

    // Handle Begin events
    if (msg.type === 'ExecCommandBegin') {
      const state: OperationState = {
        callId: msg.data.session_id,
        type: 'exec',
        startTime: new Date(),
        buffer: '',
        metadata: {
          command: msg.data.command,
          // Removed workingDir/cwd - not applicable in browser context
        },
      };
      this.operationMetadata.set(msg.data.session_id, state);
      return null; // Wait for End event
    }

    if (msg.type === 'McpToolCallBegin') {
      const state: OperationState = {
        callId: msg.data.call_id,
        type: 'tool',
        startTime: new Date(),
        buffer: '',
        metadata: {
          toolName: msg.data.tool_name,
          toolParams: msg.data.params,
        },
      };
      this.operationMetadata.set(msg.data.call_id, state);
      return null;
    }

    if (msg.type === 'PatchApplyBegin') {
      const state: OperationState = {
        callId: msg.data.session_id,
        type: 'patch',
        startTime: new Date(),
        buffer: '',
        metadata: {
          filesChanged: msg.data.num_files,
        },
      };
      this.operationMetadata.set(msg.data.session_id, state);
      return null;
    }

    // Handle End events
    if (msg.type === 'ExecCommandEnd') {
      const state = this.operationMetadata.get(msg.data.session_id);
      this.operationMetadata.delete(msg.data.session_id);

      if (!state) {
        // Orphaned End event - create standalone event
        return {
          id: event.id,
          category: 'tool',
          timestamp: new Date(),
          title: 'exec (unknown command)',
          content: 'Command completed',
          style:
            msg.data.exit_code === 0 ? STYLE_PRESETS.tool_success : STYLE_PRESETS.tool_error,
          status: msg.data.exit_code === 0 ? 'success' : 'error',
          collapsible: false,
        };
      }

      const duration = new Date().getTime() - state.startTime.getTime();
      const metadata: EventMetadata = {
        command: state.metadata.command as string,
        exitCode: msg.data.exit_code,
        workingDir: state.metadata.workingDir as string,
        duration: msg.data.duration_ms || duration,
      };

      return {
        id: event.id,
        category: 'tool',
        timestamp: new Date(),
        title: `exec ${state.metadata.command || 'command'}`,
        content: state.buffer || '(no output)',
        style: msg.data.exit_code === 0 ? STYLE_PRESETS.tool_success : STYLE_PRESETS.tool_error,
        status: msg.data.exit_code === 0 ? 'success' : 'error',
        metadata,
        collapsible: true,
        collapsed: false,
      };
    }

    if (msg.type === 'McpToolCallEnd') {
      const state = this.operationMetadata.get(msg.data.call_id);
      this.operationMetadata.delete(msg.data.call_id);

      const duration = state ? new Date().getTime() - state.startTime.getTime() : 0;
      const metadata: EventMetadata = {
        toolName: state?.metadata.toolName as string,
        duration: msg.data.duration_ms || duration,
      };

      const success = !msg.data.error;

      return {
        id: event.id,
        category: 'tool',
        timestamp: new Date(),
        title: `tool ${state?.metadata.toolName || 'unknown'}`,
        content: msg.data.error || msg.data.result || '(no result)',
        style: success ? STYLE_PRESETS.tool_success : STYLE_PRESETS.tool_error,
        status: success ? 'success' : 'error',
        metadata,
        collapsible: true,
        collapsed: false,
      };
    }

    if (msg.type === 'PatchApplyEnd') {
      const state = this.operationMetadata.get(msg.data.session_id);
      this.operationMetadata.delete(msg.data.session_id);

      const duration = state ? new Date().getTime() - state.startTime.getTime() : 0;

      return {
        id: event.id,
        category: 'tool',
        timestamp: new Date(),
        title: 'patch apply',
        content: msg.data.error || 'Patch applied successfully',
        style: msg.data.error ? STYLE_PRESETS.tool_error : STYLE_PRESETS.tool_success,
        status: msg.data.error ? 'error' : 'success',
        metadata: { duration },
        collapsible: true,
        collapsed: false,
      };
    }

    if (msg.type === 'WebSearchBegin' || msg.type === 'WebSearchEnd') {
      // Simple handling for web search events
      return {
        id: event.id,
        category: 'tool',
        timestamp: new Date(),
        title: 'web search',
        content:
          msg.type === 'WebSearchEnd'
            ? msg.data.result || msg.data.error || 'Search complete'
            : 'Searching...',
        style:
          msg.type === 'WebSearchEnd' && !msg.data.error
            ? STYLE_PRESETS.tool_success
            : STYLE_PRESETS.tool_call,
        status: msg.type === 'WebSearchEnd' ? (msg.data.error ? 'error' : 'success') : 'running',
        collapsible: true,
        collapsed: false,
      };
    }

    return null;
  }

  /**
   * Process reasoning events
   */
  private processReasoningEvent(event: Event): ProcessedEvent | null {
    if (!this.showReasoning) {
      return null;
    }

    const msg = event.msg;

    // Handle reasoning deltas
    if (msg.type === 'AgentReasoningDelta') {
      const key = 'reasoning';
      let state = this.streamingStates.get(key);

      if (!state) {
        state = {
          type: 'reasoning',
          buffer: '',
          startTime: new Date(),
          lastUpdateTime: new Date(),
          headerShown: false,
        };
        this.streamingStates.set(key, state);
      }

      state.buffer += msg.data.delta || '';
      state.lastUpdateTime = new Date();
      return null;
    }

    // Handle final reasoning event
    if (msg.type === 'AgentReasoning') {
      const key = 'reasoning';
      const state = this.streamingStates.get(key);
      const content = msg.data.reasoning || state?.buffer || '';

      this.streamingStates.delete(key);

      return {
        id: event.id,
        category: 'reasoning',
        timestamp: new Date(),
        title: 'thinking',
        content: content,
        style: STYLE_PRESETS.reasoning,
        streaming: false,
        collapsible: true,
        collapsed: false, // Expanded by default to show reasoning
      };
    }

    // Handle raw reasoning content (for thinking models like Kimi K2, o1, o3)
    if (msg.type === 'AgentReasoningRawContent') {
      const content = msg.data.content || '';

      // Only display if showReasoning is enabled
      if (!this.showReasoning) {
        return null;
      }

      return {
        id: event.id,
        category: 'reasoning',
        timestamp: new Date(),
        title: 'detailed thinking',
        content: content,
        style: STYLE_PRESETS.reasoning,
        streaming: false,
        collapsible: true,
        collapsed: false, // Show expanded by default for detailed thinking
      };
    }

    // Handle raw reasoning content deltas (for future streaming support)
    if (msg.type === 'AgentReasoningRawContentDelta') {
      // Skip for now - currently we accumulate and emit complete content
      return null;
    }

    // Handle reasoning section breaks
    if (msg.type === 'AgentReasoningSectionBreak') {
      // Skip for now - not used by current implementations
      return null;
    }

    return null;
  }

  /**
   * Process output events
   */
  private processOutputEvent(event: Event): ProcessedEvent | null {
    const msg = event.msg;

    if (msg.type === 'ExecCommandOutputDelta') {
      // Accumulate output in operation state
      const state = this.operationMetadata.get(msg.data.session_id);

      if (state) {
        state.buffer += msg.data.output || '';
      }

      // Don't create ProcessedEvent for delta - will be included in End event
      return null;
    }

    return null;
  }

  /**
   * Process approval events
   */
  private processApprovalEvent(event: Event): ProcessedEvent | null {
    const msg = event.msg;

    if (msg.type === 'ExecApprovalRequest') {
      return {
        id: event.id,
        category: 'approval',
        timestamp: new Date(),
        title: 'Approval Required: Execute Command',
        content: msg.data.command || '',
        style: { textColor: 'text-yellow-400' },
        requiresApproval: {
          id: event.id,
          type: 'exec',
          command: msg.data.command,
          explanation: msg.data.explanation,
          onApprove: () => {
            this.sendApprovalDecision(event.id, 'approve');
          },
          onReject: () => {
            this.sendApprovalDecision(event.id, 'reject');
          },
        },
        collapsible: false,
      };
    }

    if (msg.type === 'ApplyPatchApprovalRequest') {
      return {
        id: event.id,
        category: 'approval',
        timestamp: new Date(),
        title: 'Approval Required: Apply Patch',
        content: `Patch for ${msg.data.num_files || 0} file(s)`,
        style: { textColor: 'text-yellow-400' },
        requiresApproval: {
          id: event.id,
          type: 'patch',
          explanation: msg.data.explanation,
          patch: {
            path: '(multiple files)',
            diff: '(patch details)',
          },
          onApprove: () => {
            this.sendApprovalDecision(event.id, 'approve');
          },
          onReject: () => {
            this.sendApprovalDecision(event.id, 'reject');
          },
        },
        collapsible: false,
      };
    }

    if (msg.type === 'ApprovalRequested') {
      const data = msg.data;
      return {
        id: event.id,
        category: 'approval',
        timestamp: new Date(),
        title: 'Approval Required',
        content: data.command || data.explanation || '',
        style: { textColor: 'text-yellow-400' },
        requiresApproval: {
          id: data.id,
          type: 'tool',
          toolName: data.tool_name,
          command: data.command,
          explanation: data.explanation,
          riskScore: data.risk_score,
          riskLevel: data.risk_level,
          riskFactors: data.risk_factors,
          countdown: data.timeout ? Math.floor(data.timeout / 1000) : 0,
          onApprove: () => {
            this.sendApprovalDecision(data.id, 'approve');
          },
          onReject: () => {
            this.sendApprovalDecision(data.id, 'reject');
          },
          onRequestChange: (text: string) => {
            this.sendApprovalDecision(data.id, 'reject', false, text);
          },
          onRemember: (scope: 'session' | 'no') => {
            this.sendApprovalDecision(data.id, 'approve', scope === 'session');
          },
        },
        collapsible: false,
      };
    }

    return null;
  }

  /**
   * Send approval decision as a standard SUBMISSION.
   * This routes through the same pipeline for both extension and desktop,
   * reaching BrowserxAgent.handleExecApproval() on all platforms.
   */
  private sendApprovalDecision(
    id: string,
    decision: 'approve' | 'reject',
    remember?: boolean,
    alternativeText?: string
  ): void {
    try {
      chrome.runtime.sendMessage({
        type: 'SUBMISSION',
        payload: {
          id: `approval_${Date.now()}`,
          op: {
            type: 'ExecApproval',
            id,
            decision,
            ...(remember !== undefined && { remember }),
            ...(alternativeText && { alternativeText }),
          },
        },
      });
    } catch (error) {
      console.error('[EventProcessor] Failed to send approval decision:', error);
    }
  }

  /**
   * Process plan events (PlanUpdate)
   */
  private processPlanEvent(event: Event): ProcessedEvent | null {
    const msg = event.msg;

    if (msg.type === 'PlanUpdate') {
      const planData = msg.data;
      const stepCount = planData.plan?.length || 0;
      const summary = planData.explanation
        ? planData.explanation
        : `Plan: ${stepCount} step${stepCount !== 1 ? 's' : ''}`;

      return {
        id: event.id,
        category: 'plan',
        timestamp: new Date(),
        title: 'Task Plan',
        content: planData, // Pass the full plan data to PlanEvent component
        style: { textColor: 'text-cyan-400' },
        collapsible: false,
      };
    }

    return null;
  }

  /**
   * Process system events
   */
  private processSystemEvent(event: Event): ProcessedEvent | null {
    const msg = event.msg;

    if (msg.type === 'TokenCount') {
      const usage = msg.data.info?.total_token_usage;

      if (!usage) {
        return null;
      }

      const content = `Tokens: ${usage.total_tokens?.toLocaleString() || 0}
  Input: ${usage.input_tokens?.toLocaleString() || 0}${
    usage.cached_input_tokens ? ` (${usage.cached_input_tokens.toLocaleString()} cached)` : ''
  }
  Output: ${usage.output_tokens?.toLocaleString() || 0}${
    usage.reasoning_output_tokens ? `\n  Reasoning: ${usage.reasoning_output_tokens.toLocaleString()}` : ''
  }`;

      return {
        id: event.id,
        category: 'system',
        timestamp: new Date(),
        title: 'Token Usage',
        content,
        style: STYLE_PRESETS.dimmed,
        collapsible: true,
        collapsed: true,
      };
    }

    if (msg.type === 'Notification') {
      return {
        id: event.id,
        category: 'system',
        timestamp: new Date(),
        title: 'Notification',
        content: msg.data.message || '',
        style: { textColor: 'text-gray-400' },
        collapsible: false,
      };
    }

    // Generic system event handling
    return {
      id: event.id,
      category: 'system',
      timestamp: new Date(),
      title: msg.type,
      content: JSON.stringify(msg.data || {}, null, 2),
      style: STYLE_PRESETS.dimmed,
      collapsible: true,
      collapsed: true,
    };
  }

  /**
   * Handle unknown event types gracefully
   */
  private processUnknownEvent(event: Event): ProcessedEvent {
    console.warn(`Processing unknown event type:`, event);

    return {
      id: event.id,
      category: 'system',
      timestamp: new Date(),
      title: 'Unknown Event',
      content: JSON.stringify(event, null, 2),
      style: STYLE_PRESETS.dimmed,
      collapsible: true,
      collapsed: true,
    };
  }
}

// Export singleton instance
export const eventProcessor = new EventProcessor();
