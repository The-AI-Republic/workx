/**
 * Core protocol types
 */

import type { AgentMode } from '../../prompts/PromptComposer';

// Constants from protocol
export const USER_INSTRUCTIONS_OPEN_TAG = '<user_instructions>';
export const USER_INSTRUCTIONS_CLOSE_TAG = '</user_instructions>';
export const ENVIRONMENT_CONTEXT_OPEN_TAG = '<environment_context>';
export const ENVIRONMENT_CONTEXT_CLOSE_TAG = '</environment_context>';
export const USER_MESSAGE_BEGIN = '## My request for WorkX:';

/**
 * Submission Queue Entry - requests from user
 */
export interface Submission {
  /** Unique id for this Submission to correlate with Events */
  id: string;
  /** Payload */
  op: Op;
  /** Context information (optional) */
  context?: {
    /** Tab ID to execute this submission in */
    tabId?: number;
    /** Feature 015: Session ID for multi-agent routing */
    sessionId?: string;
    /**
     * Track 12: when true, this submission runs unattended — the retry
     * orchestrator waits out 429/529 instead of hard-failing. Set by
     * scheduler/connector drivers; overrides the platform default.
     */
    unattended?: boolean;
  };
}

/**
 * Submission operation
 */
export type Op =
  | { type: 'Interrupt' }
  | {
    type: 'UserInput';
    /** User input items */
    items: InputItem[];
    /** Durable client correlation id used by lifecycle-managed submissions. */
    clientMessageId?: string;
    /** SHA-256 of the canonical input; supplied by the manager when available. */
    inputDigest?: string;
  }
  | {
    type: 'UserTurn';
    /** User input items */
    items: InputItem[];
    /** Replaced cwd with tabId - browser tab ID for tool execution context */
    tabId: number;
    /** Policy to use for command approval */
    approval_policy: AskForApproval;
    /** Policy to use for tool calls */
    sandbox_policy: SandboxPolicy;
    /** Must be a valid model slug */
    model: string;
    /** Will only be honored if the model is configured to use reasoning */
    effort?: ReasoningEffortConfig;
    /** Will only be honored if the model is configured to use reasoning */
    summary: ReasoningSummaryConfig;
  }
  | {
    type: 'OverrideTurnContext';
    /** Replaced cwd with tabId - updated browser tab ID for tool execution */
    tabId?: number;
    /** Updated command approval policy */
    approval_policy?: AskForApproval;
    /** Updated sandbox policy for tool calls */
    sandbox_policy?: SandboxPolicy;
    /** Updated model slug */
    model?: string;
    /** Updated reasoning effort */
    effort?: ReasoningEffortConfig | null;
    /** Updated reasoning summary preference */
    summary?: ReasoningSummaryConfig;
  }
  | {
    type: 'ExecApproval';
    /** The id of the submission we are approving */
    id: string;
    /** The user's decision in response to the request */
    decision: ReviewDecision;
    /** Remember this decision for the rest of the session */
    remember?: boolean;
    /** Alternative instructions from the user (when decision is request_change) */
    alternativeText?: string;
  }
  | {
    type: 'PatchApproval';
    /** The id of the submission we are approving */
    id: string;
    /** The user's decision in response to the request */
    decision: ReviewDecision;
  }
  | {
    type: 'AddToHistory';
    /** The message text to be stored */
    text: string;
  }
  | {
    type: 'GetHistoryEntryRequest';
    offset: number;
    log_id: number;
  }
  | { type: 'GetPath' }
  | { type: 'ListMcpTools' }
  | { type: 'ListCustomPrompts' }
  | { type: 'Compact' }
  | { type: 'ManualCompact' } // Manual compaction trigger from UI
  | {
    type: 'SetSessionMode';
    /** Target agent persona mode for this session (per-session, hot-switch) */
    mode: AgentMode;
  }
  | {
    type: 'Review';
    review_request: ReviewRequest;
  }
  | { type: 'Shutdown' }
  | {
    type: 'ServiceRequest';
    /** UUID for response correlation */
    requestId: string;
    /** Dotted service path: 'mcp.getServers', 'vault.status', etc. */
    service: string;
    /** Request parameters */
    params: Record<string, unknown>;
  };

/**
 * Determines the conditions under which the user is consulted to approve
 * running the command proposed by WorkX.
 */
export type AskForApproval =
  | 'untrusted'
  | 'on-failure'
  | 'on-request'
  | 'never';

/**
 * Determines execution restrictions for model shell commands.
 * Adapted for browser context
 */
export type SandboxPolicy =
  | { mode: 'danger-full-access' }
  | { mode: 'read-only' }
  | {
    mode: 'workspace-write';
    /** Additional folders that should be writable (adapted for browser storage) */
    writable_roots?: string[];
    /** When true, network access is allowed */
    network_access?: boolean;
    exclude_tmpdir_env_var?: boolean;
    exclude_slash_tmp?: boolean;
  };

/**
 * Protocol model types for structured data from API responses
 */

/**
 * Content item types from protocol messages
 * Supports both legacy 'text' type and Responses API 'input_text'/'output_text'
 */
export type ContentItem =
  | { type: 'text'; text: string }  // Legacy format (backward compatibility)
  | { type: 'input_text'; text: string }  // Responses API user input
  | { type: 'input_image'; image_url: string }  // Responses API image input
  | { type: 'output_text'; text: string }  // Responses API assistant output
  | { type: 'refusal'; refusal: string };  // Responses API refusal

/**
 * Reasoning summary types
 */
export type ReasoningItemReasoningSummary = {
  type: 'summary_text';
  text: string;
};

/**
 * Reasoning content types
 */
export type ReasoningItemContent =
  | { type: 'reasoning_text'; text: string }
  | { type: 'text'; text: string };

/**
 * Web search action types
 */
export type WebSearchAction =
  | { type: 'search'; query: string }
  | { type: 'other' };

/**
 * Local shell execution status
 */
export type LocalShellStatus = 'completed' | 'in_progress' | 'incomplete';

/**
 * Local shell action types
 */
export type LocalShellAction = {
  type: 'exec';
  command: string[];
  timeout_ms?: number;
  working_directory?: string;
  env?: Record<string, string>;
  user?: string;
};

/**
 * Response item types from protocol
 */
export type ResponseItem =
  | {
    type: 'message';
    id?: string;
    /** Stable client-generated identity for optimistic user-message reconciliation. */
    client_id?: string;
    role: string;
    content: ContentItem[];
    /** Reasoning/thinking content from models like Kimi K2, o1, o3 */
    reasoning_content?: string;
    /** Tool calls for this assistant message (Chat Completions API format) */
    tool_calls?: Array<{
      id: string;
      type: string;
      function: {
        name: string;
        arguments: string;
      };
      /** Gemini thought signature for maintaining reasoning context across turns */
      thoughtSignature?: string;
    }>;
    /** Composite key identifying which model generated this message (format: "providerId:modelId") */
    modelKey?: string;
  }
  | {
    type: 'reasoning';
    id?: string;
    summary: ReasoningItemReasoningSummary[];
    content?: ReasoningItemContent[];
    encrypted_content?: string;
    /**
     * Generic encrypted reasoning payload marker for providers that require
     * exact block round-tripping across tool-use turns.
     */
    encrypted_content_type?: 'signature' | 'redacted_thinking';
  }
  | {
    type: 'web_search_call';
    id?: string;
    status?: string;
    action: WebSearchAction;
  }
  | {
    type: 'function_call';
    id?: string;
    name: string;
    arguments: string;
    call_id: string;
  }
  | {
    type: 'function_call_output';
    call_id: string;
    output: string;
  }
  | {
    type: 'local_shell_call';
    id?: string;
    call_id?: string;
    status: LocalShellStatus;
    action: LocalShellAction;
  }
  | {
    type: 'custom_tool_call';
    id?: string;
    status?: string;
    call_id: string;
    name: string;
    input: string;
  }
  | {
    type: 'custom_tool_call_output';
    call_id: string;
    output: string;
  }
  | { type: 'other' };

/**
 * Helper function to extract text content from a ResponseItem
 * Returns a string representation of the content, or empty string if not applicable
 */
export function getResponseItemContent(item: ResponseItem): string {
  switch (item.type) {
    case 'message':
      // Handle both array (correct) and string (backwards compat/malformed data)
      if (typeof item.content === 'string') {
        console.warn('[getResponseItemContent] message.content is a string (should be ContentItem[]):', item);
        return item.content;
      }
      if (!Array.isArray(item.content)) {
        console.error('[getResponseItemContent] message.content is neither string nor array:', item);
        return '';
      }
      return item.content.map(c => {
        if (c.type === 'text' || c.type === 'input_text' || c.type === 'output_text') {
          return c.text;
        }
        if (c.type === 'refusal') {
          return c.refusal;
        }
        return '';
      }).join('');
    case 'reasoning':
      return item.summary.map(s => s.text).join('\n');
    case 'function_call':
      return item.arguments;
    case 'function_call_output':
      return item.output;
    case 'custom_tool_call':
      return item.input;
    case 'custom_tool_call_output':
      return item.output;
    default:
      return '';
  }
}

/**
 * Decode the user-input wrapper emitted by WorkX versions that persisted each
 * InputItem as JSON inside an input_text part. Modern correlated messages are
 * deliberately excluded so genuine JSON entered by a user remains verbatim.
 *
 * This is a read-time compatibility projection: canonical rollout records are
 * never rewritten, while display history and resumed model context see the
 * typed content that the original submission represented.
 */
export function normalizeLegacyUserResponseItem(item: ResponseItem): ResponseItem {
  if (
    !item
    || typeof item !== 'object'
    || item.type !== 'message'
    || item.role !== 'user'
    || item.client_id
    || !Array.isArray(item.content)
    || item.content.length !== 1
  ) {
    return item;
  }

  const part = item.content[0];
  if (
    (part.type !== 'text' && part.type !== 'input_text')
    || typeof part.text !== 'string'
  ) {
    return item;
  }

  const decoded = decodeLegacySerializedInputItem(part.text);
  return decoded ? { ...item, content: [decoded] } : item;
}

function decodeLegacySerializedInputItem(value: string): ContentItem | null {
  if (!value.startsWith('{') || !value.endsWith('}')) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const input = parsed as Record<string, unknown>;

  if (
    input.type === 'text'
    && typeof input.text === 'string'
    && hasExactKeys(input, ['type', 'text'])
  ) {
    return { type: 'input_text', text: input.text };
  }
  if (
    input.type === 'image'
    && typeof input.image_url === 'string'
    && hasExactKeys(input, ['type', 'image_url'])
  ) {
    return { type: 'input_image', image_url: input.image_url };
  }
  if (
    input.type === 'clipboard'
    && (input.content === undefined || typeof input.content === 'string')
    && hasExactKeys(input, input.content === undefined ? ['type'] : ['type', 'content'])
  ) {
    return { type: 'input_text', text: input.content ?? '[clipboard]' };
  }
  if (
    input.type === 'context'
    && (input.path === undefined || typeof input.path === 'string')
    && hasExactKeys(input, input.path === undefined ? ['type'] : ['type', 'path'])
  ) {
    return { type: 'input_text', text: `[context: ${input.path ?? 'unknown'}]` };
  }
  return null;
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  const normalizedExpected = [...expected].sort();
  return actual.length === normalizedExpected.length
    && actual.every((key, index) => key === normalizedExpected[index]);
}

/**
 * Helper function to get the role from a ResponseItem message
 * Returns undefined if the item is not a message
 */
export function getResponseItemRole(item: ResponseItem): string | undefined {
  return item.type === 'message' ? item.role : undefined;
}

/**
 * Conversation history wrapper
 * Encapsulates a list of ResponseItems representing the conversation history
 */
export interface ConversationHistory {
  items: ResponseItem[];
  /** Optional metadata about the conversation */
  metadata?: {
    sessionId?: string;
    startTime?: number;
    lastUpdateTime?: number;
    totalTokens?: number;
  };
}

/**
 * User input types
 */
export type InputItem =
  | {
    type: 'text';
    text: string;
  }
  | {
    type: 'image';
    /** Pre-encoded data: URI image */
    image_url: string;
  }
  | {
    type: 'clipboard';
    /** Only available in browser context */
    content?: string;
  }
  | {
    type: 'context';
    /** Path or identifier for context */
    path?: string;
  };

/**
 * Review decision types
 */
export type ReviewDecision = 'approve' | 'reject' | 'request_change';

/**
 * Reasoning configuration
 */
export interface ReasoningEffortConfig {
  effort: 'low' | 'medium' | 'high';
}

export interface ReasoningSummaryConfig {
  enabled: boolean;
}

/**
 * Review request structure
 */
export interface ReviewRequest {
  id: string;
  content: string;
  type?: 'code' | 'document' | 'general';
}

// Re-export Event types from events.ts
export type { Event, EventMsg } from './events';
