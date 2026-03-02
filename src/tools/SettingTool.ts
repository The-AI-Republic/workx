/**
 * Setting Tool
 *
 * Exposes allowlisted user settings to the LLM conversation for reading
 * and writing. Access is gated by a hardcoded allowlist and write operations
 * are blocked in YOLO mode.
 *
 * Actions:
 * - get: Read a single setting value by key
 * - set: Update a setting value (blocked in YOLO mode)
 * - list: List all allowlisted settings with current values
 */

import {
  BaseTool,
  createToolDefinition,
  type ToolDefinition,
  type BaseToolRequest,
  type BaseToolOptions,
} from './BaseTool';
import {
  SETTINGS_ALLOWLIST,
  getEntry,
  isAllowlisted,
  validateValue,
  type AllowlistEntry,
} from './settingsAllowlist';
import { STORAGE_KEYS } from '../config/defaults';

// ── Storage helpers ────────────────────────────────────────────────────

/**
 * Read a value from chrome.storage.local at a dot-notation path
 */
async function readStorageValue(
  storageKey: string,
  configPath: string
): Promise<unknown> {
  const result = await chrome.storage.local.get(storageKey);
  const config = result[storageKey];
  if (config == null) return undefined;

  const parts = configPath.split('.');
  let current: any = config;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = current[part];
  }
  return current;
}

/**
 * Write a value to chrome.storage.local at a dot-notation path
 */
async function writeStorageValue(
  storageKey: string,
  configPath: string,
  value: unknown
): Promise<void> {
  const result = await chrome.storage.local.get(storageKey);
  const config = result[storageKey] ?? {};

  const parts = configPath.split('.');
  let current: any = config;
  for (let i = 0; i < parts.length - 1; i++) {
    if (current[parts[i]] == null || typeof current[parts[i]] !== 'object') {
      current[parts[i]] = {};
    }
    current = current[parts[i]];
  }
  current[parts[parts.length - 1]] = value;

  await chrome.storage.local.set({ [storageKey]: config });
}

/**
 * Map the allowlist storageKey to the actual chrome.storage key
 */
function resolveStorageKey(storageKey: 'agent_config' | 'approval_config'): string {
  return storageKey === 'agent_config'
    ? STORAGE_KEYS.CONFIG
    : STORAGE_KEYS.APPROVAL_CONFIG;
}

// ── Response types ─────────────────────────────────────────────────────

interface SettingToolResponse {
  success: boolean;
  action: 'get' | 'set' | 'list';
  key: string | null;
  value?: unknown;
  previousValue?: unknown;
  label?: string;
  description?: string;
  settings?: SettingListItem[];
  error?: string;
  warning?: string;
}

interface SettingListItem {
  key: string;
  category: string;
  label: string;
  description: string;
  currentValue: unknown;
  type: string;
  allowedValues: (string | boolean | number)[] | null;
}

// ── SettingTool class ──────────────────────────────────────────────────

export class SettingTool extends BaseTool {
  protected toolDefinition: ToolDefinition = createToolDefinition(
    'setting_tool',
    'Read and modify user settings via chat. Use "get" to read a single setting, "set" to change a setting value, or "list" to see all available settings with their current values. Only allowlisted settings can be accessed. Write operations are blocked in YOLO mode.',
    {
      action: {
        type: 'string',
        description: 'Operation to perform: "get" (read single setting), "set" (update setting), or "list" (show all settings)',
        enum: ['get', 'set', 'list'],
      },
      key: {
        type: 'string',
        description: 'Setting key from the allowlist (required for get/set). Example: "approval.mode", "tools.dom_tool", "general.uiTheme"',
      },
      value: {
        type: 'string',
        description: 'New value to apply (required for set). Use "true"/"false" for boolean settings.',
      },
    },
    {
      required: ['action'],
      category: 'settings',
      version: '1.0.0',
    }
  );

  protected async executeImpl(
    request: BaseToolRequest,
    _options?: BaseToolOptions
  ): Promise<SettingToolResponse> {
    const { action, key, value } = request;

    switch (action) {
      case 'get':
        return this.handleGet(key);
      case 'set':
        return this.handleSet(key, value);
      case 'list':
        return this.handleList();
      default:
        return {
          success: false,
          action,
          key: null,
          error: `Unknown action: ${action}. Use "get", "set", or "list".`,
        };
    }
  }

  // ── Get action ─────────────────────────────────────────────────────

  private async handleGet(key?: string): Promise<SettingToolResponse> {
    if (!key) {
      return {
        success: false,
        action: 'get',
        key: null,
        error: 'The "key" parameter is required for the "get" action.',
      };
    }

    if (!isAllowlisted(key)) {
      return {
        success: false,
        action: 'get',
        key,
        error: `Setting "${key}" is not accessible. This setting can only be managed through the settings UI.`,
      };
    }

    const entry = getEntry(key)!;
    const storageKey = resolveStorageKey(entry.storageKey);
    const value = await readStorageValue(storageKey, entry.configPath);

    return {
      success: true,
      action: 'get',
      key,
      value,
      label: entry.label,
      description: entry.description,
    };
  }

  // ── Set action ─────────────────────────────────────────────────────

  private async handleSet(key?: string, rawValue?: unknown): Promise<SettingToolResponse> {
    if (!key) {
      return {
        success: false,
        action: 'set',
        key: null,
        error: 'The "key" parameter is required for the "set" action.',
      };
    }

    if (!isAllowlisted(key)) {
      return {
        success: false,
        action: 'set',
        key,
        error: `Setting "${key}" is not accessible. This setting can only be managed through the settings UI.`,
      };
    }

    // YOLO mode write guard (FR-003)
    const isYolo = await this.checkYoloMode();
    if (isYolo) {
      return {
        success: false,
        action: 'set',
        key,
        error: 'Settings cannot be modified in YOLO mode. Please switch to balanced or high-speed mode first via the approval mode indicator.',
      };
    }

    const entry = getEntry(key)!;

    // Coerce string values for boolean settings
    const value = this.coerceValue(entry, rawValue);

    // Validate value
    const validation = validateValue(entry, value);
    if (!validation.valid) {
      return {
        success: false,
        action: 'set',
        key,
        error: `Invalid value for "${key}": ${validation.error}`,
      };
    }

    // Read previous value
    const storageKey = resolveStorageKey(entry.storageKey);
    const previousValue = await readStorageValue(storageKey, entry.configPath);

    // Write new value
    await writeStorageValue(storageKey, entry.configPath, value);

    // Build response
    const response: SettingToolResponse = {
      success: true,
      action: 'set',
      key,
      value,
      previousValue,
      label: entry.label,
    };

    // FR-009: YOLO transition warning
    if (key === 'approval.mode' && value === 'yolo') {
      response.warning =
        'Warning: YOLO mode is now active. Setting tool write access will be disabled. ' +
        'You will still be able to read settings, but changes must be made through the ' +
        'approval mode indicator or by asking the user to switch back first.';
    }

    return response;
  }

  // ── List action ────────────────────────────────────────────────────

  private async handleList(): Promise<SettingToolResponse> {
    const settings: SettingListItem[] = [];

    for (const entry of SETTINGS_ALLOWLIST) {
      const storageKey = resolveStorageKey(entry.storageKey);
      const currentValue = await readStorageValue(storageKey, entry.configPath);

      settings.push({
        key: entry.key,
        category: entry.category,
        label: entry.label,
        description: entry.description,
        currentValue,
        type: entry.type,
        allowedValues: entry.allowedValues,
      });
    }

    return {
      success: true,
      action: 'list',
      key: null,
      settings,
    };
  }

  // ── Helpers ────────────────────────────────────────────────────────

  /**
   * Check if the current approval mode is YOLO
   */
  private async checkYoloMode(): Promise<boolean> {
    const result = await chrome.storage.local.get(STORAGE_KEYS.APPROVAL_CONFIG);
    const config = result[STORAGE_KEYS.APPROVAL_CONFIG];
    return config?.mode === 'yolo';
  }

  /**
   * Coerce string representations to native types for boolean settings.
   * The LLM may pass "true"/"false" as strings since the parameter schema
   * uses string type for the value field.
   */
  private coerceValue(entry: AllowlistEntry, value: unknown): unknown {
    if (entry.type === 'boolean' && typeof value === 'string') {
      if (value.toLowerCase() === 'true') return true;
      if (value.toLowerCase() === 'false') return false;
    }
    return value;
  }
}
