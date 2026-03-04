/**
 * Setting Tool
 *
 * Exposes allowlisted user settings to the LLM conversation for reading
 * and writing. Access is gated by the Zod-based config schema and write
 * operations are blocked in YOLO mode.
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
  resolve,
  listAccessibleFields,
  listByCategory,
  type ResolvedField,
} from '../config/configSchema';
import { STORAGE_KEYS } from '../config/defaults';
import { z } from 'zod';

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
        description: 'Setting key (required for get/set). Example: "approval.mode", "tools.dom_tool", "preferences.uiTheme"',
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

    const resolved = resolve(key, 'read');
    if ('denied' in resolved) {
      return {
        success: false,
        action: 'get',
        key,
        error: `Setting "${key}" is not accessible. This setting can only be managed through the settings UI.`,
      };
    }

    const value = await readStorageValue(STORAGE_KEYS.CONFIG, resolved.path);

    return {
      success: true,
      action: 'get',
      key,
      value,
      label: resolved.llm_access.label,
      description: resolved.llm_access.description,
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

    const resolved = resolve(key, 'write');
    if ('denied' in resolved) {
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

    // Coerce string values for boolean settings
    const value = this.coerceValue(resolved.schema, rawValue);

    // Validate value using Zod schema
    const parseResult = resolved.schema.safeParse(value);
    if (!parseResult.success) {
      const errorMsg = parseResult.error.issues.map((i) => i.message).join(', ');
      return {
        success: false,
        action: 'set',
        key,
        error: `Invalid value for "${key}": ${errorMsg}`,
      };
    }

    // Read previous value
    const previousValue = await readStorageValue(STORAGE_KEYS.CONFIG, resolved.path);

    // Write new value
    await writeStorageValue(STORAGE_KEYS.CONFIG, resolved.path, parseResult.data);

    // Build response
    const response: SettingToolResponse = {
      success: true,
      action: 'set',
      key,
      value: parseResult.data,
      previousValue,
      label: resolved.llm_access.label,
    };

    // FR-009: YOLO transition warning
    if (resolved.path === 'approval.mode' && parseResult.data === 'yolo') {
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
    const fields = listAccessibleFields();

    for (const field of fields) {
      const currentValue = await readStorageValue(STORAGE_KEYS.CONFIG, field.path);

      settings.push({
        key: field.path,
        category: field.llm_access.category || '',
        label: field.llm_access.label || field.path,
        description: field.llm_access.description || '',
        currentValue,
        type: this.schemaToType(field.schema),
        allowedValues: this.schemaToAllowedValues(field.schema),
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
    const result = await chrome.storage.local.get(STORAGE_KEYS.CONFIG);
    const config = result[STORAGE_KEYS.CONFIG] as Record<string, any> | undefined;
    return config?.approval?.mode === 'yolo';
  }

  /**
   * Coerce string representations to native types for boolean settings.
   * The LLM may pass "true"/"false" as strings since the parameter schema
   * uses string type for the value field.
   */
  private coerceValue(schema: z.ZodTypeAny, value: unknown): unknown {
    if (this.isZodBoolean(schema) && typeof value === 'string') {
      if (value.toLowerCase() === 'true') return true;
      if (value.toLowerCase() === 'false') return false;
    }
    return value;
  }

  /**
   * Check if a Zod schema is a boolean type (handles ZodDefault wrapping)
   */
  private isZodBoolean(schema: z.ZodTypeAny): boolean {
    if (schema._def.typeName === 'ZodBoolean') return true;
    if (schema._def.typeName === 'ZodDefault') {
      return this.isZodBoolean((schema as z.ZodDefault<any>)._def.innerType);
    }
    return false;
  }

  /**
   * Derive a simple type string from a Zod schema
   */
  private schemaToType(schema: z.ZodTypeAny): string {
    const inner = this.unwrapDefault(schema);
    const typeName = inner._def.typeName;
    if (typeName === 'ZodBoolean') return 'boolean';
    if (typeName === 'ZodString') return 'string';
    if (typeName === 'ZodNumber') return 'number';
    if (typeName === 'ZodEnum') return 'string';
    if (typeName === 'ZodArray') return 'string[]';
    return 'string';
  }

  /**
   * Extract allowed values from a Zod schema (enum values)
   */
  private schemaToAllowedValues(schema: z.ZodTypeAny): (string | boolean | number)[] | null {
    const inner = this.unwrapDefault(schema);
    if (inner._def.typeName === 'ZodEnum') {
      return (inner as z.ZodEnum<any>)._def.values;
    }
    if (inner._def.typeName === 'ZodBoolean') {
      return [true, false];
    }
    return null;
  }

  /**
   * Unwrap ZodDefault to get the inner schema
   */
  private unwrapDefault(schema: z.ZodTypeAny): z.ZodTypeAny {
    if (schema._def.typeName === 'ZodDefault') {
      return (schema as z.ZodDefault<any>)._def.innerType;
    }
    return schema;
  }
}
