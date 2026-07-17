/**
 * Default centralized agent configuration values
 */

import type { IAgentConfig, IUserPreferences, ICacheSettings, IExtensionSettings, IPermissionSettings, IToolsConfig, IStorageConfig, IStoredConfig, IProviderConfig, IAppServerConfig } from './types';
import { DEFAULT_APPROVAL_CONFIG } from '../core/approval/types';
import { DEFAULT_MODE } from '../prompts/PromptComposer';
import defaultProviders from '../core/models/providers/default.json';
import { applyPolicy, getActivePolicySync } from '../core/config/policy';
import { getRemoteProviders } from './remoteCatalog';

export const DEFAULT_USER_PREFERENCES: IUserPreferences = {
  autoSync: true,
  telemetryEnabled: false,
  theme: 'system',
  uiTheme: 'modern-auto',
  autoStartEnabled: false,
  zoomLevel: 100,
  shortcuts: {},
  experimental: {},
  memoryEnabled: false,
  memoryUseOwnApiKey: true,
  defaultMode: DEFAULT_MODE,
};

export const DEFAULT_CACHE_SETTINGS: ICacheSettings = {
  enabled: true,
  ttl: 3600, // 1 hour
  maxSize: 5242880, // 5MB
  compressionEnabled: false,
  persistToStorage: false
};

export const DEFAULT_STORAGE_CONFIG: IStorageConfig = {
  rolloutTTL: 60 // 60 days default
};

export const DEFAULT_PERMISSION_SETTINGS: IPermissionSettings = {
  tabs: true,
  storage: true, // Always required
  notifications: true,
  clipboardRead: true,
  clipboardWrite: true
};

export const DEFAULT_EXTENSION_SETTINGS: IExtensionSettings = {
  enabled: true,
  contentScriptEnabled: true,
  allowedOrigins: [],
  storageQuotaWarning: 0.8, // 80% warning threshold
  updateChannel: 'stable',
  permissions: DEFAULT_PERMISSION_SETTINGS
};

// Default retry configuration
export const DEFAULT_RETRY_CONFIG = {
  maxRetries: 3,
  initialDelay: 1000,
  maxDelay: 10000,
  backoffMultiplier: 2
};

// Default timeout settings (ms)
export const DEFAULT_TIMEOUTS = {
  API_REQUEST: 30000,
  STORAGE_OPERATION: 5000
};

export const DEFAULT_TOOLS_CONFIG: IToolsConfig = {
  // Browser tool toggles
  enable_all_tools: false,
  storage_tool: true,
  tab_tool: true,
  web_scraping_tool: false,
  dom_tool: true,
  form_automation_tool: false,
  navigation_tool: true,
  network_intercept_tool: false,
  data_extraction_tool: false,
  page_action_tool: true,
  page_vision_tool: true,

  // Agent execution tool toggles
  execCommand: false,
  webSearch: true,
  fileOperations: false,
  mcpTools: false,
  customTools: {},

  // Track 11: dark by default. Enable to let the model batch tool calls.
  parallelToolCalls: false,

  // Track 39: provider-neutral dynamic tool loading. Auto mode only activates
  // when deferred schemas exceed the configured share of the model context.
  dynamicToolLoading: 'auto',
  dynamicToolLoadingThresholdPercent: 2,
  alwaysLoadTools: [],
  deferTools: [],
  hiddenTools: [],

  // Shared configuration metadata
  enabled: [
    'web_scraping',
    'form_automation',
    'network_intercept',
    'data_extraction',
    'dom_tool',
    'navigation_tool',
    'tab_tool',
    'storage_tool',
    'page_action',
    'page_vision'
  ],
  disabled: [],
  timeout: 90000, // 90 seconds default
  sandboxPolicy: {
    mode: 'workspace-write',
    writable_roots: [],
    network_access: true
  },
  perToolConfig: {
    'web_scraping': {
      enabled: true,
      timeout: 45000,
      options: {
        maxDepth: 3,
        followLinks: false
      }
    },
    'form_automation': {
      enabled: true,
      timeout: 30000,
      options: {
        validateInputs: true,
        waitForNavigation: true
      }
    },
    'network_intercept': {
      enabled: true,
      timeout: 60000,
      options: {
        captureHeaders: true,
        captureBody: true
      }
    },
    'data_extraction': {
      enabled: true,
      timeout: 30000,
      options: {
        maxRecords: 1000
      }
    },
    'page_action': {
      enabled: true,
      timeout: 60000,
      options: {
        retryAttempts: 3,
        retryDelay: 100
      }
    }
  }
};

/**
 * Default app-server config — enabled, loopback, token-required.
 *
 * Enabled by default so the browser bridge works out-of-box: the extension
 * ships on-by-default with the native transport, and the desktop must be
 * listening for it to connect. The listener is loopback-only (127.0.0.1),
 * requires a capability token, and rejects non-extension browser origins, so
 * the exposure is limited to local processes that already hold the token.
 */
export const DEFAULT_APP_SERVER_CONFIG: IAppServerConfig = {
  enabled: true,
  transport: 'websocket',
  bindHost: '127.0.0.1',
  port: 18101,
  requireAuth: true,
  rejectBrowserOrigins: true,
  // Extension bridge: extension origins may connect (token still required).
  // Browser pages can't forge Origin, so http(s) origins stay locked out.
  allowedOrigins: ['chrome-extension://*'],
  allowLan: false,
  maxConnections: 16,
  maxPayloadBytes: 1_048_576,
  maxBufferedBytes: 4_194_304,
  requestQueueCapacity: 128,
};

// Helper to create default config without module-level execution
export function getDefaultAgentConfig(): IAgentConfig {
  return {
    version: '2.1.0',
    selectedModelKey: 'deepseek:deepseek-v4-flash', // Default to DeepSeek V4 Flash (free-tier) for fresh install
    providers: getDefaultProviders(),
    profiles: {},
    activeProfile: null,
    preferences: { ...DEFAULT_USER_PREFERENCES },
    cache: { ...DEFAULT_CACHE_SETTINGS },
    extension: { ...DEFAULT_EXTENSION_SETTINGS },
    tools: { ...DEFAULT_TOOLS_CONFIG },
    storage: { ...DEFAULT_STORAGE_CONFIG },
    approval: { ...DEFAULT_APPROVAL_CONFIG },
    enabledPlugins: {},
    appServer: { ...DEFAULT_APP_SERVER_CONFIG },
  };
}


// Storage keys
export const STORAGE_KEYS = {
  CONFIG: 'agent_config',
  CONFIG_VERSION: 'config_version',
  APPROVAL_HISTORY: 'approval_history',
  DESKTOP_WELCOME_COMPLETED: 'desktop_welcome_completed',
} as const;

// Configuration limits
export const CONFIG_LIMITS = {
  SYNC_QUOTA_BYTES: 102400, // 100KB Chrome sync storage limit
  SYNC_ITEM_BYTES: 8192, // 8KB per item limit
  LOCAL_QUOTA_BYTES: 10485760, // 10MB local storage limit
  MAX_PROFILES: 20,
  MAX_PROVIDERS: 10,
  MAX_SHORTCUTS: 50,
  MAX_EXPERIMENTAL_FLAGS: 100
} as const;

// Validation constants
export const VALID_THEMES = ['light', 'dark', 'system'] as const;
export const VALID_UPDATE_CHANNELS = ['stable', 'beta'] as const;
export const VALID_REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high'] as const;
export const VALID_REASONING_SUMMARIES = ['auto', 'concise', 'detailed', 'none'] as const;
export const VALID_VERBOSITIES = ['low', 'medium', 'high'] as const;

/**
 * Merge partial config with defaults
 */
export function mergeWithDefaults(partial: Partial<IAgentConfig>): IAgentConfig {
  // Merge providers: ensure all default providers exist, preserve existing API keys
  const defaultProviders = getDefaultProviders();
  const mergedProviders: Record<string, any> = { ...defaultProviders };

  if (partial.providers) {
    Object.entries(partial.providers).forEach(([id, provider]) => {
      if (mergedProviders[id]) {
        // Provider exists in defaults, deep merge models array
        const defaultProvider = mergedProviders[id];
        const storedProvider = provider;

        // Merge models: combine default models with stored models
        const mergedModels: any[] = [];
        const defaultModels = defaultProvider.models || [];
        const storedModels = storedProvider.models || [];

        // First, merge existing models (by modelKey)
        for (const defaultModel of defaultModels) {
          // Find matching stored model by modelKey
          const storedModel = storedModels.find((m: any) => m.modelKey === defaultModel.modelKey);

          if (storedModel) {
            // Model exists in both - merge default fields with stored values
            // Stored values take precedence (preserves user customizations)
            mergedModels.push({
              ...defaultModel,      // Default fields (includes new fields like serviceTier)
              ...storedModel        // Stored values (preserves user customizations)
            });
          } else {
            // Model only exists in defaults - add it as new
            mergedModels.push({ ...defaultModel });
          }
        }

        // Add any models that exist in stored config but not in defaults
        // (e.g., user manually added models)
        for (const storedModel of storedModels) {
          const existsInDefaults = defaultModels.some((m: any) => m.modelKey === storedModel.modelKey);
          const alreadyMerged = mergedModels.some((m: any) => m.modelKey === storedModel.modelKey);
          if (!existsInDefaults && !alreadyMerged) {
            mergedModels.push({ ...storedModel });
          }
        }

        // Final deduplication pass - remove any duplicate modelKeys
        const seenModelKeys = new Set<string>();
        const deduplicatedModels = mergedModels.filter((model: any) => {
          if (seenModelKeys.has(model.modelKey)) {
            console.warn(`[mergeWithDefaults] Removing duplicate model: ${model.modelKey} from provider: ${id}`);
            return false;
          }
          seenModelKeys.add(model.modelKey);
          return true;
        });

        // Merge provider with deep-merged models array
        mergedProviders[id] = {
          ...defaultProvider,
          ...storedProvider,
          models: deduplicatedModels
        };
      } else {
        // Provider doesn't exist in defaults, keep it anyway
        mergedProviders[id] = provider;
      }
    });
  }

  const defaults = getDefaultAgentConfig();

  return {
    ...defaults,
    ...partial,
    providers: mergedProviders,
    preferences: {
      ...DEFAULT_USER_PREFERENCES,
      ...(partial.preferences || {})
    },
    cache: {
      ...DEFAULT_CACHE_SETTINGS,
      ...(partial.cache || {})
    },
    extension: {
      ...DEFAULT_EXTENSION_SETTINGS,
      ...(partial.extension || {}),
      permissions: {
        ...DEFAULT_PERMISSION_SETTINGS,
        ...(partial.extension?.permissions || {})
      }
    },
    tools: {
      ...DEFAULT_TOOLS_CONFIG,
      ...(partial.tools || {}),
      sandboxPolicy: {
        mode: DEFAULT_TOOLS_CONFIG.sandboxPolicy!.mode,
        ...DEFAULT_TOOLS_CONFIG.sandboxPolicy,
        ...(partial.tools?.sandboxPolicy || {})
      },
      perToolConfig: {
        ...DEFAULT_TOOLS_CONFIG.perToolConfig,
        ...(partial.tools?.perToolConfig || {})
      }
    },
    storage: {
      ...DEFAULT_STORAGE_CONFIG,
      ...(partial.storage || {})
    },
    approval: {
      ...DEFAULT_APPROVAL_CONFIG,
      ...(partial.approval || {}),
      timeouts: {
        ...DEFAULT_APPROVAL_CONFIG.timeouts,
        ...(partial.approval?.timeouts || {})
      }
    },
    appServer: {
      ...DEFAULT_APP_SERVER_CONFIG,
      ...(partial.appServer || {}),
    },
  };
}

/**
 * Get default provider configurations
 * Multi-provider support with models arrays
 * Loaded from JSON configuration file
 */
export function getDefaultProviders(): Record<string, IProviderConfig> {
  // Private builds may override the bundled catalog with one fetched from the
  // backend at startup (see remoteCatalog + AgentConfig.initialize). When present
  // it full-replaces default.json; otherwise we fall back to the bundled copy.
  const remote = getRemoteProviders();
  if (remote) {
    return remote;
  }
  // Return a deep copy to avoid mutation of the imported JSON
  return JSON.parse(JSON.stringify(defaultProviders));
}

/**
 * Get default stored config (minimal data for ConfigStorageProvider)
 */
export function getDefaultStoredConfig(): IStoredConfig {
  return {
    version: '2.1.0',
    selectedModelKey: 'deepseek:deepseek-v4-flash', // Default to DeepSeek V4 Flash (free-tier) for fresh install
    providerKeys: {}, // Empty - no API keys configured by default
    preferences: { ...DEFAULT_USER_PREFERENCES },
    cache: { ...DEFAULT_CACHE_SETTINGS },
    extension: { ...DEFAULT_EXTENSION_SETTINGS },
    profiles: {},
    activeProfile: null,
    tools: { ...DEFAULT_TOOLS_CONFIG },
    storage: { ...DEFAULT_STORAGE_CONFIG },
    approval: { ...DEFAULT_APPROVAL_CONFIG },
    appServer: { ...DEFAULT_APP_SERVER_CONFIG },
  };
}

/**
 * Build full runtime config by merging stored config with default providers/models
 * @param stored - Minimal stored config from ConfigStorageProvider
 * @returns Full IAgentConfig with providers/models from default.json and API keys from storage
 */
export function buildRuntimeConfig(stored: IStoredConfig | null): IAgentConfig {
  const defaults = getDefaultAgentConfig();

  if (!stored) {
    // Track 20: pin admin policy post-merge (no-op until a source is resolved).
    return applyPolicy(defaults, getActivePolicySync(), 'agent');
  }

  // Get fresh providers from default.json
  const providers = getDefaultProviders();

  // Re-inject user-defined custom providers (BYOK). These have no default.json
  // entry, so their full definition is persisted in stored.customProviders and
  // restored here BEFORE selectedModelKey validation so a selected custom model
  // is not treated as missing. The persisted apiKey is the secured marker; the
  // real key is fetched from the CredentialStore at request time by provider id.
  if (stored.customProviders) {
    for (const custom of stored.customProviders) {
      if (custom?.id) {
        providers[custom.id] = { ...custom, isCustom: true };
      }
    }
  }

  // Apply stored API keys and auth method to providers
  for (const [providerId, storedProvider] of Object.entries(stored.providerKeys)) {
    if (providers[providerId]) {
      providers[providerId].apiKey = storedProvider.apiKey;
      if (storedProvider.organization !== undefined) {
        providers[providerId].organization = storedProvider.organization;
      }
      if (storedProvider.authMethod) {
        providers[providerId].authMethod = storedProvider.authMethod;
      }
    }
  }

  // True when `key` is a "providerId:modelKey" that exists in the current
  // providers. Also rejects malformed keys (no colon).
  const modelKeyExists = (key: string): boolean => {
    const colonIndex = key.indexOf(':');
    if (colonIndex <= 0) return false;
    const providerId = key.slice(0, colonIndex);
    const modelKey = key.slice(colonIndex + 1);
    return !!providers[providerId]?.models?.some((m: { modelKey: string }) => m.modelKey === modelKey);
  };

  // Validate stored selectedModelKey exists in providers, fallback to default if not
  let selectedModelKey = stored.selectedModelKey || '';
  if (selectedModelKey && !modelKeyExists(selectedModelKey)) {
    console.warn(`[buildRuntimeConfig] Stored selectedModelKey "${selectedModelKey}" not found, falling back to default`);
    selectedModelKey = defaults.selectedModelKey;
  }
  // The hardcoded default can itself be absent from a backend-replaced catalog
  // (full-replace via remoteCatalog). Guard so we never hand downstream a key
  // that isn't in the catalog: use the first available provider model instead.
  if (selectedModelKey && !modelKeyExists(selectedModelKey)) {
    let fallback = '';
    for (const [providerId, provider] of Object.entries(providers)) {
      const firstModel = provider?.models?.[0]?.modelKey;
      if (firstModel) {
        fallback = `${providerId}:${firstModel}`;
        break;
      }
    }
    console.warn(`[buildRuntimeConfig] Fallback selectedModelKey "${selectedModelKey}" not in catalog; using first available "${fallback || '(none)'}"`);
    selectedModelKey = fallback;
  }

  // Validate the stored efficient model (legacy field read as fallback). An
  // efficient model that no longer exists in the catalog silently reverts to
  // "same as task model" (undefined) rather than breaking utility calls.
  let efficientModelKey = stored.efficientModelKey || stored.modelForTitleGenerate || undefined;
  if (efficientModelKey && !modelKeyExists(efficientModelKey)) {
    console.warn(`[buildRuntimeConfig] Stored efficientModelKey "${efficientModelKey}" not found; using task model`);
    efficientModelKey = undefined;
  }

  const merged: IAgentConfig = {
    version: stored.version || defaults.version,
    selectedModelKey,
    ...(efficientModelKey ? { efficientModelKey } : {}),
    providers,
    profiles: stored.profiles || {},
    activeProfile: stored.activeProfile || null,
    preferences: {
      ...DEFAULT_USER_PREFERENCES,
      ...(stored.preferences || {})
    },
    cache: {
      ...DEFAULT_CACHE_SETTINGS,
      ...(stored.cache || {})
    },
    extension: {
      ...DEFAULT_EXTENSION_SETTINGS,
      ...(stored.extension || {}),
      permissions: {
        ...DEFAULT_PERMISSION_SETTINGS,
        ...(stored.extension?.permissions || {})
      }
    },
    tools: {
      ...DEFAULT_TOOLS_CONFIG,
      ...(stored.tools || {}),
      sandboxPolicy: {
        mode: DEFAULT_TOOLS_CONFIG.sandboxPolicy!.mode,
        ...DEFAULT_TOOLS_CONFIG.sandboxPolicy,
        ...(stored.tools?.sandboxPolicy || {})
      },
      perToolConfig: {
        ...DEFAULT_TOOLS_CONFIG.perToolConfig,
        ...(stored.tools?.perToolConfig || {})
      }
    },
    storage: {
      ...DEFAULT_STORAGE_CONFIG,
      ...(stored.storage || {})
    },
    approval: {
      ...DEFAULT_APPROVAL_CONFIG,
      ...(stored.approval || {}),
      timeouts: {
        ...DEFAULT_APPROVAL_CONFIG.timeouts,
        ...(stored.approval?.timeouts || {})
      }
    },
    // Track 10: per-plugin enable state round-trips verbatim
    enabledPlugins: stored.enabledPlugins ?? {},
    appServer: {
      ...DEFAULT_APP_SERVER_CONFIG,
      ...(stored.appServer || {}),
    },
  };

  // Track 20: pin admin policy AFTER all merging so the one-level merges above
  // cannot defeat a nested managed value. No-op until a source is resolved.
  return applyPolicy(merged, getActivePolicySync(), 'agent');
}

/**
 * Extract minimal stored config from full runtime config
 * @param config - Full runtime IAgentConfig
 * @returns Minimal IStoredConfig for ConfigStorageProvider
 */
export function extractStoredConfig(config: IAgentConfig): IStoredConfig {
  // Extract only id, API keys and organization from providers
  const providerKeys: Record<string, { id: string; apiKey: string; organization?: string | null }> = {};
  // User-defined custom providers are persisted in full (default.json has no
  // entry to rehydrate them from). Their secret lives in the CredentialStore;
  // the persisted apiKey field is just the secured marker.
  const customProviders: IProviderConfig[] = [];

  for (const [providerId, provider] of Object.entries(config.providers)) {
    if (provider.isCustom) {
      customProviders.push(provider);
      continue;
    }
    // Only store if there's an API key configured or an auth method set
    if (provider.apiKey || provider.authMethod) {
      providerKeys[providerId] = {
        id: providerId,
        apiKey: provider.apiKey,
        organization: provider.organization,
        ...(provider.authMethod ? { authMethod: provider.authMethod } : {}),
      };
    }
  }

  return {
    version: config.version,
    selectedModelKey: config.selectedModelKey,
    ...(config.efficientModelKey ? { efficientModelKey: config.efficientModelKey } : {}),
    providerKeys,
    ...(customProviders.length > 0 ? { customProviders } : {}),
    preferences: config.preferences,
    cache: config.cache,
    extension: config.extension,
    profiles: config.profiles,
    activeProfile: config.activeProfile,
    tools: config.tools,
    storage: config.storage,
    approval: config.approval,
    // Track 10: persist per-plugin enable state
    enabledPlugins: config.enabledPlugins,
    appServer: config.appServer,
  };
}
