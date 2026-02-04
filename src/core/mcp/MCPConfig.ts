/**
 * MCP Configuration Module
 *
 * Provides Zod validation schemas and chrome.storage.local helpers
 * for MCP server configurations.
 */

import { z } from 'zod';
import type { IMCPServerConfig, IMCPServerConfigCreate, IMCPServerConfigUpdate } from './types';

// =============================================================================
// Zod Validation Schemas (T005)
// =============================================================================

/**
 * Schema for validating MCP server names.
 * - 1-50 characters
 * - Alphanumeric with hyphens only
 * - Used as tool prefix (e.g., "github" → "github:search")
 */
export const MCPServerNameSchema = z
  .string()
  .min(1, 'Name is required')
  .max(50, 'Name must be 50 characters or less')
  .regex(
    /^[a-zA-Z0-9-]+$/,
    'Name must contain only letters, numbers, and hyphens'
  );

/**
 * Schema for validating server URLs.
 * - Must be valid HTTP or HTTPS URL
 */
export const MCPServerUrlSchema = z
  .string()
  .url('Must be a valid URL')
  .refine(
    (url) => url.startsWith('http://') || url.startsWith('https://'),
    'URL must start with http:// or https://'
  );

/**
 * Schema for timeout values.
 * - 5000ms (5s) minimum
 * - 120000ms (2 min) maximum
 * - Defaults to 30000ms (30s)
 */
export const MCPTimeoutSchema = z
  .number()
  .min(5000, 'Timeout must be at least 5 seconds')
  .max(120000, 'Timeout must be at most 2 minutes')
  .default(30000);

/**
 * Full schema for a persisted MCP server configuration.
 */
export const MCPServerConfigSchema = z.object({
  id: z.string().uuid('Invalid server ID'),
  name: MCPServerNameSchema,
  url: MCPServerUrlSchema,
  apiKey: z.string().optional(),
  enabled: z.boolean(),
  timeout: MCPTimeoutSchema,
  createdAt: z.number(),
  updatedAt: z.number(),
});

/**
 * Schema for creating a new MCP server configuration.
 * ID and timestamps are generated automatically.
 */
export const MCPServerConfigCreateSchema = z.object({
  name: MCPServerNameSchema,
  url: MCPServerUrlSchema,
  apiKey: z.string().optional(),
  enabled: z.boolean().default(true),
  timeout: MCPTimeoutSchema,
});

/**
 * Schema for updating an existing MCP server configuration.
 * All fields are optional.
 */
export const MCPServerConfigUpdateSchema = z.object({
  name: MCPServerNameSchema.optional(),
  url: MCPServerUrlSchema.optional(),
  apiKey: z.string().optional(),
  enabled: z.boolean().optional(),
  timeout: MCPTimeoutSchema.optional(),
});

/**
 * Schema for the array of server configurations stored in chrome.storage.local.
 */
export const MCPServersArraySchema = z.array(MCPServerConfigSchema);

// =============================================================================
// Type Exports
// =============================================================================

export type MCPServerConfigInput = z.input<typeof MCPServerConfigCreateSchema>;
export type MCPServerConfigUpdateInput = z.input<typeof MCPServerConfigUpdateSchema>;

// =============================================================================
// Storage Helpers (T006)
// =============================================================================

const STORAGE_KEY = 'mcpServers';
const DEBUG_LOGGING_KEY = 'mcpDebugLogging';

/**
 * Load all MCP server configurations from chrome.storage.local.
 *
 * @returns Array of validated server configurations
 */
export async function loadServers(): Promise<IMCPServerConfig[]> {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    const rawServers = result[STORAGE_KEY];

    if (!rawServers || !Array.isArray(rawServers)) {
      return [];
    }

    // Validate each server config
    const validServers: IMCPServerConfig[] = [];
    for (const server of rawServers) {
      try {
        const validated = MCPServerConfigSchema.parse(server);
        validServers.push(validated);
      } catch (error) {
        console.warn('[MCPConfig] Skipping invalid server config:', server, error);
      }
    }

    return validServers;
  } catch (error) {
    console.error('[MCPConfig] Failed to load servers from storage:', error);
    return [];
  }
}

/**
 * Save all MCP server configurations to chrome.storage.local.
 *
 * @param servers Array of server configurations to save
 */
export async function saveServers(servers: IMCPServerConfig[]): Promise<void> {
  try {
    // Validate all servers before saving
    const validatedServers = MCPServersArraySchema.parse(servers);
    await chrome.storage.local.set({ [STORAGE_KEY]: validatedServers });
  } catch (error) {
    console.error('[MCPConfig] Failed to save servers to storage:', error);
    throw new Error(`Failed to save MCP server configurations: ${error}`);
  }
}

/**
 * Add a new server configuration.
 *
 * @param input Server configuration input
 * @param existingServers Current list of servers (for uniqueness check)
 * @returns The created server configuration with generated ID and timestamps
 */
export function createServerConfig(
  input: IMCPServerConfigCreate,
  existingServers: IMCPServerConfig[]
): IMCPServerConfig {
  // Validate input
  const validated = MCPServerConfigCreateSchema.parse(input);

  // Check for duplicate name
  const nameExists = existingServers.some(
    (s) => s.name.toLowerCase() === validated.name.toLowerCase()
  );
  if (nameExists) {
    throw new Error(`Server with name "${validated.name}" already exists`);
  }

  // Generate UUID
  const id = crypto.randomUUID();
  const now = Date.now();

  return {
    id,
    name: validated.name,
    url: validated.url,
    apiKey: validated.apiKey,
    enabled: validated.enabled ?? true,
    timeout: validated.timeout ?? 30000,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Update an existing server configuration.
 *
 * @param existing Current server configuration
 * @param update Fields to update
 * @param allServers All servers (for uniqueness check on name change)
 * @returns Updated server configuration
 */
export function updateServerConfig(
  existing: IMCPServerConfig,
  update: IMCPServerConfigUpdate,
  allServers: IMCPServerConfig[]
): IMCPServerConfig {
  // Validate update input
  const validated = MCPServerConfigUpdateSchema.parse(update);

  // Check for duplicate name if name is being changed
  if (validated.name && validated.name.toLowerCase() !== existing.name.toLowerCase()) {
    const nameExists = allServers.some(
      (s) => s.id !== existing.id && s.name.toLowerCase() === validated.name!.toLowerCase()
    );
    if (nameExists) {
      throw new Error(`Server with name "${validated.name}" already exists`);
    }
  }

  return {
    ...existing,
    name: validated.name ?? existing.name,
    url: validated.url ?? existing.url,
    apiKey: validated.apiKey !== undefined ? validated.apiKey : existing.apiKey,
    enabled: validated.enabled ?? existing.enabled,
    timeout: validated.timeout ?? existing.timeout,
    updatedAt: Date.now(),
  };
}

/**
 * Check if MCP debug logging is enabled.
 */
export async function isDebugLoggingEnabled(): Promise<boolean> {
  try {
    const result = await chrome.storage.local.get(DEBUG_LOGGING_KEY);
    return result[DEBUG_LOGGING_KEY] === true;
  } catch {
    return false;
  }
}

/**
 * Set MCP debug logging enabled/disabled.
 */
export async function setDebugLogging(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ [DEBUG_LOGGING_KEY]: enabled });
}

/**
 * Validate a server configuration without creating it.
 * Returns validation errors if any.
 */
export function validateServerConfig(input: unknown): {
  success: boolean;
  error?: string;
  data?: IMCPServerConfigCreate;
} {
  const result = MCPServerConfigCreateSchema.safeParse(input);
  if (result.success) {
    return { success: true, data: result.data };
  }

  // Format Zod errors into readable message
  const errors = result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`);
  return { success: false, error: errors.join('; ') };
}
