/**
 * Configuration validation functions
 */

import type {
  IAgentConfig,
  IModelConfig,
  IProviderConfig,
  IProfileConfig
} from './types';
import {
  VALID_THEMES,
  VALID_UPDATE_CHANNELS,
  VALID_REASONING_EFFORTS,
  VALID_REASONING_SUMMARIES,
  VALID_VERBOSITIES,
  CONFIG_LIMITS
} from './defaults';

export interface ValidationResult {
  valid: boolean;
  field?: string;
  value?: any;
  error?: string;
}

/**
 * Validate complete configuration
 */
export function validateConfig(config: any): ValidationResult {
  if (!config || typeof config !== 'object') {
    return { valid: false, error: 'Configuration must be an object' };
  }

  // Validate version
  if (!config.version || !/^\d+\.\d+\.\d+$/.test(config.version)) {
    return {
      valid: false,
      field: 'version',
      value: config.version,
      error: 'Invalid version format, expected semver'
    };
  }

  // Validate selectedModelId (new system)
  if (config.selectedModelId) {
    if (!isValidModelId(config.selectedModelId)) {
      return {
        valid: false,
        field: 'selectedModelId',
        value: config.selectedModelId,
        error: 'Invalid model ID format, expected 6-digit numeric string'
      };
    }

    // Verify selectedModelId exists in registry
    if (config.modelRegistry && !config.modelRegistry[config.selectedModelId]) {
      return {
        valid: false,
        field: 'selectedModelId',
        value: config.selectedModelId,
        error: 'Selected model ID not found in model registry'
      };
    }

    // Verify the provider referenced in registry exists
    if (config.modelRegistry && config.providers) {
      const entry = config.modelRegistry[config.selectedModelId];
      if (entry && !config.providers[entry.providerId]) {
        return {
          valid: false,
          field: 'selectedModelId',
          value: config.selectedModelId,
          error: `Provider ${entry.providerId} not found for selected model`
        };
      }
    }
  }

  // Validate providers
  if (config.providers && typeof config.providers === 'object') {
    for (const [id, provider] of Object.entries(config.providers)) {
      const providerValidation = validateProviderConfig(provider as any);
      if (!providerValidation.valid) {
        return {
          ...providerValidation,
          field: `providers.${id}.${providerValidation.field}`
        };
      }
    }
  }

  // Validate profiles
  if (config.profiles && typeof config.profiles === 'object') {
    const profileCount = Object.keys(config.profiles).length;
    if (profileCount > CONFIG_LIMITS.MAX_PROFILES) {
      return {
        valid: false,
        field: 'profiles',
        error: `Too many profiles (${profileCount}), max is ${CONFIG_LIMITS.MAX_PROFILES}`
      };
    }

    for (const [name, profile] of Object.entries(config.profiles)) {
      const profileValidation = validateProfileConfig(profile as any);
      if (!profileValidation.valid) {
        return {
          ...profileValidation,
          field: `profiles.${name}.${profileValidation.field}`
        };
      }
    }
  }

  // Validate activeProfile exists
  if (config.activeProfile && (!config.profiles || !config.profiles[config.activeProfile])) {
    return {
      valid: false,
      field: 'activeProfile',
      value: config.activeProfile,
      error: 'Active profile does not exist'
    };
  }

  // Validate preferences
  if (config.preferences) {
    const prefsValidation = validateUserPreferences(config.preferences);
    if (!prefsValidation.valid) {
      return prefsValidation;
    }
  }

  // Validate cache settings
  if (config.cache) {
    const cacheValidation = validateCacheSettings(config.cache);
    if (!cacheValidation.valid) {
      return cacheValidation;
    }
  }

  // Validate extension settings
  if (config.extension) {
    const extValidation = validateExtensionSettings(config.extension);
    if (!extValidation.valid) {
      return extValidation;
    }
  }

  return { valid: true };
}

/**
 * Validate model configuration
 */
export function validateModelConfig(model: any): ValidationResult {
  if (!model.selected || typeof model.selected !== 'string' || model.selected.trim() === '') {
    return {
      valid: false,
      field: 'selected',
      value: model.selected,
      error: 'Model selection is required and must be non-empty'
    };
  }

  if (!model.provider || typeof model.provider !== 'string' || model.provider.trim() === '') {
    return {
      valid: false,
      field: 'provider',
      value: model.provider,
      error: 'Provider is required and must be non-empty'
    };
  }

  if (model.contextWindow !== undefined && model.contextWindow !== null) {
    if (typeof model.contextWindow !== 'number' || model.contextWindow <= 0) {
      return {
        valid: false,
        field: 'contextWindow',
        value: model.contextWindow,
        error: 'Context window must be a positive number'
      };
    }
  }

  if (model.maxOutputTokens !== undefined && model.maxOutputTokens !== null) {
    if (typeof model.maxOutputTokens !== 'number' || model.maxOutputTokens <= 0) {
      return {
        valid: false,
        field: 'maxOutputTokens',
        value: model.maxOutputTokens,
        error: 'Max output tokens must be a positive number'
      };
    }
  }

  if (model.reasoningEffort && !VALID_REASONING_EFFORTS.includes(model.reasoningEffort)) {
    return {
      valid: false,
      field: 'reasoningEffort',
      value: model.reasoningEffort,
      error: `Invalid reasoningEffort: must be ${VALID_REASONING_EFFORTS.join(', ')}`
    };
  }

  if (model.reasoningSummary && !VALID_REASONING_SUMMARIES.includes(model.reasoningSummary)) {
    return {
      valid: false,
      field: 'reasoningSummary',
      value: model.reasoningSummary,
      error: `Invalid reasoningSummary: must be ${VALID_REASONING_SUMMARIES.join(', ')}`
    };
  }

  if (model.verbosity && !VALID_VERBOSITIES.includes(model.verbosity)) {
    return {
      valid: false,
      field: 'verbosity',
      value: model.verbosity,
      error: `Invalid verbosity: must be ${VALID_VERBOSITIES.join(', ')}`
    };
  }

  return { valid: true };
}

/**
 * Validate provider configuration
 */
export function validateProviderConfig(provider: any): ValidationResult {
  if (!provider.id || typeof provider.id !== 'string') {
    return {
      valid: false,
      field: 'id',
      error: 'Provider ID is required'
    };
  }

  if (!provider.name || typeof provider.name !== 'string') {
    return {
      valid: false,
      field: 'name',
      error: 'Provider name is required'
    };
  }

  if (!provider.apiKey || typeof provider.apiKey !== 'string') {
    return {
      valid: false,
      field: 'apiKey',
      error: 'API key is required'
    };
  }

  if (provider.baseUrl && typeof provider.baseUrl === 'string') {
    try {
      new URL(provider.baseUrl);
      if (!provider.baseUrl.startsWith('https://')) {
        return {
          valid: false,
          field: 'baseUrl',
          value: provider.baseUrl,
          error: 'Base URL must use HTTPS'
        };
      }
    } catch {
      return {
        valid: false,
        field: 'baseUrl',
        value: provider.baseUrl,
        error: 'Invalid URL format'
      };
    }
  }

  if (typeof provider.timeout !== 'number' || provider.timeout < 1000 || provider.timeout > 60000) {
    return {
      valid: false,
      field: 'timeout',
      value: provider.timeout,
      error: 'Timeout must be between 1000 and 60000 ms'
    };
  }

  return { valid: true };
}

/**
 * Validate profile configuration
 */
export function validateProfileConfig(profile: any): ValidationResult {
  if (!profile.name || typeof profile.name !== 'string') {
    return {
      valid: false,
      field: 'name',
      error: 'Profile name is required'
    };
  }

  if (!profile.model || typeof profile.model !== 'string') {
    return {
      valid: false,
      field: 'model',
      error: 'Profile model is required'
    };
  }

  if (!profile.provider || typeof profile.provider !== 'string') {
    return {
      valid: false,
      field: 'provider',
      error: 'Profile provider is required'
    };
  }

  if (typeof profile.created !== 'number' || profile.created <= 0) {
    return {
      valid: false,
      field: 'created',
      error: 'Created timestamp is required'
    };
  }

  return { valid: true };
}

/**
 * Validate user preferences
 */
export function validateUserPreferences(prefs: any): ValidationResult {
  if (prefs.theme && !VALID_THEMES.includes(prefs.theme)) {
    return {
      valid: false,
      field: 'preferences.theme',
      value: prefs.theme,
      error: `Invalid theme: must be ${VALID_THEMES.join(', ')}`
    };
  }

  if (prefs.shortcuts && typeof prefs.shortcuts === 'object') {
    const shortcutCount = Object.keys(prefs.shortcuts).length;
    if (shortcutCount > CONFIG_LIMITS.MAX_SHORTCUTS) {
      return {
        valid: false,
        field: 'preferences.shortcuts',
        error: `Too many shortcuts (${shortcutCount}), max is ${CONFIG_LIMITS.MAX_SHORTCUTS}`
      };
    }
  }

  if (prefs.experimental && typeof prefs.experimental === 'object') {
    const flagCount = Object.keys(prefs.experimental).length;
    if (flagCount > CONFIG_LIMITS.MAX_EXPERIMENTAL_FLAGS) {
      return {
        valid: false,
        field: 'preferences.experimental',
        error: `Too many experimental flags (${flagCount}), max is ${CONFIG_LIMITS.MAX_EXPERIMENTAL_FLAGS}`
      };
    }
  }

  return { valid: true };
}

/**
 * Validate cache settings
 */
export function validateCacheSettings(cache: any): ValidationResult {
  if (cache.ttl !== undefined && (typeof cache.ttl !== 'number' || cache.ttl < 0 || cache.ttl > 86400)) {
    return {
      valid: false,
      field: 'cache.ttl',
      value: cache.ttl,
      error: 'TTL must be between 0 and 86400 seconds'
    };
  }

  if (cache.maxSize !== undefined && (typeof cache.maxSize !== 'number' || cache.maxSize < 0)) {
    return {
      valid: false,
      field: 'cache.maxSize',
      value: cache.maxSize,
      error: 'Max size must be non-negative'
    };
  }

  return { valid: true };
}

/**
 * Validate extension settings
 */
export function validateExtensionSettings(ext: any): ValidationResult {
  if (ext.allowedOrigins && Array.isArray(ext.allowedOrigins)) {
    for (const origin of ext.allowedOrigins) {
      if (typeof origin !== 'string') {
        return {
          valid: false,
          field: 'extension.allowedOrigins',
          value: origin,
          error: 'All allowed origins must be strings'
        };
      }
      // Basic URL pattern validation
      if (!origin.match(/^https?:\/\/[\w\-.]+(:\d+)?(\/.*)?\*?$/)) {
        return {
          valid: false,
          field: 'extension.allowedOrigins',
          value: origin,
          error: 'Invalid URL pattern'
        };
      }
    }
  }

  if (ext.storageQuotaWarning !== undefined) {
    if (typeof ext.storageQuotaWarning !== 'number' ||
        ext.storageQuotaWarning < 0 ||
        ext.storageQuotaWarning > 1) {
      return {
        valid: false,
        field: 'extension.storageQuotaWarning',
        value: ext.storageQuotaWarning,
        error: 'Storage quota warning must be between 0 and 1'
      };
    }
  }

  if (ext.updateChannel && !VALID_UPDATE_CHANNELS.includes(ext.updateChannel)) {
    return {
      valid: false,
      field: 'extension.updateChannel',
      value: ext.updateChannel,
      error: `Invalid update channel: must be ${VALID_UPDATE_CHANNELS.join(', ')}`
    };
  }

  return { valid: true };
}

/**
 * T006, Model Registry Validation Functions
 * Feature: 001-multi-model-support
 */

// ModelRegistry has been removed - validation now handled by AgentConfig

/**
 * Get default model ID
 *
 * @param config Agent configuration
 * @returns Default model ID
 */
export function getDefaultModel(config: any): string {
  const selectedModelId = config?.selectedModelId;

  if (!selectedModelId || selectedModelId.trim() === '') {
    // Return first available model ID from registry if available
    const firstModelId = Object.keys(config?.modelRegistry || {})[0];
    return firstModelId || ''; // Return empty if no models available
  }

  return selectedModelId;
}


/**
 * Detect provider from API key format
 * Returns provider ID based on key pattern
 */
export function detectProviderFromKey(apiKey: string): 'openai' | 'xai' | 'anthropic' | 'groq' | 'google-ai-studio' | 'fireworks' | 'unknown' {
  if (!apiKey || apiKey.trim() === '') {
    return 'unknown';
  }

  // Fireworks AI keys start with 'fw-' or 'fw_'
  if (apiKey.startsWith('fw-') || apiKey.startsWith('fw_')) {
    return 'fireworks';
  }

  // Google AI Studio keys commonly start with 'AIza' or 'GOAI'
  if (apiKey.startsWith('AIza') || apiKey.startsWith('GOAI')) {
    return 'google-ai-studio';
  }

  // Groq keys: gsk_ prefix + 48 alphanumeric chars (52 total)
  if (/^gsk_[A-Za-z0-9]{48}$/.test(apiKey)) {
    return 'groq';
  }

  // xAI keys start with 'xai-'
  if (apiKey.startsWith('xai-')) {
    return 'xai';
  }

  // Anthropic keys start with 'sk-ant-'
  if (apiKey.startsWith('sk-ant-')) {
    return 'anthropic';
  }

  // OpenAI keys have T3BlbkFJ signature or start with sk-proj-/sk-svcacct-
  if (apiKey.includes('T3BlbkFJ') || apiKey.startsWith('sk-proj-') || apiKey.startsWith('sk-svcacct-')) {
    return 'openai';
  }

  // Default to OpenAI for keys starting with 'sk-' (backward compatibility)
  if (apiKey.startsWith('sk-')) {
    return 'openai';
  }

  return 'unknown';
}

/**
 * Validate model ID format
 * Checks if the provided ID is a valid 6-digit zero-padded numeric string
 * @param id - Model ID to validate
 * @returns true if ID is valid 6-digit format (e.g., "000001", "000042")
 * @example
 * isValidModelId("000001"); // true
 * isValidModelId("123");    // false
 * isValidModelId("abc123"); // false
 */
export function isValidModelId(id: string): boolean {
  return /^\d{6}$/.test(id);
}

/**
 * T065: Validate model ID uniqueness across all providers
 * Ensures no duplicate model IDs exist in the configuration
 * @param config - Agent configuration to validate
 * @returns Validation result with duplicate IDs if found
 * @example
 * const result = validateModelIdUniqueness(config);
 * if (!result.valid) {
 *   console.error('Duplicate model IDs:', result.duplicates);
 * }
 */
export function validateModelIdUniqueness(config: IAgentConfig): {
  valid: boolean;
  duplicates: string[];
  error?: string;
} {
  const seenIds = new Set<string>();
  const duplicates: string[] = [];

  // Check all models across all providers
  for (const provider of Object.values(config.providers)) {
    if (!provider.models || !Array.isArray(provider.models)) {
      continue;
    }

    for (const model of provider.models) {
      if (!model.id) {
        continue; // Skip models without IDs (will be auto-generated)
      }

      if (seenIds.has(model.id)) {
        duplicates.push(model.id);
      } else {
        seenIds.add(model.id);
      }
    }
  }

  if (duplicates.length > 0) {
    return {
      valid: false,
      duplicates,
      error: `Duplicate model IDs found: ${duplicates.join(', ')}`
    };
  }

  return {
    valid: true,
    duplicates: []
  };
}
