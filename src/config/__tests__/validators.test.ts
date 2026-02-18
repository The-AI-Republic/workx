import { describe, it, expect } from 'vitest';
import {
  validateConfig,
  validateModelConfig,
  validateProviderConfig,
  validateProfileConfig,
  validateUserPreferences,
  validateCacheSettings,
  validateExtensionSettings,
  getDefaultModel,
  detectProviderFromKey,
  isValidModelId,
  validateModelKeyUniqueness,
  validateModelIdUniqueness,
} from '@/config/validators';
import type { ValidationResult } from '@/config/validators';
import { CONFIG_LIMITS } from '@/config/defaults';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid provider for use in config-level tests */
function makeProvider(overrides: Record<string, any> = {}) {
  return {
    id: 'test-provider',
    name: 'Test Provider',
    apiKey: 'sk-test-key',
    timeout: 30000,
    models: [{ modelKey: 'test-model', name: 'Test Model' }],
    ...overrides,
  };
}

/** Minimal valid config for validateConfig */
function makeConfig(overrides: Record<string, any> = {}) {
  return {
    version: '1.0.0',
    providers: {
      'test-provider': makeProvider(),
    },
    selectedModelKey: 'test-provider:test-model',
    ...overrides,
  };
}

// ===========================================================================
// 1. validateConfig
// ===========================================================================
describe('validateConfig', () => {
  it('should reject null', () => {
    const result = validateConfig(null);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('object');
  });

  it('should reject undefined', () => {
    const result = validateConfig(undefined);
    expect(result.valid).toBe(false);
  });

  it('should reject non-object primitives', () => {
    expect(validateConfig(42).valid).toBe(false);
    expect(validateConfig('hello').valid).toBe(false);
    expect(validateConfig(true).valid).toBe(false);
  });

  it('should reject empty object (missing version)', () => {
    const result = validateConfig({});
    expect(result.valid).toBe(false);
    expect(result.field).toBe('version');
  });

  it('should reject invalid semver versions', () => {
    for (const bad of ['abc', '1.0', '1', '1.0.0.0', 'v1.0.0', '1.0.0-beta']) {
      const result = validateConfig({ version: bad });
      expect(result.valid).toBe(false);
      expect(result.field).toBe('version');
      expect(result.value).toBe(bad);
    }
  });

  it('should accept a valid minimal config', () => {
    const result = validateConfig({ version: '1.0.0' });
    expect(result.valid).toBe(true);
  });

  // -- selectedModelKey --
  it('should reject selectedModelKey without colon separator', () => {
    const result = validateConfig({ version: '1.0.0', selectedModelKey: 'nocolon' });
    expect(result.valid).toBe(false);
    expect(result.field).toBe('selectedModelKey');
    expect(result.error).toContain('providerId:modelKey');
  });

  it('should accept selectedModelKey with proper colon format', () => {
    const result = validateConfig(makeConfig());
    expect(result.valid).toBe(true);
  });

  it('should reject selectedModelKey when provider does not exist', () => {
    const cfg = makeConfig({ selectedModelKey: 'missing-provider:some-model' });
    const result = validateConfig(cfg);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('missing-provider');
  });

  it('should reject selectedModelKey when model does not exist in provider', () => {
    const cfg = makeConfig({ selectedModelKey: 'test-provider:nonexistent-model' });
    const result = validateConfig(cfg);
    expect(result.valid).toBe(false);
    expect(result.error).toContain('nonexistent-model');
  });

  it('should skip provider/model existence check when providers is absent', () => {
    const result = validateConfig({
      version: '1.0.0',
      selectedModelKey: 'any:thing',
    });
    expect(result.valid).toBe(true);
  });

  // -- providers delegation --
  it('should reject config when a nested provider is invalid', () => {
    const result = validateConfig({
      version: '1.0.0',
      providers: { bad: { name: 'Bad' } }, // missing id, timeout
    });
    expect(result.valid).toBe(false);
    expect(result.field).toContain('providers.bad');
  });

  // -- profiles --
  it('should reject when profile count exceeds MAX_PROFILES', () => {
    const profiles: Record<string, any> = {};
    for (let i = 0; i <= CONFIG_LIMITS.MAX_PROFILES; i++) {
      profiles[`p${i}`] = { name: `Profile ${i}`, model: 'm', provider: 'p', created: 1 };
    }
    const result = validateConfig({ version: '1.0.0', profiles });
    expect(result.valid).toBe(false);
    expect(result.field).toBe('profiles');
    expect(result.error).toContain('Too many profiles');
  });

  it('should reject when a nested profile is invalid', () => {
    const result = validateConfig({
      version: '1.0.0',
      profiles: { myprofile: { name: 'P', model: 'm' } }, // missing provider, created
    });
    expect(result.valid).toBe(false);
    expect(result.field).toContain('profiles.myprofile');
  });

  // -- activeProfile --
  it('should reject activeProfile that does not exist in profiles', () => {
    const result = validateConfig({
      version: '1.0.0',
      activeProfile: 'ghost',
      profiles: {},
    });
    expect(result.valid).toBe(false);
    expect(result.field).toBe('activeProfile');
    expect(result.error).toContain('does not exist');
  });

  it('should accept activeProfile when profiles is missing', () => {
    // The guard checks `!config.profiles`, which is truthy for undefined,
    // so this should technically fail — activeProfile is set but profiles is absent
    const result = validateConfig({
      version: '1.0.0',
      activeProfile: 'ghost',
    });
    expect(result.valid).toBe(false);
    expect(result.field).toBe('activeProfile');
  });

  it('should accept activeProfile that exists in profiles', () => {
    const result = validateConfig({
      version: '1.0.0',
      activeProfile: 'main',
      profiles: {
        main: { name: 'Main', model: 'gpt-4', provider: 'openai', created: 1 },
      },
    });
    expect(result.valid).toBe(true);
  });

  // -- preferences delegation --
  it('should reject config with invalid preferences', () => {
    const result = validateConfig({
      version: '1.0.0',
      preferences: { theme: 'rainbow' },
    });
    expect(result.valid).toBe(false);
    expect(result.error).toContain('theme');
  });

  // -- cache delegation --
  it('should reject config with invalid cache settings', () => {
    const result = validateConfig({
      version: '1.0.0',
      cache: { ttl: -1 },
    });
    expect(result.valid).toBe(false);
  });

  // -- extension delegation --
  it('should reject config with invalid extension settings', () => {
    const result = validateConfig({
      version: '1.0.0',
      extension: { updateChannel: 'nightly' },
    });
    expect(result.valid).toBe(false);
  });

  it('should pass full valid config with all sections', () => {
    const result = validateConfig({
      version: '2.1.0',
      selectedModelKey: 'test-provider:test-model',
      providers: { 'test-provider': makeProvider() },
      profiles: {
        default: { name: 'Default', model: 'gpt-4', provider: 'openai', created: Date.now() },
      },
      activeProfile: 'default',
      preferences: { theme: 'dark' },
      cache: { ttl: 3600, maxSize: 1024 },
      extension: { updateChannel: 'beta', storageQuotaWarning: 0.5 },
    });
    expect(result.valid).toBe(true);
  });
});

// ===========================================================================
// 2. validateModelConfig
// ===========================================================================
describe('validateModelConfig', () => {
  it('should reject when selected is missing', () => {
    const result = validateModelConfig({ provider: 'openai' });
    expect(result.valid).toBe(false);
    expect(result.field).toBe('selected');
  });

  it('should reject when selected is empty string', () => {
    const result = validateModelConfig({ selected: '  ', provider: 'openai' });
    expect(result.valid).toBe(false);
    expect(result.field).toBe('selected');
  });

  it('should reject when selected is not a string', () => {
    const result = validateModelConfig({ selected: 123, provider: 'openai' });
    expect(result.valid).toBe(false);
    expect(result.field).toBe('selected');
  });

  it('should reject when provider is missing', () => {
    const result = validateModelConfig({ selected: 'gpt-4' });
    expect(result.valid).toBe(false);
    expect(result.field).toBe('provider');
  });

  it('should reject when provider is empty string', () => {
    const result = validateModelConfig({ selected: 'gpt-4', provider: '  ' });
    expect(result.valid).toBe(false);
    expect(result.field).toBe('provider');
  });

  it('should reject non-number contextWindow', () => {
    const result = validateModelConfig({ selected: 'gpt-4', provider: 'openai', contextWindow: 'big' });
    expect(result.valid).toBe(false);
    expect(result.field).toBe('contextWindow');
  });

  it('should reject zero contextWindow', () => {
    const result = validateModelConfig({ selected: 'gpt-4', provider: 'openai', contextWindow: 0 });
    expect(result.valid).toBe(false);
    expect(result.field).toBe('contextWindow');
  });

  it('should reject negative contextWindow', () => {
    const result = validateModelConfig({ selected: 'gpt-4', provider: 'openai', contextWindow: -100 });
    expect(result.valid).toBe(false);
    expect(result.field).toBe('contextWindow');
  });

  it('should accept undefined contextWindow', () => {
    const result = validateModelConfig({ selected: 'gpt-4', provider: 'openai' });
    expect(result.valid).toBe(true);
  });

  it('should accept null contextWindow', () => {
    const result = validateModelConfig({ selected: 'gpt-4', provider: 'openai', contextWindow: null });
    expect(result.valid).toBe(true);
  });

  it('should accept positive contextWindow', () => {
    const result = validateModelConfig({ selected: 'gpt-4', provider: 'openai', contextWindow: 128000 });
    expect(result.valid).toBe(true);
  });

  it('should reject non-number maxOutputTokens', () => {
    const result = validateModelConfig({ selected: 'gpt-4', provider: 'openai', maxOutputTokens: 'lots' });
    expect(result.valid).toBe(false);
    expect(result.field).toBe('maxOutputTokens');
  });

  it('should reject zero maxOutputTokens', () => {
    const result = validateModelConfig({ selected: 'gpt-4', provider: 'openai', maxOutputTokens: 0 });
    expect(result.valid).toBe(false);
    expect(result.field).toBe('maxOutputTokens');
  });

  it('should accept positive maxOutputTokens', () => {
    const result = validateModelConfig({ selected: 'gpt-4', provider: 'openai', maxOutputTokens: 4096 });
    expect(result.valid).toBe(true);
  });

  it('should reject invalid reasoningEffort', () => {
    const result = validateModelConfig({ selected: 'gpt-4', provider: 'openai', reasoningEffort: 'extreme' });
    expect(result.valid).toBe(false);
    expect(result.field).toBe('reasoningEffort');
  });

  it('should accept valid reasoningEffort values', () => {
    for (const effort of ['minimal', 'low', 'medium', 'high']) {
      const result = validateModelConfig({ selected: 'gpt-4', provider: 'openai', reasoningEffort: effort });
      expect(result.valid).toBe(true);
    }
  });

  it('should reject invalid reasoningSummary', () => {
    const result = validateModelConfig({ selected: 'gpt-4', provider: 'openai', reasoningSummary: 'verbose' });
    expect(result.valid).toBe(false);
    expect(result.field).toBe('reasoningSummary');
  });

  it('should accept valid reasoningSummary values', () => {
    for (const summary of ['auto', 'concise', 'detailed', 'none']) {
      const result = validateModelConfig({ selected: 'gpt-4', provider: 'openai', reasoningSummary: summary });
      expect(result.valid).toBe(true);
    }
  });

  it('should reject invalid verbosity', () => {
    const result = validateModelConfig({ selected: 'gpt-4', provider: 'openai', verbosity: 'extreme' });
    expect(result.valid).toBe(false);
    expect(result.field).toBe('verbosity');
  });

  it('should accept valid verbosity values', () => {
    for (const v of ['low', 'medium', 'high']) {
      const result = validateModelConfig({ selected: 'gpt-4', provider: 'openai', verbosity: v });
      expect(result.valid).toBe(true);
    }
  });

  it('should accept a fully valid model config', () => {
    const result = validateModelConfig({
      selected: 'gpt-4',
      provider: 'openai',
      contextWindow: 128000,
      maxOutputTokens: 4096,
      reasoningEffort: 'high',
      reasoningSummary: 'concise',
      verbosity: 'medium',
    });
    expect(result.valid).toBe(true);
  });
});

// ===========================================================================
// 3. validateProviderConfig
// ===========================================================================
describe('validateProviderConfig', () => {
  it('should reject missing id', () => {
    const result = validateProviderConfig({ name: 'Test', timeout: 5000 });
    expect(result.valid).toBe(false);
    expect(result.field).toBe('id');
  });

  it('should reject non-string id', () => {
    const result = validateProviderConfig({ id: 123, name: 'Test', timeout: 5000 });
    expect(result.valid).toBe(false);
    expect(result.field).toBe('id');
  });

  it('should reject missing name', () => {
    const result = validateProviderConfig({ id: 'test', timeout: 5000 });
    expect(result.valid).toBe(false);
    expect(result.field).toBe('name');
  });

  it('should reject non-string name', () => {
    const result = validateProviderConfig({ id: 'test', name: 42, timeout: 5000 });
    expect(result.valid).toBe(false);
    expect(result.field).toBe('name');
  });

  it('should reject non-string apiKey (number)', () => {
    const result = validateProviderConfig({ id: 'test', name: 'Test', apiKey: 12345, timeout: 5000 });
    expect(result.valid).toBe(false);
    expect(result.field).toBe('apiKey');
  });

  it('should accept undefined apiKey', () => {
    const result = validateProviderConfig({ id: 'test', name: 'Test', timeout: 5000 });
    expect(result.valid).toBe(true);
  });

  it('should accept empty string apiKey', () => {
    const result = validateProviderConfig({ id: 'test', name: 'Test', apiKey: '', timeout: 5000 });
    expect(result.valid).toBe(true);
  });

  it('should reject invalid URL format for baseUrl', () => {
    const result = validateProviderConfig({ id: 'test', name: 'Test', baseUrl: 'not-a-url', timeout: 5000 });
    expect(result.valid).toBe(false);
    expect(result.field).toBe('baseUrl');
    expect(result.error).toContain('Invalid URL');
  });

  it('should reject non-HTTPS baseUrl', () => {
    const result = validateProviderConfig({ id: 'test', name: 'Test', baseUrl: 'http://api.example.com', timeout: 5000 });
    expect(result.valid).toBe(false);
    expect(result.field).toBe('baseUrl');
    expect(result.error).toContain('HTTPS');
  });

  it('should accept valid HTTPS baseUrl', () => {
    const result = validateProviderConfig({ id: 'test', name: 'Test', baseUrl: 'https://api.example.com', timeout: 5000 });
    expect(result.valid).toBe(true);
  });

  it('should reject timeout below 1000ms', () => {
    const result = validateProviderConfig({ id: 'test', name: 'Test', timeout: 500 });
    expect(result.valid).toBe(false);
    expect(result.field).toBe('timeout');
  });

  it('should reject timeout above 60000ms', () => {
    const result = validateProviderConfig({ id: 'test', name: 'Test', timeout: 120000 });
    expect(result.valid).toBe(false);
    expect(result.field).toBe('timeout');
  });

  it('should reject missing timeout', () => {
    const result = validateProviderConfig({ id: 'test', name: 'Test' });
    expect(result.valid).toBe(false);
    expect(result.field).toBe('timeout');
  });

  it('should reject non-number timeout', () => {
    const result = validateProviderConfig({ id: 'test', name: 'Test', timeout: '5000' });
    expect(result.valid).toBe(false);
    expect(result.field).toBe('timeout');
  });

  it('should accept timeout at lower boundary (1000)', () => {
    const result = validateProviderConfig({ id: 'test', name: 'Test', timeout: 1000 });
    expect(result.valid).toBe(true);
  });

  it('should accept timeout at upper boundary (60000)', () => {
    const result = validateProviderConfig({ id: 'test', name: 'Test', timeout: 60000 });
    expect(result.valid).toBe(true);
  });

  it('should accept a fully valid provider', () => {
    const result = validateProviderConfig(makeProvider());
    expect(result.valid).toBe(true);
  });
});

// ===========================================================================
// 4. validateProfileConfig
// ===========================================================================
describe('validateProfileConfig', () => {
  it('should reject missing name', () => {
    const result = validateProfileConfig({ model: 'gpt-4', provider: 'openai', created: 1 });
    expect(result.valid).toBe(false);
    expect(result.field).toBe('name');
  });

  it('should reject non-string name', () => {
    const result = validateProfileConfig({ name: 42, model: 'gpt-4', provider: 'openai', created: 1 });
    expect(result.valid).toBe(false);
    expect(result.field).toBe('name');
  });

  it('should reject missing model', () => {
    const result = validateProfileConfig({ name: 'My Profile', provider: 'openai', created: 1 });
    expect(result.valid).toBe(false);
    expect(result.field).toBe('model');
  });

  it('should reject non-string model', () => {
    const result = validateProfileConfig({ name: 'P', model: false, provider: 'openai', created: 1 });
    expect(result.valid).toBe(false);
    expect(result.field).toBe('model');
  });

  it('should reject missing provider', () => {
    const result = validateProfileConfig({ name: 'My Profile', model: 'gpt-4', created: 1 });
    expect(result.valid).toBe(false);
    expect(result.field).toBe('provider');
  });

  it('should reject non-string provider', () => {
    const result = validateProfileConfig({ name: 'P', model: 'gpt-4', provider: 123, created: 1 });
    expect(result.valid).toBe(false);
    expect(result.field).toBe('provider');
  });

  it('should reject missing created timestamp', () => {
    const result = validateProfileConfig({ name: 'P', model: 'gpt-4', provider: 'openai' });
    expect(result.valid).toBe(false);
    expect(result.field).toBe('created');
  });

  it('should reject zero created timestamp', () => {
    const result = validateProfileConfig({ name: 'P', model: 'gpt-4', provider: 'openai', created: 0 });
    expect(result.valid).toBe(false);
    expect(result.field).toBe('created');
  });

  it('should reject negative created timestamp', () => {
    const result = validateProfileConfig({ name: 'P', model: 'gpt-4', provider: 'openai', created: -100 });
    expect(result.valid).toBe(false);
    expect(result.field).toBe('created');
  });

  it('should reject non-number created timestamp', () => {
    const result = validateProfileConfig({ name: 'P', model: 'gpt-4', provider: 'openai', created: '2024-01-01' });
    expect(result.valid).toBe(false);
    expect(result.field).toBe('created');
  });

  it('should accept a valid profile', () => {
    const result = validateProfileConfig({ name: 'Default', model: 'gpt-4', provider: 'openai', created: Date.now() });
    expect(result.valid).toBe(true);
  });
});

// ===========================================================================
// 5. validateUserPreferences
// ===========================================================================
describe('validateUserPreferences', () => {
  it('should reject invalid theme', () => {
    const result = validateUserPreferences({ theme: 'rainbow' });
    expect(result.valid).toBe(false);
    expect(result.field).toBe('preferences.theme');
  });

  it('should accept valid themes', () => {
    for (const theme of ['light', 'dark', 'system']) {
      expect(validateUserPreferences({ theme }).valid).toBe(true);
    }
  });

  it('should accept empty preferences', () => {
    expect(validateUserPreferences({}).valid).toBe(true);
  });

  it('should reject too many shortcuts', () => {
    const shortcuts: Record<string, string> = {};
    for (let i = 0; i <= CONFIG_LIMITS.MAX_SHORTCUTS; i++) {
      shortcuts[`key${i}`] = `value${i}`;
    }
    const result = validateUserPreferences({ shortcuts });
    expect(result.valid).toBe(false);
    expect(result.field).toBe('preferences.shortcuts');
    expect(result.error).toContain('Too many shortcuts');
  });

  it('should accept shortcuts within limit', () => {
    const shortcuts: Record<string, string> = {};
    for (let i = 0; i < CONFIG_LIMITS.MAX_SHORTCUTS; i++) {
      shortcuts[`key${i}`] = `value${i}`;
    }
    const result = validateUserPreferences({ shortcuts });
    expect(result.valid).toBe(true);
  });

  it('should reject too many experimental flags', () => {
    const experimental: Record<string, boolean> = {};
    for (let i = 0; i <= CONFIG_LIMITS.MAX_EXPERIMENTAL_FLAGS; i++) {
      experimental[`flag${i}`] = true;
    }
    const result = validateUserPreferences({ experimental });
    expect(result.valid).toBe(false);
    expect(result.field).toBe('preferences.experimental');
    expect(result.error).toContain('Too many experimental flags');
  });

  it('should accept experimental flags within limit', () => {
    const experimental: Record<string, boolean> = {};
    for (let i = 0; i < CONFIG_LIMITS.MAX_EXPERIMENTAL_FLAGS; i++) {
      experimental[`flag${i}`] = true;
    }
    const result = validateUserPreferences({ experimental });
    expect(result.valid).toBe(true);
  });
});

// ===========================================================================
// 6. validateCacheSettings
// ===========================================================================
describe('validateCacheSettings', () => {
  it('should reject negative ttl', () => {
    const result = validateCacheSettings({ ttl: -1 });
    expect(result.valid).toBe(false);
    expect(result.field).toBe('cache.ttl');
  });

  it('should reject ttl above 86400', () => {
    const result = validateCacheSettings({ ttl: 86401 });
    expect(result.valid).toBe(false);
    expect(result.field).toBe('cache.ttl');
  });

  it('should reject non-number ttl', () => {
    const result = validateCacheSettings({ ttl: '3600' });
    expect(result.valid).toBe(false);
    expect(result.field).toBe('cache.ttl');
  });

  it('should accept ttl at lower boundary (0)', () => {
    expect(validateCacheSettings({ ttl: 0 }).valid).toBe(true);
  });

  it('should accept ttl at upper boundary (86400)', () => {
    expect(validateCacheSettings({ ttl: 86400 }).valid).toBe(true);
  });

  it('should accept undefined ttl', () => {
    expect(validateCacheSettings({}).valid).toBe(true);
  });

  it('should reject negative maxSize', () => {
    const result = validateCacheSettings({ maxSize: -1 });
    expect(result.valid).toBe(false);
    expect(result.field).toBe('cache.maxSize');
  });

  it('should reject non-number maxSize', () => {
    const result = validateCacheSettings({ maxSize: '1024' });
    expect(result.valid).toBe(false);
    expect(result.field).toBe('cache.maxSize');
  });

  it('should accept zero maxSize', () => {
    expect(validateCacheSettings({ maxSize: 0 }).valid).toBe(true);
  });

  it('should accept large maxSize', () => {
    expect(validateCacheSettings({ maxSize: 10_000_000 }).valid).toBe(true);
  });

  it('should accept valid cache settings with both fields', () => {
    expect(validateCacheSettings({ ttl: 3600, maxSize: 5242880 }).valid).toBe(true);
  });
});

// ===========================================================================
// 7. validateExtensionSettings
// ===========================================================================
describe('validateExtensionSettings', () => {
  it('should reject non-string items in allowedOrigins', () => {
    const result = validateExtensionSettings({ allowedOrigins: [123] });
    expect(result.valid).toBe(false);
    expect(result.field).toBe('extension.allowedOrigins');
    expect(result.error).toContain('strings');
  });

  it('should reject invalid URL patterns in allowedOrigins', () => {
    const result = validateExtensionSettings({ allowedOrigins: ['not-a-url'] });
    expect(result.valid).toBe(false);
    expect(result.field).toBe('extension.allowedOrigins');
    expect(result.error).toContain('Invalid URL pattern');
  });

  it('should accept valid URL patterns in allowedOrigins', () => {
    const result = validateExtensionSettings({
      allowedOrigins: ['https://example.com', 'http://localhost:3000'],
    });
    expect(result.valid).toBe(true);
  });

  it('should accept valid URL patterns with wildcards', () => {
    const result = validateExtensionSettings({
      allowedOrigins: ['https://example.com/*'],
    });
    expect(result.valid).toBe(true);
  });

  it('should accept empty allowedOrigins array', () => {
    expect(validateExtensionSettings({ allowedOrigins: [] }).valid).toBe(true);
  });

  it('should reject storageQuotaWarning below 0', () => {
    const result = validateExtensionSettings({ storageQuotaWarning: -0.1 });
    expect(result.valid).toBe(false);
    expect(result.field).toBe('extension.storageQuotaWarning');
  });

  it('should reject storageQuotaWarning above 1', () => {
    const result = validateExtensionSettings({ storageQuotaWarning: 1.1 });
    expect(result.valid).toBe(false);
    expect(result.field).toBe('extension.storageQuotaWarning');
  });

  it('should reject non-number storageQuotaWarning', () => {
    const result = validateExtensionSettings({ storageQuotaWarning: '0.8' });
    expect(result.valid).toBe(false);
    expect(result.field).toBe('extension.storageQuotaWarning');
  });

  it('should accept storageQuotaWarning at boundaries (0 and 1)', () => {
    expect(validateExtensionSettings({ storageQuotaWarning: 0 }).valid).toBe(true);
    expect(validateExtensionSettings({ storageQuotaWarning: 1 }).valid).toBe(true);
  });

  it('should accept valid storageQuotaWarning (0.8)', () => {
    expect(validateExtensionSettings({ storageQuotaWarning: 0.8 }).valid).toBe(true);
  });

  it('should reject invalid updateChannel', () => {
    const result = validateExtensionSettings({ updateChannel: 'nightly' });
    expect(result.valid).toBe(false);
    expect(result.field).toBe('extension.updateChannel');
  });

  it('should accept valid updateChannel values', () => {
    for (const ch of ['stable', 'beta']) {
      expect(validateExtensionSettings({ updateChannel: ch }).valid).toBe(true);
    }
  });

  it('should accept empty extension settings', () => {
    expect(validateExtensionSettings({}).valid).toBe(true);
  });

  it('should accept a fully valid extension settings object', () => {
    const result = validateExtensionSettings({
      allowedOrigins: ['https://example.com'],
      storageQuotaWarning: 0.8,
      updateChannel: 'stable',
    });
    expect(result.valid).toBe(true);
  });
});

// ===========================================================================
// 8. getDefaultModel
// ===========================================================================
describe('getDefaultModel', () => {
  it('should return selectedModelKey when present', () => {
    const config = { selectedModelKey: 'openai:gpt-4' };
    expect(getDefaultModel(config)).toBe('openai:gpt-4');
  });

  it('should return empty string when selectedModelKey is empty and no providers', () => {
    expect(getDefaultModel({ selectedModelKey: '' })).toBe('');
  });

  it('should return empty string when selectedModelKey is whitespace and no providers', () => {
    expect(getDefaultModel({ selectedModelKey: '   ' })).toBe('');
  });

  it('should return empty string when config is null', () => {
    expect(getDefaultModel(null)).toBe('');
  });

  it('should return empty string when config is undefined', () => {
    expect(getDefaultModel(undefined)).toBe('');
  });

  it('should fallback to first model from first provider when selectedModelKey is missing', () => {
    const config = {
      providers: {
        openai: { models: [{ modelKey: 'gpt-4' }, { modelKey: 'gpt-3.5' }] },
      },
    };
    expect(getDefaultModel(config)).toBe('openai:gpt-4');
  });

  it('should skip providers with empty models array', () => {
    const config = {
      providers: {
        empty: { models: [] },
        openai: { models: [{ modelKey: 'gpt-4' }] },
      },
    };
    expect(getDefaultModel(config)).toBe('openai:gpt-4');
  });

  it('should return empty string when all providers have no models', () => {
    const config = {
      providers: {
        empty1: { models: [] },
        empty2: {},
      },
    };
    expect(getDefaultModel(config)).toBe('');
  });

  it('should return empty string when providers object is empty', () => {
    const config = { providers: {} };
    expect(getDefaultModel(config)).toBe('');
  });
});

// ===========================================================================
// 9. detectProviderFromKey
// ===========================================================================
describe('detectProviderFromKey', () => {
  it('should return unknown for empty string', () => {
    expect(detectProviderFromKey('')).toBe('unknown');
  });

  it('should return unknown for whitespace-only string', () => {
    expect(detectProviderFromKey('   ')).toBe('unknown');
  });

  it('should detect fireworks from fw- prefix', () => {
    expect(detectProviderFromKey('fw-abc123')).toBe('fireworks');
  });

  it('should detect fireworks from fw_ prefix', () => {
    expect(detectProviderFromKey('fw_abc123')).toBe('fireworks');
  });

  it('should detect google-ai-studio from AIza prefix', () => {
    expect(detectProviderFromKey('AIzaSyD_abc123')).toBe('google-ai-studio');
  });

  it('should detect google-ai-studio from GOAI prefix', () => {
    expect(detectProviderFromKey('GOAI_abc123')).toBe('google-ai-studio');
  });

  it('should detect groq from gsk_ prefix with correct length', () => {
    // gsk_ + 48 alphanumeric chars = 52 total
    const key = 'gsk_' + 'a'.repeat(48);
    expect(detectProviderFromKey(key)).toBe('groq');
  });

  it('should not detect groq when gsk_ key has wrong length', () => {
    const key = 'gsk_' + 'a'.repeat(10);
    expect(detectProviderFromKey(key)).not.toBe('groq');
  });

  it('should detect xai from xai- prefix', () => {
    expect(detectProviderFromKey('xai-abc123')).toBe('xai');
  });

  it('should detect anthropic from sk-ant- prefix', () => {
    expect(detectProviderFromKey('sk-ant-api03-abc123')).toBe('anthropic');
  });

  it('should detect openai from T3BlbkFJ signature', () => {
    expect(detectProviderFromKey('some-key-with-T3BlbkFJ-in-it')).toBe('openai');
  });

  it('should detect openai from sk-proj- prefix', () => {
    expect(detectProviderFromKey('sk-proj-abc123')).toBe('openai');
  });

  it('should detect openai from sk-svcacct- prefix', () => {
    expect(detectProviderFromKey('sk-svcacct-abc123')).toBe('openai');
  });

  it('should default to openai for generic sk- prefix', () => {
    expect(detectProviderFromKey('sk-abc123')).toBe('openai');
  });

  it('should return unknown for unrecognized key format', () => {
    expect(detectProviderFromKey('some-random-key')).toBe('unknown');
  });

  it('should return unknown for numeric-only key', () => {
    expect(detectProviderFromKey('1234567890')).toBe('unknown');
  });
});

// ===========================================================================
// 10. isValidModelId
// ===========================================================================
describe('isValidModelId', () => {
  it('should accept valid 6-digit zero-padded IDs', () => {
    expect(isValidModelId('000001')).toBe(true);
    expect(isValidModelId('000042')).toBe(true);
    expect(isValidModelId('123456')).toBe(true);
    expect(isValidModelId('000000')).toBe(true);
    expect(isValidModelId('999999')).toBe(true);
  });

  it('should reject too short IDs', () => {
    expect(isValidModelId('123')).toBe(false);
    expect(isValidModelId('12345')).toBe(false);
    expect(isValidModelId('')).toBe(false);
  });

  it('should reject too long IDs', () => {
    expect(isValidModelId('1234567')).toBe(false);
    expect(isValidModelId('12345678')).toBe(false);
  });

  it('should reject IDs with letters', () => {
    expect(isValidModelId('abc123')).toBe(false);
    expect(isValidModelId('12a456')).toBe(false);
    expect(isValidModelId('abcdef')).toBe(false);
  });

  it('should reject IDs with special characters', () => {
    expect(isValidModelId('12-456')).toBe(false);
    expect(isValidModelId('12.456')).toBe(false);
    expect(isValidModelId('12 456')).toBe(false);
  });
});

// ===========================================================================
// 11. validateModelKeyUniqueness
// ===========================================================================
describe('validateModelKeyUniqueness', () => {
  it('should return valid when no duplicates exist', () => {
    const config = {
      providers: {
        openai: { models: [{ modelKey: 'gpt-4' }, { modelKey: 'gpt-3.5' }] },
        anthropic: { models: [{ modelKey: 'claude-3' }] },
      },
    } as any;
    const result = validateModelKeyUniqueness(config);
    expect(result.valid).toBe(true);
    expect(result.duplicates).toEqual([]);
  });

  it('should detect duplicate keys within the same provider', () => {
    const config = {
      providers: {
        openai: { models: [{ modelKey: 'gpt-4' }, { modelKey: 'gpt-4' }] },
      },
    } as any;
    const result = validateModelKeyUniqueness(config);
    expect(result.valid).toBe(false);
    expect(result.duplicates).toContain('openai:gpt-4');
    expect(result.error).toContain('Duplicate model keys');
  });

  it('should allow same modelKey across different providers', () => {
    const config = {
      providers: {
        providerA: { models: [{ modelKey: 'same-model' }] },
        providerB: { models: [{ modelKey: 'same-model' }] },
      },
    } as any;
    const result = validateModelKeyUniqueness(config);
    expect(result.valid).toBe(true);
  });

  it('should handle providers with missing models array', () => {
    const config = {
      providers: {
        openai: { models: [{ modelKey: 'gpt-4' }] },
        broken: {},
      },
    } as any;
    const result = validateModelKeyUniqueness(config);
    expect(result.valid).toBe(true);
  });

  it('should handle providers with non-array models', () => {
    const config = {
      providers: {
        openai: { models: 'not-an-array' },
      },
    } as any;
    const result = validateModelKeyUniqueness(config);
    expect(result.valid).toBe(true);
  });

  it('should skip models without modelKey', () => {
    const config = {
      providers: {
        openai: { models: [{ modelKey: 'gpt-4' }, { name: 'no-key' }, { modelKey: 'gpt-3.5' }] },
      },
    } as any;
    const result = validateModelKeyUniqueness(config);
    expect(result.valid).toBe(true);
  });

  it('should handle empty providers', () => {
    const config = { providers: {} } as any;
    const result = validateModelKeyUniqueness(config);
    expect(result.valid).toBe(true);
    expect(result.duplicates).toEqual([]);
  });

  it('should detect multiple duplicates across providers', () => {
    const config = {
      providers: {
        openai: { models: [{ modelKey: 'gpt-4' }, { modelKey: 'gpt-4' }, { modelKey: 'gpt-4' }] },
      },
    } as any;
    const result = validateModelKeyUniqueness(config);
    expect(result.valid).toBe(false);
    // Two duplicates for the same key (second and third occurrences)
    expect(result.duplicates.length).toBe(2);
  });
});

// ===========================================================================
// 12. validateModelIdUniqueness (deprecated alias)
// ===========================================================================
describe('validateModelIdUniqueness (deprecated alias)', () => {
  it('should be the same function as validateModelKeyUniqueness', () => {
    expect(validateModelIdUniqueness).toBe(validateModelKeyUniqueness);
  });
});
