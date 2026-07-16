/**
 * Model Client Factory for WorkX
 * Creates and manages model client instances with provider selection and caching
 */

import { ModelClient, ModelClientError, type RetryConfig } from './ModelClient';
import { OpenAIResponsesClient } from './client/OpenAIResponsesClient';
import { OpenAIChatCompletionClient } from './client/OpenAIChatCompletionClient';
import { GoogleCompletionClient } from './client/GoogleCompletionClient';
import { GroqClient } from './client/GroqClient';
import { FireworksChatCompletionClient } from './client/FireworksChatCompletionClient';
import { TogetherChatCompletionClient } from './client/TogetherChatCompletionClient';
import { AnthropicClient } from './client/AnthropicClient';
import { AgentConfig } from '../../config/AgentConfig';
import { getConfigStorage } from '../storage/ConfigStorageProvider';
import type { IAuthManager } from './types/Auth';

/**
 * Supported model providers
 */
export type ModelProvider = 'openai' | 'xai' | 'anthropic' | 'groq' | 'google-ai-studio' | 'fireworks' | 'moonshot' | 'together' | 'deepseek' | (string & {});

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
 * Storage keys for default provider persistence
 */
const STORAGE_KEYS = {
  DEFAULT_PROVIDER: 'default_provider',
} as const;

const DEFAULT_MODEL = 'gpt-5';

interface ClientConstructionSignature {
  selectedModelKey: string;
  parallelToolCalls: boolean;
  providerBaseUrl: string | null;
  providerOrganization: string | null;
  gatewayLlmBaseUrl: string | null;
  model: {
    modelKey: string | null;
    supportsReasoning: boolean;
    supportsReasoningSummaries: boolean;
    serviceTier: string | null;
    supportBackendMode: number | null;
  };
}

/**
 * Factory for creating and managing model clients
 */
export class ModelClientFactory {
  private clientCache: Map<string, ModelClient>;
  private config?: AgentConfig;
  private authManager: IAuthManager | null = null;

  constructor() {
    this.clientCache = new Map();
  }

  /**
   * Set the auth manager for routing decisions
   * Clears client cache when auth changes to ensure fresh clients
   * @param authManager - AuthManager instance or null
   */
  setAuthManager(authManager: IAuthManager | null): void {
    this.authManager = authManager;
    // Clear cache when auth changes to ensure new clients use correct routing
    this.clientCache.clear();
  }

  /**
   * Get current auth manager
   * @returns Current auth manager or null
   */
  getAuthManager(): IAuthManager | null {
    return this.authManager;
  }

  private _chatGPTOAuth401Retries = 0;
  private static readonly MAX_OAUTH_401_RETRIES = 1;

  /**
   * Handle a 401 error when ChatGPT OAuth is active.
   * Clears the client cache so the next request triggers a fresh token fetch.
   * Returns true if ChatGPT OAuth is active and retry is allowed (max 1 retry).
   */
  handleChatGPTOAuth401(): boolean {
    if (this.authManager?.isChatGPTOAuthActive?.()) {
      if (this._chatGPTOAuth401Retries >= ModelClientFactory.MAX_OAUTH_401_RETRIES) {
        this._chatGPTOAuth401Retries = 0;
        return false;
      }
      this._chatGPTOAuth401Retries++;
      this.clientCache.clear();
      return true;
    }
    return false;
  }

  /**
   * Reset the OAuth 401 retry counter. Call after a successful request.
   */
  resetOAuth401Retries(): void {
    this._chatGPTOAuth401Retries = 0;
  }

  /**
   * Check if using backend routing (useOwnApiKey=false)
   * @returns true if requests should route through backend
   */
  isBackendRouting(): boolean {
    return this.authManager?.shouldUseBackend() ?? false;
  }

  /**
   * Create a model client for the currently selected model
   * Uses the config passed during initialize() to determine provider
   * @returns Promise resolving to a model client
   */
  async createClientForCurrentModel(): Promise<ModelClient> {
    if (!this.config) {
      throw new ModelClientError('ModelClientFactory not initialized - call initialize() first');
    }

    const config = this.config.getConfig();
    const modelData = this.config.getModelByKey(config.selectedModelKey);

    if (!modelData) {
      throw new ModelClientError(`Selected model ${config.selectedModelKey} not found`);
    }

    const providerId = modelData.provider.id;
    const provider = this.mapProviderIdToType(providerId);

    return this.createClient(provider);
  }


  /**
   * Create a model client for a specific model key (e.g., 'openai:gpt-4o').
   * Used by sub-agents to honor model overrides from SubAgentTypeConfig.
   * Falls back to createClientForCurrentModel() if modelKey is not provided.
   */
  async createClientForModelKey(modelKey?: string): Promise<ModelClient> {
    if (!modelKey) {
      return this.createClientForCurrentModel();
    }
    if (!this.config) {
      throw new ModelClientError('ModelClientFactory not initialized - call initialize() first');
    }
    const modelData = this.config.getModelByKey(modelKey);
    if (!modelData) {
      throw new ModelClientError(`Model ${modelKey} not found`);
    }
    const provider = this.mapProviderIdToType(modelData.provider.id);
    return this.createClient(provider);
  }

  /**
   * Map provider ID from config to ModelProvider type
   * @param providerId Provider ID from config (e.g., 'openai', 'xai', 'anthropic', 'groq')
   * @returns ModelProvider type
   */
  private mapProviderIdToType(providerId: string): ModelProvider {
    if (providerId === 'openai' || providerId === 'xai' || providerId === 'anthropic' || providerId === 'groq' || providerId === 'google-ai-studio' || providerId === 'fireworks' || providerId === 'moonshot' || providerId === 'together' || providerId === 'deepseek') {
      return providerId;
    }
    // User-defined custom providers (BYOK) have arbitrary ids. Allow any provider
    // that exists in config and is flagged isCustom through; it routes by its
    // apiFormat in instantiateClient. Reject anything else as unsupported.
    if (this.config?.getProvider(providerId)?.isCustom) {
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
    // Include model key in cache key to prevent reusing clients with wrong config
    // (e.g., switching from Qwen with reasoning to Kimi K2 without reasoning)
    const selectedModelKey = this.config?.getConfig().selectedModelKey || 'unknown';

    // Add routing type and OAuth status to cache key to separate clients
    const oauthActive = this.authManager?.isChatGPTOAuthActive?.() ? 'oauth' : 'direct';
    const routingType = this.isBackendRouting() ? 'backend' : oauthActive;
    const constructionSignature = this.hashObject(this.getClientConstructionSignature(provider));
    const cacheKey = `${provider}-${selectedModelKey}-${routingType}-${constructionSignature}`;

    // Check cache first
    const cached = this.clientCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const client = await this.buildClient(provider);

    // Cache the client instance
    this.clientCache.set(cacheKey, client);

    return client;
  }

  /**
   * Build a client instance for a provider without touching the cache.
   * Used by createClient (which caches the result) and by
   * createEfficientClient (which must NOT share the cached main-conversation
   * instance, because it overrides the instance's model via setModel()).
   */
  private async buildClient(provider: ModelProvider): Promise<ModelClient> {
    // User-defined custom providers (BYOK) always use direct API-key mode — the
    // backend gateway only knows about built-in providers, so never route a
    // custom endpoint through it even when the user is logged in.
    const isCustomProvider = !!this.config?.getProvider(provider)?.isCustom;

    // If using backend routing (logged in), create backend-routed client
    if (!isCustomProvider && this.isBackendRouting()) {
      const gatewayLlmBaseUrl = this.authManager?.getGatewayLlmBaseUrl?.();
      return gatewayLlmBaseUrl
        ? await this.createGatewayRoutedClient(provider, gatewayLlmBaseUrl)
        : await this.createBackendRoutedClient(provider);
    }

    // Fall through to existing provider-specific logic for API key mode
    const config = await this.loadConfigForProvider(provider);
    return this.instantiateClient(config);
  }

  /**
   * Create a client for the "efficient" model — the cheap model used for
   * internal app-logistics tasks (title generation, tool-use summaries,
   * prompt suggestions). Never used for user-facing tasks.
   *
   * Resolution order:
   * 1. Explicit user selection (config.efficientModelKey, legacy
   *    modelForTitleGenerate) — honored only when it is from the same
   *    provider as the selected task model.
   * 2. Gateway default (env seam gatewayDefaultEfficientModel, e.g.
   *    "deepseek-v4-flash") when the user is logged in (backend routing)
   *    and made no explicit choice.
   * 3. The selected task model (same client as the main conversation).
   *
   * When a distinct efficient model resolves, a dedicated un-cached client
   * instance is built and its model overridden — the cached main-conversation
   * client is never mutated.
   */
  async createEfficientClient(): Promise<ModelClient> {
    if (!this.config) {
      throw new ModelClientError('ModelClientFactory not initialized - call initialize() first');
    }

    const cfg = this.config.getConfig();
    const selectedKey = cfg.selectedModelKey;
    const selectedProvider = selectedKey.split(':')[0];

    // 1. Explicit selection (same-provider rule enforced defensively — the
    //    setter validates too, but stored config may predate a provider switch).
    let efficientKey = cfg.efficientModelKey ?? cfg.modelForTitleGenerate;
    if (efficientKey && efficientKey.split(':')[0] !== selectedProvider) {
      console.warn(`[ModelClientFactory] Efficient model ${efficientKey} is not from provider ${selectedProvider}; using task model`);
      efficientKey = undefined;
    }

    // 2. Gateway default when logged in (single gateway credential routes any
    //    catalog model, so this default may come from a different provider).
    if (!efficientKey && this.isBackendRouting()) {
      const { resolveRuntimeUrls } = await import('../../config/runtimeUrls');
      const defaultModel = resolveRuntimeUrls().gatewayDefaultEfficientModel;
      if (defaultModel) {
        const sameProviderKey = `${selectedProvider}:${defaultModel}`;
        if (this.config.getModelByKey(sameProviderKey)) {
          efficientKey = sameProviderKey;
        } else {
          for (const [providerId, provider] of Object.entries(cfg.providers)) {
            if (provider?.models?.some((m) => m.modelKey === defaultModel)) {
              efficientKey = `${providerId}:${defaultModel}`;
              break;
            }
          }
        }
      }
    }

    // 3. Same as task model → share the normal (cached) client.
    if (!efficientKey || efficientKey === selectedKey) {
      return this.createClientForCurrentModel();
    }

    const modelData = this.config.getModelByKey(efficientKey);
    if (!modelData) {
      console.warn(`[ModelClientFactory] Efficient model ${efficientKey} not found in catalog; using task model`);
      return this.createClientForCurrentModel();
    }

    const provider = this.mapProviderIdToType(modelData.provider.id);
    const client = await this.buildClient(provider);
    client.setModel(modelData.model.modelKey);
    return client;
  }

  /**
   * Create a client that routes through the backend service
   * Used when user is logged in
   * @param provider The provider (used for model metadata)
   * @returns Model client configured for backend routing
   */
  private async createBackendRoutedClient(provider: ModelProvider): Promise<ModelClient> {
    const backendUrl = this.authManager?.getBackendBaseUrl();
    if (!backendUrl) {
      throw new ModelClientError('Backend URL not available for backend routing');
    }

    // Get access token from auth manager (desktop provides JWT, extension uses cookies)
    const accessToken = await this.authManager?.getAccessToken();
    // Use real token if available (desktop), fall back to dummy key (extension uses cookies)
    const apiKey = accessToken || 'backend-routed';

    // Track 11: resolve the parallel-tool-calls flag from tools config.
    const parallelToolCalls = this.resolveParallelToolCalls();

    // Get model metadata for configuration
    let modelConfig: any = undefined;
    let supportsReasoning = false;
    let supportsReasoningSummaries = false;
    let selectedModel = 'gpt-5';
    let supportBackendMode = 0;

    if (this.config) {
      const configData = this.config.getConfig();
      const modelData = this.config.getModelByKey(configData.selectedModelKey);
      if (modelData?.model) {
        modelConfig = modelData.model;
        supportsReasoning = modelData.model.supportsReasoning ?? false;
        supportsReasoningSummaries = modelData.model.supportsReasoningSummaries ?? false;
        selectedModel = modelData.model.modelKey;
        supportBackendMode = modelData.model.supportBackendMode ?? 0;
      }
    }

    // Build model family configuration
    const modelFamily = {
      family: selectedModel,
      base_instructions: 'You are a helpful coding assistant.',
      supports_reasoning: supportsReasoning,
      supports_reasoning_summaries: supportsReasoningSummaries,
      needs_special_apply_patch_instructions: false,
    };

    // Build provider configuration for backend
    const backendProvider = {
      name: 'Backend',
      base_url: backendUrl,
      wire_api: 'Responses' as const,
      requires_openai_auth: false, // Backend handles auth via cookies
    };

    // Generate conversation ID
    const sessionId = this.generateConversationId();

    // Get reasoning effort if supported
    let reasoningEffort: string | undefined;
    if (supportsReasoning) {
      reasoningEffort = 'medium';
    }

    // Select client based on supportBackendMode value:
    // 0 = not supported (should not reach here)
    // 1 = OpenAI Responses API
    // 2 = OpenAI Chat Completions API
    // 3 = Google API
    const geminiApiBaseUrl = backendUrl + '/gemini';

    if (supportBackendMode === 3) {
      // Google API
      const googleProvider = {
        name: 'Google AI Studio',
        base_url: geminiApiBaseUrl,
        wire_api: 'Chat' as const,
        requires_openai_auth: false,
      };

      return new GoogleCompletionClient({
        apiKey,
        baseUrl: geminiApiBaseUrl,
        provider: googleProvider,
        modelFamily,
        useCredentials: true,
      });
    }

    const openAIClientBackendBaseUrl = backendUrl + '/openai';
    if (supportBackendMode === 1) {
      // OpenAI Responses API
      return new OpenAIResponsesClient({
        apiKey,
        baseUrl: openAIClientBackendBaseUrl,
        sessionId,
        modelFamily,
        provider: backendProvider,
        modelConfig,
        reasoningEffort: reasoningEffort as any,
        reasoningSummary: supportsReasoningSummaries ? { enabled: true } : undefined,
        useCredentials: true,
        parallelToolCalls,
      });
    }

    // supportBackendMode === 2 or fallback: OpenAI Chat Completions API
    return new OpenAIChatCompletionClient({
      apiKey,
      baseUrl: openAIClientBackendBaseUrl,
      sessionId,
      modelFamily,
      provider: backendProvider,
      modelConfig,
      useCredentials: true,
      parallelToolCalls,
    });
  }

  /**
   * Create a remote gateway client.
   *
   * The gateway exposes an OpenAI-compatible /v1 Chat Completions surface. Auth
   * is resolved per request so cached clients do not pin an expired session JWT.
   */
  private async createGatewayRoutedClient(provider: ModelProvider, gatewayLlmBaseUrl: string): Promise<ModelClient> {
    const tokenProvider = async () => this.authManager?.getAccessToken() ?? null;
    const accessToken = await tokenProvider();
    if (!accessToken) {
      throw new ModelClientError('Gateway routing requires a session access token');
    }

    const parallelToolCalls = this.resolveParallelToolCalls();
    let modelConfig: any = undefined;
    let supportsReasoning = false;
    let supportsReasoningSummaries = false;
    let selectedModel = DEFAULT_MODEL;

    if (this.config) {
      const configData = this.config.getConfig();
      const modelData = this.config.getModelByKey(configData.selectedModelKey);
      if (modelData?.model) {
        modelConfig = modelData.model;
        supportsReasoning = modelData.model.supportsReasoning ?? false;
        supportsReasoningSummaries = modelData.model.supportsReasoningSummaries ?? false;
        // The Hub gateway resolves the canonical "<owner>/<model>" slug; for our
        // first-party catalog the provider id is the owner. (A catalog-driven
        // slug lookup would be the robust long-term form.)
        selectedModel = `${modelData.provider.id}/${modelData.model.modelKey}`;
      }
    }

    const modelFamily = {
      family: selectedModel,
      base_instructions: 'You are a helpful coding assistant.',
      supports_reasoning: supportsReasoning,
      supports_reasoning_summaries: supportsReasoningSummaries,
      needs_special_apply_patch_instructions: false,
    };

    const gatewayProvider = {
      name: 'Gateway',
      base_url: gatewayLlmBaseUrl,
      wire_api: 'Chat' as const,
      requires_openai_auth: true,
    };

    return new OpenAIChatCompletionClient({
      apiKey: 'gateway-routed',
      baseUrl: gatewayLlmBaseUrl,
      sessionId: this.generateConversationId(),
      modelFamily,
      provider: gatewayProvider,
      modelConfig,
      useCredentials: false,
      parallelToolCalls,
      getAuthorizationToken: tokenProvider,
      refreshAuthorizationToken: async () => this.authManager?.refreshAccessToken?.() ?? null,
    });
  }

  /**
   * Create a client with explicit configuration
   * @param config The client configuration
   * @returns Model client instance
   */
  createClientWithConfig(config: ModelClientConfig): ModelClient {
    const constructionSignature = this.hashObject(this.getClientConstructionSignature(config.provider));
    const cacheKey = `${config.provider}-${this.hashConfig(config)}-${constructionSignature}`;

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
   * Load API key for a provider from config
   * @param provider The provider
   * @returns Promise resolving to the API key or null if not found
   */
  async loadApiKey(provider: ModelProvider): Promise<string | null> {
    try {
      if (!this.config) {
        console.warn(`[ModelClientFactory] loadApiKey called before initialization`);
        return null;
      }
      return await this.config.getProviderApiKey(provider);
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
    try {
      await getConfigStorage().set(STORAGE_KEYS.DEFAULT_PROVIDER, provider);
    } catch (error) {
      console.warn(`[ModelClientFactory] Failed to set default provider:`, error);
    }
  }

  /**
   * Get the default provider
   * @returns Promise resolving to the default provider
   */
  async getDefaultProvider(): Promise<ModelProvider> {
    try {
      const stored = await getConfigStorage().get<ModelProvider>(STORAGE_KEYS.DEFAULT_PROVIDER);
      return stored || 'openai';
    } catch (error) {
      console.warn(`[ModelClientFactory] Failed to get default provider:`, error);
      return 'openai';
    }
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
   * Get configuration status for all providers.
   *
   * Iterates the live provider catalog rather than a hardcoded list, so it
   * stays correct as providers are added/removed (including user-defined custom
   * BYOK providers) without hand-editing a parallel ladder.
   * @returns Promise resolving to configuration status keyed by provider id
   */
  async getConfigurationStatus(): Promise<Record<ModelProvider, { hasApiKey: boolean; isDefault: boolean }>> {
    const providerIds = Object.keys(this.config?.getProviders() ?? {});
    const defaultProvider = await this.getDefaultProvider();

    const entries = await Promise.all(
      providerIds.map(
        async (id) =>
          [id, { hasApiKey: await this.hasValidApiKey(id), isDefault: defaultProvider === id }] as const
      )
    );

    return Object.fromEntries(entries) as Record<ModelProvider, { hasApiKey: boolean; isDefault: boolean }>;
  }

  /**
   * Load configuration for a provider from config
   * @param provider The provider
   * @returns Promise resolving to the client configuration
   * Note: API key can be null - validation happens when making API requests
   */
  private async loadConfigForProvider(provider: ModelProvider): Promise<ModelClientConfig> {
    // Get provider-specific API key from config
    let apiKey: string | null = null;
    let providerConfig: any = null;

    if (!this.config) {
      console.warn(`[ModelClientFactory] loadConfigForProvider called before initialization`);
    } else {
      try {
        // Get API key for this specific provider
        apiKey = await this.config.getProviderApiKey(provider);

        // Get provider configuration for base URL, organization, etc.
        const providerData = this.config.getProvider(provider);
        if (providerData) {
          providerConfig = providerData;
        }
      } catch (error) {
        console.warn(`[ModelClientFactory] Failed to load config for provider ${provider}: ${error}`);
      }
    }

    // ChatGPT OAuth: if OpenAI provider and OAuth is active, use the OAuth token
    if (provider === 'openai' && this.authManager?.isChatGPTOAuthActive?.()) {
      try {
        const oauthToken = await this.authManager.getChatGPTAccessToken?.();
        if (oauthToken) {
          apiKey = oauthToken;
        }
      } catch (error) {
        console.warn(`[ModelClientFactory] ChatGPT OAuth token retrieval failed: ${error}`);
      }
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

    return config;
  }

  /**
   * T032, Instantiate a client with the given configuration
   * Direct provider-to-client mapping for simplicity
   * @param config The client configuration
   * @returns Model client instance
   */
  private instantiateClient(config: ModelClientConfig): ModelClient {
    // Track 11: resolve the parallel-tool-calls flag from tools config.
    const parallelToolCalls = this.resolveParallelToolCalls();

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
      const modelData = this.config.getModelByKey(configData.selectedModelKey);
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
        ? 'You are Gemini 2.5 Pro integrated with the WorkX agent. Provide accurate answers and suggest tool usage when relevant.'
        : 'You are a helpful coding assistant.',
      supports_reasoning: supportsReasoning,
      supports_reasoning_summaries: supportsReasoningSummaries,
      needs_special_apply_patch_instructions: false,
    };

    // Build provider configuration
    // Map internal provider IDs to display names
    let displayName: string = providerName;
    if (providerName === 'google-ai-studio') {
      displayName = 'Google AI Studio';
    } else if (providerName === 'fireworks') {
      displayName = 'Fireworks AI';
    } else if (providerName === 'together') {
      displayName = 'Together AI';
    } else if (providerName === 'anthropic') {
      displayName = 'Anthropic';
    }

    const provider = {
      name: displayName,
      base_url: resolvedBaseUrl,
      wire_api: providerName === 'google-ai-studio' ? 'Chat' as const : 'Responses' as const,
      requires_openai_auth: providerName !== 'google-ai-studio' && providerName !== 'anthropic',
      ...(providerName === 'google-ai-studio' && {
        env_key: 'GOOGLE_AI_STUDIO_API_KEY',
        env_key_instructions: 'Set a Google AI Studio key in Settings to enable Gemini.',
      }),
    };

    // Generate a conversation ID for prompt_cache_key usage
    const sessionId = this.generateConversationId();

    // Get reasoning effort from model config
    // Default to 'medium' for models that support reasoning
    let reasoningEffort: string | undefined;
    if (supportsReasoning) {
      reasoningEffort = 'medium'; // Default reasoning effort
    }

    // User-defined custom providers (BYOK) route by their wire API format rather
    // than by provider id. Default to Chat Completions — the broadly compatible
    // baseline most OpenAI-compatible servers implement; 'responses' is opt-in.
    const customProvider = this.config?.getProvider(providerName);
    if (customProvider?.isCustom) {
      const clientArgs = {
        apiKey: config.apiKey,
        baseUrl: resolvedBaseUrl,
        organization,
        sessionId,
        modelFamily,
        provider,
        modelConfig,
        reasoningEffort: reasoningEffort as any,
        reasoningSummary: supportsReasoningSummaries ? { enabled: true } : undefined,
        parallelToolCalls,
      };
      return customProvider.apiFormat === 'responses'
        ? new OpenAIResponsesClient(clientArgs)
        : new OpenAIChatCompletionClient(clientArgs);
    }

    // Direct provider-to-client mapping
    // This is the single source of truth for which client each provider uses
    switch (providerName) {
      case 'moonshot':
      case 'deepseek':
        return new OpenAIChatCompletionClient({
          apiKey: config.apiKey,
          baseUrl: resolvedBaseUrl,
          organization,
          sessionId,
          modelFamily,
          provider,
          modelConfig,
          parallelToolCalls,
        });

      case 'together':
        return new TogetherChatCompletionClient({
          apiKey: config.apiKey,
          baseUrl: resolvedBaseUrl,
          organization,
          sessionId,
          modelFamily,
          provider,
          modelConfig,
          parallelToolCalls,
        });

      case 'fireworks':
        return new FireworksChatCompletionClient({
          apiKey: config.apiKey,
          baseUrl: resolvedBaseUrl,
          organization,
          sessionId,
          modelFamily,
          provider,
          modelConfig,
          parallelToolCalls,
        });

      case 'google-ai-studio':
        return new GoogleCompletionClient({
          apiKey: config.apiKey,
          baseUrl: resolvedBaseUrl,
          provider,
          modelFamily,
        });

      case 'groq':
        return new GroqClient({
          apiKey: config.apiKey,
          baseUrl: resolvedBaseUrl,
          organization,
          sessionId,
          modelFamily,
          provider,
          modelConfig,
          reasoningEffort: reasoningEffort as any,
          reasoningSummary: supportsReasoningSummaries ? { enabled: true } : undefined,
          parallelToolCalls,
        });

      case 'anthropic':
        return new AnthropicClient({
          apiKey: config.apiKey,
          baseUrl: resolvedBaseUrl,
          organization,
          sessionId,
          modelFamily,
          provider,
          modelConfig,
          reasoningEffort: reasoningEffort as any,
          reasoningSummary: supportsReasoningSummaries ? { enabled: true } : undefined,
        });

      case 'openai':
      case 'xai':
      default:
        return new OpenAIResponsesClient({
          apiKey: config.apiKey,
          baseUrl: resolvedBaseUrl,
          organization,
          sessionId,
          modelFamily,
          provider,
          modelConfig,
          reasoningEffort: reasoningEffort as any,
          reasoningSummary: supportsReasoningSummaries ? { enabled: true } : undefined,
          serviceTier,
          parallelToolCalls,
        });
    }
  }

  /**
   * Create a simple hash of the configuration for caching
   * @param config The configuration to hash
   * @returns Hash string
   */
  private hashConfig(config: ModelClientConfig): string {
    return this.hashObject({
      provider: config.provider,
      apiKey: config.apiKey?.slice(0, 10) || 'null', // Only use first 10 chars for privacy
      options: config.options || {},
    });
  }

  private hashObject(value: unknown): string {
    const str = JSON.stringify(value);
    // Simple hash function
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }

    return hash.toString(36);
  }

  private getClientConstructionSignature(provider: ModelProvider): ClientConstructionSignature {
    const selectedModelKey = this.config?.getConfig().selectedModelKey || 'unknown';
    const providerConfig = this.config?.getProvider?.(provider);
    const modelData = this.config?.getModelByKey?.(selectedModelKey);
    const model = modelData?.model;

    return {
      selectedModelKey,
      parallelToolCalls: this.resolveParallelToolCalls(),
      providerBaseUrl: providerConfig?.baseUrl ?? null,
      providerOrganization: providerConfig?.organization ?? null,
      gatewayLlmBaseUrl: this.authManager?.getGatewayLlmBaseUrl?.() ?? null,
      model: {
        modelKey: model?.modelKey ?? null,
        supportsReasoning: model?.supportsReasoning ?? false,
        supportsReasoningSummaries: model?.supportsReasoningSummaries ?? false,
        serviceTier: model?.serviceTier ?? null,
        supportBackendMode: model?.supportBackendMode ?? null,
      },
    };
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
  /**
   * Track 11: resolve the config-driven parallel-tool-calls flag.
   * The `getToolsConfig?.()` guard is load-bearing — `this.config` may be a
   * partial mock or an early-bootstrap config without the method. Defaults
   * to false in that case.
   */
  private resolveParallelToolCalls(): boolean {
    return this.config?.getToolsConfig?.()?.parallelToolCalls ?? false;
  }

  getSelectedModel(): string {
    if (this.config) {
      // Get selectedModelKey from config
      const configData = this.config.getConfig();
      const selectedModelKey = configData.selectedModelKey;

      // Look up the model by composite key
      const modelData = this.config.getModelByKey(selectedModelKey);
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
    // Fallback using cryptographically secure random values
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
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
