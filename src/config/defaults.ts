/**
 * T037: Default centralized agent configuration values
 */

import type { IAgentConfig, IModelConfig, IUserPreferences, ICacheSettings, IExtensionSettings, IPermissionSettings, IToolsConfig, IStorageConfig, IAuthConfig } from './types';
import { AuthMode } from '../models/types/Auth.js';

export const DEFAULT_AUTH_CONFIG: IAuthConfig = {
  apiKey: '',
  authMode: AuthMode.ApiKey,
  accountId: null,
  planType: null,
  lastUpdated: 0
};

export const DEFAULT_MODEL_CONFIG: IModelConfig = {
  selected: 'gpt-5',
  provider: 'openai',
  contextWindow: 128000,
  maxOutputTokens: 16384,
  autoCompactTokenLimit: null,
  reasoningEffort: 'medium',
  reasoningSummary: 'auto',
  verbosity: 'medium'
};

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

export const DEFAULT_AGENT_CONFIG: IAgentConfig = {
  version: '1.0.0',
  model: DEFAULT_MODEL_CONFIG,
  providers: {},
  profiles: {},
  activeProfile: null,
  preferences: DEFAULT_USER_PREFERENCES,
  cache: DEFAULT_CACHE_SETTINGS,
  extension: DEFAULT_EXTENSION_SETTINGS,
  tools: DEFAULT_TOOLS_CONFIG,
  storage: DEFAULT_STORAGE_CONFIG,
  auth: DEFAULT_AUTH_CONFIG
};

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

/**
 * Merge partial config with defaults
 */
export function mergeWithDefaults(partial: Partial<IAgentConfig>): IAgentConfig {
  return {
    ...DEFAULT_AGENT_CONFIG,
    ...partial,
    model: {
      ...DEFAULT_MODEL_CONFIG,
      ...(partial.model || {})
    },
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
    },
    auth: {
      ...DEFAULT_AUTH_CONFIG,
      ...(partial.auth || {})
    }
  };
}

/**
 * Get default provider configurations
 */
export function getDefaultProviders(): Record<string, any> {
  return {
    openai: {
      id: 'openai',
      name: 'OpenAI',
      apiKey: '',
      baseUrl: 'https://api.openai.com/v1',
      timeout: DEFAULT_TIMEOUTS.API_REQUEST,
      retryConfig: DEFAULT_RETRY_CONFIG
    },
    anthropic: {
      id: 'anthropic',
      name: 'Anthropic',
      apiKey: '',
      baseUrl: 'https://api.anthropic.com',
      timeout: DEFAULT_TIMEOUTS.API_REQUEST,
      retryConfig: DEFAULT_RETRY_CONFIG
    }
  };
}