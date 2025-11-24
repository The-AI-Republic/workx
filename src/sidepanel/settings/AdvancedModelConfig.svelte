<!--
  AdvancedModelConfig - Svelte component for advanced model and provider configuration
  Exposes IModelConfig and IProviderConfig fields for detailed configuration
-->

<script lang="ts">
  import { createEventDispatcher, onMount } from 'svelte';
  import type { AgentConfig } from '../../config/AgentConfig';
  import type { IModelConfig, IProviderConfig, IRetryConfig } from '../../config/types';

  export let settingsConfig: AgentConfig | null;
  export let modelId: string;
  export let providerId: string;

  const dispatch = createEventDispatcher<{
    back: void;
    saved: { success: boolean; error?: string };
  }>();

  export let isDirty = false;

  // State
  let isLoading = true;
  let isSaving = false;
  let saveMessage = '';
  let saveMessageType: 'success' | 'error' | '' = '';

  // Model config fields (from IModelConfig)
  let modelName = '';
  let modelKey = '';
  let creator = '';
  let contextWindow = 0;
  let maxOutputTokens = 0;
  let supportsReasoning = false;
  let reasoningEfforts: string[] = [];
  let supportsReasoningSummaries = false;
  let supportsVerbosity = false;
  let verbosityLevels: string[] = [];
  let supportsImage = true;
  let releaseDate: string | null = null;
  let deprecated = false;
  let deprecationMessage: string | null = null;
  let serviceTier: 'default' | 'flex' | 'priority' | undefined;
  let pricingInputToken = '';
  let pricingOutputToken = '';
  let pricingLink = '';

  // Provider config fields (from IProviderConfig)
  let providerName = '';
  let organization: string | null = null;
  let baseUrl: string | null = null;
  let version: string | null = null;
  let timeout = 60000;
  let retryMaxRetries = 3;
  let retryInitialDelay = 1000;
  let retryMaxDelay = 30000;
  let retryBackoffMultiplier = 2;

  // Original values for dirty checking
  let originalModel: Partial<IModelConfig> = {};
  let originalProvider: Partial<IProviderConfig> = {};

  onMount(async () => {
    await loadConfig();
  });

  async function loadConfig() {
    if (!settingsConfig) {
      isLoading = false;
      return;
    }

    try {
      isLoading = true;

      // Load model config
      const modelData = settingsConfig.getModelById(modelId);
      if (modelData?.model) {
        const model = modelData.model;
        modelName = model.name || '';
        modelKey = model.modelKey || '';
        creator = model.creator || '';
        contextWindow = model.contextWindow || 0;
        maxOutputTokens = model.maxOutputTokens || 0;
        supportsReasoning = model.supportsReasoning || false;
        reasoningEfforts = model.reasoningEfforts || [];
        supportsReasoningSummaries = model.supportsReasoningSummaries || false;
        supportsVerbosity = model.supportsVerbosity || false;
        verbosityLevels = model.verbosityLevels || [];
        supportsImage = model.supportsImage !== false;
        releaseDate = model.releaseDate || null;
        deprecated = model.deprecated || false;
        deprecationMessage = model.deprecationMessage || null;
        serviceTier = model.serviceTier;
        pricingInputToken = model.pricing?.inputToken || '';
        pricingOutputToken = model.pricing?.outputToken || '';
        pricingLink = model.pricing?.link || '';

        originalModel = { ...model };
      }

      // Load provider config
      const provider = settingsConfig.getProvider(providerId);
      if (provider) {
        providerName = provider.name || '';
        organization = provider.organization || null;
        baseUrl = provider.baseUrl || null;
        version = provider.version || null;
        timeout = provider.timeout || 60000;

        if (provider.retryConfig) {
          retryMaxRetries = provider.retryConfig.maxRetries ?? 3;
          retryInitialDelay = provider.retryConfig.initialDelay ?? 1000;
          retryMaxDelay = provider.retryConfig.maxDelay ?? 30000;
          retryBackoffMultiplier = provider.retryConfig.backoffMultiplier ?? 2;
        }

        originalProvider = { ...provider };
      }
    } catch (error) {
      console.error('[AdvancedModelConfig] Failed to load config:', error);
      showMessage('Failed to load configuration', 'error');
    } finally {
      isLoading = false;
    }
  }

  function handleInput() {
    isDirty = true;
  }

  function handleBack() {
    dispatch('back');
  }

  async function handleSave() {
    if (!settingsConfig || !isDirty) return;

    try {
      isSaving = true;

      // Build updated model config
      const updatedModel: Partial<IModelConfig> = {
        name: modelName,
        modelKey: modelKey,
        creator: creator,
        contextWindow: contextWindow,
        maxOutputTokens: maxOutputTokens,
        supportsReasoning: supportsReasoning,
        reasoningEfforts: reasoningEfforts.length > 0 ? reasoningEfforts : undefined,
        supportsReasoningSummaries: supportsReasoningSummaries || undefined,
        supportsVerbosity: supportsVerbosity || undefined,
        verbosityLevels: verbosityLevels.length > 0 ? verbosityLevels : undefined,
        supportsImage: supportsImage,
        releaseDate: releaseDate || undefined,
        deprecated: deprecated || undefined,
        deprecationMessage: deprecationMessage || undefined,
        serviceTier: serviceTier
      };

      // Add pricing if any field is set
      if (pricingInputToken || pricingOutputToken || pricingLink) {
        updatedModel.pricing = {
          inputToken: pricingInputToken,
          outputToken: pricingOutputToken,
          link: pricingLink
        };
      }

      // Build updated provider config
      const retryConfig: IRetryConfig = {
        maxRetries: retryMaxRetries,
        initialDelay: retryInitialDelay,
        maxDelay: retryMaxDelay,
        backoffMultiplier: retryBackoffMultiplier
      };

      const updatedProvider: Partial<IProviderConfig> = {
        name: providerName,
        organization: organization || undefined,
        baseUrl: baseUrl || undefined,
        version: version || undefined,
        timeout: timeout,
        retryConfig: retryConfig
      };

      // Update provider (which includes model updates)
      const provider = settingsConfig.getProvider(providerId);
      if (provider) {
        // Update model in provider's models array
        const modelIndex = provider.models.findIndex(m => m.id === modelId);
        if (modelIndex !== -1) {
          provider.models[modelIndex] = {
            ...provider.models[modelIndex],
            ...updatedModel
          };
        }

        // Update provider with new values
        await settingsConfig.updateProvider(providerId, {
          ...updatedProvider,
          models: provider.models
        });
      }

      // Notify service worker
      chrome.runtime.sendMessage({ type: 'CONFIG_UPDATE' }).catch(() => {});

      isDirty = false;
      showMessage('Configuration saved successfully', 'success');
      dispatch('saved', { success: true });
    } catch (error) {
      console.error('[AdvancedModelConfig] Failed to save config:', error);
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      showMessage(`Failed to save: ${errorMsg}`, 'error');
      dispatch('saved', { success: false, error: errorMsg });
    } finally {
      isSaving = false;
    }
  }

  function showMessage(message: string, type: 'success' | 'error') {
    saveMessage = message;
    saveMessageType = type;
    setTimeout(() => {
      saveMessage = '';
      saveMessageType = '';
    }, 3000);
  }

  function handleReasoningEffortsInput(event: Event) {
    const target = event.target as HTMLInputElement;
    reasoningEfforts = target.value.split(',').map(s => s.trim()).filter(s => s.length > 0);
    handleInput();
  }

  function handleVerbosityLevelsInput(event: Event) {
    const target = event.target as HTMLInputElement;
    verbosityLevels = target.value.split(',').map(s => s.trim()).filter(s => s.length > 0);
    handleInput();
  }
</script>

<div class="advanced-config">
  <button class="back-button" on:click={handleBack}>← Back to Model Config</button>

  <h2 class="config-title">Advanced Configuration</h2>

  {#if isLoading}
    <div class="loading">Loading configuration...</div>
  {:else}
    <div class="config-form">
      <!-- Model Configuration Section -->
      <div class="config-section">
        <h3 class="section-title">Model Configuration</h3>
        <p class="section-description warning">Warning: Changing these settings may impact model performance and behavior. Only modify if you understand the implications.</p>

        <div class="form-row">
          <div class="form-group">
            <label for="model-name" class="form-label">Model Name</label>
            <input
              id="model-name"
              type="text"
              bind:value={modelName}
              on:input={handleInput}
              class="form-input"
              placeholder="e.g., GPT-4 Turbo"
            />
            <div class="help-text">Human-readable display name</div>
          </div>

          <div class="form-group">
            <label for="model-key" class="form-label">Model Key (API)</label>
            <input
              id="model-key"
              type="text"
              bind:value={modelKey}
              on:input={handleInput}
              class="form-input"
              placeholder="e.g., gpt-4-turbo"
            />
            <div class="help-text">Internal API identifier</div>
          </div>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label for="creator" class="form-label">Creator</label>
            <input
              id="creator"
              type="text"
              bind:value={creator}
              on:input={handleInput}
              class="form-input"
              placeholder="e.g., OpenAI"
            />
            <div class="help-text">Company that developed/trained the model</div>
          </div>

          <div class="form-group">
            <label for="release-date" class="form-label">Release Date</label>
            <input
              id="release-date"
              type="date"
              bind:value={releaseDate}
              on:input={handleInput}
              class="form-input"
            />
            <div class="help-text">Model release date (optional)</div>
          </div>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label for="context-window" class="form-label">Context Window (tokens)</label>
            <input
              id="context-window"
              type="number"
              bind:value={contextWindow}
              on:input={handleInput}
              class="form-input"
              min="0"
            />
            <div class="help-text">Maximum tokens in a single request</div>
          </div>

          <div class="form-group">
            <label for="max-output" class="form-label">Max Output Tokens</label>
            <input
              id="max-output"
              type="number"
              bind:value={maxOutputTokens}
              on:input={handleInput}
              class="form-input"
              min="0"
            />
            <div class="help-text">Maximum tokens per response</div>
          </div>
        </div>

        <!-- Capabilities -->
        <div class="capabilities-section">
          <h4 class="subsection-title">Capabilities</h4>
          <div class="checkbox-grid">
            <label class="checkbox-label">
              <input
                type="checkbox"
                bind:checked={supportsImage}
                on:change={handleInput}
                class="form-checkbox"
              />
              <span>Supports Image Input</span>
            </label>

            <label class="checkbox-label">
              <input
                type="checkbox"
                bind:checked={supportsReasoning}
                on:change={handleInput}
                class="form-checkbox"
              />
              <span>Supports Reasoning</span>
            </label>

            <label class="checkbox-label">
              <input
                type="checkbox"
                bind:checked={supportsReasoningSummaries}
                on:change={handleInput}
                class="form-checkbox"
              />
              <span>Supports Reasoning Summaries</span>
            </label>

            <label class="checkbox-label">
              <input
                type="checkbox"
                bind:checked={supportsVerbosity}
                on:change={handleInput}
                class="form-checkbox"
              />
              <span>Supports Verbosity Control</span>
            </label>

            <label class="checkbox-label">
              <input
                type="checkbox"
                bind:checked={deprecated}
                on:change={handleInput}
                class="form-checkbox"
              />
              <span>Deprecated</span>
            </label>
          </div>
        </div>

        {#if supportsReasoning}
          <div class="form-group">
            <label for="reasoning-efforts" class="form-label">Reasoning Efforts</label>
            <input
              id="reasoning-efforts"
              type="text"
              value={reasoningEfforts.join(', ')}
              on:input={handleReasoningEffortsInput}
              class="form-input"
              placeholder="low, medium, high"
            />
            <div class="help-text">Comma-separated list of reasoning effort levels</div>
          </div>
        {/if}

        {#if supportsVerbosity}
          <div class="form-group">
            <label for="verbosity-levels" class="form-label">Verbosity Levels</label>
            <input
              id="verbosity-levels"
              type="text"
              value={verbosityLevels.join(', ')}
              on:input={handleVerbosityLevelsInput}
              class="form-input"
              placeholder="concise, normal, verbose"
            />
            <div class="help-text">Comma-separated list of verbosity levels</div>
          </div>
        {/if}

        {#if deprecated}
          <div class="form-group">
            <label for="deprecation-message" class="form-label">Deprecation Message</label>
            <input
              id="deprecation-message"
              type="text"
              bind:value={deprecationMessage}
              on:input={handleInput}
              class="form-input"
              placeholder="This model will be retired on..."
            />
            <div class="help-text">Custom message for deprecated models</div>
          </div>
        {/if}

        <!-- Service Tier (OpenAI specific) -->
        {#if providerId === 'openai'}
          <div class="form-group">
            <label for="service-tier" class="form-label">Service Tier</label>
            <select
              id="service-tier"
              bind:value={serviceTier}
              on:change={handleInput}
              class="form-select"
            >
              <option value={undefined}>Not set</option>
              <option value="default">Default</option>
              <option value="flex">Flex</option>
              <option value="priority">Priority</option>
            </select>
            <div class="help-text">OpenAI-specific service tier for API requests</div>
          </div>
        {/if}

        <!-- Pricing -->
        <div class="pricing-section">
          <h4 class="subsection-title">Pricing Information</h4>
          <div class="form-row">
            <div class="form-group">
              <label for="pricing-input" class="form-label">Input Token Price</label>
              <input
                id="pricing-input"
                type="text"
                bind:value={pricingInputToken}
                on:input={handleInput}
                class="form-input"
                placeholder="$0.01 / 1K tokens"
              />
            </div>

            <div class="form-group">
              <label for="pricing-output" class="form-label">Output Token Price</label>
              <input
                id="pricing-output"
                type="text"
                bind:value={pricingOutputToken}
                on:input={handleInput}
                class="form-input"
                placeholder="$0.03 / 1K tokens"
              />
            </div>
          </div>

          <div class="form-group">
            <label for="pricing-link" class="form-label">Pricing Page URL</label>
            <input
              id="pricing-link"
              type="url"
              bind:value={pricingLink}
              on:input={handleInput}
              class="form-input"
              placeholder="https://openai.com/pricing"
            />
            <div class="help-text">Link to official pricing documentation</div>
          </div>
        </div>
      </div>

      <!-- Provider Configuration Section -->
      <div class="config-section">
        <h3 class="section-title">Provider Configuration</h3>
        <p class="section-description">Configure provider-specific settings from IProviderConfig</p>

        <div class="form-row">
          <div class="form-group">
            <label for="provider-name" class="form-label">Provider Name</label>
            <input
              id="provider-name"
              type="text"
              bind:value={providerName}
              on:input={handleInput}
              class="form-input"
              placeholder="e.g., OpenAI"
            />
          </div>

          <div class="form-group">
            <label for="organization" class="form-label">Organization ID</label>
            <input
              id="organization"
              type="text"
              bind:value={organization}
              on:input={handleInput}
              class="form-input"
              placeholder="org-xxx (optional)"
            />
            <div class="help-text">For organizational billing</div>
          </div>
        </div>

        <div class="form-group">
          <label for="base-url" class="form-label">Base URL</label>
          <input
            id="base-url"
            type="url"
            bind:value={baseUrl}
            on:input={handleInput}
            class="form-input"
            placeholder="https://api.openai.com/v1"
          />
          <div class="help-text">API base URL override (leave empty for default)</div>
        </div>

        <div class="form-row">
          <div class="form-group">
            <label for="api-version" class="form-label">API Version</label>
            <input
              id="api-version"
              type="text"
              bind:value={version}
              on:input={handleInput}
              class="form-input"
              placeholder="e.g., 2023-06-01"
            />
            <div class="help-text">Provider-specific API version</div>
          </div>

          <div class="form-group">
            <label for="timeout" class="form-label">Timeout (ms)</label>
            <input
              id="timeout"
              type="number"
              bind:value={timeout}
              on:input={handleInput}
              class="form-input"
              min="1000"
              max="120000"
            />
            <div class="help-text">Request timeout (1000-120000 ms)</div>
          </div>
        </div>

        <!-- Retry Configuration -->
        <div class="retry-section">
          <h4 class="subsection-title">Retry Configuration</h4>
          <div class="form-row">
            <div class="form-group">
              <label for="retry-max" class="form-label">Max Retries</label>
              <input
                id="retry-max"
                type="number"
                bind:value={retryMaxRetries}
                on:input={handleInput}
                class="form-input"
                min="0"
                max="10"
              />
            </div>

            <div class="form-group">
              <label for="retry-initial" class="form-label">Initial Delay (ms)</label>
              <input
                id="retry-initial"
                type="number"
                bind:value={retryInitialDelay}
                on:input={handleInput}
                class="form-input"
                min="100"
              />
            </div>
          </div>

          <div class="form-row">
            <div class="form-group">
              <label for="retry-max-delay" class="form-label">Max Delay (ms)</label>
              <input
                id="retry-max-delay"
                type="number"
                bind:value={retryMaxDelay}
                on:input={handleInput}
                class="form-input"
                min="1000"
              />
            </div>

            <div class="form-group">
              <label for="retry-multiplier" class="form-label">Backoff Multiplier</label>
              <input
                id="retry-multiplier"
                type="number"
                bind:value={retryBackoffMultiplier}
                on:input={handleInput}
                class="form-input"
                min="1"
                step="0.5"
              />
            </div>
          </div>
        </div>
      </div>

      <!-- Save Button -->
      <div class="button-group">
        <button
          class="btn btn-primary"
          on:click={handleSave}
          disabled={!isDirty || isSaving}
        >
          {isSaving ? 'Saving...' : 'Save Configuration'}
        </button>
      </div>

      {#if saveMessage}
        <div class="message {saveMessageType}">
          {#if saveMessageType === 'success'}
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <polyline points="20,6 9,17 4,12"></polyline>
            </svg>
          {:else}
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="15" y1="9" x2="9" y2="15"></line>
              <line x1="9" y1="9" x2="15" y2="15"></line>
            </svg>
          {/if}
          {saveMessage}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .advanced-config {
    padding: 1.5rem;
  }

  .back-button {
    background: none;
    border: none;
    color: var(--browserx-primary);
    cursor: pointer;
    font-size: 0.9375rem;
    font-weight: 500;
    padding: 0.5rem 0;
    margin-bottom: 1rem;
    display: flex;
    align-items: center;
    gap: 0.25rem;
    transition: opacity 0.2s;
  }

  .back-button:hover {
    opacity: 0.8;
  }

  .config-title {
    margin: 0 0 1.5rem 0;
    font-size: 1.5rem;
    font-weight: 600;
    color: var(--browserx-text);
  }

  .loading {
    padding: 2rem;
    text-align: center;
    color: var(--browserx-text-secondary);
  }

  .config-form {
    max-width: 800px;
  }

  .config-section {
    margin-bottom: 2rem;
    padding: 1.5rem;
    background: var(--browserx-surface);
    border: 1px solid var(--browserx-border);
    border-radius: 0.5rem;
  }

  .section-title {
    margin: 0 0 0.5rem 0;
    font-size: 1.125rem;
    font-weight: 600;
    color: var(--browserx-text);
  }

  .section-description {
    margin: 0 0 1.5rem 0;
    font-size: 0.875rem;
    color: var(--browserx-text-secondary);
  }

  .section-description.warning {
    color: #f59e0b;
    background: color-mix(in srgb, #f59e0b 10%, transparent);
    padding: 0.75rem;
    border-radius: 0.375rem;
    border-left: 3px solid #f59e0b;
  }

  .subsection-title {
    margin: 1.5rem 0 1rem 0;
    font-size: 1rem;
    font-weight: 600;
    color: var(--browserx-text);
    padding-top: 1rem;
    border-top: 1px solid var(--browserx-border);
  }

  .form-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem;
  }

  @media (max-width: 600px) {
    .form-row {
      grid-template-columns: 1fr;
    }
  }

  .form-group {
    margin-bottom: 1rem;
  }

  .form-label {
    display: block;
    margin-bottom: 0.5rem;
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--browserx-text);
  }

  .form-input, .form-select {
    width: 100%;
    padding: 0.625rem;
    border: 1px solid var(--browserx-border);
    border-radius: 0.375rem;
    background: var(--browserx-background);
    color: var(--browserx-text);
    font-size: 0.875rem;
    transition: all 0.2s;
    box-sizing: border-box;
  }

  .form-input:focus, .form-select:focus {
    outline: none;
    border-color: var(--browserx-primary);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--browserx-primary) 10%, transparent);
  }

  .help-text {
    margin-top: 0.375rem;
    font-size: 0.75rem;
    color: var(--browserx-text-secondary);
  }

  .capabilities-section {
    margin-top: 1.5rem;
  }

  .checkbox-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 0.75rem;
  }

  .checkbox-label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
    font-size: 0.875rem;
    color: var(--browserx-text);
  }

  .form-checkbox {
    width: 16px;
    height: 16px;
    cursor: pointer;
    accent-color: var(--browserx-primary);
  }

  .pricing-section, .retry-section {
    margin-top: 1rem;
  }

  .button-group {
    margin-top: 2rem;
  }

  .btn {
    padding: 0.75rem 1.5rem;
    border-radius: 0.5rem;
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
    border: none;
  }

  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn-primary {
    background: var(--browserx-primary);
    color: white;
  }

  .btn-primary:hover:not(:disabled) {
    background: color-mix(in srgb, var(--browserx-primary) 90%, black);
  }

  .message {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.75rem;
    border-radius: 0.5rem;
    font-size: 0.875rem;
    margin-top: 1rem;
  }

  .message.success {
    color: var(--browserx-success);
    background: color-mix(in srgb, var(--browserx-success) 10%, transparent);
  }

  .message.error {
    color: var(--browserx-error);
    background: color-mix(in srgb, var(--browserx-error) 10%, transparent);
  }
</style>
