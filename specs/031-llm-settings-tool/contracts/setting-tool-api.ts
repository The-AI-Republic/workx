/**
 * SettingTool API Contract
 * Feature: 031-llm-settings-tool
 *
 * Defines the interfaces for the SettingTool that exposes
 * allowlisted agent settings to the LLM conversation.
 */

// ─── Allowlist Definition ────────────────────────────────────────────

export type SettingValueType = 'boolean' | 'string' | 'number' | 'string[]';

export interface AllowlistEntry {
  /** Unique setting key (e.g., 'approval.mode', 'tools.dom_tool') */
  key: string;
  /** Setting category for grouping */
  category: 'model' | 'general' | 'tools' | 'approval' | 'storage';
  /** Human-readable label */
  label: string;
  /** Brief description of what this setting controls */
  description: string;
  /** Value type for validation */
  type: SettingValueType;
  /** Enum of valid values, or null if any value of the type is valid */
  allowedValues: (string | boolean | number)[] | null;
  /** Dot-notation path to read/write from stored config */
  configPath: string;
  /** Storage key: 'agent_config' or 'approval_config' */
  storageKey: 'agent_config' | 'approval_config';
}

// ─── Tool Request / Response ─────────────────────────────────────────

export interface SettingToolRequest {
  /** Operation to perform */
  action: 'get' | 'set' | 'list';
  /** Setting key from allowlist (required for get/set) */
  key?: string;
  /** New value to apply (required for set) */
  value?: unknown;
}

export interface SettingToolResponse {
  success: boolean;
  action: 'get' | 'set' | 'list';
  /** Setting key (null for list action) */
  key: string | null;
  /** Current value (get) or updated value (set) */
  value?: unknown;
  /** Previous value before update (set only) */
  previousValue?: unknown;
  /** All allowlisted settings with values (list only) */
  settings?: SettingListItem[];
  /** Error message if operation failed */
  error?: string;
}

export interface SettingListItem {
  key: string;
  category: string;
  label: string;
  description: string;
  currentValue: unknown;
  type: SettingValueType;
  allowedValues: (string | boolean | number)[] | null;
}

// ─── Risk Assessor ───────────────────────────────────────────────────

/**
 * SettingToolRiskAssessor scoring:
 *
 * | Action | Risk Score | Level  | Decision     |
 * |--------|-----------|--------|--------------|
 * | get    | 0         | none   | auto_approve |
 * | list   | 0         | none   | auto_approve |
 * | set    | 50        | medium | ask_user     |
 */

// ─── Allowlist Constants ─────────────────────────────────────────────

/**
 * The SETTINGS_ALLOWLIST is the security boundary.
 * Only settings in this list can be accessed by the SettingTool.
 * New settings are blocked by default until added here.
 *
 * Categories in initial allowlist (per FR-012):
 * - approval: mode, trustedDomains, blockedDomains
 * - tools: all tool toggle booleans (enable_all_tools, dom_tool, etc.)
 * - general: uiTheme, theme, language
 * - model: selection (provider:modelKey) — NOT api keys
 */
