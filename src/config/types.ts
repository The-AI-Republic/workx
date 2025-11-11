/**
 * Agent Configuration Type Definitions
 * Type definitions for the centralized config system
 */

/**
 * Model registry entry for fast provider lookup
 *
 * Maps model ID to provider ID and model key for O(1) lookups.
 */
export interface IModelRegistryEntry {
  /**
   * ID of the provider hosting this model
   * MUST correspond to a key in IAgentConfig.providers
   */
  providerId: string;

  /**
   * Internal model identifier for API calls
   * Corresponds to IModelConfig.modelKey in the provider's models array
   */
  modelKey: string;
}

// Main centralized configuration interface for the agent
export interface IAgentConfig {
  version: string;

  /**
   * Currently selected model ID
   * The globally unique ID of the active model
   * MUST exist in modelRegistry
   */
  selectedModelId: string;

  /**
   * Model ID to provider/model lookup table
   * Fast O(1) lookup from model ID to provider and model key
   * Automatically maintained when providers/models are updated
   */
  modelRegistry: Record<string, IModelRegistryEntry>;

  providers: Record<string, IProviderConfig>;
  profiles?: Record<string, IProfileConfig>;
  activeProfile?: string | null;
  preferences: IUserPreferences;
  cache: ICacheSettings;
  extension: IExtensionSettings;
  tools?: IToolsConfig;
  storage?: IStorageConfig;
}

// Model pricing information
export interface IModelPrice {
  /**
   * Input token pricing
   * String format to support complex pricing (e.g., "$1 / 1M tokens < 200K, $2 / 1M tokens > 200K")
   */
  inputToken: string;

  /**
   * Output token pricing
   * String format to support complex pricing
   */
  outputToken: string;

  /**
   * Official pricing page URL
   * Link to the provider's official pricing documentation
   */
  link: string;
}

// Model configuration
export interface IModelConfig {
  /**
   * Globally unique model identifier
   * Sequential 6-digit zero-padded numeric string
   * Generated automatically when model is added to a provider
   * MUST be unique across ALL providers
   */
  id: string;

  /**
   * Human-readable model name
   * Display name shown to users in Settings UI
   */
  name: string;

  /**
   * Internal API identifier
   * The exact model name/identifier used in API requests to the provider
   */
  modelKey: string;

  /**
   * Model creator/developer
   * The company that developed/trained the model
   * DISTINCT from the provider hosting the model API
   */
  creator: string;

  /**
   * Maximum context window in tokens
   * Total number of tokens the model can process in a single request
   */
  contextWindow: number;

  /**
   * Maximum output tokens per request
   * Maximum number of tokens the model can generate in a single response
   */
  maxOutputTokens: number;

  /**
   * Pricing information (optional)
   * Contains input/output token pricing and link to official pricing page
   */
  pricing?: IModelPrice;

  /**
   * Whether model supports reasoning features
   * If true, the model can be configured with reasoning effort levels
   */
  supportsReasoning: boolean;

  /**
   * Supported reasoning effort levels (optional)
   * Array of valid effort level strings for this model
   */
  reasoningEfforts?: string[];

  /**
   * Whether model supports reasoning summaries (optional)
   * If true, the model can provide summaries of its reasoning process
   */
  supportsReasoningSummaries?: boolean;

  /**
   * Whether model supports verbosity control (optional)
   * If true, the model's output verbosity can be adjusted
   */
  supportsVerbosity?: boolean;

  /**
   * Supported verbosity levels (optional)
   * Array of valid verbosity level strings for this model
   */
  verbosityLevels?: string[];

  /**
   * Whether model supports image input (optional)
   * If true, the model can accept and process image inputs
   * If false, vision-related tools will be disabled
   */
  supportsImage?: boolean;

  /**
   * Model release date (optional)
   * ISO 8601 date string (YYYY-MM-DD) indicating when the model was released
   */
  releaseDate?: string | null;

  /**
   * Whether model is deprecated (optional)
   * If true, the model should show deprecation warnings in the UI
   */
  deprecated?: boolean;

  /**
   * User-facing deprecation message (optional)
   * Custom message to display when deprecated is true
   */
  deprecationMessage?: string | null;
}

// Provider configuration
export interface IProviderConfig {
  id: string;
  name: string;

  /**
   * Encrypted API key
   * Empty string indicates no API key configured
   */
  apiKey: string;

  /**
   * Provider-specific organization ID (optional)
   * Used by some providers (e.g., OpenAI) for organizational billing
   */
  organization?: string | null;

  /**
   * API base URL override (optional)
   * Custom base URL for API requests
   */
  baseUrl?: string | null;

  /**
   * API version string (optional)
   * Provider-specific API version identifier
   */
  version?: string | null;

  /**
   * Custom HTTP headers (optional)
   * Additional headers to include in all API requests
   */
  headers?: Record<string, string>;

  /**
   * Request timeout in milliseconds
   * MUST be between 1000ms (1s) and 120000ms (2min)
   */
  timeout: number;

  /**
   * Retry configuration (optional)
   * Defines retry behavior for failed API requests
   */
  retryConfig?: IRetryConfig;

  /**
   * Models hosted by this provider
   * Array of models available through this provider's API
   * MUST contain at least one model
   */
  models: IModelConfig[];
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

// Multi-provider validation result types
export interface IProviderValidationResult {
  isValid: boolean;
  detectedProvider: 'openai' | 'xai' | 'anthropic' | 'groq' | 'google-ai-studio' | 'unknown';
  warnings: string[];
  errors: string[];
}

export interface IProviderStatus {
  id: string;
  name: string;
  configured: boolean;
  active: boolean;
  lastUsed?: number;
  requestCount?: number;
}

// ============================================================================
// Legacy ModelRegistry type replacements
// Simplified types to replace ModelRegistry.ts imports
// ============================================================================

/**
 * Configured features for UI validation
 * Replaces ConfiguredFeatures from ModelRegistry.ts
 */
export interface ConfiguredFeatures {
  reasoningEffort?: string | null;
  reasoningSummary?: string;
  verbosity?: string | null;
  maxOutputTokens?: number | null;
  contextWindow?: number | null;
}

/**
 * Model metadata for UI display
 * Simplified version replacing ModelMetadata from ModelRegistry.ts
 */
export interface ModelMetadata {
  id: string;
  name: string;
  modelKey: string;
  creator: string;
  contextWindow: number;
  maxOutputTokens: number;
  supportsReasoning: boolean;
  reasoningEfforts?: string[];
  supportsReasoningSummaries?: boolean;
  supportsVerbosity?: boolean;
  verbosityLevels?: string[];
  releaseDate?: string | null;
  deprecated?: boolean;
  deprecationMessage?: string | null;
  provider: string; // Provider ID for UI display
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
