/**
 * Agent Configuration Type Definitions
 * Type definitions for the centralized config system
 */

import { AuthMode, PlanType } from '../models/types/Auth';

// Authentication configuration
export interface IAuthConfig {
  /**
   * Encrypted API key
   * Empty string indicates no API key configured
   */
  apiKey: string;

  /**
   * Authentication mode
   */
  authMode: AuthMode;

  /**
   * Optional account identifier
   */
  accountId?: string | null;

  /**
   * Optional plan type information
   */
  planType?: PlanType | null;

  /**
   * Timestamp of last configuration update in milliseconds
   * 0 indicates never updated
   */
  lastUpdated?: number;
}

// Main centralized configuration interface for the agent
export interface IAgentConfig {
  version: string;
  model: IModelConfig;
  providers: Record<string, IProviderConfig>;
  profiles?: Record<string, IProfileConfig>;
  activeProfile?: string | null;
  preferences: IUserPreferences;
  cache: ICacheSettings;
  extension: IExtensionSettings;
  tools?: IToolsConfig;
  storage?: IStorageConfig;
  auth?: IAuthConfig;
}

// Model configuration
export interface IModelConfig {
  selected: string;
  provider: string;
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
  autoCompactTokenLimit?: number | null;
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high' | null;
  reasoningSummary?: 'auto' | 'concise' | 'detailed' | 'none';
  verbosity?: 'low' | 'medium' | 'high' | null;
}

/**
 * Configuration for rate limit pause behavior
 */
export interface IRateLimitPauseConfig {
  /**
   * Enable/disable pause-instead-of-retry for rate limits
   * @default true
   */
  enabled: boolean;

  /**
   * Default pause duration in milliseconds when no Retry-After header present
   * @default 60000 (60 seconds)
   * @minimum 1000 (1 second)
   * @maximum maxDuration
   */
  defaultDuration: number;

  /**
   * Maximum allowed pause duration in milliseconds (safety cap)
   * @default 300000 (5 minutes)
   * @minimum 1000 (1 second)
   * @maximum 600000 (10 minutes)
   */
  maxDuration: number;

  /**
   * Use Retry-After header from API response if present
   * @default true
   */
  useRetryAfterHeader: boolean;
}

// Provider configuration
export interface IProviderConfig {
  id: string;
  name: string;
  apiKey: string;
  baseUrl?: string | null;
  organization?: string | null;
  version?: string | null;
  headers?: Record<string, string>;
  timeout: number;
  retryConfig?: IRetryConfig;
  rateLimitPause?: IRateLimitPauseConfig;
}

// Profile configuration
export interface IProfileConfig {
  name: string;
  description?: string | null;
  model: string;
  provider: string;
  modelSettings?: Partial<IModelConfig>;
  created: number;
  lastUsed?: number | null;
}

// Remaining interfaces
export interface IUserPreferences {
  autoSync?: boolean;
  telemetryEnabled?: boolean;
  theme?: 'light' | 'dark' | 'system';
  shortcuts?: Record<string, string>;
  experimental?: Record<string, boolean>;
}

export interface ICacheSettings {
  enabled?: boolean;
  ttl?: number;
  maxSize?: number;
  compressionEnabled?: boolean;
  persistToStorage?: boolean;
}

export interface IStorageConfig {
  /**
   * Time-to-live for rollouts in days.
   * - number: Rollouts expire after this many days (e.g., 60)
   * - 'permanent': Rollouts never expire
   * - undefined: Use default (60 days)
   */
  rolloutTTL?: number | 'permanent';
}

export interface IExtensionSettings {
  enabled?: boolean;
  contentScriptEnabled?: boolean;
  allowedOrigins?: string[];
  storageQuotaWarning?: number;
  updateChannel?: 'stable' | 'beta';
  permissions?: IPermissionSettings;
}

export interface IPermissionSettings {
  tabs?: boolean;
  storage?: boolean;
  notifications?: boolean;
  clipboardRead?: boolean;
  clipboardWrite?: boolean;
}

export interface IRetryConfig {
  maxRetries?: number;
  initialDelay?: number;
  maxDelay?: number;
  backoffMultiplier?: number;
}

// Tool configuration helpers
export interface IToolSandboxPolicy {
  mode: 'read-only' | 'workspace-write' | 'danger-full-access';
  writable_roots?: string[];
  network_access?: boolean;
}

export interface IToolSpecificConfig {
  enabled?: boolean;
  timeout?: number;
  maxRetries?: number;
  options?: Record<string, unknown>;
}

// Tool configuration
export interface IToolsConfig {
  // Browser tool toggles
  enable_all_tools?: boolean;
  storage_tool?: boolean;
  tab_tool?: boolean;
  web_scraping_tool?: boolean;
  dom_tool?: boolean;
  form_automation_tool?: boolean;
  navigation_tool?: boolean;
  network_intercept_tool?: boolean;
  data_extraction_tool?: boolean;
  page_action_tool?: boolean;
  page_vision_tool?: boolean;

  // Agent execution tool toggles
  execCommand?: boolean;
  webSearch?: boolean;
  fileOperations?: boolean;
  mcpTools?: boolean;
  customTools?: Record<string, boolean>;

  // Shared configuration metadata
  enabled?: string[];
  disabled?: string[];
  timeout?: number;
  sandboxPolicy?: IToolSandboxPolicy;
  perToolConfig?: Record<string, IToolSpecificConfig>;
}

// Storage interfaces
export interface IConfigStorage {
  get(): Promise<IAgentConfig | null>;
  set(config: IAgentConfig): Promise<void>;
  clear(): Promise<void>;
  getStorageInfo(): Promise<IStorageInfo>;
}

export interface IStorageInfo {
  used: number;
  quota: number;
  percentUsed: number;
}

// Service interfaces
export interface IConfigService {
  // Core operations
  getConfig(): IAgentConfig;
  updateConfig(config: Partial<IAgentConfig>): IAgentConfig;
  resetConfig(preserveApiKeys?: boolean): IAgentConfig;

  // Model operations
  getModelConfig(): IModelConfig;
  updateModelConfig(config: Partial<IModelConfig>): IModelConfig;

  // Provider operations
  getProviders(): Record<string, IProviderConfig>;
  getProvider(id: string): IProviderConfig | null;
  addProvider(provider: IProviderConfig): IProviderConfig;
  updateProvider(id: string, provider: Partial<IProviderConfig>): IProviderConfig;
  deleteProvider(id: string): void;

  // Profile operations
  getProfiles(): Record<string, IProfileConfig>;
  getProfile(name: string): IProfileConfig | null;
  createProfile(profile: IProfileConfig): IProfileConfig;
  updateProfile(name: string, profile: Partial<IProfileConfig>): IProfileConfig;
  deleteProfile(name: string): void;
  activateProfile(name: string): void;

  // Import/Export
  exportConfig(includeApiKeys?: boolean): IExportData;
  importConfig(data: IExportData): IAgentConfig;
}

// Export/Import data structure
export interface IExportData {
  version: string;
  exportDate: number;
  config: IAgentConfig;
}

// Event interfaces for config changes
export interface IConfigChangeEvent {
  type: 'config-changed';
  section: 'model' | 'provider' | 'profile' | 'preferences' | 'cache' | 'extension' | 'security';
  oldValue?: any;
  newValue: any;
  timestamp: number;
}

export interface IConfigEventEmitter {
  on(event: 'config-changed', handler: (e: IConfigChangeEvent) => void): void;
  off(event: 'config-changed', handler: (e: IConfigChangeEvent) => void): void;
  emit(event: 'config-changed', data: IConfigChangeEvent): void;
}

// Factory interface
export interface IConfigFactory {
  createDefault(): IAgentConfig;
  createFromStorage(data: any): IAgentConfig;
  validateConfig(config: any): config is IAgentConfig;
}

// Error types
export class ConfigValidationError extends Error {
  constructor(
    public field: string,
    public value: any,
    message: string
  ) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}

export class ConfigStorageError extends Error {
  constructor(
    public operation: 'read' | 'write' | 'delete',
    message: string
  ) {
    super(message);
    this.name = 'ConfigStorageError';
  }
}
