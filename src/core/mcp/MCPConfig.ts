/**
 * MCP Configuration Module
 *
 * Provides Zod validation schemas and ConfigStorageProvider helpers
 * for MCP server configurations.
 */

import { z } from 'zod';
import type { IMCPServerConfig, IMCPServerConfigCreate, IMCPServerConfigUpdate, MCPTransportType, MCPPlatformScope, MCPAuthMode } from './types';
import {
  getConfigStorage,
  type ConfigStorageProvider
} from '../storage/ConfigStorageProvider';

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
 * - 180000ms (3 min) maximum (increased for stdio servers that may take longer)
 * - Defaults to 30000ms (30s)
 */
export const MCPTimeoutSchema = z
  .number()
  .min(5000, 'Timeout must be at least 5 seconds')
  .max(180000, 'Timeout must be at most 3 minutes')
  .default(30000);

/**
 * Schema for transport type.
 */
export const MCPTransportTypeSchema = z.enum(['sse', 'streamable-http', 'stdio']);

/**
 * Schema for remote auth mode.
 */
export const MCPAuthModeSchema = z.enum(['none', 'api-key', 'session-jwt']);

/**
 * Schema for platform scope.
 */
export const MCPPlatformScopeSchema = z.enum(['shared', 'extension', 'desktop', 'server']);

/**
 * Full schema for a persisted MCP server configuration.
 */
export const MCPServerConfigSchema = z.object({
  id: z.string().uuid('Invalid server ID'),
  name: MCPServerNameSchema,
  url: z.string().default(''), // Optional for stdio transport
  apiKey: z.string().optional(),
  enabled: z.boolean(),
  timeout: MCPTimeoutSchema,
  transport: MCPTransportTypeSchema.default('sse'),
  authMode: MCPAuthModeSchema.optional(),
  headers: z.record(z.string()).optional(),
  platform: MCPPlatformScopeSchema.default('shared'),
  builtin: z.boolean().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  cwd: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  // Track 10: plugin owner (absent for user-added servers)
  pluginId: z.string().optional(),
});

/**
 * Schema for creating a new MCP server configuration.
 * ID and timestamps are generated automatically.
 */
export const MCPServerConfigCreateSchema = z.object({
  name: MCPServerNameSchema,
  url: z.string().optional(), // Optional — not needed for stdio
  apiKey: z.string().optional(),
  enabled: z.boolean().default(true),
  timeout: MCPTimeoutSchema,
  transport: MCPTransportTypeSchema.default('sse'),
  authMode: MCPAuthModeSchema.optional(),
  headers: z.record(z.string()).optional(),
  platform: MCPPlatformScopeSchema.default('shared'),
  builtin: z.boolean().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  cwd: z.string().optional(),
  // Track 10: plugin owner (absent for user-added servers)
  pluginId: z.string().optional(),
}).refine(
  (data) => {
    // HTTP transports require url
    if ((data.transport === 'sse' || data.transport === 'streamable-http') && (!data.url || data.url.trim() === '')) {
      return false;
    }
    // stdio transport requires command
    if (data.transport === 'stdio' && (!data.command || data.command.trim() === '')) {
      return false;
    }
    return true;
  },
  {
    message: 'HTTP transports require url; stdio transport requires command',
  }
);

/**
 * Schema for updating an existing MCP server configuration.
 * All fields are optional.
 */
export const MCPServerConfigUpdateSchema = z.object({
  name: MCPServerNameSchema.optional(),
  url: z.string().optional(),
  apiKey: z.string().optional(),
  enabled: z.boolean().optional(),
  timeout: MCPTimeoutSchema.optional(),
  transport: MCPTransportTypeSchema.optional(),
  authMode: MCPAuthModeSchema.optional(),
  headers: z.record(z.string()).optional(),
  platform: MCPPlatformScopeSchema.optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
  cwd: z.string().optional(),
});

/**
 * Schema for the array of server configurations stored via ConfigStorageProvider.
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
 * Get storage provider (throws if not initialized).
 */
function getStorage(): ConfigStorageProvider {
  return getConfigStorage();
}

/**
 * Migrate a legacy server config (pre-transport/platform) to the current schema.
 * Adds default transport='sse' and platform='shared' if missing.
 */
function migrateServerConfig(server: Record<string, unknown>): Record<string, unknown> {
  let migrated = false;

  if (!server.transport) {
    server.transport = 'sse';
    migrated = true;
  }

  if (!server.platform) {
    server.platform = 'shared';
    migrated = true;
  }

  // Ensure url has a default value for backwards compatibility
  if (server.url === undefined || server.url === null) {
    server.url = '';
    migrated = true;
  }

  return server;
}

/**
 * Load all MCP server configurations from storage.
 * Automatically migrates legacy configs that lack transport/platform fields.
 *
 * @returns Array of validated server configurations
 */
export async function loadServers(): Promise<IMCPServerConfig[]> {
  try {
    const storage = getStorage();
    const rawServers = await storage.get<IMCPServerConfig[]>(STORAGE_KEY);

    if (!rawServers || !Array.isArray(rawServers)) {
      return [];
    }

    // Migrate and validate each server config
    let needsPersist = false;
    const validServers: IMCPServerConfig[] = [];
    for (const server of rawServers) {
      try {
        // Migrate legacy configs (mutates in place, returns same object)
        const raw = server as unknown as Record<string, unknown>;
        const serverBefore = JSON.stringify(raw);
        migrateServerConfig(raw);
        if (JSON.stringify(raw) !== serverBefore) {
          needsPersist = true;
        }
        const validated = MCPServerConfigSchema.parse(raw);
        validServers.push(validated);
      } catch (error) {
        console.warn('[MCPConfig] Skipping invalid server config:', server, error);
      }
    }

    // Persist migrated configs back to storage
    if (needsPersist && validServers.length > 0) {
      try {
        await storage.set(STORAGE_KEY, validServers);
      } catch (e) {
        console.warn('[MCPConfig] Failed to persist migrated configs:', e);
      }
    }

    return validServers;
  } catch (error) {
    console.error('[MCPConfig] Failed to load servers from storage:', error);
    return [];
  }
}

/**
 * Save all MCP server configurations to storage.
 *
 * @param servers Array of server configurations to save
 */
export async function saveServers(servers: IMCPServerConfig[]): Promise<void> {
  try {
    const storage = getStorage();
    // Validate all servers before saving
    const validatedServers = MCPServersArraySchema.parse(servers);
    await storage.set(STORAGE_KEY, validatedServers);
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
    url: validated.url ?? '',
    apiKey: validated.apiKey,
    enabled: validated.enabled ?? true,
    timeout: validated.timeout ?? 30000,
    transport: (validated.transport ?? 'sse') as MCPTransportType,
    authMode: (validated.authMode ?? (validated.apiKey ? 'api-key' : 'none')) as MCPAuthMode,
    headers: validated.headers,
    platform: (validated.platform ?? 'shared') as MCPPlatformScope,
    builtin: validated.builtin,
    command: validated.command,
    args: validated.args,
    env: validated.env,
    cwd: validated.cwd,
    createdAt: now,
    updatedAt: now,
    pluginId: validated.pluginId,
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
    transport: validated.transport ?? existing.transport,
    authMode: validated.authMode ?? existing.authMode,
    headers: validated.headers !== undefined ? validated.headers : existing.headers,
    platform: validated.platform ?? existing.platform,
    command: validated.command !== undefined ? validated.command : existing.command,
    args: validated.args !== undefined ? validated.args : existing.args,
    env: validated.env !== undefined ? validated.env : existing.env,
    cwd: validated.cwd !== undefined ? validated.cwd : existing.cwd,
    updatedAt: Date.now(),
  };
}

/**
 * Check if MCP debug logging is enabled.
 */
export async function isDebugLoggingEnabled(): Promise<boolean> {
  try {
    const storage = getStorage();
    const value = await storage.get<boolean>(DEBUG_LOGGING_KEY);
    return value === true;
  } catch {
    return false;
  }
}

/**
 * Set MCP debug logging enabled/disabled.
 */
export async function setDebugLogging(enabled: boolean): Promise<void> {
  const storage = getStorage();
  await storage.set(DEBUG_LOGGING_KEY, enabled);
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
