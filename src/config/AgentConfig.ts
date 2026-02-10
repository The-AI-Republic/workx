/**
 * Main centralized agent configuration class
 */

import type {
  IAgentConfig,
  IModelConfig,
  IProviderConfig,
  IProfileConfig,
  IConfigService,
  IConfigChangeEvent,
  IExportData,
  IToolsConfig,
  IToolSpecificConfig
} from './types';
import { ConfigValidationError } from './types';
import { ConfigStorage } from '../storage/ConfigStorage';
import {
  getDefaultAgentConfig,
  buildRuntimeConfig,
  extractStoredConfig
} from './defaults';
import { validateConfig, validateModelConfig, validateProviderConfig, detectProviderFromKey } from './validators';
import {
  getCredentialStore,
  isCredentialStoreInitialized,
  type CredentialStore
} from '../core/storage/CredentialStore';

// Credential store constants
const CREDENTIAL_SERVICE = 'browserx';
const CREDENTIAL_ACCOUNT_PREFIX = 'provider-apikey-';

export class AgentConfig implements IConfigService {
  private static instance: AgentConfig | null = null;
  private storage: ConfigStorage;
  private currentConfig: IAgentConfig;
  private eventHandlers: Map<string, Set<(e: IConfigChangeEvent) => void>>;
  private initialized: boolean = false;

  private constructor() {
    this.storage = new ConfigStorage();
    this.currentConfig = getDefaultAgentConfig();
    this.eventHandlers = new Map();
  }

  /**
   * Get the singleton instance of AgentConfig
   * @returns Promise resolving to the singleton AgentConfig instance
   */
  public static async getInstance(): Promise<AgentConfig> {
    if (!AgentConfig.instance) {
      const instance = new AgentConfig();
      await instance.initialize();
      AgentConfig.instance = instance;
    }
    return AgentConfig.instance;
  }

  /**
   * Initialize the config from storage (lazy initialization)
   * Called automatically on first config access
   *
   * Storage contains only user-changeable data (API keys, selectedModelKey, preferences).
   * Provider/model metadata is loaded fresh from default.json at runtime.
   */
  public async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      const storedConfig = await this.storage.get();
      console.log('[AgentConfig] initialize - storedConfig from storage:', storedConfig?.selectedModelKey);

      // Build full runtime config by merging stored data with default.json providers/models
      this.currentConfig = buildRuntimeConfig(storedConfig);
      console.log('[AgentConfig] initialize - after buildRuntimeConfig, selectedModelKey:', this.currentConfig.selectedModelKey);

      // Save back to storage (only minimal data)
      await this.storage.set(extractStoredConfig(this.currentConfig));
      this.initialized = true;
    } catch (error) {
      console.error('[AgentConfig] Failed to initialize config:', error);
      this.currentConfig = getDefaultAgentConfig();
      try {
        await this.storage.set(extractStoredConfig(this.currentConfig));
      } catch (ensureError) {
        console.error('[AgentConfig] Failed to save default config on error recovery:', ensureError);
      }
      this.initialized = true;
    }
  }



  /**
   * Reload the config from storage
   * Useful when config has been updated by another component
   */
  public async reload(): Promise<void> {
    try {
      const storedConfig = await this.storage.get();

      // Build full runtime config by merging stored data with default.json providers/models
      this.currentConfig = buildRuntimeConfig(storedConfig);
    } catch (error) {
      console.error('Failed to reload config:', error);
      throw error;
    }
  }

  // Core CRUD operations
  getConfig(): IAgentConfig {
    this.ensureInitialized();
    return { ...this.currentConfig };
  }

  updateConfig(config: Partial<IAgentConfig>): IAgentConfig {
    this.ensureInitialized();

    const oldConfig = { ...this.currentConfig };
    const newConfig = { ...this.currentConfig, ...config };

    // Validate the new configuration
    const validation = validateConfig(newConfig);
    if (!validation.valid) {
      throw new ConfigValidationError(
        validation.field || 'config',
        validation.value,
        validation.error || 'Invalid configuration'
      );
    }

    this.currentConfig = newConfig;
    this.storage.set(extractStoredConfig(this.currentConfig)).catch(err => {
      console.error('Failed to persist config:', err);
    });

    // Emit change events if selectedModelKey changed
    if (oldConfig.selectedModelKey !== newConfig.selectedModelKey) {
      this.emitChangeEvent('model', oldConfig.selectedModelKey, newConfig.selectedModelKey);
    }

    return { ...this.currentConfig };
  }

  resetConfig(preserveApiKeys?: boolean): IAgentConfig {
    this.ensureInitialized();

    let newConfig = getDefaultAgentConfig();

    if (preserveApiKeys && this.currentConfig.providers) {
      // Preserve API keys from existing providers
      Object.entries(this.currentConfig.providers).forEach(([id, provider]) => {
        if (provider.apiKey && newConfig.providers[id]) {
          newConfig.providers[id].apiKey = provider.apiKey;
          newConfig.providers[id].organization = provider.organization;
        }
      });
    }

    this.currentConfig = newConfig;
    this.storage.set(extractStoredConfig(this.currentConfig)).catch(err => {
      console.error('Failed to persist config:', err);
    });

    return { ...this.currentConfig };
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error('AgentConfig not initialized. Call initialize() first.');
    }
  }

  // Model operations

  /**
   * Set the selected model by composite key
   * @param compositeKey - Model key in format "providerId:modelKey" (e.g., "openai:gpt-5.1")
   * @throws Error if model is not found
   * @example
   * await agentConfig.setSelectedModel('openai:gpt-5.1');
   */
  async setSelectedModel(compositeKey: string): Promise<void> {
    this.ensureInitialized();

    // Validate format
    if (!compositeKey.includes(':')) {
      console.error(`[AgentConfig] Invalid model key format: ${compositeKey}`);
      throw new Error(`Invalid model key format: ${compositeKey}. Expected "providerId:modelKey".`);
    }

    // Verify model exists
    const modelData = this.getModelByKey(compositeKey);
    if (!modelData) {
      console.error(`[AgentConfig] Model not found: ${compositeKey}`);
      throw new Error(`Model not found: ${compositeKey}`);
    }

    // Update selectedModelKey
    const oldModelKey = this.currentConfig.selectedModelKey;
    this.currentConfig.selectedModelKey = compositeKey;

    await this.storage.set(extractStoredConfig(this.currentConfig));
    this.emitChangeEvent('model', oldModelKey, compositeKey);
  }

  /**
   * Get current model configuration
   * @returns Model configuration for currently selected model
   * @example
   * const model = agentConfig.getModelConfig();
   * console.log(model.name); // "GPT-5"
   */
  getModelConfig(): IModelConfig {
    this.ensureInitialized();

    const modelData = this.getModelByKey(this.currentConfig.selectedModelKey);
    if (modelData) {
      return modelData.model;
    }

    // Fallback: return first available model
    const allModels = this.getAllModels();
    if (allModels.length > 0) {
      return allModels[0].model;
    }

    throw new Error('No model configuration available');
  }

  updateModelConfig(config: Partial<IModelConfig>): IModelConfig {
    this.ensureInitialized();

    const oldModel = this.getModelConfig();
    const newModel = { ...oldModel, ...config };

    // Validate model configuration
    const validation = validateModelConfig(newModel);
    if (!validation.valid) {
      throw new ConfigValidationError(
        validation.field || 'model',
        validation.value,
        validation.error || 'Invalid model configuration'
      );
    }

    // Validate maxOutputTokens <= contextWindow
    if (newModel.maxOutputTokens && newModel.contextWindow &&
      newModel.maxOutputTokens > newModel.contextWindow) {
      throw new Error('maxOutputTokens cannot exceed contextWindow');
    }

    // Update the model in the provider's models array
    const modelData = this.getModelByKey(this.currentConfig.selectedModelKey);
    if (!modelData) {
      throw new Error('Cannot update model: selected model not found');
    }

    const provider = this.currentConfig.providers[modelData.provider.id];
    if (!provider || !provider.models) {
      throw new Error('Cannot update model: provider not found');
    }

    // Find and update the model in the provider's models array
    const modelIndex = provider.models.findIndex(m => m.modelKey === modelData.model.modelKey);
    if (modelIndex === -1) {
      throw new Error('Cannot update model: model not found in provider');
    }

    provider.models[modelIndex] = newModel;

    this.storage.set(extractStoredConfig(this.currentConfig)).catch(err => {
      console.error('Failed to persist config:', err);
    });

    this.emitChangeEvent('model', oldModel, newModel);

    return newModel;
  }

  // Provider management
  getProviders(): Record<string, IProviderConfig> {
    this.ensureInitialized();
    return { ...this.currentConfig.providers };
  }

  /**
   * Add a new provider with automatic model ID assignment
   * @param provider Provider configuration to add
   * @returns Added provider with model IDs assigned
   */
  addProvider(provider: IProviderConfig): IProviderConfig {
    this.ensureInitialized();

    const validation = validateProviderConfig(provider);
    if (!validation.valid) {
      throw new ConfigValidationError(
        validation.field || 'provider',
        validation.value,
        validation.error || 'Invalid provider configuration'
      );
    }

    this.currentConfig.providers[provider.id] = provider;
    this.storage.set(extractStoredConfig(this.currentConfig)).catch(err => {
      console.error('Failed to persist config:', err);
    });

    this.emitChangeEvent('provider', null, provider);

    return provider;
  }

  /**
   * Update a provider with automatic model ID assignment for new models
   * @param id Provider ID to update
   * @param provider Partial provider config with updates
   * @returns Updated provider configuration
   */
  updateProvider(id: string, provider: Partial<IProviderConfig>): IProviderConfig {
    this.ensureInitialized();

    const existing = this.currentConfig.providers[id];
    if (!existing) {
      throw new Error(`Provider not found: ${id}`);
    }

    const updated = { ...existing, ...provider };

    const validation = validateProviderConfig(updated);
    if (!validation.valid) {
      throw new ConfigValidationError(
        validation.field || 'provider',
        validation.value,
        validation.error || 'Invalid provider configuration'
      );
    }

    this.currentConfig.providers[id] = updated;
    this.storage.set(extractStoredConfig(this.currentConfig)).catch(err => {
      console.error('Failed to persist config:', err);
    });

    this.emitChangeEvent('provider', existing, updated);

    return updated;
  }

  deleteProvider(id: string): void {
    this.ensureInitialized();

    // Check if provider hosts the currently selected model
    if (this.currentConfig.selectedModelKey.startsWith(`${id}:`)) {
      throw new Error('Cannot delete provider that hosts the currently selected model');
    }

    const deleted = this.currentConfig.providers[id];
    delete this.currentConfig.providers[id];
    this.storage.set(extractStoredConfig(this.currentConfig)).catch(err => {
      console.error('Failed to persist config:', err);
    });

    this.emitChangeEvent('provider', deleted, null);
  }

  /**
   * Get the credential store, with fallback for when not initialized
   */
  private getCredentials(): CredentialStore | null {
    if (isCredentialStoreInitialized()) {
      return getCredentialStore();
    }
    return null;
  }

  /**
   * Set API key for a specific provider
   * @param providerId - Provider identifier (e.g., 'openai', 'xai', 'anthropic', 'google-ai-studio')
   * @param apiKey - API key (stored securely in credential store)
   * @returns Provider configuration
   * @throws Error if provider is unknown
   * @example
   * await agentConfig.setProviderApiKey('xai', 'xai-abc123...');
   */
  async setProviderApiKey(providerId: string, apiKey: string): Promise<IProviderConfig> {
    this.ensureInitialized();

    // Check if provider exists
    const provider = this.currentConfig.providers[providerId];
    if (!provider) {
      console.error(`[AgentConfig] Provider not found: ${providerId}`);
      throw new Error(`Provider not found: ${providerId}`);
    }

    // Store API key in credential store (OS keychain on desktop, chrome.storage on extension)
    const credentials = this.getCredentials();
    if (credentials) {
      await credentials.set(CREDENTIAL_SERVICE, `${CREDENTIAL_ACCOUNT_PREFIX}${providerId}`, apiKey);
    }

    // Mark that this provider has an API key configured (without storing the actual key)
    provider.apiKey = '[SECURED]';
    this.currentConfig.providers[providerId] = provider;

    await this.storage.set(extractStoredConfig(this.currentConfig));
    this.emitChangeEvent('provider', null, provider);

    return provider;
  }

  /**
   * Get API key for a specific provider
   * @param providerId - Provider identifier (e.g., 'openai', 'xai', 'anthropic', 'google-ai-studio')
   * @returns API key or null if not configured
   * @example
   * const apiKey = await agentConfig.getProviderApiKey('openai');
   * if (apiKey) {
   *   // Use API key for requests
   * }
   */
  async getProviderApiKey(providerId: string): Promise<string | null> {
    this.ensureInitialized();

    // Get API key from credential store
    const credentials = this.getCredentials();
    if (credentials) {
      const apiKey = await credentials.get(CREDENTIAL_SERVICE, `${CREDENTIAL_ACCOUNT_PREFIX}${providerId}`);
      if (apiKey) {
        return apiKey;
      }
    }

    return null;
  }

  /**
   * Delete API key for a specific provider
   * @param providerId - Provider identifier (e.g., 'openai', 'xai', 'anthropic', 'google-ai-studio')
   * @throws Error if provider is not found
   * @example
   * await agentConfig.deleteProviderApiKey('xai');
   */
  async deleteProviderApiKey(providerId: string): Promise<void> {
    this.ensureInitialized();

    const provider = this.currentConfig.providers[providerId];
    if (!provider) {
      console.error(`[AgentConfig] Cannot delete API key - provider not found: ${providerId}`);
      throw new Error(`Provider not found: ${providerId}`);
    }

    // Delete from credential store
    const credentials = this.getCredentials();
    if (credentials) {
      await credentials.delete(CREDENTIAL_SERVICE, `${CREDENTIAL_ACCOUNT_PREFIX}${providerId}`);
    }

    // Clear the marker
    provider.apiKey = '';
    this.currentConfig.providers[providerId] = provider;

    await this.storage.set(extractStoredConfig(this.currentConfig));
    this.emitChangeEvent('provider', provider, { ...provider, apiKey: '' });
  }

  /**
   * Get provider configuration by ID
   * @param id - Provider identifier
   * @returns Provider configuration or null if not found
   * @example
   * const provider = agentConfig.getProvider('xai');
   * if (provider) {
   *   console.log(provider.baseUrl); // https://api.x.ai/v1
   * }
   */
  getProvider(id: string): IProviderConfig | null {
    this.ensureInitialized();
    return this.currentConfig.providers[id] || null;
  }

  /**
   * Get list of providers with configured API keys
   * @returns Array of provider IDs that have API keys configured
   * @example
   * const configured = agentConfig.getConfiguredProviders();
   * // ['openai', 'xai'] - providers with API keys
   */
  getConfiguredProviders(): string[] {
    this.ensureInitialized();
    return Object.keys(this.currentConfig.providers).filter(
      id => this.currentConfig.providers[id].apiKey
    );
  }

  /**
   * Create a composite model key from provider ID and model key
   * @param providerId - Provider identifier (e.g., 'openai', 'xai')
   * @param modelKey - Model's API identifier (e.g., 'gpt-5.1', 'grok-4-1-fast-reasoning')
   * @returns Composite key in format "providerId:modelKey"
   * @example
   * const key = AgentConfig.createModelKey('openai', 'gpt-5.1');
   * console.log(key); // "openai:gpt-5.1"
   */
  static createModelKey(providerId: string, modelKey: string): string {
    return `${providerId}:${modelKey}`;
  }

  /**
   * Get model by composite key
   * @param compositeKey - Model key in format "providerId:modelKey" (e.g., "openai:gpt-5.1")
   * @returns Model config with provider context, or null if not found
   * @example
   * const result = agentConfig.getModelByKey('openai:gpt-5.1');
   * if (result) {
   *   console.log(result.model.name); // "GPT-5.1"
   *   console.log(result.provider.name); // "OpenAI"
   * }
   */
  getModelByKey(compositeKey: string): { model: IModelConfig; provider: IProviderConfig } | null {
    this.ensureInitialized();

    if (!compositeKey || !compositeKey.includes(':')) return null;

    // Use indexOf to handle modelKeys that might contain colons
    const colonIndex = compositeKey.indexOf(':');
    const providerId = compositeKey.slice(0, colonIndex);
    const modelKey = compositeKey.slice(colonIndex + 1);

    const provider = this.currentConfig.providers[providerId];
    if (!provider) return null;

    const model = provider.models?.find(m => m.modelKey === modelKey);
    if (!model) return null;

    return { model, provider };
  }

  /**
   * @deprecated Use getModelByKey instead
   */
  getModelById(compositeKey: string): { model: IModelConfig; provider: IProviderConfig } | null {
    return this.getModelByKey(compositeKey);
  }

  /**
   * Get all models across all providers
   * Flattens models from all providers into single array with provider context
   * @returns Array of models with provider info
   * @example
   * const allModels = agentConfig.getAllModels();
   * allModels.forEach(({ model, provider }) => {
   *   console.log(`${model.name} - ${provider.name}`);
   * });
   */
  getAllModels(): Array<{
    model: IModelConfig;
    providerId: string;
    providerName: string;
  }> {
    this.ensureInitialized();

    const models: Array<{
      model: IModelConfig;
      providerId: string;
      providerName: string;
    }> = [];

    for (const [providerId, provider] of Object.entries(this.currentConfig.providers)) {
      if (provider.models) {
        for (const model of provider.models) {
          models.push({
            model,
            providerId,
            providerName: provider.name
          });
        }
      }
    }

    return models;
  }



  /**
   * Detect provider from API key format
   * @param apiKey - Unencrypted API key
   * @returns Provider identifier or 'unknown' if cannot be detected
   * @remarks Uses regex patterns to identify provider from key format
   * @example
   * const provider = await agentConfig.detectProviderFromKey('xai-abc123');
   * console.log(provider); // 'xai'
   */
  async detectProviderFromKey(apiKey: string): Promise<string> {
    return detectProviderFromKey(apiKey);
  }

  // Profile management
  getProfiles(): Record<string, IProfileConfig> {
    this.ensureInitialized();
    return { ...(this.currentConfig.profiles || {}) };
  }

  getProfile(name: string): IProfileConfig | null {
    this.ensureInitialized();
    return this.currentConfig.profiles?.[name] || null;
  }

  createProfile(profile: IProfileConfig): IProfileConfig {
    this.ensureInitialized();

    if (!this.currentConfig.profiles) {
      this.currentConfig.profiles = {};
    }

    if (this.currentConfig.profiles[profile.name]) {
      throw new Error(`Profile already exists: ${profile.name}`);
    }

    this.currentConfig.profiles[profile.name] = profile;
    this.storage.set(extractStoredConfig(this.currentConfig)).catch(err => {
      console.error('Failed to persist config:', err);
    });

    this.emitChangeEvent('profile', null, profile);

    return profile;
  }

  updateProfile(name: string, profile: Partial<IProfileConfig>): IProfileConfig {
    this.ensureInitialized();

    if (!this.currentConfig.profiles?.[name]) {
      throw new Error(`Profile not found: ${name}`);
    }

    const updated = { ...this.currentConfig.profiles[name], ...profile };
    this.currentConfig.profiles[name] = updated;
    this.storage.set(extractStoredConfig(this.currentConfig)).catch(err => {
      console.error('Failed to persist config:', err);
    });

    this.emitChangeEvent('profile', this.currentConfig.profiles[name], updated);

    return updated;
  }

  deleteProfile(name: string): void {
    this.ensureInitialized();

    if (this.currentConfig.activeProfile === name) {
      throw new Error('Cannot delete active profile');
    }

    const deleted = this.currentConfig.profiles?.[name];
    if (this.currentConfig.profiles) {
      delete this.currentConfig.profiles[name];
    }
    this.storage.set(extractStoredConfig(this.currentConfig)).catch(err => {
      console.error('Failed to persist config:', err);
    });

    this.emitChangeEvent('profile', deleted, null);
  }

  activateProfile(name: string): void {
    this.ensureInitialized();

    if (!this.currentConfig.profiles?.[name]) {
      throw new Error(`Profile not found: ${name}`);
    }

    this.currentConfig.activeProfile = name;
    const profile = this.currentConfig.profiles[name];
    profile.lastUsed = Date.now();

    this.storage.set(extractStoredConfig(this.currentConfig)).catch(err => {
      console.error('Failed to persist config:', err);
    });

    this.emitChangeEvent('profile', null, profile);
  }

  // Import/Export
  exportConfig(includeApiKeys?: boolean): IExportData {
    this.ensureInitialized();

    const configToExport = { ...this.currentConfig };

    if (!includeApiKeys) {
      // Redact API keys
      Object.values(configToExport.providers).forEach(provider => {
        provider.apiKey = '[REDACTED]';
      });
    }

    return {
      version: configToExport.version,
      exportDate: Date.now(),
      config: configToExport
    };
  }

  importConfig(data: IExportData): IAgentConfig {
    const validation = validateConfig(data.config);
    if (!validation.valid) {
      throw new ConfigValidationError(
        validation.field || 'config',
        validation.value,
        validation.error || 'Invalid configuration'
      );
    }

    this.currentConfig = data.config;
    this.storage.set(extractStoredConfig(this.currentConfig)).catch(err => {
      console.error('Failed to persist config:', err);
    });

    return { ...this.currentConfig };
  }

  // Tool configuration operations
  getToolsConfig(): IToolsConfig {
    this.ensureInitialized();
    return { ...(this.currentConfig.tools || {}) } as IToolsConfig;
  }

  updateToolsConfig(config: Partial<IToolsConfig>): IToolsConfig {
    this.ensureInitialized();

    const oldConfig = this.currentConfig.tools;
    const newConfig = {
      ...(this.currentConfig.tools || {}),
      ...config,
      sandboxPolicy: {
        ...(this.currentConfig.tools?.sandboxPolicy || {}),
        ...(config.sandboxPolicy || {})
      },
      perToolConfig: {
        ...(this.currentConfig.tools?.perToolConfig || {}),
        ...(config.perToolConfig || {})
      }
    };

    this.currentConfig.tools = newConfig as IToolsConfig;
    this.storage.set(extractStoredConfig(this.currentConfig)).catch(err => {
      console.error('Failed to persist config:', err);
    });
    this.emitChangeEvent('tools' as any, oldConfig, newConfig);

    return newConfig as IToolsConfig;
  }

  getEnabledTools(): string[] {
    this.ensureInitialized();
    return this.currentConfig.tools?.enabled || [];
  }

  enableTool(toolName: string): void {
    this.ensureInitialized();

    const tools = this.currentConfig.tools || { enabled: [], disabled: [] };
    if (!tools.enabled) tools.enabled = [];
    if (!tools.disabled) tools.disabled = [];

    if (!tools.enabled.includes(toolName)) {
      tools.enabled.push(toolName);
    }
    tools.disabled = tools.disabled.filter(name => name !== toolName);

    this.currentConfig.tools = tools as IToolsConfig;
    this.storage.set(extractStoredConfig(this.currentConfig)).catch(err => {
      console.error('Failed to persist config:', err);
    });
    this.emitChangeEvent('tools' as any, null, tools);
  }

  disableTool(toolName: string): void {
    this.ensureInitialized();

    const tools = this.currentConfig.tools || { enabled: [], disabled: [] };
    if (!tools.enabled) tools.enabled = [];
    if (!tools.disabled) tools.disabled = [];

    tools.enabled = tools.enabled.filter(name => name !== toolName);
    if (!tools.disabled.includes(toolName)) {
      tools.disabled.push(toolName);
    }

    this.currentConfig.tools = tools as IToolsConfig;
    this.storage.set(extractStoredConfig(this.currentConfig)).catch(err => {
      console.error('Failed to persist config:', err);
    });
    this.emitChangeEvent('tools' as any, null, tools);
  }

  getToolTimeout(): number {
    this.ensureInitialized();
    return this.currentConfig.tools?.timeout || 30000;
  }

  getToolSandboxPolicy(): any {
    this.ensureInitialized();
    return this.currentConfig.tools?.sandboxPolicy || { mode: 'workspace-write' };
  }

  getToolSpecificConfig(toolName: string): IToolSpecificConfig | null {
    this.ensureInitialized();
    return this.currentConfig.tools?.perToolConfig?.[toolName] || null;
  }

  updateToolSpecificConfig(
    toolName: string,
    config: Partial<IToolSpecificConfig>
  ): void {
    this.ensureInitialized();

    if (!this.currentConfig.tools) {
      this.currentConfig.tools = { enabled: [], disabled: [] } as IToolsConfig;
    }
    if (!this.currentConfig.tools.perToolConfig) {
      this.currentConfig.tools.perToolConfig = {};
    }

    const oldConfig = this.currentConfig.tools.perToolConfig[toolName];
    this.currentConfig.tools.perToolConfig[toolName] = {
      ...(oldConfig || {}),
      ...config
    };

    this.storage.set(extractStoredConfig(this.currentConfig)).catch(err => {
      console.error('Failed to persist config:', err);
    });
    this.emitChangeEvent('tools' as any, oldConfig, this.currentConfig.tools.perToolConfig[toolName]);
  }

  // Event emitter functionality
  on(event: 'config-changed', handler: (e: IConfigChangeEvent) => void): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    this.eventHandlers.get(event)!.add(handler);
  }

  off(event: 'config-changed', handler: (e: IConfigChangeEvent) => void): void {
    this.eventHandlers.get(event)?.delete(handler);
  }

  private emitChangeEvent(
    section: IConfigChangeEvent['section'],
    oldValue: any,
    newValue: any
  ): void {
    const handlers = this.eventHandlers.get('config-changed');
    if (handlers) {
      const event: IConfigChangeEvent = {
        type: 'config-changed',
        section,
        oldValue,
        newValue,
        timestamp: Date.now()
      };
      handlers.forEach(handler => handler(event));
    }
  }
}
