/**
 * Configuration validation functions
 */

import type {
  IAgentConfig,
  IModelConfig,
  IProviderConfig,
  IProfileConfig,
  IAuthConfig
} from './types';
import { AuthMode } from '../models/types/Auth.js';
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

  // Validate model
  if (!config.model || typeof config.model !== 'object') {
    return {
      valid: false,
      field: 'model',
      error: 'Model configuration is required'
    };
  }

  const modelValidation = validateModelConfig(config.model);
  if (!modelValidation.valid) {
    return modelValidation;
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
 * Validate authentication configuration
 */
export function validateAuthConfig(auth: any): ValidationResult {
  if (!auth || typeof auth !== 'object') {
    return { valid: false, error: 'Auth configuration must be an object' };
  }

  // Validate apiKey (if non-empty, should be valid base64)
  if (auth.apiKey && typeof auth.apiKey !== 'string') {
    return {
      valid: false,
      field: 'auth.apiKey',
      value: auth.apiKey,
      error: 'API key must be a string'
    };
  }

  // Validate authMode
  if (!Object.values(AuthMode).includes(auth.authMode)) {
    return {
      valid: false,
      field: 'auth.authMode',
      value: auth.authMode,
      error: `Invalid auth mode: must be one of ${Object.values(AuthMode).join(', ')}`
    };
  }

  // Validate lastUpdated (if provided)
  if (auth.lastUpdated !== undefined) {
    if (typeof auth.lastUpdated !== 'number' || auth.lastUpdated < 0) {
      return {
        valid: false,
        field: 'auth.lastUpdated',
        value: auth.lastUpdated,
        error: 'lastUpdated must be a non-negative number'
      };
    }
  }

  // accountId and planType can be any value or null, no validation needed

  return { valid: true };
}