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
  mergeWithDefaults,
  getDefaultProviders
} from './defaults';
import { validateConfig, validateModelConfig, validateProviderConfig, detectProviderFromKey } from './validators';
import { encryptApiKey, decryptApiKey } from '../utils/encryption';

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
   * @returns The singleton AgentConfig instance
   */
  public static getInstance(): AgentConfig {
    if (!AgentConfig.instance) {
      const instance = new AgentConfig();
      instance.initialize();
      AgentConfig.instance = instance;
    }
    return AgentConfig.instance;
  }

  /**
   * Initialize the config from storage (lazy initialization)
   * Called automatically on first config access
   */
  public async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    try {
      const storedConfig = await this.storage.get();

      if (storedConfig) {
        this.currentConfig = mergeWithDefaults(storedConfig);
      } else {
        // First time setup
        this.currentConfig = getDefaultAgentConfig();
      }

      // Ensure all models have IDs and registry is populated
      await this.ensureModelIds();

      await this.storage.set(this.currentConfig);
      this.initialized = true;
    } catch (error) {
      console.error('[AgentConfig] Failed to initialize config:', error);
      this.currentConfig = getDefaultAgentConfig();
      // Even on error, try to ensure model IDs
      try {
        await this.ensureModelIds();
        await this.storage.set(this.currentConfig);
      } catch (ensureError) {
        console.error('[AgentConfig] Failed to ensure model IDs on error recovery:', ensureError);
      }
      this.initialized = true;
    }
  }

  /**
   * Generate a random 6-digit model ID that doesn't exist in the registry
   * @private
   * @returns Random 6-digit numeric string
   */
  private generateRandomModelId(): string {
    const existingIds = new Set(Object.keys(this.currentConfig.modelRegistry));
    let newId: string;
    let attempts = 0;
    const maxAttempts = 100;

    do {
      // Generate 6 random digits
      let id = '';
      for (let i = 0; i < 6; i++) {
        id += Math.floor(Math.random() * 10).toString();
      }
      newId = id;
      attempts++;

      if (attempts >= maxAttempts) {
        throw new Error('Failed to generate unique model ID after 100 attempts');
      }
    } while (existingIds.has(newId));

    return newId;
  }

  /**
   * Ensure all models have unique IDs and registry is populated
   * Automatically generates IDs for any models missing them
   * @private
   */
  private async ensureModelIds(): Promise<void> {
    let modified = false;

    // Iterate through all providers and their models
    for (const provider of Object.values(this.currentConfig.providers)) {
      if (!provider.models || !Array.isArray(provider.models)) {
        console.warn(`[AgentConfig] Provider ${provider.id} has no models array`);
        continue;
      }

      for (const model of provider.models) {
        // Generate ID if missing or empty
        if (!model.id || model.id === '') {
          // Generate random 6-digit ID
          model.id = this.generateRandomModelId();
          modified = true;
        }

        // Add to registry
        this.currentConfig.modelRegistry[model.id] = {
          providerId: provider.id,
          modelKey: model.modelKey
        };
      }
    }

    // Ensure selectedModelId is valid, otherwise pick first available model
    if (!this.currentConfig.selectedModelId ||
        !this.currentConfig.modelRegistry[this.currentConfig.selectedModelId]) {
      const firstModelId = Object.keys(this.currentConfig.modelRegistry)[0];
      if (firstModelId) {
        this.currentConfig.selectedModelId = firstModelId;
        modified = true;
      } else {
        console.error('[AgentConfig] No models found in registry after processing!');
      }
    }

    // Save if we made any changes
    if (modified) {
      await this.storage.set(this.currentConfig);
    }
  }

  /**
   * Reload the config from storage
   * Useful when config has been updated by another component
   */
  public async reload(): Promise<void> {
    try {
      const storedConfig = await this.storage.get();

      if (storedConfig) {
        this.currentConfig = mergeWithDefaults(storedConfig);
      } else {
        // No stored config, use defaults
        this.currentConfig = getDefaultAgentConfig();
      }
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
    const newConfig = mergeWithDefaults({ ...this.currentConfig, ...config });

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
    this.storage.set(this.currentConfig).catch(err => {
      console.error('Failed to persist config:', err);
    });

    // Emit change events if selectedModelId changed
    if (oldConfig.selectedModelId !== newConfig.selectedModelId) {
      this.emitChangeEvent('model', oldConfig.selectedModelId, newConfig.selectedModelId);
    }

    return { ...this.currentConfig };
  }

  resetConfig(preserveApiKeys?: boolean): IAgentConfig {
    this.ensureInitialized();

    let newConfig = getDefaultAgentConfig();

    if (preserveApiKeys && this.currentConfig.providers) {
      // Preserve API keys from existing providers
      const preservedProviders: Record<string, IProviderConfig> = {};
      Object.entries(this.currentConfig.providers).forEach(([id, provider]) => {
        if (provider.apiKey) {
          preservedProviders[id] = {
            ...getDefaultProviders()[id],
            apiKey: provider.apiKey,
            organization: provider.organization
          };
        }
      });
      newConfig.providers = preservedProviders;
    }

    this.currentConfig = newConfig;
    this.storage.set(this.currentConfig).catch(err => {
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
   * Set the selected model by ID
   * @param modelId - Model ID to select (must exist in modelRegistry)
   * @throws Error if model ID is invalid or not found
   * @example
   * await agentConfig.setSelectedModel('000001');
   */
  async setSelectedModel(modelId: string): Promise<void> {
    this.ensureInitialized();

    // Validate model ID format
    if (!/^\d{6}$/.test(modelId)) {
      console.error(`[AgentConfig] Invalid model ID format: ${modelId}`);
      throw new Error(`Invalid model ID format: ${modelId}. Expected 6-digit numeric string.`);
    }

    // Check if model exists in registry
    const entry = this.currentConfig.modelRegistry[modelId];
    if (!entry) {
      console.error(`[AgentConfig] Model ID not found in registry: ${modelId}`);
      throw new Error(`Model ID not found in registry: ${modelId}`);
    }

    // Verify provider exists
    const provider = this.currentConfig.providers[entry.providerId];
    if (!provider) {
      console.error(`[AgentConfig] Provider not found: ${entry.providerId} for model ${modelId}`);
      throw new Error(`Provider not found for model: ${entry.providerId}`);
    }

    // Verify model exists in provider
    const model = provider.models?.find(m => m.modelKey === entry.modelKey);
    if (!model) {
      console.error(`[AgentConfig] Model not found in provider: ${entry.modelKey} in ${entry.providerId}`);
      throw new Error(`Model not found in provider: ${entry.modelKey}`);
    }

    // Update selectedModelId
    const oldModelId = this.currentConfig.selectedModelId;
    this.currentConfig.selectedModelId = modelId;

    console.log(`[AgentConfig] Model switched: ${oldModelId} → ${modelId} (${model.name} - ${provider.name})`);

    await this.storage.set(this.currentConfig);
    this.emitChangeEvent('model', oldModelId, modelId);
  }

  /**
   * Get current model configuration
   * Resolves selectedModelId through registry to find actual model config
   * @returns Model configuration for currently selected model
   * @example
   * const model = agentConfig.getModelConfig();
   * console.log(model.name); // "GPT-5"
   */
  getModelConfig(): IModelConfig {
    this.ensureInitialized();

    // Use selectedModelId system
    const modelData = this.getModelById(this.currentConfig.selectedModelId);
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
    const modelData = this.getModelById(this.currentConfig.selectedModelId);
    if (!modelData) {
      throw new Error('Cannot update model: selected model not found');
    }

    const provider = this.currentConfig.providers[modelData.provider.id];
    if (!provider || !provider.models) {
      throw new Error('Cannot update model: provider not found');
    }

    // Find and update the model in the provider's models array
    const modelIndex = provider.models.findIndex(m => m.id === this.currentConfig.selectedModelId);
    if (modelIndex === -1) {
      throw new Error('Cannot update model: model not found in provider');
    }

    provider.models[modelIndex] = newModel;

    this.storage.set(this.currentConfig).catch(err => {
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
   * T063: Add a new provider with automatic model ID assignment
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

    // Auto-assign model IDs for any models without IDs
    if (provider.models) {
      for (const model of provider.models) {
        if (!model.id || model.id === '') {
          model.id = this.generateModelId();
        }

        // Add to registry
        this.currentConfig.modelRegistry[model.id] = {
          providerId: provider.id,
          modelKey: model.modelKey
        };
      }
    }

    this.currentConfig.providers[provider.id] = provider;
    this.storage.set(this.currentConfig).catch(err => {
      console.error('Failed to persist config:', err);
    });

    this.emitChangeEvent('provider', null, provider);

    return provider;
  }

  /**
   * T064: Update a provider with automatic model ID assignment for new models
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

    // Auto-assign model IDs for any new models without IDs
    if (updated.models) {
      for (const model of updated.models) {
        if (!model.id || model.id === '') {
          model.id = this.generateModelId();
        }

        // Update registry
        this.currentConfig.modelRegistry[model.id] = {
          providerId: updated.id,
          modelKey: model.modelKey
        };
      }
    }

    const validation = validateProviderConfig(updated);
    if (!validation.valid) {
      throw new ConfigValidationError(
        validation.field || 'provider',
        validation.value,
        validation.error || 'Invalid provider configuration'
      );
    }

    this.currentConfig.providers[id] = updated;
    this.storage.set(this.currentConfig).catch(err => {
      console.error('Failed to persist config:', err);
    });

    this.emitChangeEvent('provider', existing, updated);

    return updated;
  }

  deleteProvider(id: string): void {
    this.ensureInitialized();

    // Check if provider hosts the currently selected model
    const selectedModelEntry = this.currentConfig.modelRegistry[this.currentConfig.selectedModelId];
    if (selectedModelEntry && selectedModelEntry.providerId === id) {
      throw new Error('Cannot delete provider that hosts the currently selected model');
    }

    const deleted = this.currentConfig.providers[id];
    delete this.currentConfig.providers[id];
    this.storage.set(this.currentConfig).catch(err => {
      console.error('Failed to persist config:', err);
    });

    this.emitChangeEvent('provider', deleted, null);
  }

  /**
   * Set API key for a specific provider
   * @param providerId - Provider identifier (e.g., 'openai', 'xai', 'anthropic', 'google-ai-studio')
   * @param apiKey - Unencrypted API key (will be encrypted before storage)
   * @returns Provider configuration with encrypted API key
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

    // Encrypt and store API key
    provider.apiKey = encryptApiKey(apiKey);
    this.currentConfig.providers[providerId] = provider;

    console.log(`[AgentConfig] API key set for provider: ${providerId} (${provider.name})`);

    await this.storage.set(this.currentConfig);
    this.emitChangeEvent('provider', null, provider);

    return provider;
  }

  /**
   * Get decrypted API key for a specific provider
   * @param providerId - Provider identifier (e.g., 'openai', 'xai', 'anthropic', 'google-ai-studio')
   * @returns Decrypted API key or null if not configured
   * @remarks Includes backward compatibility fallback to auth.apiKey
   * @example
   * const apiKey = await agentConfig.getProviderApiKey('openai');
   * if (apiKey) {
   *   // Use API key for requests
   * }
   */
  async getProviderApiKey(providerId: string): Promise<string | null> {
    this.ensureInitialized();

  // Use static import for encryption utilities

    // Check provider-specific key first
    const provider = this.currentConfig.providers[providerId];
    if (provider?.apiKey) {
      return decryptApiKey(provider.apiKey);
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

    // Clear the API key
    provider.apiKey = '';
    this.currentConfig.providers[providerId] = provider;

    console.log(`[AgentConfig] API key deleted for provider: ${providerId} (${provider.name})`);

    await this.storage.set(this.currentConfig);
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
   * Generate a unique 6-digit model ID using random generation
   * @returns Random 6-digit numeric string (e.g., "847291", "103847")
   * @example
   * const modelId = agentConfig.generateModelId();
   * console.log(modelId); // "847291"
   */
  generateModelId(): string {
    this.ensureInitialized();

    // Generate random 6-digit ID that doesn't conflict with existing IDs
    const newId = this.generateRandomModelId();

    // Persist the config (registry has been updated)
    this.storage.set(this.currentConfig).catch(err => {
      console.error('Failed to persist config after ID generation:', err);
    });

    return newId;
  }

  /**
   * Get model by ID
   * Resolves model ID through registry to find actual model config
   * @param modelId - Model ID to lookup
   * @returns Model config with provider context, or null if not found
   * @example
   * const result = agentConfig.getModelById('000001');
   * if (result) {
   *   console.log(result.model.name); // "GPT-5"
   *   console.log(result.provider.name); // "OpenAI"
   * }
   */
  getModelById(modelId: string): { model: IModelConfig; provider: IProviderConfig } | null {
    this.ensureInitialized();

    const entry = this.currentConfig.modelRegistry[modelId];
    if (!entry) return null;

    const provider = this.currentConfig.providers[entry.providerId];
    if (!provider) return null;

    const model = provider.models?.find(m => m.modelKey === entry.modelKey);
    if (!model) return null;

    return { model, provider };
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
    this.storage.set(this.currentConfig).catch(err => {
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
    this.storage.set(this.currentConfig).catch(err => {
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
    this.storage.set(this.currentConfig).catch(err => {
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

    this.storage.set(this.currentConfig).catch(err => {
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
    this.storage.set(this.currentConfig).catch(err => {
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
    this.storage.set(this.currentConfig).catch(err => {
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
    this.storage.set(this.currentConfig).catch(err => {
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
    this.storage.set(this.currentConfig).catch(err => {
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

    this.storage.set(this.currentConfig).catch(err => {
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
