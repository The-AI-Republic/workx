/**
 * Hook & Event System — Type Definitions
 *
 * Defines all types for the BrowserX hook system, inspired by claudy's
 * 28-event hook architecture adapted for browser automation context.
 */

// ---------------------------------------------------------------------------
// Hook Events
// ---------------------------------------------------------------------------

/**
 * Hook events supported by BrowserX.
 * Phase 1 ships the first 11; remaining events added in later phases.
 */
export type HookEvent =
  // Phase 1: Core tool lifecycle
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  // Phase 1: Session lifecycle
  | 'SessionStart'
  | 'SessionEnd'
  // Phase 1: User interaction
  | 'UserPromptSubmit'
  | 'Stop'
  // Phase 1: Approval integration
  | 'PermissionRequest'
  | 'PermissionDenied'
  // Phase 1: Task tracking
  | 'TaskCreated'
  | 'TaskCompleted'
  // Phase 2+
  | 'PreCompact'
  | 'PostCompact'
  | 'ConfigChange';

// ---------------------------------------------------------------------------
// Hook Command Definitions
// ---------------------------------------------------------------------------

/**
 * Hook command types — what the hook actually does.
 */
export type HookCommandType = 'command' | 'prompt' | 'http';

/**
 * A single hook command definition.
 */
export interface HookCommand {
  readonly type: HookCommandType;

  // Command-type fields
  readonly command?: string;
  readonly shell?: 'bash' | 'powershell';

  // Prompt-type fields
  readonly prompt?: string;
  readonly model?: string;

  // HTTP-type fields
  readonly url?: string;
  readonly headers?: Readonly<Record<string, string>>;

  // Common fields
  readonly timeout?: number;
  readonly if?: string;
  readonly once?: boolean;
  readonly async?: boolean;
  readonly statusMessage?: string;
}

/**
 * A matcher entry: a pattern and a list of hooks.
 */
export interface HookMatcherEntry {
  readonly matcher?: string;
  readonly hooks: readonly HookCommand[];
}

// ---------------------------------------------------------------------------
// Registration Metadata
// ---------------------------------------------------------------------------

/**
 * Where a hook was registered from, for display and priority ordering.
 *
 * Track 10 widened the union so the plugin variant carries `pluginId`,
 * enabling per-plugin scoped removal via
 * `HookRegistry.unregisterBySource({ type: 'plugin', pluginId })`.
 * `'config'` and `'session'` remain flat strings — existing call sites
 * are unaffected.
 */
export type HookSource =
  | 'config'
  | 'session'
  | { type: 'plugin'; pluginId: string };

/**
 * Deep-equal source comparison handling the discriminated-union widening.
 */
export function isSameHookSource(a: HookSource, b: HookSource): boolean {
  if (typeof a === 'string' && typeof b === 'string') return a === b;
  if (typeof a === 'string' || typeof b === 'string') return false;
  return a.type === b.type && a.pluginId === b.pluginId;
}

/**
 * Internal registered hook with source metadata.
 */
export interface RegisteredHook {
  readonly id: string;
  readonly event: HookEvent;
  readonly matcher?: string;
  readonly command: HookCommand;
  readonly source: HookSource;
  readonly registeredAt: number;
}

// ---------------------------------------------------------------------------
// Execution Results
// ---------------------------------------------------------------------------

/**
 * Hook execution outcome for a single hook.
 */
export type HookOutcome =
  | 'success'
  | 'blocking_error'
  | 'non_blocking_error'
  | 'cancelled'
  | 'timeout';

/**
 * Result from a single hook execution.
 */
export interface HookResult {
  readonly hookId: string;
  readonly outcome: HookOutcome;
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly duration: number;

  // Parsed response fields
  readonly continue?: boolean;
  readonly suppressOutput?: boolean;
  readonly stopReason?: string;
  readonly decision?: 'approve' | 'block';
  readonly systemMessage?: string;
  readonly updatedInput?: Record<string, unknown>;
  readonly updatedOutput?: unknown;
  readonly additionalContext?: string;
}

/**
 * Aggregated result from all hooks for a single event firing.
 */
export interface AggregatedHookResult {
  readonly shouldContinue: boolean;
  readonly stopReason?: string;
  readonly updatedInput?: Readonly<Record<string, unknown>>;
  readonly updatedOutput?: unknown;
  readonly additionalContext: readonly string[];
  readonly systemMessages: readonly string[];
  readonly permissionDecision?: 'approve' | 'block';
  readonly results: readonly HookResult[];
  readonly totalDuration: number;
}

// ---------------------------------------------------------------------------
// Hook Input
// ---------------------------------------------------------------------------

/**
 * Context passed to each hook when it fires.
 * Serialized as JSON to stdin for command hooks, or as POST body for HTTP hooks.
 */
export interface HookInput {
  readonly hook_event_name: HookEvent;
  readonly session_id: string;
  readonly cwd?: string;

  // Tool context (PreToolUse, PostToolUse, PostToolUseFailure)
  readonly tool_name?: string;
  readonly tool_input?: Readonly<Record<string, unknown>>;
  readonly tool_output?: unknown;
  readonly tool_error?: string;

  // User interaction (UserPromptSubmit)
  readonly user_prompt?: string;

  // Session lifecycle
  readonly session_start_source?: 'startup' | 'resume';
  readonly session_end_reason?: string;

  // Approval (PermissionRequest, PermissionDenied)
  readonly risk_score?: number;
  readonly risk_level?: string;
  readonly approval_decision?: string;

  // Task tracking
  readonly task_id?: string;
  readonly task_type?: string;

  // BrowserX-specific context
  readonly current_url?: string;
  readonly current_domain?: string;
  readonly tab_id?: number;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration shape for hooks in settings.
 * Keyed by hook event name, each containing an array of matcher entries.
 */
export type HooksConfig = {
  readonly [event: string]: readonly HookMatcherEntry[];
};
