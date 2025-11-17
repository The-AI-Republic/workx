/**
 * Default centralized agent configuration values
 */

import type { IAgentConfig, IUserPreferences, ICacheSettings, IExtensionSettings, IPermissionSettings, IToolsConfig, IStorageConfig } from './types';
import defaultProviders from '../models/providers/default.json';

export const DEFAULT_USER_PREFERENCES: IUserPreferences = {
  autoSync: true,
  telemetryEnabled: false,
  theme: 'system',
  shortcuts: {},
  experimental: {}
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

// Helper to create default config without module-level execution
export function getDefaultAgentConfig(): IAgentConfig {
  return {
    version: '2.1.0',
    selectedModelId: '', // Will be set to first available model during initialization
    modelRegistry: {}, // Will be populated during initialization
    providers: getDefaultProviders(),
    profiles: {},
    activeProfile: null,
    preferences: { ...DEFAULT_USER_PREFERENCES },
    cache: { ...DEFAULT_CACHE_SETTINGS },
    extension: { ...DEFAULT_EXTENSION_SETTINGS },
    tools: { ...DEFAULT_TOOLS_CONFIG },
    storage: { ...DEFAULT_STORAGE_CONFIG }
  };
}


// Storage keys
export const STORAGE_KEYS = {
  CONFIG: 'agent_config',
  CONFIG_VERSION: 'config_version'
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
        // Provider exists in defaults, merge with stored values (preserve API keys)
        mergedProviders[id] = {
          ...mergedProviders[id],
          ...provider
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
    }
  };
}

/**
 * Get default provider configurations
 * Multi-provider support with models arrays
 * Loaded from JSON configuration file
 */
export function getDefaultProviders(): Record<string, any> {
  // Return a deep copy to avoid mutation of the imported JSON
  return JSON.parse(JSON.stringify(defaultProviders));
}
