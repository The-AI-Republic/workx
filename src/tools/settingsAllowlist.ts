/**
 * Settings Allowlist - Security boundary for SettingTool
 *
 * Only settings explicitly listed here can be accessed by the LLM via chat.
 * API keys, secrets, and internal fields are excluded by design.
 */

export type SettingValueType = 'boolean' | 'string' | 'number' | 'string[]';

export interface AllowlistEntry {
  /** Unique setting key (e.g., 'approval.mode', 'tools.dom_tool') */
  key: string;
  /** Setting category for grouping */
  category: 'model' | 'general' | 'tools' | 'approval';
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

/**
 * The SETTINGS_ALLOWLIST is the security boundary.
 * Only settings in this list can be accessed by the SettingTool.
 * New settings are blocked by default until explicitly added here.
 */
export const SETTINGS_ALLOWLIST: AllowlistEntry[] = [
  // ── Approval Category (approval_config storage key) ──────────────────
  {
    key: 'approval.mode',
    category: 'approval',
    label: 'Approval Mode',
    description: 'Controls how tool calls are approved: balanced (ask for medium+ risk), high_speed (ask for high+ risk), or yolo (auto-approve all)',
    type: 'string',
    allowedValues: ['balanced', 'high_speed', 'yolo'],
    configPath: 'mode',
    storageKey: 'approval_config',
  },
  {
    key: 'approval.trustedDomains',
    category: 'approval',
    label: 'Trusted Domains',
    description: 'Domains that are trusted for automatic approval of tool calls',
    type: 'string[]',
    allowedValues: null,
    configPath: 'trustedDomains',
    storageKey: 'approval_config',
  },
  {
    key: 'approval.blockedDomains',
    category: 'approval',
    label: 'Blocked Domains',
    description: 'Domains that are blocked from tool call execution',
    type: 'string[]',
    allowedValues: null,
    configPath: 'blockedDomains',
    storageKey: 'approval_config',
  },

  // ── Tools Category (agent_config storage key) ────────────────────────
  {
    key: 'tools.enable_all_tools',
    category: 'tools',
    label: 'Enable All Tools',
    description: 'Master toggle to enable all browser tools at once',
    type: 'boolean',
    allowedValues: [true, false],
    configPath: 'tools.enable_all_tools',
    storageKey: 'agent_config',
  },
  {
    key: 'tools.storage_tool',
    category: 'tools',
    label: 'Storage Tool',
    description: 'Enable the browser storage inspection tool',
    type: 'boolean',
    allowedValues: [true, false],
    configPath: 'tools.storage_tool',
    storageKey: 'agent_config',
  },
  {
    key: 'tools.tab_tool',
    category: 'tools',
    label: 'Tab Tool',
    description: 'Enable the browser tab management tool',
    type: 'boolean',
    allowedValues: [true, false],
    configPath: 'tools.tab_tool',
    storageKey: 'agent_config',
  },
  {
    key: 'tools.web_scraping_tool',
    category: 'tools',
    label: 'Web Scraping Tool',
    description: 'Enable the web page scraping tool',
    type: 'boolean',
    allowedValues: [true, false],
    configPath: 'tools.web_scraping_tool',
    storageKey: 'agent_config',
  },
  {
    key: 'tools.dom_tool',
    category: 'tools',
    label: 'DOM Tool',
    description: 'Enable the DOM manipulation and interaction tool',
    type: 'boolean',
    allowedValues: [true, false],
    configPath: 'tools.dom_tool',
    storageKey: 'agent_config',
  },
  {
    key: 'tools.form_automation_tool',
    category: 'tools',
    label: 'Form Automation Tool',
    description: 'Enable the form filling and automation tool',
    type: 'boolean',
    allowedValues: [true, false],
    configPath: 'tools.form_automation_tool',
    storageKey: 'agent_config',
  },
  {
    key: 'tools.navigation_tool',
    category: 'tools',
    label: 'Navigation Tool',
    description: 'Enable the page navigation tool',
    type: 'boolean',
    allowedValues: [true, false],
    configPath: 'tools.navigation_tool',
    storageKey: 'agent_config',
  },
  {
    key: 'tools.network_intercept_tool',
    category: 'tools',
    label: 'Network Intercept Tool',
    description: 'Enable the network request interception tool',
    type: 'boolean',
    allowedValues: [true, false],
    configPath: 'tools.network_intercept_tool',
    storageKey: 'agent_config',
  },
  {
    key: 'tools.data_extraction_tool',
    category: 'tools',
    label: 'Data Extraction Tool',
    description: 'Enable the structured data extraction tool',
    type: 'boolean',
    allowedValues: [true, false],
    configPath: 'tools.data_extraction_tool',
    storageKey: 'agent_config',
  },
  {
    key: 'tools.page_action_tool',
    category: 'tools',
    label: 'Page Action Tool',
    description: 'Enable the page action automation tool',
    type: 'boolean',
    allowedValues: [true, false],
    configPath: 'tools.page_action_tool',
    storageKey: 'agent_config',
  },
  {
    key: 'tools.page_vision_tool',
    category: 'tools',
    label: 'Page Vision Tool',
    description: 'Enable the visual page analysis tool (requires model with image support)',
    type: 'boolean',
    allowedValues: [true, false],
    configPath: 'tools.page_vision_tool',
    storageKey: 'agent_config',
  },
  {
    key: 'tools.execCommand',
    category: 'tools',
    label: 'Command Execution',
    description: 'Enable shell command execution',
    type: 'boolean',
    allowedValues: [true, false],
    configPath: 'tools.execCommand',
    storageKey: 'agent_config',
  },
  {
    key: 'tools.webSearch',
    category: 'tools',
    label: 'Web Search',
    description: 'Enable web search capabilities',
    type: 'boolean',
    allowedValues: [true, false],
    configPath: 'tools.webSearch',
    storageKey: 'agent_config',
  },
  {
    key: 'tools.fileOperations',
    category: 'tools',
    label: 'File Operations',
    description: 'Enable file read/write operations',
    type: 'boolean',
    allowedValues: [true, false],
    configPath: 'tools.fileOperations',
    storageKey: 'agent_config',
  },
  {
    key: 'tools.mcpTools',
    category: 'tools',
    label: 'MCP Tools',
    description: 'Enable Model Context Protocol tools',
    type: 'boolean',
    allowedValues: [true, false],
    configPath: 'tools.mcpTools',
    storageKey: 'agent_config',
  },

  // ── General Category (agent_config storage key) ──────────────────────
  {
    key: 'general.uiTheme',
    category: 'general',
    label: 'UI Theme',
    description: 'Visual theme for the interface: chatgpt (modern) or terminal (retro)',
    type: 'string',
    allowedValues: ['chatgpt', 'terminal'],
    configPath: 'preferences.uiTheme',
    storageKey: 'agent_config',
  },
  {
    key: 'general.theme',
    category: 'general',
    label: 'Color Theme',
    description: 'System color scheme: light, dark, or follow system setting',
    type: 'string',
    allowedValues: ['light', 'dark', 'system'],
    configPath: 'preferences.theme',
    storageKey: 'agent_config',
  },
  {
    key: 'general.language',
    category: 'general',
    label: 'Language',
    description: 'Preferred interface language (e.g., en, es, zh)',
    type: 'string',
    allowedValues: null,
    configPath: 'preferences.language',
    storageKey: 'agent_config',
  },

  // ── Model Category (agent_config storage key) ────────────────────────
  {
    key: 'model.selection',
    category: 'model',
    label: 'Model Selection',
    description: 'Currently active AI model in provider:modelKey format (e.g., openai:gpt-4o)',
    type: 'string',
    allowedValues: null,
    configPath: 'selectedModelKey',
    storageKey: 'agent_config',
  },
];

// ── Helper Functions ─────────────────────────────────────────────────────

/**
 * Get an allowlist entry by key
 */
export function getEntry(key: string): AllowlistEntry | undefined {
  return SETTINGS_ALLOWLIST.find((entry) => entry.key === key);
}

/**
 * Check if a setting key is in the allowlist
 */
export function isAllowlisted(key: string): boolean {
  return SETTINGS_ALLOWLIST.some((entry) => entry.key === key);
}

/**
 * Validate a value against an allowlist entry's type and allowed values
 */
export function validateValue(entry: AllowlistEntry, value: unknown): { valid: boolean; error?: string } {
  // Type check
  switch (entry.type) {
    case 'boolean':
      if (typeof value !== 'boolean') {
        return { valid: false, error: `Expected boolean, got ${typeof value}` };
      }
      break;
    case 'string':
      if (typeof value !== 'string') {
        return { valid: false, error: `Expected string, got ${typeof value}` };
      }
      break;
    case 'number':
      if (typeof value !== 'number') {
        return { valid: false, error: `Expected number, got ${typeof value}` };
      }
      break;
    case 'string[]':
      if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
        return { valid: false, error: `Expected string array` };
      }
      break;
    default:
      return { valid: false, error: `Unknown type: ${entry.type}` };
  }

  // Allowed values check (only for non-array types)
  if (entry.allowedValues !== null && entry.type !== 'string[]') {
    if (!entry.allowedValues.includes(value as string | boolean | number)) {
      return {
        valid: false,
        error: `Value must be one of: ${entry.allowedValues.join(', ')}`,
      };
    }
  }

  return { valid: true };
}

/**
 * Get all allowlist entries for a specific category
 */
export function getByCategory(category: AllowlistEntry['category']): AllowlistEntry[] {
  return SETTINGS_ALLOWLIST.filter((entry) => entry.category === category);
}
