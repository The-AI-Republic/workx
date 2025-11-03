/**
 * UI Types for Event Processor
 *
 * This file defines all types needed for transforming protocol events
 * into UI-ready representations for the side panel display.
 */

import type { Event } from '../protocol/types';

// ============================================================================
// Core Event Display Types (T002)
// ============================================================================

/**
 * EventDisplayCategory - Groups events by display behavior and styling
 * (Renamed from EventCategory for clarity)
 */
export type EventDisplayCategory =
  | 'task'        // TaskStarted, TaskComplete, TaskFailed
  | 'message'     // AgentMessage, AgentMessageDelta
  | 'reasoning'   // AgentReasoning*, 4 types
  | 'tool'        // McpToolCall*, ExecCommand*, WebSearch*, PatchApply*
  | 'output'      // ExecCommandOutputDelta
  | 'error'       // Error, StreamError, TaskFailed
  | 'approval'    // ExecApprovalRequest, ApplyPatchApprovalRequest
  | 'system';     // TokenCount, PlanUpdate, Notification, etc.

/**
 * EventStatus - Current status of an operation
 */
export type EventStatus = 'running' | 'success' | 'error';

/**
 * Color and styling type aliases
 */
export type ColorClass = string;  // Tailwind color class (e.g., 'text-green-400')
export type FontWeight = 'font-normal' | 'font-bold';
export type FontStyle = 'italic' | 'normal';
export type IconType = 'info' | 'success' | 'error' | 'warning' | 'tool' | 'thinking';

// ============================================================================
// EventStyle Interface (T003)
// ============================================================================

/**
 * EventStyle - Visual styling theme for events
 */
export interface EventStyle {
  // Text styling
  textColor: ColorClass;
  textWeight?: FontWeight;
  textStyle?: FontStyle;

  // Container styling
  bgColor?: ColorClass;
  borderColor?: ColorClass;

  // Icon
  icon?: IconType;
  iconColor?: ColorClass;
}

/**
 * Style Presets - Predefined styles for common event types
 */
export const STYLE_PRESETS: Record<string, EventStyle> = {
  task_started: {
    textColor: 'text-cyan-400',
    icon: 'info',
  },
  task_complete: {
    textColor: 'text-green-400',
    icon: 'success',
  },
  task_failed: {
    textColor: 'text-red-400',
    icon: 'error',
  },
  agent_message: {
    textColor: 'text-purple-400',
    textStyle: 'italic',
  },
  reasoning: {
    textColor: 'text-purple-400',
    textStyle: 'italic',
    icon: 'thinking',
  },
  tool_call: {
    textColor: 'text-purple-400',
  },
  tool_success: {
    textColor: 'text-green-400',
  },
  tool_error: {
    textColor: 'text-red-400',
  },
  error: {
    textColor: 'text-red-400',
    textWeight: 'font-bold',
    icon: 'error',
  },
  dimmed: {
    textColor: 'text-gray-500',
  },
};

// ============================================================================
// EventMetadata Interface (T004)
// ============================================================================

/**
 * TokenUsage - Token count details
 */
export interface TokenUsage {
  input: number;
  cached: number;
  output: number;
  reasoning: number;
  total: number;
}

/**
 * EventMetadata - Additional information specific to event types
 */
export interface EventMetadata {
  // Time & Performance
  duration?: number;              // Operation duration in ms
  startTime?: Date;               // Operation start time
  endTime?: Date;                 // Operation end time

  // Token Usage (TokenCount events)
  tokenUsage?: TokenUsage;

  // Command Execution
  command?: string;               // Original command
  exitCode?: number;              // Exit code (0 = success)
  workingDir?: string;            // CWD for command

  // Tool Calls
  toolName?: string;              // MCP tool name
  toolParams?: Record<string, any>; // Tool parameters

  // File Operations
  filesChanged?: number;          // Number of files in patch
  diffSummary?: string;           // Patch summary

  // Model Info
  model?: string;                 // Model name
  turnCount?: number;             // Turn number
}

// ============================================================================
// OperationState and StreamingState Interfaces (T005)
// ============================================================================

/**
 * OperationState - Track multi-event operations (Begin → Delta → End)
 */
export interface OperationState {
  // Identity
  callId: string;                      // Unique operation ID
  type: 'exec' | 'tool' | 'patch';     // Operation type

  // Timing
  startTime: Date;                     // When operation began

  // Content
  buffer: string;                      // Accumulated deltas
  processedEventId?: string;           // ID of ProcessedEvent for this operation

  // Metadata
  metadata: Record<string, any>;       // Type-specific data
}

/**
 * StreamingState - Track streaming message/reasoning content
 */
export interface StreamingState {
  // Identity
  type: 'message' | 'reasoning' | 'raw_reasoning';

  // Content
  buffer: string;                      // Accumulated deltas
  processedEventId?: string;           // Associated ProcessedEvent

  // Timing
  startTime: Date;
  lastUpdateTime: Date;

  // Display
  headerShown: boolean;                // Has header been displayed?
}

// ============================================================================
// ApprovalRequest and ContentBlock Types (T006)
// ============================================================================

/**
 * ApprovalRequest - Data for interactive approval UI
 */
export interface ApprovalRequest {
  id: string;                          // Approval request ID
  type: 'exec' | 'patch';              // What needs approval

  // Content
  command?: string;                    // For exec approvals
  explanation?: string;                // Why this action

  patch?: {                            // For patch approvals
    path: string;
    diff: string;
  };

  // Response callbacks
  onApprove: () => void;               // Callback for approval
  onReject: () => void;                // Callback for rejection
  onRequestChange?: () => void;        // Optional: request changes
}

/**
 * ContentBlock - Structured content for rich formatting
 */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'code'; lang: string; code: string }
  | { type: 'diff'; additions: string[]; deletions: string[]; context: string[] }
  | { type: 'list'; items: string[] }
  | { type: 'table'; headers: string[]; rows: string[][] };

// ============================================================================
// ProcessedEvent - Main UI Event Type (T002)
// ============================================================================

/**
 * ProcessedEvent - Unified representation of any event after transformation,
 * ready for UI rendering
 */
export interface ProcessedEvent {
  // Identity
  id: string;                          // Unique event ID (from Event.id)
  category: EventDisplayCategory;      // Display category
  timestamp: Date;                     // When event occurred

  // Display
  title: string;                       // Header text (e.g., "browserx", "exec ls", "tool Read")
  content: string | ContentBlock[];    // Main content (text or structured)
  style: EventStyle;                   // Visual styling category

  // State
  status?: EventStatus;                // For operations: 'running' | 'success' | 'error'
  streaming?: boolean;                 // Is this event still receiving deltas?

  // Metadata
  metadata?: EventMetadata;            // Additional info (duration, tokens, etc.)

  // Interactive
  requiresApproval?: ApprovalRequest;  // For approval events
  collapsible?: boolean;               // Can be collapsed (reasoning, tool output)
  collapsed?: boolean;                 // Current collapse state
}
