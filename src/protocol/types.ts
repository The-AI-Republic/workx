/**
 * Core protocol types ported from browserx-rs/protocol/src/protocol.rs
 * Preserving exact type names and structure from Rust
 */

// Constants from protocol
export const USER_INSTRUCTIONS_OPEN_TAG = '<user_instructions>';
export const USER_INSTRUCTIONS_CLOSE_TAG = '</user_instructions>';
export const ENVIRONMENT_CONTEXT_OPEN_TAG = '<environment_context>';
export const ENVIRONMENT_CONTEXT_CLOSE_TAG = '</environment_context>';
export const USER_MESSAGE_BEGIN = '## My request for Browserx:';

/**
 * Submission Queue Entry - requests from user
 */
export interface Submission {
  /** Unique id for this Submission to correlate with Events */
  id: string;
  /** Payload */
  op: Op;
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
    }
  | {
      type: 'UserTurn';
      /** User input items */
      items: InputItem[];
      /** cwd to use with the SandboxPolicy */
      cwd: string;
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
      /** Updated cwd for sandbox/tool calls */
      cwd?: string;
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
  | {
      type: 'Review';
      review_request: ReviewRequest;
    }
  | { type: 'Shutdown' };

/**
 * Determines the conditions under which the user is consulted to approve
 * running the command proposed by Browserx.
 */
export type AskForApproval =
  | 'untrusted'    // UnlessTrusted in Rust
  | 'on-failure'   // OnFailure
  | 'on-request'   // OnRequest (default)
  | 'never';       // Never

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
 * Protocol model types ported from browserx-rs/protocol/src/models.rs
 * These types represent the structured data from API responses
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
 * Response item types from protocol - discriminated union matching Rust enum
 */
export type ResponseItem =
  | {
      type: 'message';
      id?: string;
      role: string;
      content: ContentItem[];
    }
  | {
      type: 'reasoning';
      id?: string;
      summary: ReasoningItemReasoningSummary[];
      content?: ReasoningItemContent[];
      encrypted_content?: string;
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

// Re-export EventMsg from events.ts
export type { EventMsg } from './events';