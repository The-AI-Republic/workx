/**
 * Model Client Factory for browserx-chrome
 * Creates and manages model client instances with provider selection and caching
 */

import { ModelClient, ModelClientError, type RetryConfig } from './ModelClient';
import { OpenAIResponsesClient } from './client/OpenAIResponsesClient';
import { OpenAIChatCompletionClient } from './client/OpenAIChatCompletionClient';
import { GoogleCompletionClient } from './client/GoogleCompletionClient';
import { GroqClient } from './client/GroqClient';
import { FireworksChatCompletionClient } from './client/FireworksChatCompletionClient';
import { AgentConfig } from '../config/AgentConfig';

/**
 * Supported model providers
 */
export type ModelProvider = 'openai' | 'xai' | 'anthropic' | 'groq' | 'google-ai-studio' | 'fireworks' | 'moonshot';

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

const DEFAULT_MODEL = 'gpt-5';

/**
 * Factory for creating and managing model clients
 */
export class ModelClientFactory {
  private clientCache: Map<string, ModelClient>;
  private config?: AgentConfig;

  constructor() {
    this.clientCache = new Map();
  }

  /**
   * Create a model client for the currently selected model
   * Uses AgentConfig's selectedModelId to determine provider
   * @returns Promise resolving to a model client
   */
  async createClientForCurrentModel(): Promise<ModelClient> {
    const agentConfig = await AgentConfig.getInstance();

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
   * Map provider ID from config to ModelProvider type
   * @param providerId Provider ID from config (e.g., 'openai', 'xai', 'anthropic', 'groq')
   * @returns ModelProvider type
   */
  private mapProviderIdToType(providerId: string): ModelProvider {
    if (providerId === 'openai' || providerId === 'xai' || providerId === 'anthropic' || providerId === 'groq' || providerId === 'google-ai-studio' || providerId === 'fireworks' || providerId === 'moonshot') {
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
    // Include model ID in cache key to prevent reusing clients with wrong config
    // (e.g., switching from Qwen with reasoning to Kimi K2 without reasoning)
    const selectedModelId = this.config?.getConfig().selectedModelId || 'unknown';
    const cacheKey = `${provider}-${selectedModelId}`;

    // Check cache first
    const cached = this.clientCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const config = await this.loadConfigForProvider(provider);
    const client = this.instantiateClient(config);

    // Cache the client instance
    this.clientCache.set(cacheKey, client);

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
    try {
      if (this.config) {
        return await this.config.getProviderApiKey(provider);
      }

      const agentConfig = AgentConfig.getInstance();
      await agentConfig.initialize();
      return await agentConfig.getProviderApiKey(provider);
    } catch (error) {
      console.warn(`[ModelClientFactory] Failed to load API key for provider ${provider}:`, error);
      return null;
    }
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
      // Clear all cache entries for this provider (cache keys are now provider-modelId)
      const keysToDelete: string[] = [];
      for (const key of this.clientCache.keys()) {
        if (key.startsWith(`${provider}-`)) {
          keysToDelete.push(key);
        }
      }
      keysToDelete.forEach(key => this.clientCache.delete(key));
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
    const [openaiHasKey, xaiHasKey, anthropicHasKey, groqHasKey, googleAiStudioHasKey, fireworksHasKey, moonshotHasKey, defaultProvider] = await Promise.all([
      this.hasValidApiKey('openai'),
      this.hasValidApiKey('xai'),
      this.hasValidApiKey('anthropic'),
      this.hasValidApiKey('groq'),
      this.hasValidApiKey('google-ai-studio'),
      this.hasValidApiKey('fireworks'),
      this.hasValidApiKey('moonshot'),
      this.getDefaultProvider(),
    ]);

    return {
      moonshot: {
        hasApiKey: moonshotHasKey,
        isDefault: defaultProvider === 'moonshot',
      },
      fireworks: {
        hasApiKey: fireworksHasKey,
        isDefault: defaultProvider === 'fireworks',
      },
      openai: {
        hasApiKey: openaiHasKey,
        isDefault: defaultProvider === 'openai',
      },
      xai: {
        hasApiKey: xaiHasKey,
        isDefault: defaultProvider === 'xai',
      },
      anthropic: {
        hasApiKey: anthropicHasKey,
        isDefault: defaultProvider === 'anthropic',
      },
      groq: {
        hasApiKey: groqHasKey,
        isDefault: defaultProvider === 'groq',
      },
      'google-ai-studio': {
        hasApiKey: googleAiStudioHasKey,
        isDefault: defaultProvider === 'google-ai-studio',
      },
    };
  }

  /**
   * Load configuration for a provider from AgentConfig
   * @param provider The provider
   * @returns Promise resolving to the client configuration
   * Note: API key can be null - validation happens when making API requests
   */
  private async loadConfigForProvider(provider: ModelProvider): Promise<ModelClientConfig> {
    // Get provider-specific API key from AgentConfig
    let apiKey: string | null = null;
    let providerConfig: any = null;

    try {
      const agentConfig = await AgentConfig.getInstance();

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

    // Load provider-specific base URL (if not already set)
    if (this.config && !config.options?.baseUrl) {
      const providerConfigFromAgent = this.config.getProvider(provider);
      if (providerConfigFromAgent?.baseUrl) {
        config.options!.baseUrl = providerConfigFromAgent.baseUrl;
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
   * Direct provider-to-client mapping for simplicity
   * @param config The client configuration
   * @returns Model client instance
   */
  private instantiateClient(config: ModelClientConfig): ModelClient {
    // Get provider name from config
    const providerName = config.provider;
    const baseUrl = config.options?.baseUrl;

    // Determine base URL
    const resolvedBaseUrl = baseUrl || config.options?.baseUrl;
    const organization = config.options?.organization;

    // Get selected model and metadata
    const selectedModel = this.getSelectedModel();
    let supportsReasoning = false;
    let supportsReasoningSummaries = false;
    let serviceTier: 'default' | 'flex' | 'priority' | undefined;
    let modelConfig: any = undefined;
    if (this.config) {
      const configData = this.config.getConfig();
      const modelData = this.config.getModelById(configData.selectedModelId);
      if (modelData?.model) {
        modelConfig = modelData.model;
        supportsReasoning = modelData.model.supportsReasoning ?? false;
        supportsReasoningSummaries = modelData.model.supportsReasoningSummaries ?? false;
        // For OpenAI models, merge default serviceTier value with stored value
        serviceTier = modelData.model.serviceTier;
        if (providerName === 'openai' && !serviceTier) {
          serviceTier = 'default';
        }
      }
    }

    // Build model family configuration
    const modelFamily = {
      family: selectedModel,
      base_instructions: providerName === 'google-ai-studio'
        ? 'You are Gemini 2.5 Pro integrated with the BrowserX agent. Provide accurate answers and suggest tool usage when relevant.'
        : 'You are a helpful coding assistant.',
      supports_reasoning: supportsReasoning,
      supports_reasoning_summaries: supportsReasoningSummaries,
      needs_special_apply_patch_instructions: false,
    };

    // Build provider configuration
    // Map internal provider IDs to display names
    let displayName = providerName;
    if (providerName === 'google-ai-studio') {
      displayName = 'Google AI Studio';
    } else if (providerName === 'fireworks') {
      displayName = 'Fireworks AI';
    }

    const provider = {
      name: displayName,
      base_url: resolvedBaseUrl,
      wire_api: 'Responses' as 'Responses' | 'Chat', // Kept for backward compatibility
      requires_openai_auth: true,
      ...(providerName === 'google-ai-studio' && {
        env_key: 'GOOGLE_AI_STUDIO_API_KEY',
        env_key_instructions: 'Set a Google AI Studio key in Settings to enable Gemini.',
      }),
    };

    // Generate a conversation ID for prompt_cache_key usage
    const conversationId = this.generateConversationId();

    // Get reasoning effort from model config
    // Default to 'medium' for models that support reasoning
    let reasoningEffort: string | undefined;
    if (supportsReasoning) {
      reasoningEffort = 'medium'; // Default reasoning effort
      console.log(`[ModelClientFactory] Enabling reasoning with effort: ${reasoningEffort} for model: ${selectedModel}`);
    } else {
      console.log(`[ModelClientFactory] Model ${selectedModel} does not support reasoning - omitting reasoning parameter`);
    }

    // Direct provider-to-client mapping
    // This is the single source of truth for which client each provider uses
    switch (providerName) {
      case 'moonshot':
        console.log(`[ModelClientFactory] Instantiating OpenAIChatCompletionClient for Moonshot AI`);
        return new OpenAIChatCompletionClient({
          apiKey: config.apiKey,
          baseUrl: resolvedBaseUrl,
          organization,
          conversationId,
          modelFamily,
          provider,
          modelConfig,
        });

      case 'fireworks':
        console.log(`[ModelClientFactory] Instantiating FireworksChatCompletionClient for Fireworks`);
        return new FireworksChatCompletionClient({
          apiKey: config.apiKey,
          baseUrl: resolvedBaseUrl,
          organization,
          conversationId,
          modelFamily,
          provider,
          modelConfig,
        });

      case 'google-ai-studio':
        console.log(`[ModelClientFactory] Instantiating GoogleCompletionClient for Google AI Studio`);
        return new GoogleCompletionClient({
          apiKey: config.apiKey,
          baseUrl: resolvedBaseUrl,
          organization,
          conversationId,
          modelFamily,
          provider,
          modelConfig,
        });

      case 'groq':
        console.log(`[ModelClientFactory] Instantiating GroqClient for Groq`);
        return new GroqClient({
          apiKey: config.apiKey,
          baseUrl: resolvedBaseUrl,
          organization,
          conversationId,
          modelFamily,
          provider,
          modelConfig,
          reasoningEffort: reasoningEffort as any,
          reasoningSummary: supportsReasoningSummaries ? { enabled: true } : undefined,
        });

      case 'openai':
      case 'xai':
      case 'anthropic':
      default:
        console.log(`[ModelClientFactory] Instantiating OpenAIResponsesClient for ${providerName}`);
        return new OpenAIResponsesClient({
          apiKey: config.apiKey,
          baseUrl: resolvedBaseUrl,
          organization,
          conversationId,
          modelFamily,
          provider,
          modelConfig,
          reasoningEffort: reasoningEffort as any,
          reasoningSummary: supportsReasoningSummaries ? { enabled: true } : undefined,
          serviceTier,
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
    // Clear cache when config changes to use new settings
    this.clientCache.clear();
  }

  /**
   * Get selected model from config
   * Returns the modelKey of the currently selected model
   */
  getSelectedModel(): string {
    if (this.config) {
      // Get selectedModelId from config
      const configData = this.config.getConfig();
      const selectedModelId = configData.selectedModelId;

      // Look up the model in the registry
      const modelData = this.config.getModelById(selectedModelId);
      if (modelData) {
        return modelData.model.modelKey;
      }
    }
    return DEFAULT_MODEL;
  }

  /**
   * Generate a conversation identifier compatible with both browser and Node runtimes.
   */
  private generateConversationId(): string {
    if (typeof crypto !== 'undefined' && typeof (crypto as any).randomUUID === 'function') {
      return (crypto as any).randomUUID();
    }
    return `conv_${Math.random().toString(36).slice(2)}`;
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
