/**
 * A2A Configuration Module
 *
 * Provides Zod validation schemas and ConfigStorageProvider helpers
 * for A2A agent configurations.
 */

import { z } from 'zod';
import type { IA2AAgentConfig, IA2AAgentConfigCreate, IA2AAgentConfigUpdate, A2AAuthType, A2APlatformScope } from './types';
import {
  getConfigStorage,
  type ConfigStorageProvider
} from '../storage/ConfigStorageProvider';

// =============================================================================
// Zod Validation Schemas
// =============================================================================

/**
 * Schema for validating A2A agent names.
 * - 1-50 characters
 * - Alphanumeric with hyphens only
 * - Used as tool prefix (e.g., "research" -> "research__summarize")
 */
export const A2AAgentNameSchema = z
  .string()
  .min(1, 'Name is required')
  .max(50, 'Name must be 50 characters or less')
  .regex(
    /^[a-zA-Z0-9-]+$/,
    'Name must contain only letters, numbers, and hyphens'
  );

/**
 * Schema for validating agent URLs.
 * - Must be valid HTTP or HTTPS URL
 */
export const A2AAgentUrlSchema = z
  .string()
  .url('Must be a valid URL')
  .refine(
    (url) => url.startsWith('http://') || url.startsWith('https://'),
    'URL must start with http:// or https://'
  );

/**
 * Schema for timeout values.
 * - 5000ms (5s) minimum
 * - 180000ms (3 min) maximum
 * - Defaults to 30000ms (30s)
 */
export const A2ATimeoutSchema = z
  .number()
  .min(5000, 'Timeout must be at least 5 seconds')
  .max(180000, 'Timeout must be at most 3 minutes')
  .default(30000);

/**
 * Schema for authentication type.
 */
export const A2AAuthTypeSchema = z.enum(['apiKey', 'bearer', 'none']);

/**
 * Schema for platform scope.
 */
export const A2APlatformScopeSchema = z.enum(['shared', 'extension', 'desktop', 'server']);

/**
 * Full schema for a persisted A2A agent configuration.
 */
export const A2AAgentConfigSchema = z.object({
  id: z.string().uuid('Invalid agent ID'),
  name: A2AAgentNameSchema,
  url: A2AAgentUrlSchema,
  apiKey: z.string().optional(),
  authType: A2AAuthTypeSchema.default('none'),
  enabled: z.boolean(),
  trusted: z.boolean(),
  timeout: A2ATimeoutSchema,
  platform: A2APlatformScopeSchema.default('shared'),
  createdAt: z.number(),
  updatedAt: z.number(),
});

/**
 * Schema for creating a new A2A agent configuration.
 * ID and timestamps are generated automatically.
 */
export const A2AAgentConfigCreateSchema = z.object({
  name: A2AAgentNameSchema,
  url: A2AAgentUrlSchema,
  apiKey: z.string().optional(),
  authType: A2AAuthTypeSchema.default('none'),
  enabled: z.boolean().default(true),
  trusted: z.boolean().default(false),
  timeout: A2ATimeoutSchema,
  platform: A2APlatformScopeSchema.default('shared'),
});

/**
 * Schema for updating an existing A2A agent configuration.
 * All fields are optional.
 */
export const A2AAgentConfigUpdateSchema = z.object({
  name: A2AAgentNameSchema.optional(),
  url: A2AAgentUrlSchema.optional(),
  apiKey: z.string().optional(),
  authType: A2AAuthTypeSchema.optional(),
  enabled: z.boolean().optional(),
  trusted: z.boolean().optional(),
  timeout: A2ATimeoutSchema.optional(),
  platform: A2APlatformScopeSchema.optional(),
});

/**
 * Schema for the array of agent configurations stored via ConfigStorageProvider.
 */
export const A2AAgentsArraySchema = z.array(A2AAgentConfigSchema);

// =============================================================================
// Type Exports
// =============================================================================

export type A2AAgentConfigInput = z.input<typeof A2AAgentConfigCreateSchema>;
export type A2AAgentConfigUpdateInput = z.input<typeof A2AAgentConfigUpdateSchema>;

// =============================================================================
// Storage Helpers
// =============================================================================

const STORAGE_KEY = 'a2aAgents';
const DEBUG_LOGGING_KEY = 'a2aDebugLogging';

/**
 * Get storage provider (throws if not initialized).
 */
function getStorage(): ConfigStorageProvider {
  return getConfigStorage();
}

/**
 * Load all A2A agent configurations from storage.
 *
 * @returns Array of validated agent configurations
 */
export async function loadAgents(): Promise<IA2AAgentConfig[]> {
  try {
    const storage = getStorage();

    const rawAgents = await storage.get<IA2AAgentConfig[]>(STORAGE_KEY);

    if (!rawAgents || !Array.isArray(rawAgents)) {
      return [];
    }

    // Validate each agent config
    const validAgents: IA2AAgentConfig[] = [];
    for (const agent of rawAgents) {
      try {
        const validated = A2AAgentConfigSchema.parse(agent);
        validAgents.push(validated);
      } catch (error) {
        console.warn('[A2AConfig] Skipping invalid agent config:', agent, error);
      }
    }

    return validAgents;
  } catch (error) {
    console.error('[A2AConfig] Failed to load agents from storage:', error);
    return [];
  }
}

/**
 * Save all A2A agent configurations to storage.
 *
 * @param agents Array of agent configurations to save
 */
export async function saveAgents(agents: IA2AAgentConfig[]): Promise<void> {
  try {
    const storage = getStorage();
    // Validate all agents before saving
    const validatedAgents = A2AAgentsArraySchema.parse(agents);
    await storage.set(STORAGE_KEY, validatedAgents);
  } catch (error) {
    console.error('[A2AConfig] Failed to save agents to storage:', error);
    throw new Error(`Failed to save A2A agent configurations: ${error}`);
  }
}

/**
 * Add a new agent configuration.
 *
 * @param input Agent configuration input
 * @param existingAgents Current list of agents (for uniqueness check)
 * @returns The created agent configuration with generated ID and timestamps
 */
export function createAgentConfig(
  input: IA2AAgentConfigCreate,
  existingAgents: IA2AAgentConfig[]
): IA2AAgentConfig {
  // Validate input
  const validated = A2AAgentConfigCreateSchema.parse(input);

  // Check for duplicate name
  const nameExists = existingAgents.some(
    (a) => a.name.toLowerCase() === validated.name.toLowerCase()
  );
  if (nameExists) {
    throw new Error(`Agent with name "${validated.name}" already exists`);
  }

  // Generate UUID
  const id = crypto.randomUUID();
  const now = Date.now();

  return {
    id,
    name: validated.name,
    url: validated.url,
    apiKey: validated.apiKey,
    authType: (validated.authType ?? 'none') as A2AAuthType,
    enabled: validated.enabled ?? true,
    trusted: validated.trusted ?? false,
    timeout: validated.timeout ?? 30000,
    platform: (validated.platform ?? 'shared') as A2APlatformScope,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Update an existing agent configuration.
 *
 * @param existing Current agent configuration
 * @param update Fields to update
 * @param allAgents All agents (for uniqueness check on name change)
 * @returns Updated agent configuration
 */
export function updateAgentConfig(
  existing: IA2AAgentConfig,
  update: IA2AAgentConfigUpdate,
  allAgents: IA2AAgentConfig[]
): IA2AAgentConfig {
  // Validate update input
  const validated = A2AAgentConfigUpdateSchema.parse(update);

  // Check for duplicate name if name is being changed
  if (validated.name && validated.name.toLowerCase() !== existing.name.toLowerCase()) {
    const nameExists = allAgents.some(
      (a) => a.id !== existing.id && a.name.toLowerCase() === validated.name!.toLowerCase()
    );
    if (nameExists) {
      throw new Error(`Agent with name "${validated.name}" already exists`);
    }
  }

  return {
    ...existing,
    name: validated.name ?? existing.name,
    url: validated.url ?? existing.url,
    apiKey: validated.apiKey !== undefined ? validated.apiKey : existing.apiKey,
    authType: validated.authType ?? existing.authType,
    enabled: validated.enabled ?? existing.enabled,
    trusted: validated.trusted ?? existing.trusted,
    timeout: validated.timeout ?? existing.timeout,
    platform: validated.platform ?? existing.platform,
    updatedAt: Date.now(),
  };
}

/**
 * Check if A2A debug logging is enabled.
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
 * Set A2A debug logging enabled/disabled.
 */
export async function setDebugLogging(enabled: boolean): Promise<void> {
  const storage = getStorage();
  await storage.set(DEBUG_LOGGING_KEY, enabled);
}

/**
 * Validate an agent configuration without creating it.
 * Returns validation errors if any.
 */
export function validateAgentConfig(input: unknown): {
  success: boolean;
  error?: string;
  data?: IA2AAgentConfigCreate;
} {
  const result = A2AAgentConfigCreateSchema.safeParse(input);
  if (result.success) {
    return { success: true, data: result.data };
  }

  // Format Zod errors into readable message
  const errors = result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`);
  return { success: false, error: errors.join('; ') };
}
