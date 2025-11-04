/**
 * Model Client Factory for browserx-chrome
 * Creates and manages model client instances with provider selection and caching
 */

import { ModelClient, ModelClientError, type RetryConfig } from './ModelClient';
import { OpenAIResponsesClient } from './OpenAIResponsesClient';
import { ChromeAuthManager } from './ChromeAuthManager';
import { AgentConfig } from '../config/AgentConfig';

/**
 * Supported model providers
 */
export type ModelProvider = 'openai' | 'xai' | 'anthropic';

/**
 * Configuration for model client creation
 */
export interface ModelClientConfig {
  /** Provider to use */
  provider: ModelProvider;
  /** API key for the provider (can be null - validation happens at request time) */
  apiKey: string | null;
  /** Additional provider-specific options */
  options?: {
    /** Base URL for API requests (optional) */
    baseUrl?: string;
    /** Organization ID (OpenAI) */
    organization?: string;
  };
}

/**
 * Storage keys for Chrome storage
 */
const STORAGE_KEYS = {
  OPENAI_API_KEY: 'openai_api_key',
  DEFAULT_PROVIDER: 'default_provider',
  OPENAI_ORGANIZATION: 'openai_organization',
} as const;

/**
 * Model name to provider mapping
 * Note: Only OpenAI models supported
 */
const MODEL_PROVIDER_MAP: Record<string, ModelProvider> = {
  // OpenAI models
  'gpt-5': 'openai',
  'gpt-4': 'openai',
  'gpt-4-turbo': 'openai',
  'gpt-4o': 'openai',
};

const DEFAULT_MODEL = 'gpt-5';

/**
 * Factory for creating and managing model clients
 */
export class ModelClientFactory {
  private clientCache: Map<string, ModelClient> = new Map();
  private config?: AgentConfig;
  private authManager?: ChromeAuthManager;
  private storageListener?: (changes: { [key: string]: chrome.storage.StorageChange }, areaName: string) => void;

  constructor() {
    // Setup storage listener to invalidate cache when API keys change
    this.setupStorageListener();
  }

  /**
   * Setup storage listener to invalidate cache when API keys change
   */
  private setupStorageListener(): void {
    this.storageListener = (changes, areaName) => {
      // Check if any API key related storage changed
      const relevantKeys = [
        STORAGE_KEYS.OPENAI_API_KEY,
        'browserx_api_key_encrypted', // ChromeAuthManager encrypted key
        'browserx_auth_data', // ChromeAuthManager auth data
      ];

      for (const key of relevantKeys) {
        if (changes[key]) {
          console.log(`[ModelClientFactory] API key changed in ${areaName} storage, clearing cache`);
          this.clearCache();
          break;
        }
      }
    };

    // Listen to both sync and local storage changes
    if (typeof chrome !== 'undefined' && chrome.storage) {
      chrome.storage.onChanged.addListener(this.storageListener);
    }
  }

  /**
   * Cleanup storage listener
   */
  destroy(): void {
    if (this.storageListener && typeof chrome !== 'undefined' && chrome.storage) {
      chrome.storage.onChanged.removeListener(this.storageListener);
    }
    this.clearCache();
  }

  /**
   * Create a model client for the currently selected model
   * Uses AgentConfig's selectedModelId to determine provider
   * @returns Promise resolving to a model client
   */
  async createClientForCurrentModel(): Promise<ModelClient> {
    const agentConfig = AgentConfig.getInstance();
    await agentConfig.initialize();

    const config = agentConfig.getConfig();
    const modelData = agentConfig.getModelById(config.selectedModelId);

    if (!modelData) {
      throw new ModelClientError(`Selected model ${config.selectedModelId} not found in registry`);
    }

    const providerId = modelData.provider.id;
    const provider = this.mapProviderIdToType(providerId);

    return this.createClient(provider);
  }

  /**
   * Create a model client for the specified model
   * @param model The model name to create a client for (legacy support)
   * @returns Promise resolving to a model client
   */
  async createClientForModel(model: string): Promise<ModelClient> {
    if (model === 'default') {
      // Use current selected model
      return this.createClientForCurrentModel();
    }

    const provider = this.getProviderForModel(model);
    return this.createClient(provider);
  }

  /**
   * Map provider ID from config to ModelProvider type
   * @param providerId Provider ID from config (e.g., 'openai', 'xai', 'anthropic')
   * @returns ModelProvider type
   */
  private mapProviderIdToType(providerId: string): ModelProvider {
    if (providerId === 'openai' || providerId === 'xai' || providerId === 'anthropic') {
      return providerId;
    }
    throw new ModelClientError(`Unsupported provider: ${providerId}`);
  }

  /**
   * Create a model client for the specified provider
   * @param provider The provider to create a client for
   * @returns Promise resolving to a model client
   */
  async createClient(provider: ModelProvider): Promise<ModelClient> {
    // Check cache first
    const cached = this.clientCache.get(provider);
    if (cached) {
      return cached;
    }

    const config = await this.loadConfigForProvider(provider);
    const client = this.instantiateClient(config);

    // Cache the client instance
    this.clientCache.set(provider, client);

    return client;
  }

  /**
   * Create a client with explicit configuration
   * @param config The client configuration
   * @returns Model client instance
   */
  createClientWithConfig(config: ModelClientConfig): ModelClient {
    const cacheKey = `${config.provider}-${this.hashConfig(config)}`;

    // Check cache first
    const cached = this.clientCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const client = this.instantiateClient(config);

    // Cache the client instance
    this.clientCache.set(cacheKey, client);

    return client;
  }

  /**
   * Get the provider for a given model name
   * Uses AgentConfig.modelRegistry as primary source
   * @param model The model name (modelKey)
   * @returns The provider for the model
   * @deprecated Use createClientForCurrentModel() instead for proper registry lookup
   */
  getProviderForModel(model: string): ModelProvider {
    if (model === 'default') {
      return 'openai';
    }

    // Try to infer from model name patterns as heuristic fallback
    // This method is deprecated and should not be used for new code
    try {
      if (model.startsWith('gpt-')) {
        return 'openai';
      }
      if (model.startsWith('grok-')) {
        return 'xai';
      }
      if (model.startsWith('claude-')) {
        return 'anthropic';
      }

      throw new ModelClientError(`Unknown model: ${model}. Supported providers: OpenAI, xAI, Anthropic. Use createClientForCurrentModel() instead.`);
    } catch (error) {
      throw new ModelClientError(`Failed to determine provider for model: ${model}. ${error}`);
    }
  }

  /**
   * Get all supported models for a provider
   * @param provider The provider
   * @returns Array of model keys
   * @deprecated Use AgentConfig.getAllModels() instead for proper registry lookup
   */
  getSupportedModels(provider: ModelProvider): string[] {
    if (!this.config) {
      return [];
    }

    const providerConfig = this.config.getProvider(provider);
    if (!providerConfig || !providerConfig.models) {
      return [];
    }

    return providerConfig.models.map(m => m.modelKey);
  }

  /**
   * Load API key for a provider from AgentConfig
   * @param provider The provider
   * @returns Promise resolving to the API key or null if not found
   */
  async loadApiKey(provider: ModelProvider): Promise<string | null> {
    // First try to get API key from ChromeAuthManager if available
    if (this.authManager) {
      const apiKey = await this.authManager.retrieveApiKey();

      if (apiKey) {
        // Validate if this key is for OpenAI
        // OpenAI keys start with 'sk-'
        const isOpenAIKey = apiKey.startsWith('sk-');

        if (provider === 'openai' && isOpenAIKey) {
          return apiKey;
        }
      }
    }

    return null;
  }

  /**
   * Set the default provider
   * @param provider The provider to set as default
   */
  async setDefaultProvider(provider: ModelProvider): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      chrome.storage.sync.set({ [STORAGE_KEYS.DEFAULT_PROVIDER]: provider }, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve();
        }
      });
    });
  }

  /**
   * Get the default provider
   * @returns Promise resolving to the default provider
   */
  async getDefaultProvider(): Promise<ModelProvider> {
    return new Promise((resolve, reject) => {
      chrome.storage.sync.get([STORAGE_KEYS.DEFAULT_PROVIDER], (result) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(result[STORAGE_KEYS.DEFAULT_PROVIDER] || 'openai');
        }
      });
    });
  }

  /**
   * Clear the client cache
   * @param provider Optional provider to clear, or all if not specified
   */
  clearCache(provider?: ModelProvider): void {
    if (provider) {
      this.clientCache.delete(provider);
    } else {
      this.clientCache.clear();
    }
  }

  /**
   * Check if a provider has a valid API key configured
   * @param provider The provider to check
   * @returns Promise resolving to true if API key exists
   */
  async hasValidApiKey(provider: ModelProvider): Promise<boolean> {
    const apiKey = await this.loadApiKey(provider);

    if (apiKey && apiKey.trim().length > 0) {
      // Basic validation - just check if it's a non-empty string
      // Provider-specific validation is handled by the model clients themselves
      return true;
    }

    return false;
  }

  /**
   * Get configuration status for all providers
   * @returns Promise resolving to configuration status
   */
  async getConfigurationStatus(): Promise<Record<ModelProvider, { hasApiKey: boolean; isDefault: boolean }>> {
    const [openaiHasKey, defaultProvider] = await Promise.all([
      this.hasValidApiKey('openai'),
      this.getDefaultProvider(),
    ]);

    return {
      openai: {
        hasApiKey: openaiHasKey,
        isDefault: defaultProvider === 'openai',
      },
    };
  }

  /**
   * T046: Load configuration for a provider from AgentConfig
   * @param provider The provider
   * @returns Promise resolving to the client configuration
   * Note: API key can be null - validation happens when making API requests
   */
  private async loadConfigForProvider(provider: ModelProvider): Promise<ModelClientConfig> {
    // Get provider-specific API key from AgentConfig
    let apiKey: string | null = null;
    let providerConfig: any = null;

    try {
      const agentConfig = AgentConfig.getInstance();
      await agentConfig.initialize();

      // Get API key for this specific provider
      apiKey = await agentConfig.getProviderApiKey(provider);

      // Get provider configuration for base URL, organization, etc.
      const providerData = agentConfig.getProvider(provider);
      if (providerData) {
        providerConfig = providerData;
      }
    } catch (error) {
      console.warn(`[ModelClientFactory] Failed to load config from AgentConfig: ${error}`);
      // Fall back to legacy method
      apiKey = await this.loadApiKey(provider);
    }

    // Don't throw error if API key is missing - allow model client to be created
    // The error will be thrown when actually trying to make an API request

    const config: ModelClientConfig = {
      provider,
      apiKey: apiKey || null,
      options: {
        baseUrl: providerConfig?.baseUrl,
        organization: providerConfig?.organization
      },
    };

    // Load provider-specific base URL
    if (this.config) {
      const modelConfig = this.config.getModelConfig();
      const providerConfig = this.config.getProvider(modelConfig.provider);
      if (providerConfig?.baseUrl) {
        config.options!.baseUrl = providerConfig.baseUrl;
      }
    }

    // Load provider-specific options
    if (provider === 'openai') {
      const organization = await this.loadFromStorage(STORAGE_KEYS.OPENAI_ORGANIZATION);
      if (organization) {
        config.options!.organization = organization;
      }
    }

    return config;
  }

  /**
   * Load a value from Chrome storage
   * @param key The storage key
   * @returns Promise resolving to the value or null
   */
  private async loadFromStorage(key: string): Promise<string | null> {
    return new Promise((resolve, reject) => {
      chrome.storage.sync.get([key], (result) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(result[key] || null);
        }
      });
    });
  }

  /**
   * T032, Instantiate a client with the given configuration
   * @param config The client configuration
   * @returns Model client instance
   */
  private instantiateClient(config: ModelClientConfig): ModelClient {
    // Get provider name from config if available
    let providerName = config.provider;
    let baseUrl = config.options?.baseUrl;

    if (this.config) {
      const modelConfig = this.config.getModelConfig();
      providerName = modelConfig.provider as ModelProvider;

      // Base URL will be loaded from provider config instead
      // No need to check model metadata
    }

    switch (providerName) {
      case 'openai':
      default:
        // Use the experimental OpenAI Responses API client by default
        // Construct minimal provider and model family configs
        const baseUrl = config.options?.baseUrl;
        const organization = config.options?.organization;

        const provider = {
          name: providerName,
          base_url: baseUrl,
          wire_api: 'Responses' as const,
          requires_openai_auth: true,
        };

        // Use selected model from config instead of hardcoded 'gpt-5'
        const selectedModel = this.getSelectedModel();
        const modelFamily = {
          family: selectedModel,
          base_instructions: 'You are a helpful coding assistant.',
          supports_reasoning_summaries: true,
          needs_special_apply_patch_instructions: false,
        };

        // Generate a conversation ID for prompt_cache_key usage
        const conversationId = (typeof crypto !== 'undefined' && typeof (crypto as any).randomUUID === 'function')
          ? (crypto as any).randomUUID()
          : `conv_${Math.random().toString(36).slice(2)}`;

        return new OpenAIResponsesClient({
          apiKey: config.apiKey,
          baseUrl,
          organization,
          conversationId,
          modelFamily,
          provider,
        });
    }
  }

  /**
   * Create a simple hash of the configuration for caching
   * @param config The configuration to hash
   * @returns Hash string
   */
  private hashConfig(config: ModelClientConfig): string {
    const str = JSON.stringify({
      provider: config.provider,
      apiKey: config.apiKey?.slice(0, 10) || 'null', // Only use first 10 chars for privacy
      options: config.options || {},
    });

    // Simple hash function
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }

    return hash.toString(36);
  }

  /**
   * Initialize with configuration
   */
  async initialize(config: AgentConfig): Promise<void> {
    this.config = config;
    // Create ChromeAuthManager instance with the config
    this.authManager = new ChromeAuthManager(config);
    // Clear cache when config changes to use new settings
    this.clientCache.clear();
  }

  /**
   * Get selected model from config
   */
  getSelectedModel(): string {
    if (this.config) {
      const modelConfig = this.config.getModelConfig();
      return modelConfig.selected || DEFAULT_MODEL;
    }
    return DEFAULT_MODEL;
  }

  /**
   * Get API key from config for a provider
   */
  async getApiKey(provider: string): Promise<string | null> {
    if (!this.config) {
      return await this.loadApiKey('openai');
    }

    return await this.config.getProviderApiKey(provider);
  }

  /**
   * Get base URL from config for a provider
   */
  getBaseUrl(provider: string): string | undefined {
    if (!this.config) {
      return undefined;
    }

    const providerConfig = this.config.getProvider(provider);
    return providerConfig?.baseUrl || undefined;
  }
}
