/**
 * Agent Configuration Type Definitions
 * Type definitions for the centralized config system
 */

import type { IApprovalConfig } from '../core/approval/types';
import type { AgentMode } from '../prompts/PromptComposer';
import type { HooksConfig } from '../core/hooks/types';
import type { ShortcutUserConfig } from '../core/shortcuts/types';

/**
 * Main centralized configuration interface for the agent (RUNTIME)
 *
 * This is the HYDRATED runtime configuration used throughout the application.
 * It contains the complete configuration including static provider/model metadata.
 *
 * Relationship with IStoredConfig:
 * - IStoredConfig: Minimal data persisted to ConfigStorageProvider (user-changeable only)
 * - IAgentConfig: Full runtime config = IStoredConfig + static metadata from default.json
 *
 * At startup, the config service:
 * 1. Loads IStoredConfig from storage (API keys, preferences, selected model)
 * 2. Loads static metadata from default.json (provider info, model definitions)
 * 3. Merges them to produce this IAgentConfig for runtime use
 *
 * @see IStoredConfig for the persistence format
 */
export interface IAgentConfig {
  version: string;

  /**
   * Currently selected model key
   * Format: "providerId:modelKey" (e.g., "openai:gpt-5.1", "xai:grok-4-1-fast-reasoning")
   * Uniquely identifies a model across all providers
   */
  selectedModelKey: string;

  /**
   * Model key for title generation (optional)
   * Format: "providerId:modelKey" (e.g., "openai:gpt-4o-mini")
   * If not specified, uses selectedModelKey
   * Recommended: Use a fast/cheap model for title generation
   */
  modelForTitleGenerate?: string;

  providers: Record<string, IProviderConfig>;
  profiles?: Record<string, IProfileConfig>;
  activeProfile?: string | null;
  preferences: IUserPreferences;
  cache: ICacheSettings;
  extension: IExtensionSettings;
  tools?: IToolsConfig;
  storage?: IStorageConfig;
  approval?: IApprovalConfig;
  hooks?: HooksConfig;

  /**
   * Track 20: runtime-only managed-policy marker. Populated by the policy
   * resolver post-merge. NOT persisted (absent from {@link IStoredConfig} and
   * {@link extractStoredConfig}). `lockedKeys` are namespace-relative agent
   * dot-paths the UI renders non-editable; `origin` identifies the source.
   */
  policy?: {
    lockedKeys: string[];
    origin: 'chrome-managed' | 'file' | 'remote' | 'env' | null;
  };

  /**
   * Track 10: per-plugin enable state. Keyed by `<name>@<marketplace>`.
   * Read by `PluginRegistry.bootstrapEnabledPlugins`; written on every
   * `/plugin enable|disable`. Absent → no plugins enabled.
   */
  enabledPlugins?: Record<string, boolean>;
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
   * Human-readable model name
   * Display name shown to users in Settings UI
   */
  name: string;

  /**
   * Internal API identifier
   * The exact model name/identifier used in API requests to the provider
   * Also serves as the unique identifier for this model within a provider
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
   * Whether model supports native web search (optional)
   * If true, the provider handles web search server-side (e.g., OpenAI web_search tool, Gemini grounding)
   * If false/undefined, falls back to CDP-based Google scraping
   */
  supportsWebSearch?: boolean;

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

  /**
   * Service tier for API requests (optional)
   * OpenAI-specific parameter for controlling service level
   * Supported values: 'default' | 'flex' | 'priority'
   * When omitted, the provider's default service tier is used
   */
  serviceTier?: 'default' | 'flex' | 'priority';

  /**
   * Backend mode routing support (optional)
   * Indicates which backend API endpoint to use when routing through the backend service
   * 0 or undefined = not supported (model only available in direct API mode)
   * 1 = OpenAI Responses API
   * 2 = OpenAI Chat Completions API
   * 3 = Google API (Google's native API format)
   * Default: 0 (must be explicitly enabled)
   */
  supportBackendMode?: number;

  /**
   * Track 12: fallback model key (optional).
   * When sustained provider overload (consecutive 529s) is detected, the
   * retry orchestrator downgrades to this model and retries. Must be a
   * composite key (`provider:modelKey`, e.g. `openai:gpt-5.1`) of a
   * generally-available model. Undefined ⇒ no downgrade (the run fails
   * after the retry budget instead).
   */
  fallbackModelKey?: string;
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
   * Active authentication method for this provider (optional)
   * When set, determines whether API key or ChatGPT OAuth is used
   */
  authMethod?: 'api_key' | 'chatgpt_oauth';

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
  /**
   * UI theme for the side panel
   * - 'terminal': Retro terminal-style UI with green text on black background
   * - 'modern-auto': Modern Chat UI, follows system light/dark preference
   * - 'modern-light': Modern Chat UI, always light
   * - 'modern-dark': Modern Chat UI, always dark
   */
  uiTheme?: 'terminal' | 'modern-auto' | 'modern-light' | 'modern-dark';
  /**
   * Whether to use own API key directly instead of backend routing
   * - When true: LLM requests go directly to provider APIs using user's API key
   * - When false: LLM requests route through AI Republic backend (requires login)
   * - Default: false for logged-in users, true (forced) for non-logged-in users
   */
  useOwnApiKey?: boolean;
  /**
   * Whether to show token usage information during task execution
   * - When true: Token consumption (input/output tokens) is displayed in task events
   * - When false: Token information is hidden from the UI
   * - Default: false (hidden by default)
   */
  showTokenUsage?: boolean;
  /**
   * Maximum number of concurrent agent sessions (Feature 015: Multi-Agent Instances)
   * - Controls how many parallel sessions can run simultaneously
   * - Includes primary user session and scheduled task sessions
   * - Default: 3, Range: 1-10
   */
  maxConcurrentSessions?: number;
  /**
   * Whether to auto-start the app on OS login (desktop only)
   * - When true: App registers itself to start on OS login
   * - When false: App does not start on OS login
   * - Default: false (opt-in; user enables via Settings > General)
   */
  autoStartEnabled?: boolean;
  /**
   * User's preferred language code (e.g., 'en', 'es', 'zh')
   */
  language?: string;
  /**
   * Default agent persona mode for NEW conversations (Apple Pi only).
   * - 'general': desktop automation agent (existing behavior)
   * - 'code': professional software engineering agent
   * This only seeds new sessions. The ACTIVE mode is per-session and changed
   * at runtime via SetSessionMode; it is not stored here. Ignored by browserx.
   * Default: 'general'.
   */
  defaultMode?: AgentMode;
  /**
   * Absolute path to the user-selected project directory ("workspace root")
   * for code mode (desktop only). All read/edit/write/grep/glob file tools
   * operate inside this directory and treat it as the security jail anchor.
   * Unset ⇒ code-mode file/search tools are disabled (never default to the
   * app's own cwd). Selected via a folder picker; persisted here.
   */
  workspaceRoot?: string;
  /**
   * Whether agent long-term memory is enabled (desktop/server only)
   * - When true: Agent remembers facts across conversations via file-based markdown storage
   *   in `~/.airepublic-pi/memory/`, with an LLM driving save/search/forget tool calls.
   * - When false: No memory persistence between conversations.
   * - Default: false (opt-in). Works with any LLM provider; uses gpt-4o-mini for low-cost
   *   keyword/relevance operations when an OpenAI key is available.
   */
  memoryEnabled?: boolean;
  /**
   * Routing for the cheap LLM used by memory keyword extraction and relevance ranking.
   * - When true: Memory LLM requests go directly to OpenAI using the user's own API key.
   * - When false: Memory LLM requests route through AI Republic backend (requires login + paid tier).
   * - Default: true (own key); set to false by UI for logged-in paid-tier users.
   */
  memoryUseOwnApiKey?: boolean;
  /**
   * LLM model used for memory keyword extraction, relevance ranking, and core-memory merges.
   * Defaults to gpt-4o-mini for low cost. Independent of the user's selected chat model.
   */
  extractionModel?: string;
  /**
   * Track 05b: automatic per-session summary extraction.
   * - When true: a background sub-agent distills the conversation into
   *   `~/.airepublic-pi/memory/sessions/<sessionId>/summary.md` and the
   *   compaction service folds it in.
   * - When false (default): feature disabled.
   *
   * Off-by-default until telemetry validates cost and quality on real
   * sessions; flip via Memory Settings once the feature gates open.
   */
  sessionSummaryEnabled?: boolean;
  zoomLevel?: number;
  shortcuts?: ShortcutUserConfig | Record<string, string>;
  experimental?: Record<string, boolean>;
  /**
   * Track 24.2: selected output-style persona name. Resolved against built-in
   * `src/prompts/styles/*.md` (and filesystem `.browserx/styles` on the
   * server). Unknown/unset → the prompt is composed unchanged.
   */
  personaName?: string;
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

  // Setting tool toggle (LLM settings access)
  setting_tool?: boolean;

  // Agent execution tool toggles
  execCommand?: boolean;
  webSearch?: boolean;
  /**
   * Whether to use native provider web search when the model supports it.
   * - When true (default): Uses provider-side web search for capable models,
   *   falls back to CDP-based Google scraping for models without native support
   * - When false: Forces CDP-based Google scraping for all models
   */
  useNativeWebSearch?: boolean;
  fileOperations?: boolean;
  mcpTools?: boolean;
  customTools?: Record<string, boolean>;

  /**
   * Allow the model to emit multiple tool calls in one response (Track 11).
   * When true, Track 02's orchestrator runs concurrency-safe calls in
   * parallel (bounded) and unsafe calls sequentially. Applies to all
   * OpenAI-compatible providers; Gemini already emits the parallel format
   * natively. Default false (conservative — preserves current behavior).
   */
  parallelToolCalls?: boolean;

  // Shared configuration metadata
  enabled?: string[];
  disabled?: string[];
  timeout?: number;
  sandboxPolicy?: IToolSandboxPolicy;
  perToolConfig?: Record<string, IToolSpecificConfig>;
}

/**
 * Minimal stored provider config (only user-changeable fields)
 * Static provider metadata (name, baseUrl, models, etc.) is loaded from default.json
 */
export interface IStoredProviderConfig {
  /** Provider identifier (e.g., 'openai', 'xai', 'google-ai-studio') */
  id: string;
  /** Encrypted API key */
  apiKey: string;
  /** Provider-specific organization ID (optional) */
  organization?: string | null;
  /** Active authentication method for this provider (optional) */
  authMethod?: 'api_key' | 'chatgpt_oauth';
}

/**
 * Minimal configuration stored in ConfigStorageProvider (PERSISTENCE)
 *
 * This is the SERIALIZATION format for persisting user configuration.
 * Only user-changeable data is stored; static model/provider metadata is NOT persisted.
 *
 * Relationship with IAgentConfig:
 * - IStoredConfig: What gets saved to storage (minimal, user data only)
 * - IAgentConfig: What the app uses at runtime (full, includes static metadata)
 *
 * Key differences from IAgentConfig:
 * - Uses `providerKeys` (just apiKey + org) instead of full `providers` with model metadata
 * - Static provider info (name, baseUrl, models, etc.) comes from default.json at runtime
 *
 * This separation ensures:
 * - Smaller storage footprint
 * - Model metadata updates via default.json don't require migration
 * - User secrets (API keys) are cleanly separated from static config
 *
 * @see IAgentConfig for the runtime format
 * @see IStoredProviderConfig for the minimal provider data stored
 */
export interface IStoredConfig {
  version: string;
  /** Currently selected model key (format: "providerId:modelKey") */
  selectedModelKey: string;
  /** Model key for title generation (optional, defaults to selectedModelKey) */
  modelForTitleGenerate?: string;
  /** Provider API keys and organization IDs only */
  providerKeys: Record<string, IStoredProviderConfig>;
  /** User preferences */
  preferences: IUserPreferences;
  /** Cache settings */
  cache: ICacheSettings;
  /** Extension settings */
  extension: IExtensionSettings;
  /** Profiles (user-created) */
  profiles?: Record<string, IProfileConfig>;
  /** Active profile name */
  activeProfile?: string | null;
  /** Tools configuration */
  tools?: IToolsConfig;
  /** Storage configuration */
  storage?: IStorageConfig;
  /** Approval system configuration */
  approval?: IApprovalConfig;
  /** Hook system configuration */
  hooks?: HooksConfig;
  /** Track 10: per-plugin enable state, keyed by `<name>@<marketplace>` */
  enabledPlugins?: Record<string, boolean>;
}

// Storage interfaces
export interface IConfigStorage {
  get(): Promise<IStoredConfig | null>;
  set(config: IStoredConfig): Promise<void>;
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
  section: 'model' | 'provider' | 'profile' | 'preferences' | 'cache' | 'extension' | 'security' | 'approval' | 'hooks' | 'policy' | 'enabledPlugins';
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
  /** Composite key: "providerId:modelKey" */
  compositeKey: string;
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
  providerId: string; // Provider ID for UI display
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
