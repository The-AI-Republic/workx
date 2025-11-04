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
  IToolSpecificConfig,
  IAuthConfig
} from './types';
import { ConfigValidationError } from './types';
import { ConfigStorage } from '../storage/ConfigStorage';
import {
  DEFAULT_AGENT_CONFIG,
  DEFAULT_AUTH_CONFIG,
  mergeWithDefaults,
  getDefaultProviders
} from './defaults';
import { validateConfig, validateModelConfig, validateProviderConfig, validateAuthConfig } from './validators';

export class AgentConfig implements IConfigService {
  private static instance: AgentConfig | null = null;
  private storage: ConfigStorage;
  private currentConfig: IAgentConfig;
  private eventHandlers: Map<string, Set<(e: IConfigChangeEvent) => void>>;
  private initialized: boolean = false;

  private constructor() {
    this.storage = new ConfigStorage();
    this.currentConfig = DEFAULT_AGENT_CONFIG;
    this.eventHandlers = new Map();
  }

  /**
   * Get the singleton instance of AgentConfig
   * @returns The singleton AgentConfig instance
   */
  public static getInstance(): AgentConfig {
    if (!AgentConfig.instance) {
      AgentConfig.instance = new AgentConfig();
    }
    return AgentConfig.instance;
  }

  /**
   * Initialize the config from storage (lazy initialization)
   * Called automatically on first config access
   */
  public async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      const storedConfig = await this.storage.get();

      if (storedConfig) {
        this.currentConfig = mergeWithDefaults(storedConfig);
      } else {
        // First time setup
        this.currentConfig = DEFAULT_AGENT_CONFIG;
        await this.storage.set(this.currentConfig);
      }
      this.initialized = true;
    } catch (error) {
      console.error('Failed to initialize config:', error);
      this.currentConfig = DEFAULT_AGENT_CONFIG;
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

      if (storedConfig) {
        this.currentConfig = mergeWithDefaults(storedConfig);
      } else {
        // No stored config, use defaults
        this.currentConfig = DEFAULT_AGENT_CONFIG;
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

    // Emit change events
    this.emitChangeEvent('model', oldConfig.model, newConfig.model);

    return { ...this.currentConfig };
  }

  resetConfig(preserveApiKeys?: boolean): IAgentConfig {
    this.ensureInitialized();

    let newConfig = DEFAULT_AGENT_CONFIG;

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
  getModelConfig(): IModelConfig {
    this.ensureInitialized();

    let modelConfig = { ...this.currentConfig.model };

    // Apply profile overrides if active
    if (this.currentConfig.activeProfile && this.currentConfig.profiles) {
      const profile = this.currentConfig.profiles[this.currentConfig.activeProfile];
      if (profile) {
        modelConfig = {
          ...modelConfig,
          selected: profile.model,
          provider: profile.provider,
          ...(profile.modelSettings || {})
        };
      }
    }

    return modelConfig;
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

    // Check provider exists
    if (newModel.provider && !this.currentConfig.providers[newModel.provider]) {
      throw new Error(`Provider not found: ${newModel.provider}`);
    }

    // Validate maxOutputTokens <= contextWindow
    if (newModel.maxOutputTokens && newModel.contextWindow &&
        newModel.maxOutputTokens > newModel.contextWindow) {
      throw new Error('maxOutputTokens cannot exceed contextWindow');
    }

    this.currentConfig.model = newModel;
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

  getProvider(id: string): IProviderConfig | null {
    this.ensureInitialized();
    return this.currentConfig.providers[id] || null;
  }

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
    this.storage.set(this.currentConfig).catch(err => {
      console.error('Failed to persist config:', err);
    });

    this.emitChangeEvent('provider', null, provider);

    return provider;
  }

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
    this.storage.set(this.currentConfig).catch(err => {
      console.error('Failed to persist config:', err);
    });

    this.emitChangeEvent('provider', existing, updated);

    return updated;
  }

  deleteProvider(id: string): void {
    this.ensureInitialized();

    // Check if provider is currently active
    if (this.currentConfig.model.provider === id) {
      throw new Error('Cannot delete active provider');
    }

    const deleted = this.currentConfig.providers[id];
    delete this.currentConfig.providers[id];
    this.storage.set(this.currentConfig).catch(err => {
      console.error('Failed to persist config:', err);
    });

    this.emitChangeEvent('provider', deleted, null);
  }

  // Authentication management
  /**
   * Get authentication configuration
   * @returns Current auth config or defaults if not set
   * @example
   * const authConfig = agentConfig.getAuthConfig();
   * if (authConfig.apiKey) {
   *   console.log('API key is configured');
   * }
   */
  getAuthConfig(): IAuthConfig {
    this.ensureInitialized();
    return this.currentConfig.auth || DEFAULT_AUTH_CONFIG;
  }

  /**
   * Update authentication configuration
   * @param config - Partial auth config to update
   * @returns Updated complete auth config
   * @throws {ConfigValidationError} If validation fails
   * @remarks Automatically sets lastUpdated timestamp and persists to storage
   * @example
   * // Update API key
   * agentConfig.updateAuthConfig({
   *   apiKey: encryptApiKey('sk-ant-api03-...'),
   *   authMode: AuthMode.ApiKey
   * });
   *
   * // Clear auth
   * agentConfig.updateAuthConfig({
   *   apiKey: '',
   *   accountId: null,
   *   planType: null
   * });
   */
  updateAuthConfig(config: Partial<IAuthConfig>): IAuthConfig {
    this.ensureInitialized();

    const oldAuth = this.getAuthConfig();
    const newAuth = {
      ...oldAuth,
      ...config,
      lastUpdated: Date.now()
    };

    const validation = validateAuthConfig(newAuth);
    if (!validation.valid) {
      throw new ConfigValidationError(
        validation.field || 'auth',
        validation.value,
        validation.error || 'Invalid auth configuration'
      );
    }

    this.currentConfig.auth = newAuth;
    this.storage.set(this.currentConfig).catch(err => {
      console.error('Failed to persist config:', err);
    });

    this.emitChangeEvent('auth' as any, oldAuth, newAuth);

    return newAuth;
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
    if (!tools.enabled.includes(toolName)) {
      tools.enabled.push(toolName);
    }
    tools.disabled = (tools.disabled || []).filter(name => name !== toolName);

    this.currentConfig.tools = tools as IToolsConfig;
    this.storage.set(this.currentConfig).catch(err => {
      console.error('Failed to persist config:', err);
    });
    this.emitChangeEvent('tools' as any, null, tools);
  }

  disableTool(toolName: string): void {
    this.ensureInitialized();

    const tools = this.currentConfig.tools || { enabled: [], disabled: [] };
    tools.enabled = tools.enabled.filter(name => name !== toolName);
    if (!tools.disabled) tools.disabled = [];
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