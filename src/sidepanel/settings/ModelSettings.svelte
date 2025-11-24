<!--
  ModelSettings - Svelte component for model configuration
  Handles model selection, API key configuration, and provider settings
-->

<script lang="ts">
  import { createEventDispatcher, onMount } from 'svelte';
  import type { AgentConfig } from '../../config/AgentConfig';
  import type { ConfiguredFeatures } from '../../config/types';
  import { AuthMode } from '../../models/types/index.js';
  import ModelSelector from './components/ModelSelector.svelte';

  export let settingsConfig: AgentConfig | null;

  const dispatch = createEventDispatcher<{
    back: void;
    saved: { success: boolean; error?: string };
    authUpdated: { isAuthenticated: boolean; mode: AuthMode | null };
    navigateToAdvanced: { modelId: string; providerId: string };
  }>();

  // Exported for parent to bind
  export let isDirty = false;

  // Component state
  let apiKey = '';
  let maskedApiKey = '';
  let showApiKey = false;
  let isInitializing = true;
  let isSaving = false;
  let isTesting = false;
  let isModelSwitching = false;
  let isClearingAuth = false;
  let saveMessage = '';
  let saveMessageType: 'success' | 'error' | 'info' | '' = '';
  let testResult: { valid: boolean; error?: string } | null = null;
  let isAuthenticated = false;

  // Model configuration state
  let selectedModelId = '';
  let configuredFeatures: ConfiguredFeatures = {};
  let modelValidationError = '';
  let serviceTier: 'default' | 'flex' | 'priority' | undefined;

  // Provider-aware API key display
  let currentProvider = 'openai';
  let currentProviderName = 'OpenAI';
  let currentProviderOrganization: string | null = null;

  // Model selection array
  interface ModelSelectionItem {
    modelId: string;
    modelName: string;
    modelKey: string;
    providerId: string;
    providerName: string;
    organization: string | null;
    apiKey: string | null;
    contextWindow: number;
    maxOutputTokens: number;
    baseUrl: string;
    supportsImage: boolean;
    selected: boolean;
    serviceTier?: 'default' | 'flex' | 'priority';
    supportsReasoning?: boolean;
    reasoningEfforts?: string[];
    pricing?: {
      inputToken: string;
      outputToken: string;
      link: string;
    };
  }
  let modelSelectionItems: ModelSelectionItem[] = [];

  onMount(async () => {
    await loadSettings();
  });

  /**
   * Load settings from AgentConfig
   */
  async function loadSettings() {
    if (!settingsConfig) {
      isInitializing = false;
      return;
    }

    try {
      isInitializing = true;

      const config = settingsConfig.getConfig();
      selectedModelId = config.selectedModelId;

      // Build model selection array
      const tempModelItems: ModelSelectionItem[] = [];
      const providers = settingsConfig.getProviders();

      for (const [providerId, provider] of Object.entries(providers)) {
        if (!provider.models || !Array.isArray(provider.models)) {
          continue;
        }

        const providerApiKey = await settingsConfig.getProviderApiKey(providerId);

        for (const model of provider.models) {
          let modelServiceTier = model.serviceTier;
          if (providerId === 'openai' && !modelServiceTier) {
            modelServiceTier = 'default';
          }

          tempModelItems.push({
            modelId: model.id,
            modelName: model.name,
            modelKey: model.modelKey,
            providerId: provider.id,
            providerName: provider.name,
            organization: provider.organization || null,
            apiKey: providerApiKey,
            contextWindow: model.contextWindow,
            maxOutputTokens: model.maxOutputTokens,
            baseUrl: provider.baseUrl || '',
            supportsImage: model.supportsImage !== false,
            selected: model.id === selectedModelId,
            serviceTier: modelServiceTier,
            supportsReasoning: model.supportsReasoning,
            reasoningEfforts: model.reasoningEfforts,
            pricing: model.pricing
          });
        }
      }

      modelSelectionItems = tempModelItems;

      // Validate selectedModelId
      if (!selectedModelId || selectedModelId === '') {
        if (modelSelectionItems.length > 0) {
          selectedModelId = modelSelectionItems[0].modelId;
          await settingsConfig.setSelectedModel(selectedModelId);
        } else {
          showMessage('No models available. Please check configuration.', 'error');
          return;
        }
      }

      // Load data for selected model
      const selectedItem = modelSelectionItems.find(item => item.modelId === selectedModelId);
      if (selectedItem) {
        loadModelData(selectedItem);
      } else if (modelSelectionItems.length > 0) {
        selectedModelId = modelSelectionItems[0].modelId;
        await settingsConfig.setSelectedModel(selectedModelId);
        loadModelData(modelSelectionItems[0]);
      }
    } catch (error) {
      console.error('[ModelSettings] Failed to load settings:', error);
      showMessage('Failed to load settings', 'error');
    } finally {
      isInitializing = false;
    }
  }

  function loadModelData(item: ModelSelectionItem) {
    currentProvider = item.providerId;
    currentProviderName = item.providerName;
    currentProviderOrganization = item.organization;
    apiKey = item.apiKey || '';
    maskedApiKey = apiKey ? maskApiKey(apiKey) : '';
    isAuthenticated = !!item.apiKey;
    serviceTier = item.serviceTier;

    const defaultReasoningEffort = item.supportsReasoning && item.reasoningEfforts?.length
      ? 'medium'
      : null;

    configuredFeatures = {
      reasoningEffort: defaultReasoningEffort,
      reasoningSummary: undefined,
      verbosity: null,
      contextWindow: item.contextWindow,
      maxOutputTokens: item.maxOutputTokens
    };
  }

  function maskApiKey(key: string): string {
    if (!key || key.length < 6) return key;
    return `${key.substring(0, 6)}***`;
  }

  function handleApiKeyInput(event: Event) {
    const target = event.target as HTMLInputElement;
    apiKey = target.value;
    maskedApiKey = maskApiKey(apiKey);
    clearMessage();
    testResult = null;
  }

  function toggleApiKeyVisibility() {
    showApiKey = !showApiKey;
  }

  async function saveApiKey() {
    if (isSaving || !apiKey.trim() || !settingsConfig) return;

    try {
      isSaving = true;
      await settingsConfig.setProviderApiKey(currentProvider, apiKey);

      isAuthenticated = true;
      maskedApiKey = maskApiKey(apiKey);

      for (let i = 0; i < modelSelectionItems.length; i++) {
        if (modelSelectionItems[i].providerId === currentProvider) {
          modelSelectionItems[i].apiKey = apiKey;
        }
      }

      showMessage('API key saved successfully!', 'success');

      chrome.runtime.sendMessage({ type: 'CONFIG_UPDATE' }).catch(() => {});

      dispatch('authUpdated', { isAuthenticated: true, mode: AuthMode.ApiKey });
    } catch (error) {
      console.error('[ModelSettings] Failed to save API key:', error);
      showMessage('Failed to save API key', 'error');
    } finally {
      isSaving = false;
    }
  }

  async function testConnection() {
    if (!apiKey.trim()) {
      showMessage('Please enter an API key first', 'error');
      return;
    }

    try {
      isTesting = true;
      testResult = null;

      const selectedItem = modelSelectionItems.find(item => item.modelId === selectedModelId);
      if (!selectedItem) {
        testResult = { valid: false, error: 'Selected model configuration missing' };
        showMessage('Connection failed: selected model configuration missing', 'error');
        return;
      }

      const providerId = selectedItem.providerId;
      const modelKey = selectedItem.modelKey ?? selectedItem.modelId;
      const baseUrl = selectedItem.baseUrl;
      const organization = selectedItem.organization;

      if (!baseUrl) {
        testResult = { valid: false, error: 'Base URL not configured for this provider' };
        showMessage('Connection failed: Base URL not configured', 'error');
        return;
      }

      if (providerId === 'anthropic') {
        await testAnthropicConnection(baseUrl, modelKey);
      } else {
        await testOpenAICompatibleConnection(baseUrl, modelKey, organization);
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Network error';
      testResult = { valid: false, error: errorMsg };
      showMessage('Failed to test connection', 'error');
    } finally {
      isTesting = false;
    }
  }

  async function testAnthropicConnection(baseUrl: string, modelKey: string) {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    };

    const response = await fetch(baseUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: modelKey,
        max_tokens: 1,
        messages: [{ role: 'user', content: 'test' }]
      })
    });

    if (response.ok || response.status === 400) {
      testResult = { valid: true };
      showMessage('Connection test successful!', 'success');
    } else if (response.status === 401) {
      testResult = { valid: false, error: 'Invalid API key' };
      showMessage('Connection test failed: Invalid API key', 'error');
    } else {
      testResult = { valid: false, error: `API error: ${response.status}` };
      showMessage(`Connection test failed: API error ${response.status}`, 'error');
    }
  }

  async function testOpenAICompatibleConnection(baseUrl: string, modelKey: string, organization: string | null) {
    const { default: OpenAI } = await import('openai');

    const client = new OpenAI({
      apiKey: apiKey,
      baseURL: baseUrl,
      organization: organization || undefined,
      timeout: 30000,
      maxRetries: 0,
      dangerouslyAllowBrowser: true
    });

    try {
      await client.chat.completions.create({
        model: modelKey,
        messages: [{ role: 'user', content: 'test' }],
        max_tokens: 1
      });
      testResult = { valid: true };
      showMessage('Connection test successful!', 'success');
    } catch (error: any) {
      if (error?.status === 401 || error?.code === 'invalid_api_key') {
        testResult = { valid: false, error: 'Invalid API key' };
        showMessage('Connection test failed: Invalid API key', 'error');
      } else if (error?.status === 400) {
        testResult = { valid: true };
        showMessage('Connection test successful! (API key is valid)', 'success');
      } else {
        const errorMsg = error?.message || 'Network error';
        testResult = { valid: false, error: errorMsg };
        showMessage(`Connection test failed: ${errorMsg}`, 'error');
      }
    }
  }

  async function clearAuth() {
    const providerName = currentProvider === 'openai' ? 'OpenAI'
      : currentProvider === 'xai' ? 'xAI'
      : currentProvider === 'anthropic' ? 'Anthropic'
      : currentProvider === 'google-ai-studio' ? 'Google AI Studio'
      : currentProvider === 'groq' ? 'Groq'
      : currentProvider;

    if (!confirm(`Are you sure you want to remove your ${providerName} API key?`)) return;
    if (!settingsConfig) return;

    try {
      isClearingAuth = true;
      await settingsConfig.deleteProviderApiKey(currentProvider);

      apiKey = '';
      maskedApiKey = '';
      isAuthenticated = false;
      testResult = null;

      for (let i = 0; i < modelSelectionItems.length; i++) {
        if (modelSelectionItems[i].providerId === currentProvider) {
          modelSelectionItems[i].apiKey = null;
        }
      }

      showMessage(`${providerName} API key removed successfully`, 'info');
      chrome.runtime.sendMessage({ type: 'CONFIG_UPDATE' }).catch(() => {});
      dispatch('authUpdated', { isAuthenticated: false, mode: null });
    } catch (error) {
      showMessage('Failed to remove API key', 'error');
    } finally {
      isClearingAuth = false;
    }
  }

  function showMessage(message: string, type: 'success' | 'error' | 'info') {
    saveMessage = message;
    saveMessageType = type;
    setTimeout(clearMessage, 5000);
  }

  function clearMessage() {
    saveMessage = '';
    saveMessageType = '';
  }

  function handleBack() {
    dispatch('back');
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' && !isSaving && !isModelSwitching && !isClearingAuth && !isInitializing) {
      saveApiKey();
    }
  }

  async function handleModelChange(event: CustomEvent<{ modelId: string }>) {
    if (!settingsConfig) return;

    try {
      isModelSwitching = true;
      const { modelId } = event.detail;

      const selectedItem = modelSelectionItems.find(item => item.modelId === modelId);
      if (!selectedItem) throw new Error('Model not found');

      const previousModelId = selectedModelId;

      if (!confirm('The model switch will clear the current conversation. Do you want to continue?')) {
        modelSelectionItems = modelSelectionItems.map(item => ({
          ...item,
          selected: item.modelId === previousModelId
        }));
        isModelSwitching = false;
        return;
      }

      if (selectedItem.supportsImage === false) {
        alert(`Model "${selectedItem.modelName}" does not support image input. Some tools will be disabled.`);
      }

      selectedModelId = modelId;
      loadModelData(selectedItem);
      modelValidationError = '';
      testResult = null;
      clearMessage();

      modelSelectionItems = modelSelectionItems.map(item => ({
        ...item,
        selected: item.modelId === modelId
      }));

      await settingsConfig.setSelectedModel(modelId);
      chrome.runtime.sendMessage({ type: 'CONFIG_UPDATE' }).catch(() => {});

      const message = apiKey
        ? `Model changed to ${selectedItem.modelName}. Session will be reinitialized.`
        : `Model changed to ${selectedItem.modelName}. Please configure your API key.`;
      showMessage(message, apiKey ? 'success' : 'info');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      showMessage(`Failed to change model: ${errorMessage}`, 'error');
      await loadSettings();
    } finally {
      isModelSwitching = false;
    }
  }

  function handleValidationError(event: CustomEvent) {
    const { errors } = event.detail;
    modelValidationError = errors.join('. ');
    showMessage(`Cannot select model: ${modelValidationError}`, 'error');
  }

  async function handleServiceTierChange(event: Event) {
    if (!settingsConfig) return;

    try {
      const target = event.target as HTMLSelectElement;
      const newServiceTier = target.value as 'default' | 'flex' | 'priority' | '';
      serviceTier = newServiceTier === '' ? undefined : newServiceTier;

      const modelData = settingsConfig.getModelById(selectedModelId);
      if (modelData?.model) {
        const provider = settingsConfig.getProvider(modelData.providerId);
        if (provider) {
          const modelIndex = provider.models.findIndex(m => m.id === selectedModelId);
          if (modelIndex !== -1) {
            provider.models[modelIndex].serviceTier = serviceTier;
            await settingsConfig.updateProvider(modelData.providerId, { models: provider.models });
            chrome.runtime.sendMessage({ type: 'CONFIG_UPDATE' }).catch(() => {});
            showMessage(`Service tier updated to ${serviceTier || 'default'}`, 'success');
          }
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      showMessage(`Failed to update service tier: ${errorMessage}`, 'error');
    }
  }

  function navigateToAdvancedConfig() {
    dispatch('navigateToAdvanced', { modelId: selectedModelId, providerId: currentProvider });
  }
</script>

<div class="model-settings">
  <button class="back-button" on:click={handleBack}>← Back</button>

  <!-- Model Selection -->
  <div class="settings-section">
    <h3 class="section-title">Model Selection</h3>
    <div class="form-group">
      <label class="form-label">Choose AI Model</label>
      <ModelSelector
        selectedModel={selectedModelId}
        {modelSelectionItems}
        disabled={isInitializing || isSaving}
        on:modelChange={handleModelChange}
        on:validationError={handleValidationError}
      />
      <div class="help-text">
        Select the AI model to use for conversations.
      </div>

      {#if modelValidationError}
        <div class="message error">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="15" y1="9" x2="9" y2="15"></line>
            <line x1="9" y1="9" x2="15" y2="15"></line>
          </svg>
          {modelValidationError}
        </div>
      {/if}

      <!-- Provider Information -->
      <div class="provider-info-container">
        <div class="provider-info-row">
          <span class="provider-info-left">
            <span class="provider-info-label">Provider:</span>
            <span class="provider-info-value">{currentProviderName}</span>
          </span>
          <button class="more-config-btn" on:click={navigateToAdvancedConfig}>
            More Config >>
          </button>
        </div>
        {#if currentProviderOrganization}
          <div class="provider-info-row">
            <span class="provider-info-left">
              <span class="provider-info-label">Organization:</span>
              <span class="provider-info-value">{currentProviderOrganization}</span>
            </span>
          </div>
        {/if}
      </div>
    </div>
  </div>

  <!-- API Key Section -->
  <div class="settings-section">
    <div class="section-header">
      <h3 class="section-title">API Key Configuration</h3>
      {#if isAuthenticated}
        <span class="auth-status authenticated">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <polyline points="20,6 9,17 4,12"></polyline>
          </svg>
          Connected
        </span>
      {:else}
        <span class="auth-status not-authenticated">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="15" y1="9" x2="9" y2="15"></line>
            <line x1="9" y1="9" x2="15" y2="15"></line>
          </svg>
          Not Connected
        </span>
      {/if}
    </div>

    <div class="form-group">
      <label for="api-key" class="form-label">
        {#if currentProvider === 'xai'}
          xAI API Key
        {:else if currentProvider === 'anthropic'}
          Anthropic API Key
        {:else if currentProvider === 'google-ai-studio'}
          Google AI Studio API Key
        {:else if currentProvider === 'groq'}
          Groq API Key
        {:else}
          OpenAI API Key
        {/if}
      </label>
      <div class="input-group">
        {#if showApiKey}
          <input
            id="api-key"
            type="text"
            bind:value={apiKey}
            on:input={handleApiKeyInput}
            on:keydown={handleKeydown}
            placeholder={isAuthenticated ? maskedApiKey : (currentProvider === 'xai' ? 'xai-...' : currentProvider === 'anthropic' ? 'sk-ant-...' : currentProvider === 'groq' ? 'gsk_...' : 'sk-...')}
            class="api-key-input"
            disabled={isInitializing || isSaving}
            autocomplete="off"
            spellcheck="false"
          />
        {:else}
          <input
            id="api-key"
            type="password"
            bind:value={apiKey}
            on:input={handleApiKeyInput}
            on:keydown={handleKeydown}
            placeholder={isAuthenticated ? maskedApiKey : (currentProvider === 'xai' ? 'xai-...' : currentProvider === 'anthropic' ? 'sk-ant-...' : currentProvider === 'groq' ? 'gsk_...' : 'sk-...')}
            class="api-key-input"
            disabled={isInitializing || isSaving}
            autocomplete="off"
            spellcheck="false"
          />
        {/if}
        <button
          type="button"
          class="visibility-toggle"
          on:click={toggleApiKeyVisibility}
          aria-label={showApiKey ? 'Hide API key' : 'Show API key'}
        >
          {#if showApiKey}
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path>
              <line x1="1" y1="1" x2="23" y2="23"></line>
            </svg>
          {:else}
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
              <circle cx="12" cy="12" r="3"></circle>
            </svg>
          {/if}
        </button>
      </div>
      <div class="help-text">
        {#if currentProvider === 'xai'}
          Enter your xAI API key (starts with 'xai-')
        {:else if currentProvider === 'anthropic'}
          Enter your Anthropic API key (starts with 'sk-ant-')
        {:else if currentProvider === 'google-ai-studio'}
          Enter your Google AI Studio API key
        {:else}
          Enter your OpenAI API key (starts with 'sk-' or 'sk-proj-')
        {/if}
      </div>

      {#if !apiKey.trim()}
        <div class="message warning">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="8" x2="12" y2="12"></line>
            <line x1="12" y1="16" x2="12.01" y2="16"></line>
          </svg>
          Please input a valid API key.
        </div>
      {/if}
    </div>

    <!-- Service Tier Selection (OpenAI only) -->
    {#if currentProvider === 'openai'}
      <div class="form-group">
        <label for="service-tier" class="form-label">Service Tier</label>
        <select
          id="service-tier"
          bind:value={serviceTier}
          on:change={handleServiceTierChange}
          class="form-select"
          disabled={isInitializing || isSaving}
        >
          <option value="default">Default</option>
          <option value="flex">Flex</option>
          <option value="priority">Priority</option>
        </select>
        <div class="help-text">
          Priority tier provides faster response times with higher pricing.
        </div>
      </div>
    {/if}

    <!-- Action Buttons -->
    <div class="button-group">
      <button
        class="btn btn-primary"
        on:click={saveApiKey}
        disabled={isInitializing || isSaving || !apiKey.trim()}
      >
        {#if isSaving}
          <svg class="spinner" width="16" height="16" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-dasharray="31.416" stroke-dashoffset="31.416">
              <animate attributeName="stroke-dasharray" dur="2s" values="0 31.416;15.708 15.708;0 31.416" repeatCount="indefinite"/>
              <animate attributeName="stroke-dashoffset" dur="2s" values="0;-15.708;-31.416" repeatCount="indefinite"/>
            </circle>
          </svg>
          Saving...
        {:else}
          Save API Key
        {/if}
      </button>

      <button
        class="btn btn-secondary"
        on:click={testConnection}
        disabled={isTesting || !apiKey.trim()}
      >
        {#if isTesting}
          <svg class="spinner" width="16" height="16" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-dasharray="31.416" stroke-dashoffset="31.416">
              <animate attributeName="stroke-dasharray" dur="2s" values="0 31.416;15.708 15.708;0 31.416" repeatCount="indefinite"/>
              <animate attributeName="stroke-dashoffset" dur="2s" values="0;-15.708;-31.416" repeatCount="indefinite"/>
            </circle>
          </svg>
          Testing...
        {:else}
          Test Connection
        {/if}
      </button>

      {#if isAuthenticated}
        <button
          class="btn btn-danger"
          on:click={clearAuth}
          disabled={isInitializing || isSaving}
        >
          Remove API Key
        </button>
      {/if}
    </div>

    <!-- Test Result -->
    {#if testResult}
      <div class="test-result {testResult.valid ? 'success' : 'error'}">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor">
          {#if testResult.valid}
            <polyline points="20,6 9,17 4,12"></polyline>
          {:else}
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="15" y1="9" x2="9" y2="15"></line>
            <line x1="9" y1="9" x2="15" y2="15"></line>
          {/if}
        </svg>
        {testResult.valid ? 'Connection successful!' : `Connection failed: ${testResult.error}`}
      </div>
    {/if}

    <!-- Save Message -->
    {#if saveMessage}
      <div class="message {saveMessageType}">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor">
          {#if saveMessageType === 'success'}
            <polyline points="20,6 9,17 4,12"></polyline>
          {:else if saveMessageType === 'error'}
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="15" y1="9" x2="9" y2="15"></line>
            <line x1="9" y1="9" x2="15" y2="15"></line>
          {:else}
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="16" x2="12" y2="12"></line>
            <line x1="12" y1="8" x2="12.01" y2="8"></line>
          {/if}
        </svg>
        {saveMessage}
      </div>
    {/if}
  </div>

  <!-- Security Notice -->
  <div class="settings-section">
    <h3 class="section-title">Security & Privacy</h3>
    <div class="security-notice">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
      </svg>
      <div>
        <div class="security-title">Your API key is encrypted</div>
        <div class="security-text">
          API keys are encrypted and stored locally in your browser.
          They are never sent to external servers except for API calls.
        </div>
      </div>
    </div>
  </div>
</div>

<style>
  .model-settings {
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

  .settings-section {
    margin-bottom: 2rem;
  }

  .section-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
  }

  .section-title {
    margin: 0 0 1rem 0;
    font-size: 1.125rem;
    font-weight: 600;
    color: var(--browserx-text);
  }

  .section-header .section-title {
    margin-bottom: 0;
  }

  .auth-status {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.875rem;
    padding: 0.25rem 0.75rem;
    border-radius: 9999px;
    font-weight: 500;
  }

  .auth-status.authenticated {
    color: var(--browserx-success);
    background: color-mix(in srgb, var(--browserx-success) 10%, transparent);
  }

  .auth-status.not-authenticated {
    color: var(--browserx-error);
    background: color-mix(in srgb, var(--browserx-error) 10%, transparent);
  }

  .form-group {
    margin-bottom: 1.5rem;
  }

  .form-label {
    display: block;
    margin-bottom: 0.5rem;
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--browserx-text);
  }

  .input-group {
    position: relative;
    display: flex;
  }

  .api-key-input {
    flex: 1;
    padding: 0.75rem 3rem 0.75rem 0.75rem;
    border: 1px solid var(--browserx-border);
    border-radius: 0.5rem;
    background: var(--browserx-surface);
    color: var(--browserx-text);
    font-size: 0.875rem;
    font-family: 'SF Mono', 'Monaco', monospace;
    transition: all 0.2s;
  }

  .api-key-input:focus {
    outline: none;
    border-color: var(--browserx-primary);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--browserx-primary) 10%, transparent);
  }

  .api-key-input:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .visibility-toggle {
    position: absolute;
    right: 0.75rem;
    top: 50%;
    transform: translateY(-50%);
    background: none;
    border: none;
    color: var(--browserx-text-secondary);
    cursor: pointer;
    padding: 0.25rem;
    border-radius: 0.25rem;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: color 0.2s;
  }

  .visibility-toggle:hover {
    color: var(--browserx-text);
  }

  .form-select {
    width: 100%;
    padding: 0.75rem;
    border: 1px solid var(--browserx-border);
    border-radius: 0.5rem;
    background: var(--browserx-surface);
    color: var(--browserx-text);
    font-size: 0.875rem;
    cursor: pointer;
    transition: all 0.2s;
  }

  .form-select:focus {
    outline: none;
    border-color: var(--browserx-primary);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--browserx-primary) 10%, transparent);
  }

  .form-select:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .help-text {
    margin-top: 0.5rem;
    font-size: 0.75rem;
    color: var(--browserx-text-secondary);
  }

  .button-group {
    display: flex;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .btn {
    display: flex;
    align-items: center;
    gap: 0.5rem;
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

  .btn-secondary {
    background: var(--browserx-surface);
    color: var(--browserx-text);
    border: 1px solid var(--browserx-border);
  }

  .btn-secondary:hover:not(:disabled) {
    background: color-mix(in srgb, var(--browserx-surface) 80%, var(--browserx-text));
  }

  .btn-danger {
    background: var(--browserx-error);
    color: white;
  }

  .btn-danger:hover:not(:disabled) {
    background: color-mix(in srgb, var(--browserx-error) 90%, black);
  }

  .spinner {
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    from { transform: rotate(0deg); }
    to { transform: rotate(360deg); }
  }

  .test-result, .message {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.75rem;
    border-radius: 0.5rem;
    font-size: 0.875rem;
    margin-top: 1rem;
  }

  .test-result.success, .message.success {
    color: var(--browserx-success);
    background: color-mix(in srgb, var(--browserx-success) 10%, transparent);
  }

  .test-result.error, .message.error {
    color: var(--browserx-error);
    background: color-mix(in srgb, var(--browserx-error) 10%, transparent);
  }

  .message.info {
    color: var(--browserx-primary);
    background: color-mix(in srgb, var(--browserx-primary) 10%, transparent);
  }

  .message.warning {
    color: #f59e0b;
    background: color-mix(in srgb, #f59e0b 10%, transparent);
  }

  .security-notice {
    display: flex;
    gap: 0.75rem;
    padding: 1rem;
    border-radius: 0.5rem;
    background: var(--browserx-surface);
    border: 1px solid var(--browserx-border);
  }

  .security-notice svg {
    color: var(--browserx-primary);
    flex-shrink: 0;
    margin-top: 0.125rem;
  }

  .security-title {
    font-weight: 600;
    margin-bottom: 0.25rem;
    color: var(--browserx-text);
  }

  .security-text {
    font-size: 0.875rem;
    color: var(--browserx-text-secondary);
    line-height: 1.5;
  }

  /* Provider Information */
  .provider-info-container {
    margin-top: 1rem;
    padding: 0.75rem;
    background: var(--browserx-surface);
    border: 1px solid var(--browserx-border);
    border-radius: 0.5rem;
  }

  .provider-info-row {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: center;
    padding: 0.375rem 0;
    gap: 0.25rem;
  }

  .provider-info-row:not(:last-child) {
    border-bottom: 1px solid var(--browserx-border);
  }

  .provider-info-left {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .provider-info-label {
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--browserx-text-secondary);
    flex-shrink: 0;
  }

  .provider-info-value {
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--browserx-text);
    max-width: 150px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .more-config-btn {
    background: none;
    border: none;
    color: var(--browserx-primary);
    cursor: pointer;
    font-size: 0.875rem;
    font-weight: 500;
    padding: 0.25rem 0.5rem;
    border-radius: 0.25rem;
    transition: all 0.2s;
  }

  .more-config-btn:hover {
    background: color-mix(in srgb, var(--browserx-primary) 10%, transparent);
  }
</style>
