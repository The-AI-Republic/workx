/**
 * Model Client Factory for browserx-chrome
 * Creates and manages model client instances with provider selection and caching
 */

import { ModelClient, ModelClientError, type RetryConfig } from './ModelClient';
import { OpenAIResponsesClient } from './OpenAIResponsesClient';
import { ChromeAuthManager } from './ChromeAuthManager';
import { ModelRegistry } from './ModelRegistry';
import type { AgentConfig } from '../config/AgentConfig';

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
  // xAI models
  'grok-4-fast-reasoning': 'xai',
};

const DEFAULT_MODEL = 'gpt-5';

/**
 * Factory for creating and managing model clients
 */
export class ModelClientFactory {
  private static instance: ModelClientFactory;
  private clientCache: Map<string, ModelClient> = new Map();
  private config?: AgentConfig;
  private authManager?: ChromeAuthManager;
  private storageListener?: (changes: { [key: string]: chrome.storage.StorageChange }, areaName: string) => void;

  private constructor() {
    // Setup storage listener to invalidate cache when API keys change
    this.setupStorageListener();
  }

  /**
   * Get the singleton instance of the factory
   */
  static getInstance(): ModelClientFactory {
    if (!ModelClientFactory.instance) {
      ModelClientFactory.instance = new ModelClientFactory();
    }
    return ModelClientFactory.instance;
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
   * Create a model client for the specified model
   * @param model The model name to create a client for
   * @returns Promise resolving to a model client
   */
  async createClientForModel(model: string): Promise<ModelClient> {
    if (model === 'default') {
      model = DEFAULT_MODEL;
    }

    const provider = this.getProviderForModel(model);
    return this.createClient(provider);
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
   * Enhanced to check ModelRegistry for multi-provider support
   * @param model The model name
   * @returns The provider for the model
   */
  getProviderForModel(model: string): ModelProvider {
    if (model === 'default') {
      return 'openai';
    }

    const provider = MODEL_PROVIDER_MAP[model];

    if (!provider) {
      // Check ModelRegistry for the model's provider
      const modelMetadata = ModelRegistry.getModel(model);
      if (modelMetadata && (modelMetadata.provider === 'openai' || modelMetadata.provider === 'xai' || modelMetadata.provider === 'anthropic')) {
        return modelMetadata.provider as ModelProvider;
      }

      // Try to infer from model name patterns
      if (model.startsWith('gpt-')) {
        return 'openai';
      }
      if (model.startsWith('grok-')) {
        return 'xai';
      }
      if (model.startsWith('claude-')) {
        return 'anthropic';
      }

      throw new ModelClientError(`Unknown model: ${model}. Supported providers: OpenAI, xAI, Anthropic.`);
    }

    return provider;
  }

  /**
   * Get all supported models for a provider
   * @param provider The provider
   * @returns Array of model names
   */
  getSupportedModels(provider: ModelProvider): string[] {
    return Object.entries(MODEL_PROVIDER_MAP)
      .filter(([, p]) => p === provider)
      .map(([model]) => model);
  }

  /**
   * Load API key for a provider from Chrome storage
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

    if (apiKey && apiKey.trim().length > 0 && this.authManager) {
      // Additional validation using ChromeAuthManager
      return this.authManager.validateApiKey(apiKey);
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
   * T032, Load configuration for a provider from Chrome storage
   * @param provider The provider
   * @returns Promise resolving to the client configuration
   * Note: API key can be null - validation happens when making API requests
   */
  private async loadConfigForProvider(provider: ModelProvider): Promise<ModelClientConfig> {
    // Get provider-specific API key
    let apiKey: string | null = null;
    if (this.config) {
      const modelConfig = this.config.getModelConfig();
      apiKey = await this.config.getProviderApiKey(modelConfig.provider);
    } else {
      apiKey = await this.loadApiKey(provider);
    }

    // Don't throw error if API key is missing - allow model client to be created
    // The error will be thrown when actually trying to make an API request

    const config: ModelClientConfig = {
      provider,
      apiKey: apiKey || null,
      options: {},
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

      // Use provider-specific base URL from model metadata if not in config
      if (!baseUrl) {
        const modelMetadata = ModelRegistry.getModel(modelConfig.selected);
        baseUrl = modelMetadata?.baseUrl;
      }
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

/**
 * Convenience function to get the factory instance
 */
export const getModelClientFactory = () => ModelClientFactory.getInstance();