<!--
  Settings - Svelte component for managing user settings
  Handles API key configuration and secure storage
-->

<script lang="ts">
  import { onMount, createEventDispatcher } from 'svelte';
  import { AgentConfig } from '../config/AgentConfig.js';
  import { encryptApiKey, decryptApiKey } from '../utils/encryption.js';
  import { AuthMode } from '../models/types/index.js';
  import ModelSelector from './settings/ModelSelector.svelte';
  import type { ConfiguredFeatures } from '../config/types.js';

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
  let currentAuthMode: AuthMode | null = null;

  // T011: Model configuration state
  // selectedModelId starts empty, will be loaded from AgentConfig in loadSettings()
  let selectedModelId = '';
  let configuredFeatures: ConfiguredFeatures = {};
  let modelValidationError = '';

  // T022, T023: Provider-aware API key display
  let currentProvider = 'openai';
  let currentProviderName = 'OpenAI';
  let currentProviderOrganization: string | null = null;
  let providerValidationWarning = '';

  // Model selection array - flattened view of all models from all providers
  // Note: API keys are stored at PROVIDER level in AgentConfig, but cached here for UI convenience
  // This allows one provider to have multiple models, and handles cases where the same
  // model might be available from different providers (e.g., GPT-5 from OpenAI vs Azure)
  interface ModelSelectionItem {
    modelId: string;
    modelName: string;
    modelKey: string;
    providerId: string;      // Reference to provider
    providerName: string;
    organization: string | null;  // Provider organization (e.g., 'OpenAI', 'Anthropic')
    apiKey: string | null;   // Cached from provider for UI convenience
    contextWindow: number;
    maxOutputTokens: number;
    baseUrl: string;
  }
  let modelSelectionItems: ModelSelectionItem[] = [];

  // Settings component has its own AgentConfig instance (not shared with agent)
  let settingsConfig: AgentConfig | null = null;

  // Event dispatcher for parent components
  const dispatch = createEventDispatcher<{
    authUpdated: { isAuthenticated: boolean; mode: AuthMode | null };
    close: void;
  }>();

  // Load existing settings on mount
  // Create isolated AgentConfig instance for Settings (not shared with agent)
  onMount(async () => {
    await loadSettings();
  });

  /**
   * Load settings from chrome.storage.local with isolated AgentConfig
   * This creates a new AgentConfig instance that is NOT shared with the agent
   */
  async function loadSettings() {
    try {
      isInitializing = true;
      console.log('[Settings] Creating isolated AgentConfig instance...');

      // Create new AgentConfig instance
      settingsConfig = new (AgentConfig as any)();

      // Ensure initialization succeeded
      if (!settingsConfig) {
        throw new Error('Failed to initialize AgentConfig');
      }
      await settingsConfig.initialize();

      // Get current config - selectedModelId should come from AgentConfig
      const config = settingsConfig.getConfig();
      selectedModelId = config.selectedModelId;

      console.log('[Settings] Loaded selectedModelId from AgentConfig:', selectedModelId);
      console.log('[Settings] Full config:', { selectedModelId: config.selectedModelId, providers: Object.keys(config.providers || {}) });

      // Build model selection array - flatten models from all providers
      // Fetch API key from provider level and cache it in each model item for UI convenience
      modelSelectionItems = [];
      const providers = settingsConfig.getProviders();

      for (const [providerId, provider] of Object.entries(providers)) {
        if (!provider.models || !Array.isArray(provider.models)) continue;

        // Get API key for this provider (stored at provider level)
        const providerApiKey = await settingsConfig.getProviderApiKey(providerId);

        for (const model of provider.models) {
          modelSelectionItems.push({
            modelId: model.id,
            modelName: model.name,
            modelKey: model.modelKey,
            providerId: provider.id,
            providerName: provider.name,
            organization: provider.organization || null,  // Provider organization
            apiKey: providerApiKey,  // Cached from provider for UI convenience
            contextWindow: model.contextWindow,
            maxOutputTokens: model.maxOutputTokens,
            baseUrl: provider.baseUrl || ''
          });
        }
      }

      console.log('[Settings] Built selection items:', modelSelectionItems.length, 'models');

      // Validate selectedModelId loaded from AgentConfig
      if (!selectedModelId || selectedModelId === '') {
        console.warn('[Settings] selectedModelId from AgentConfig is empty or invalid');
        if (modelSelectionItems.length > 0) {
          selectedModelId = modelSelectionItems[0].modelId;
          console.warn('[Settings] Falling back to first available model:', selectedModelId);
          // Save the fallback selection to AgentConfig for next time
          await settingsConfig.setSelectedModel(selectedModelId);
        } else {
          console.error('[Settings] No models available in configuration');
          showMessage('No models available. Please check configuration.', 'error');
          return;
        }
      }

      // Verify the selectedModelId from AgentConfig exists in available models
      const selectedItem = modelSelectionItems.find(item => item.modelId === selectedModelId);
      if (selectedItem) {
        currentProvider = selectedItem.providerId;
        currentProviderName = selectedItem.providerName;
        currentProviderOrganization = selectedItem.organization;  // Use cached organization

        console.log('[Settings] Initial load - currentProvider:', currentProvider);
        console.log('[Settings] Initial load - selectedItem:', { modelId: selectedItem.modelId, modelName: selectedItem.modelName, providerId: selectedItem.providerId });

        // Use cached API key from selectedItem
        apiKey = selectedItem.apiKey || '';
        maskedApiKey = apiKey ? maskApiKey(apiKey) : '';
        isAuthenticated = !!selectedItem.apiKey;
        currentAuthMode = isAuthenticated ? AuthMode.ApiKey : null;

        configuredFeatures = {
          reasoningEffort: null,
          reasoningSummary: undefined,
          verbosity: null,
          contextWindow: selectedItem.contextWindow,
          maxOutputTokens: selectedItem.maxOutputTokens
        };
      } else {
        // Model from AgentConfig not found in available models - fallback to first model
        console.warn('[Settings] Model from AgentConfig not found in available models:', selectedModelId);
        if (modelSelectionItems.length > 0) {
          selectedModelId = modelSelectionItems[0].modelId;
          console.warn('[Settings] Falling back to first available model:', selectedModelId);
          await settingsConfig.setSelectedModel(selectedModelId);
          
          // Load data for fallback model
          const fallbackItem = modelSelectionItems[0];
          currentProvider = fallbackItem.providerId;
          currentProviderName = fallbackItem.providerName;
          currentProviderOrganization = fallbackItem.organization;
          apiKey = fallbackItem.apiKey || '';
          maskedApiKey = apiKey ? maskApiKey(apiKey) : '';
          isAuthenticated = !!fallbackItem.apiKey;
          currentAuthMode = isAuthenticated ? AuthMode.ApiKey : null;
          configuredFeatures = {
            reasoningEffort: null,
            reasoningSummary: undefined,
            verbosity: null,
            contextWindow: fallbackItem.contextWindow,
            maxOutputTokens: fallbackItem.maxOutputTokens
          };
        } else {
          // No models available at all
          console.error('[Settings] No models available for fallback');
          currentProvider = 'openai';
          currentProviderName = 'OpenAI';
          currentProviderOrganization = null;
          apiKey = '';
          maskedApiKey = '';
          isAuthenticated = false;
          currentAuthMode = null;
          configuredFeatures = {};
        }
      }

      console.log('[Settings] Loaded settings successfully');
    } catch (error) {
      console.error('[Settings] Failed to load settings:', error);
      showMessage('Failed to load settings', 'error');
    } finally {
      isInitializing = false;
    }
  }

  /**
   * Mask API key for display
   */
  function maskApiKey(key: string): string {
    if (!key || key.length < 6) {
      return key;
    }

    // Show only first 6 characters followed by ***
    const start = key.substring(0, 6);
    return `${start}***`;
  }

  /**
   * Handle API key input changes
   */
  function handleApiKeyInput(event: Event) {
    const target = event.target as HTMLInputElement;
    apiKey = target.value;
    maskedApiKey = maskApiKey(apiKey);

    // Clear any previous messages when user starts typing
    clearMessage();
    testResult = null;
  }

  /**
   * Toggle API key visibility
   */
  function toggleApiKeyVisibility() {
    showApiKey = !showApiKey;
  }

  /**
   * 3.3: Save API key button - save API key from user input to storage
   * This is separate from model selection and only updates the API key
   */
  async function saveApiKey() {
    if (isSaving) {
      return;
    }

    if (!apiKey.trim()) {
      showMessage('Please enter an API key', 'error');
      return;
    }

    if (!settingsConfig) {
      showMessage('Configuration not initialized', 'error');
      return;
    }

    try {
      isSaving = true;
      console.log('[Settings] Saving API key for provider:', currentProvider);
      console.log('[Settings] Currently selected model:', selectedModelId);
      console.log('[Settings] API key starts with:', apiKey.substring(0, 10) + '...');

      // Validate API key format using provider-aware validation
      const { validateApiKeyFormat } = await import('../config/validators');
      const validation = validateApiKeyFormat(apiKey, currentProvider);

      if (!validation.isValid) {
        providerValidationWarning = '';
        showMessage(validation.errors.join('. '), 'error');
        return;
      }

      // Display warning if provider mismatch, but allow save
      if (validation.warnings.length > 0) {
        providerValidationWarning = validation.warnings.join(' ');
      } else {
        providerValidationWarning = '';
      }

      // Save API key to provider level in storage
      // Note: This saves to the PROVIDER, not the individual model
      // All models under this provider will use this API key
      await settingsConfig.setProviderApiKey(currentProvider, apiKey);

      // Update component state
      isAuthenticated = true;
      currentAuthMode = AuthMode.ApiKey;
      maskedApiKey = maskApiKey(apiKey);

      // Update cached API key in ALL model items from this provider
      // (since API key is stored at provider level, all models under it share the same key)
      for (let i = 0; i < modelSelectionItems.length; i++) {
        if (modelSelectionItems[i].providerId === currentProvider) {
          modelSelectionItems[i].apiKey = apiKey;
        }
      }

      console.log('[Settings] API key saved to provider:', currentProvider);
      showMessage('API key saved successfully!', 'success');

      console.log('[Settings] API key saved, notifying agent to re-initialize');

      // Send message to service worker to reload config and recreate BrowserxAgent
      chrome.runtime.sendMessage({
        type: 'CONFIG_UPDATE'
      }).catch(err => {
        console.error('[Settings] Failed to notify service worker of config update:', err);
      });

      // Notify parent components
      dispatch('authUpdated', {
        isAuthenticated: true,
        mode: AuthMode.ApiKey
      });

    } catch (error) {
      console.error('[Settings] Failed to save API key:', error);
      showMessage('Failed to save API key', 'error');
    } finally {
      isSaving = false;
    }
  }

  /**
   * Test API key connection using provider SDKs
   */
  async function testConnection() {
    if (!apiKey.trim()) {
      showMessage('Please enter an API key first', 'error');
      return;
    }

    try {
      isTesting = true;
      testResult = null;

      const selectedItem = modelSelectionItems.find(
        item => item.modelId === selectedModelId
      );

      if (!selectedItem) {
        console.error('[Settings] No matching model for selectedModelId:', selectedModelId);
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

      console.log('[Settings] Testing connection for provider:', providerId);

      // Use provider-specific testing method
      if (providerId === 'anthropic') {
        await testAnthropicConnection(baseUrl, modelKey);
      } else {
        // OpenAI, xAI, and other OpenAI-compatible providers
        await testOpenAICompatibleConnection(baseUrl, modelKey, organization);
      }

    } catch (error) {
      console.error('[Settings] Failed to test API key:', error);
      const errorMsg = error instanceof Error ? error.message : 'Network error';
      testResult = { valid: false, error: errorMsg };
      showMessage('Failed to test connection', 'error');
    } finally {
      isTesting = false;
    }
  }

  /**
   * Test Anthropic API connection (using fetch since no SDK installed)
   */
  async function testAnthropicConnection(baseUrl: string, modelKey: string) {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    };

    const testRequest = {
      model: modelKey,
      max_tokens: 1,
      messages: [{ role: 'user', content: 'test' }]
    };

    const response = await fetch(baseUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(testRequest)
    });

    if (response.ok || response.status === 400) {
      // 400 is OK for test - means auth worked but request was invalid
      testResult = { valid: true };
      showMessage('Connection test successful!', 'success');
    } else if (response.status === 401) {
      testResult = { valid: false, error: 'Invalid API key' };
      showMessage('Connection test failed: Invalid API key', 'error');
    } else {
      const errorText = await response.text().catch(() => 'Unknown error');
      testResult = { valid: false, error: `API error: ${response.status}` };
      showMessage(`Connection test failed: API error ${response.status}`, 'error');
      console.error('[Settings] Anthropic API error:', errorText);
    }
  }

  /**
   * Test OpenAI-compatible API connection (OpenAI, xAI, etc.) using OpenAI SDK
   */
  async function testOpenAICompatibleConnection(baseUrl: string, modelKey: string, organization: string | null) {
    // Dynamically import OpenAI SDK
    const { default: OpenAI } = await import('openai');

    // Create OpenAI client with provider-specific configuration
    const client = new OpenAI({
      apiKey: apiKey,
      baseURL: baseUrl,
      organization: organization || undefined,
      timeout: 30000, // 30 seconds for test
      maxRetries: 0, // No retries for test
      dangerouslyAllowBrowser: true // Allow in browser context
    });

    try {
      // Make a minimal test request
      const response = await client.chat.completions.create({
        model: modelKey,
        messages: [{ role: 'user', content: 'test' }],
        max_tokens: 1,
      });

      // If we got a response, the API key is valid
      console.log('[Settings] OpenAI-compatible API test successful:', response.id);
      testResult = { valid: true };
      showMessage('Connection test successful!', 'success');
    } catch (error: any) {
      console.error('[Settings] OpenAI-compatible API test failed:', error);

      // Parse OpenAI SDK error
      if (error?.status === 401 || error?.code === 'invalid_api_key') {
        testResult = { valid: false, error: 'Invalid API key' };
        showMessage('Connection test failed: Invalid API key', 'error');
      } else if (error?.status === 400) {
        // 400 with SDK usually means request issue but auth worked
        testResult = { valid: true };
        showMessage('Connection test successful! (API key is valid)', 'success');
      } else if (error?.status) {
        testResult = { valid: false, error: `API error: ${error.status}` };
        showMessage(`Connection test failed: API error ${error.status}`, 'error');
      } else {
        const errorMsg = error?.message || 'Network error';
        testResult = { valid: false, error: errorMsg };
        showMessage(`Connection test failed: ${errorMsg}`, 'error');
      }
    }
  }

  /**
   * Clear stored authentication for current provider
   */
  async function clearAuth() {
    const providerName = currentProvider === 'openai' ? 'OpenAI'
      : currentProvider === 'xai' ? 'xAI'
      : currentProvider === 'anthropic' ? 'Anthropic'
      : currentProvider;

    if (!confirm(`Are you sure you want to remove your ${providerName} API key? You will need to enter it again to use this provider.`)) {
      return;
    }

    if (!settingsConfig) {
      showMessage('Configuration not initialized', 'error');
      return;
    }

    try {
      isClearingAuth = true;
      console.log('[Settings] Clearing API key for provider:', currentProvider);

      // Delete provider-level API key from storage
      // Note: This removes the key from the PROVIDER, affecting all models under this provider
      await settingsConfig.deleteProviderApiKey(currentProvider);

      // Reset component state
      apiKey = '';
      maskedApiKey = '';
      isAuthenticated = false;
      currentAuthMode = null;
      testResult = null;

      // Clear cached API key in ALL model items from this provider
      for (let i = 0; i < modelSelectionItems.length; i++) {
        if (modelSelectionItems[i].providerId === currentProvider) {
          modelSelectionItems[i].apiKey = null;
        }
      }

      console.log('[Settings] Cleared API key from provider:', currentProvider);
      showMessage(`${providerName} API key removed successfully`, 'info');

      // Send message to service worker to reload config and recreate BrowserxAgent
      chrome.runtime.sendMessage({
        type: 'CONFIG_UPDATE'
      }).catch(err => {
        console.error('[Settings] Failed to notify service worker of config update:', err);
      });

      // Notify parent components
      dispatch('authUpdated', {
        isAuthenticated: false,
        mode: null
      });

    } catch (error) {
      console.error('[Settings] Failed to clear auth:', error);
      showMessage('Failed to remove API key', 'error');
    } finally {
      isClearingAuth = false;
    }
  }

  /**
   * Show temporary message
   */
  function showMessage(message: string, type: 'success' | 'error' | 'info') {
    saveMessage = message;
    saveMessageType = type;

    // Auto-clear after 5 seconds
    setTimeout(clearMessage, 5000);
  }

  /**
   * Clear message
   */
  function clearMessage() {
    saveMessage = '';
    saveMessageType = '';
  }

  /**
   * Close settings panel
   */
  function closeSettings() {
    dispatch('close');
  }

  /**
   * Handle Enter key in input
   */
  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      if (isSaving || isModelSwitching || isClearingAuth || isInitializing) {
        event.preventDefault();
        return;
      }
      saveApiKey();
    }
  }

  /**
   * T039: Check if there's an active conversation
   */
  async function isConversationActive(): Promise<boolean> {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
      return response?.isActiveTurn || false;
    } catch (error) {
      console.error('Failed to check conversation status:', error);
      return false;
    }
  }

  /**
   * Handle model selection change
   * 3.1: Load related API key to field (empty if not available)
   * 3.2: Save model selection WITHOUT updating API key
   * 3.4: Trigger BrowserAgent re-initialization
   */
  async function handleModelChange(event: CustomEvent<{ modelId: string }>) {
    if (!settingsConfig) return;

    try {
      isModelSwitching = true;
      const { modelId } = event.detail;

      console.log('[Settings] Model changed to:', modelId);

      // Find the selected item from our pre-built selection array
      const selectedItem = modelSelectionItems.find(item => item.modelId === modelId);
      if (!selectedItem) {
        throw new Error('Model not found in selection items');
      }

      // Update ALL UI state IMMEDIATELY for instant feedback
      // This ensures dropdown, provider section, API key field, and features all stay in sync
      selectedModelId = modelId;
      currentProvider = selectedItem.providerId;
      currentProviderName = selectedItem.providerName;
      currentProviderOrganization = selectedItem.organization;
      
      // Load the API key for this provider from the cache (already fetched in loadSettings)
      apiKey = selectedItem.apiKey || '';
      maskedApiKey = apiKey ? maskApiKey(apiKey) : '';
      isAuthenticated = !!selectedItem.apiKey;
      currentAuthMode = isAuthenticated ? AuthMode.ApiKey : null;
      
      // Update model features
      configuredFeatures = {
        reasoningEffort: null,
        reasoningSummary: undefined,
        verbosity: null,
        contextWindow: selectedItem.contextWindow,
        maxOutputTokens: selectedItem.maxOutputTokens
      };

      // Clear validation errors and previous test results
      modelValidationError = '';
      providerValidationWarning = '';
      testResult = null;
      clearMessage();
      
      modelSelectionItems = [...modelSelectionItems];

      console.log('[Settings] Model changed - Summary:');
      console.log('  - Selected model:', selectedModelId, selectedItem.modelName);
      console.log('  - Provider:', currentProvider, currentProviderName);
      console.log('  - Organization:', currentProviderOrganization);
      console.log('  - API key from cache:', selectedItem.apiKey ? `${selectedItem.apiKey.substring(0, 10)}... (${selectedItem.apiKey.length} chars)` : 'NONE');
      console.log('  - apiKey variable set to:', apiKey ? `${apiKey.substring(0, 10)}... (${apiKey.length} chars)` : 'EMPTY STRING');
      console.log('  - maskedApiKey set to:', maskedApiKey);
      console.log('  - isAuthenticated:', isAuthenticated);

      // Check if there's an active conversation to show appropriate warning
      const conversationActive = await isConversationActive();

      // 3.1: All UI state already updated above for instant feedback

      // 3.2: Save model selection to storage WITHOUT updating API key
      // We only update selectedModelId, not the provider API keys
      await settingsConfig.setSelectedModel(modelId);

      console.log('[Settings] Model selection saved to storage (API key NOT updated)');

      // 3.4: Trigger BrowserAgent re-initialization
      chrome.runtime.sendMessage({ type: 'CONFIG_UPDATE' }).catch(err => {
        console.error('[Settings] Failed to notify agent of config update:', err);
      });

      // Show appropriate message based on conversation state and API key availability
      let message: string;
      let messageType: 'success' | 'info' | 'error';

      if (conversationActive) {
        // Active conversation - warn about clearing
        if (apiKey) {
          message = `Model changed to ${selectedItem.modelName}. The current conversation will be cleared and session will be reinitialized.`;
          messageType = 'info';
        } else {
          message = `Model changed to ${selectedItem.modelName}. The current conversation will be cleared. Please configure your ${selectedItem.providerName} API key below.`;
          messageType = 'info';
        }
      } else {
        // No active conversation
        if (apiKey) {
          message = `Model changed to ${selectedItem.modelName}. Session will be reinitialized.`;
          messageType = 'success';
        } else {
          message = `Model changed to ${selectedItem.modelName}. Please configure your ${selectedItem.providerName} API key below.`;
          messageType = 'info';
        }
      }

      showMessage(message, messageType);
    } catch (error) {
      console.error('[Settings] Failed to change model:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      showMessage(`Failed to change model: ${errorMessage}`, 'error');

      // Revert to previous selection
      await loadSettings();
    } finally {
      isModelSwitching = false;
    }
  }

  /**
   * T015: Handle validation errors
   */
  function handleValidationError(event: CustomEvent) {
    const { errors, incompatibleFeatures } = event.detail;
    modelValidationError = errors.join('. ');
    showMessage(`Cannot select model: ${modelValidationError}`, 'error');
  }
</script>

<div class="settings-container">
  <div class="settings-header">
    <h2 class="settings-title">Settings</h2>
    <button class="close-button" on:click={closeSettings} aria-label="Close settings">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor">
        <line x1="18" y1="6" x2="6" y2="18"></line>
        <line x1="6" y1="6" x2="18" y2="18"></line>
      </svg>
    </button>
  </div>

  <div class="settings-content">
    <!-- T021: Model Selection moved above API Key Section -->
    <div class="settings-section">
      <h3 class="section-title">Model Selection</h3>
      <div class="form-group">
        <label class="form-label">
          Choose AI Model
        </label>
        <ModelSelector
          selectedModel={selectedModelId}
          {modelSelectionItems}
          disabled={isInitializing || isSaving}
          on:modelChange={handleModelChange}
          on:validationError={handleValidationError}
        />
        <div class="help-text">
          Select the AI model to use for conversations. Different models have different capabilities and costs.
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
            <span class="provider-info-label">Provider:</span>
            <span class="provider-info-value">{currentProviderName}</span>
          </div>
          {#if currentProviderOrganization}
            <div class="provider-info-row">
              <span class="provider-info-label">Organization:</span>
              <span class="provider-info-value">{currentProviderOrganization}</span>
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
              placeholder={isAuthenticated ? maskedApiKey : (currentProvider === 'xai' ? 'xai-...' : currentProvider === 'anthropic' ? 'sk-ant-...' : 'sk-...')}
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
              placeholder={isAuthenticated ? maskedApiKey : (currentProvider === 'xai' ? 'xai-...' : currentProvider === 'anthropic' ? 'sk-ant-...' : 'sk-...')}
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

        {#if providerValidationWarning}
          <div class="message warning">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="12" y1="8" x2="12" y2="12"></line>
              <line x1="12" y1="16" x2="12.01" y2="16"></line>
            </svg>
            {providerValidationWarning}
          </div>
        {/if}
      </div>

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
            They are never sent to external servers except for API calls to OpenAI/Anthropic.
          </div>
        </div>
      </div>
    </div>
  </div>
</div>

<style>
  .settings-container {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--browserx-background);
    color: var(--browserx-text);
  }

  .settings-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 1rem 1.5rem;
    border-bottom: 1px solid var(--browserx-border);
  }

  .settings-title {
    margin: 0;
    font-size: 1.25rem;
    font-weight: 600;
    color: var(--browserx-text);
  }

  .close-button {
    background: none;
    border: none;
    color: var(--browserx-text-secondary);
    cursor: pointer;
    padding: 0.25rem;
    border-radius: 0.375rem;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s;
  }

  .close-button:hover {
    color: var(--browserx-text);
    background: var(--browserx-surface);
  }

  .settings-content {
    flex: 1;
    padding: 1.5rem;
    overflow-y: auto;
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
    margin: 0;
    font-size: 1.125rem;
    font-weight: 600;
    color: var(--browserx-text);
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
    font-family: 'SF Mono', 'Monaco', 'Cascadia Code', 'Roboto Mono', monospace;
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
    justify-content: space-between;
    align-items: center;
    padding: 0.375rem 0;
  }

  .provider-info-row:not(:last-child) {
    border-bottom: 1px solid var(--browserx-border);
  }

  .provider-info-label {
    font-size: 0.875rem;
    font-weight: 500;
    color: var(--browserx-text-secondary);
  }

  .provider-info-value {
    font-size: 0.875rem;
    font-weight: 600;
    color: var(--browserx-text);
  }
</style>
