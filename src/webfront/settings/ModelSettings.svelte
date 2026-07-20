<!--
  ModelSettings - Svelte component for model configuration
  Handles model selection, API key configuration, and provider settings
-->

<script lang="ts">
  import { onMount } from 'svelte';
  import type { AgentConfig } from '@/config/AgentConfig';
  import type { ConfiguredFeatures } from '@/config/types';
  import ModelSelector from './components/ModelSelector.svelte';
  import { userStore } from '../stores/userStore';
  import { LLM_API_URL } from '../lib/constants';
  import { t, _t } from '../lib/i18n';
  import { getInitializedUIClient } from '@/core/messaging';
  import type { AgentAccessState } from '@/core/services/runtime-state';
  import { highlightSetting } from './utils/highlightSetting';
  import './utils/highlight-pulse.css';
  import { platform } from '../stores/platformStore';
  import { FREE_USER_DEFAULT_COMPOUND_KEY, isModelAvailableForFreeUser } from '../lib/freeUserModels';

  let {
    settingsConfig,
    isDirty = $bindable(false),
    highlightSettingId = undefined as string | undefined,
    onBack,
    onSaved,
    onAuthUpdated,
    onNavigateToAdvanced,
  }: {
    settingsConfig: AgentConfig | null;
    isDirty?: boolean;
    highlightSettingId?: string | undefined;
    onBack?: () => void;
    onSaved?: (detail: { success: boolean; error?: string }) => void;
    onAuthUpdated?: (detail: { isAuthenticated: boolean; mode: 'login' | 'api_key' | null }) => void;
    onNavigateToAdvanced?: (detail: { modelId: string; providerId: string }) => void;
  } = $props();

  // Component state
  let apiKey = $state('');
  let maskedApiKey = $state('');
  let showApiKey = $state(false);
  let isInitializing = $state(true);
  let isSaving = $state(false);
  let isTesting = $state(false);
  let isModelSwitching = $state(false);
  let isClearingAuth = $state(false);
  let saveMessage = $state('');
  let saveMessageType: 'success' | 'error' | 'info' | '' = $state('');
  let testResult: { valid: boolean; error?: string } | null = $state(null);
  let isAuthenticated = $state(false);

  // Model configuration state - uses composite key format: "providerId:modelKey"
  let selectedModelKey = $state('');
  // Efficient model for internal app-logistics tasks (titles, summaries).
  // '' = same as task model. Constrained to the task model's provider.
  let efficientModelKey = $state('');
  let configuredFeatures: ConfiguredFeatures = $state({});
  let modelValidationError = $state('');
  let serviceTier: 'default' | 'flex' | 'priority' | undefined = $state(undefined);

  // Provider-aware API key display
  let currentProvider = $state('openai');
  let currentProviderName = $state('OpenAI');
  let currentProviderOrganization: string | null = $state(null);

  // Backend mode toggle
  let useOwnApiKey = $state(false);

  // API key validation warning (only show after save attempt)
  let showApiKeyWarning = $state(false);

  // ChatGPT OAuth state
  let chatgptOAuthConnected = $state(false);
  let chatgptOAuthSigningIn = $state(false);
  let chatgptOAuthError = $state('');

  // Custom endpoint (BYOK) form state
  let customName = $state('');
  let customBaseUrl = $state('');
  let customModelHandle = $state('');
  let customApiKey = $state('');
  let customApiFormat: 'chat_completions' | 'responses' = $state('chat_completions');
  let customContextWindow = $state(128000);
  let isAddingCustom = $state(false);
  let customError = $state('');
  interface CustomEndpointItem {
    id: string;
    name: string;
    baseUrl: string;
    modelKey: string;
    apiFormat: 'chat_completions' | 'responses';
  }
  let customEndpoints: CustomEndpointItem[] = $state([]);

  // Derived state from user store
  let isUserLoggedIn = $derived($userStore.isLoggedIn);
  let isFreeUser = $derived($userStore.userType === 0);

  // Model selection array
  interface ModelSelectionItem {
    modelId: string; // Composite key: "providerId:modelKey"
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
    supportBackendMode?: number;
    isCustom?: boolean;
    apiFormat?: 'chat_completions' | 'responses';
  }
  let modelSelectionItems: ModelSelectionItem[] = $state([]);

  // Filtered model items based on backend mode
  // supportBackendMode > 0 means the model supports backend routing
  let filteredModelItems = $derived(
    isUserLoggedIn && !useOwnApiKey
      // Custom (BYOK) endpoints are direct-only (supportBackendMode 0) but must
      // still be selectable in backend mode — they run on the user's own key.
      ? modelSelectionItems.filter(item => (item.supportBackendMode ?? 0) > 0 || item.isCustom)
      : modelSelectionItems
  );

  // Efficient-model candidates. Gateway routing (logged in, not using own
  // API key) routes any catalog model through one credential, so the provider
  // doesn't matter — offer everything the main selector offers. Own-API-key
  // mode requires the efficient model to share the task model's provider
  // (different providers mean different keys/endpoints).
  let efficientModelOptions = $derived(
    isUserLoggedIn && !useOwnApiKey
      ? filteredModelItems
      : filteredModelItems.filter(
          (item) => item.providerId === selectedModelKey.split(':')[0]
        )
  );

  // Displayed value: a stored selection that is no longer offered (e.g. a
  // cross-provider pick after switching the task model's provider in
  // own-API-key mode) renders as "Same as task model" — which matches the
  // factory's runtime fallback.
  let efficientModelDisplayValue = $derived(
    efficientModelOptions.some((item) => item.modelId === efficientModelKey)
      ? efficientModelKey
      : ''
  );

  // Highlight setting effect
  $effect(() => {
    if (highlightSettingId) {
      highlightSetting(highlightSettingId);
      highlightSettingId = undefined;
    }
  });

  async function handleChatGPTSignIn() {
    chatgptOAuthSigningIn = true;
    chatgptOAuthError = '';
    try {
      if (platform.platformName === 'desktop') {
        // Track 43: the runtime owns the OAuth callback HTTP server and the
        // token storage. The UI just asks for the auth URL, opens it, and
        // awaits completion.
        const client = await getInitializedUIClient();
        const { authUrl } = await client.serviceRequest<{ authUrl: string }>(
          'auth.chatgpt.startLogin',
        );
        const { open } = await import('@tauri-apps/plugin-shell');
        await open(authUrl);
        await client.serviceRequest('auth.chatgpt.awaitCompletion');
      } else {
        const { ChatGPTOAuthService } = await import('@/core/auth/ChatGPTOAuthService');
        const { ChatGPTOAuthExtensionFlow } = await import('@/extension/auth/ChatGPTOAuthExtensionFlow');
        const { ChatGPTOAuthExtensionStorage } = await import('@/extension/auth/ChatGPTOAuthExtensionStorage');
        const storage = new ChatGPTOAuthExtensionStorage();
        const oauthService = new ChatGPTOAuthService(storage);
        const flow = new ChatGPTOAuthExtensionFlow(oauthService);
        await flow.login();
      }
      chatgptOAuthConnected = true;

      // Update the stored provider config authMethod
      if (settingsConfig) {
        const config = settingsConfig.getConfig();
        const providerConfig = config.providers?.openai;
        if (providerConfig) {
          await settingsConfig.updateConfig({
            providers: {
              ...config.providers,
              openai: { ...providerConfig, authMethod: 'chatgpt_oauth' },
            },
          });
        }
      }
      getInitializedUIClient().then(c => c.serviceRequest('agent.configUpdate')).catch(err => console.warn('[ModelSettings] Failed to send configUpdate:', err));
    } catch (err: any) {
      if (err?.message?.includes('Failed to bind port 1455')) {
        chatgptOAuthError = t('Port 1455 is in use. Please close any application using this port and try again.');
      } else if (err?.message?.includes('timed out')) {
        // Timeout: silently reset to disconnected
        chatgptOAuthError = '';
      } else {
        chatgptOAuthError = err?.message || t('Sign in failed');
      }
    } finally {
      chatgptOAuthSigningIn = false;
    }
  }

  /**
   * Extension-only OAuth service factory. Desktop uses the runtime's
   * `auth.chatgpt.*` services instead (the runtime owns ChatGPT tokens
   * after Track 43's cutover).
   */
  async function getChatGPTOAuthService() {
    const { ChatGPTOAuthService } = await import('@/core/auth/ChatGPTOAuthService');
    if (platform.platformName === 'desktop') {
      throw new Error('Desktop ChatGPT OAuth runs in the runtime; call auth.chatgpt.* services instead');
    }
    const { ChatGPTOAuthExtensionStorage } = await import('@/extension/auth/ChatGPTOAuthExtensionStorage');
    return new ChatGPTOAuthService(new ChatGPTOAuthExtensionStorage());
  }

  async function handleChatGPTDisconnect() {
    try {
      if (platform.platformName === 'desktop') {
        const client = await getInitializedUIClient();
        await client.serviceRequest('auth.chatgpt.logout');
      } else {
        const oauthService = await getChatGPTOAuthService();
        await oauthService.logout();
      }
      chatgptOAuthConnected = false;

      // Revert authMethod to api_key
      if (settingsConfig) {
        const config = settingsConfig.getConfig();
        const providerConfig = config.providers?.openai;
        if (providerConfig) {
          await settingsConfig.updateConfig({
            providers: {
              ...config.providers,
              openai: { ...providerConfig, authMethod: 'api_key' },
            },
          });
        }
      }
      getInitializedUIClient().then(c => c.serviceRequest('agent.configUpdate')).catch(err => console.warn('[ModelSettings] Failed to send configUpdate:', err));
    } catch (err: any) {
      console.error('[ModelSettings] ChatGPT disconnect failed:', err);
    }
  }

  async function checkChatGPTOAuthStatus() {
    try {
      if (platform.platformName === 'desktop') {
        const client = await getInitializedUIClient();
        const { connected } = await client.serviceRequest<{ connected: boolean }>(
          'auth.chatgpt.isConnected',
        );
        chatgptOAuthConnected = connected;
        return;
      }
      const oauthService = await getChatGPTOAuthService();
      const isAuth = await oauthService.isAuthenticated();
      chatgptOAuthConnected = isAuth;

      // If connected, verify the token is still valid
      if (isAuth) {
        try {
          await oauthService.getValidAccessToken();
        } catch {
          // Token refresh failed — session expired
          chatgptOAuthConnected = false;
          chatgptOAuthError = t('ChatGPT session expired. Please sign in again.');
        }
      }
    } catch (err) {
      console.warn('[ModelSettings] ChatGPT OAuth status check failed:', err);
      chatgptOAuthConnected = false;
    }
  }

  // Load settings on mount
  onMount(() => {
    loadSettings();
    checkChatGPTOAuthStatus();
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
      selectedModelKey = config.selectedModelKey;
      efficientModelKey = config.efficientModelKey ?? '';
      console.log('[ModelSettings] loadSettings - selectedModelKey from config:', selectedModelKey);

      // Load useOwnApiKey preference (default false for logged-in users)
      useOwnApiKey = config.preferences?.useOwnApiKey ?? false;

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

          // Create composite key for model identification
          const compositeKey = `${providerId}:${model.modelKey}`;

          tempModelItems.push({
            modelId: compositeKey, // Use composite key as modelId
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
            selected: compositeKey === selectedModelKey,
            serviceTier: modelServiceTier,
            supportsReasoning: model.supportsReasoning,
            reasoningEfforts: model.reasoningEfforts,
            pricing: model.pricing,
            supportBackendMode: model.supportBackendMode,
            isCustom: provider.isCustom ?? false,
            apiFormat: provider.apiFormat === 'responses' ? 'responses' : 'chat_completions',
          });
        }
      }

      modelSelectionItems = tempModelItems;
      loadCustomEndpoints();
      console.log(
        '[ModelSettings] Available model IDs:',
        modelSelectionItems.map((m) => m.modelId)
      );

      // Validate selectedModelKey
      if (!selectedModelKey || selectedModelKey === '') {
        console.log('[ModelSettings] selectedModelKey is empty, selecting default model');
        if (modelSelectionItems.length > 0) {
          // For free users or when no model is selected, try to use the free user default model
          const freeUserDefault = modelSelectionItems.find(m => m.modelId === FREE_USER_DEFAULT_COMPOUND_KEY);
          if (freeUserDefault) {
            selectedModelKey = FREE_USER_DEFAULT_COMPOUND_KEY;
            console.log('[ModelSettings] Using free user default model:', selectedModelKey);
          } else {
            // Fallback to first available model if kimi-k2p6 not found
            selectedModelKey = modelSelectionItems[0].modelId;
            console.log('[ModelSettings] Free user default not found, using first model:', selectedModelKey);
          }
          await settingsConfig.setSelectedModel(selectedModelKey);
        } else {
          showMessage(t('No models available. Please check configuration.'), 'error');
          return;
        }
      }

      // Load data for selected model
      const selectedItem = modelSelectionItems.find((item) => item.modelId === selectedModelKey);
      console.log(
        '[ModelSettings] Looking for selectedModelKey:',
        selectedModelKey,
        'Found:',
        !!selectedItem
      );
      if (selectedItem) {
        loadModelData(selectedItem);
      } else if (modelSelectionItems.length > 0) {
        console.log(
          '[ModelSettings] selectedModelKey not found in items, falling back to first model!'
        );
        selectedModelKey = modelSelectionItems[0].modelId;
        await settingsConfig.setSelectedModel(selectedModelKey);
        loadModelData(modelSelectionItems[0]);
      }
    } catch (error) {
      console.error('[ModelSettings] Failed to load settings:', error);
      showMessage(t('Failed to load settings'), 'error');
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

    const defaultReasoningEffort =
      item.supportsReasoning && item.reasoningEfforts?.length ? 'medium' : null;

    configuredFeatures = {
      reasoningEffort: defaultReasoningEffort,
      reasoningSummary: undefined,
      verbosity: null,
      contextWindow: item.contextWindow,
      maxOutputTokens: item.maxOutputTokens,
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
    showApiKeyWarning = false; // Reset warning when user starts typing
  }

  function toggleApiKeyVisibility() {
    showApiKey = !showApiKey;
  }

  async function saveApiKey() {
    // Show warning if API key is empty when user clicks save
    if (!apiKey.trim()) {
      showApiKeyWarning = true;
      return;
    }
    if (isSaving || !settingsConfig) return;

    try {
      isSaving = true;
      await settingsConfig.setProviderApiKey(currentProvider, apiKey);

      // If ChatGPT OAuth was connected, disconnect it (mutual exclusivity)
      if (currentProvider === 'openai' && chatgptOAuthConnected) {
        await handleChatGPTDisconnect();
      }

      isAuthenticated = true;
      maskedApiKey = maskApiKey(apiKey);

      for (let i = 0; i < modelSelectionItems.length; i++) {
        if (modelSelectionItems[i].providerId === currentProvider) {
          modelSelectionItems[i].apiKey = apiKey;
        }
      }

      showMessage(t('API key saved successfully!'), 'success');

      getInitializedUIClient().then(c => c.serviceRequest('agent.configUpdate')).catch(err => console.warn('[ModelSettings] Failed to send configUpdate:', err));

      onAuthUpdated?.({ isAuthenticated: true, mode: 'api_key' });
    } catch (error) {
      console.error('[ModelSettings] Failed to save API key:', error);
      showMessage(t('Failed to save API key'), 'error');
    } finally {
      isSaving = false;
    }
  }

  /** Refresh the list of user-defined custom endpoints from the live config. */
  function loadCustomEndpoints() {
    if (!settingsConfig) return;
    const providers = settingsConfig.getProviders();
    customEndpoints = Object.values(providers)
      .filter((p) => p.isCustom)
      .map((p) => ({
        id: p.id,
        name: p.name,
        baseUrl: p.baseUrl || '',
        modelKey: p.models?.[0]?.modelKey || '',
        apiFormat: p.apiFormat === 'responses' ? 'responses' : 'chat_completions',
      }));
  }

  /**
   * Add a user-defined custom endpoint (BYOK). Modelled as a runtime provider
   * with a single model so it flows through the existing model picker, cost,
   * and credential machinery. The provider definition is persisted in full (see
   * IStoredConfig.customProviders); the key goes to the credential store.
   */
  async function addCustomEndpoint() {
    if (!settingsConfig || isAddingCustom) return;
    customError = '';

    const name = customName.trim();
    const baseUrl = customBaseUrl.trim();
    const modelKey = customModelHandle.trim();
    const key = customApiKey.trim();

    if (!name || !baseUrl || !modelKey || !key) {
      customError = t('Display name, API base URL, model handle, and API key are required.');
      return;
    }
    if (!/^https:\/\//i.test(baseUrl)) {
      customError = t('API base URL must start with https://');
      return;
    }
    try {
      // eslint-disable-next-line no-new
      new URL(baseUrl);
    } catch {
      customError = t('API base URL is not a valid URL.');
      return;
    }
    // Floor the context window so a tiny/empty value can't silently clamp
    // maxOutputTokens to an unusable size (e.g. user types 100 → 100-token cap).
    const requestedContext =
      typeof customContextWindow === 'number' && customContextWindow > 0 ? customContextWindow : 128000;
    const contextWindow = Math.max(4096, requestedContext);
    const maxOutputTokens = Math.min(16384, contextWindow);

    try {
      isAddingCustom = true;
      const id = `custom-${Date.now().toString(36)}`;

      settingsConfig.addProvider({
        id,
        name,
        apiKey: '',
        baseUrl,
        timeout: 30000,
        retryConfig: { maxRetries: 3, initialDelay: 1000, maxDelay: 10000, backoffMultiplier: 2 },
        isCustom: true,
        apiFormat: customApiFormat,
        models: [
          {
            name,
            modelKey,
            creator: 'Custom',
            contextWindow,
            maxOutputTokens,
            supportsReasoning: false,
            supportsImage: false,
            supportBackendMode: 0,
          },
        ],
      });

      if (key) {
        await settingsConfig.setProviderApiKey(id, key);
      }

      // Reset the form
      customName = '';
      customBaseUrl = '';
      customModelHandle = '';
      customApiKey = '';
      customApiFormat = 'chat_completions';
      customContextWindow = 128000;

      await loadSettings();
      loadCustomEndpoints();
      showMessage(t('Custom endpoint added.'), 'success');
      getInitializedUIClient()
        .then((c) => c.serviceRequest('agent.configUpdate'))
        .catch((err) => console.warn('[ModelSettings] Failed to send configUpdate:', err));
    } catch (error) {
      console.error('[ModelSettings] Failed to add custom endpoint:', error);
      customError = error instanceof Error ? error.message : t('Failed to add custom endpoint.');
    } finally {
      isAddingCustom = false;
    }
  }

  /** Remove a custom endpoint, switching away from it first if it is selected. */
  async function deleteCustomEndpoint(id: string) {
    if (!settingsConfig || isAddingCustom) return;
    try {
      isAddingCustom = true;

      // deleteProvider rejects removing the provider that hosts the selected
      // model, so switch to another available model first. For free users, the
      // fallback must itself be free-tier-allowed — otherwise we'd silently park
      // them on a premium model that every subsequent message fails on.
      if (selectedModelKey.startsWith(`${id}:`)) {
        const candidates = modelSelectionItems.filter((m) => !m.modelId.startsWith(`${id}:`));
        let fallback = candidates[0];
        if (isFreeUser) {
          fallback =
            candidates.find((m) => m.modelId === FREE_USER_DEFAULT_COMPOUND_KEY) ??
            candidates.find((m) => isModelAvailableForFreeUser(m.modelKey, m.isCustom)) ??
            candidates[0];
        }
        if (fallback) {
          await settingsConfig.setSelectedModel(fallback.modelId);
          selectedModelKey = fallback.modelId;
        }
      }

      await settingsConfig.deleteProviderApiKey(id).catch(() => {});
      settingsConfig.deleteProvider(id);

      await loadSettings();
      loadCustomEndpoints();
      showMessage(t('Custom endpoint removed.'), 'success');
      getInitializedUIClient()
        .then((c) => c.serviceRequest('agent.configUpdate'))
        .catch((err) => console.warn('[ModelSettings] Failed to send configUpdate:', err));
    } catch (error) {
      console.error('[ModelSettings] Failed to remove custom endpoint:', error);
      showMessage(t('Failed to remove custom endpoint.'), 'error');
    } finally {
      isAddingCustom = false;
    }
  }

  async function testConnection() {
    if (!apiKey.trim()) {
      showMessage(t('Please enter an API key first'), 'error');
      return;
    }

    try {
      isTesting = true;
      testResult = null;

      const selectedItem = modelSelectionItems.find((item) => item.modelId === selectedModelKey);
      if (!selectedItem) {
        testResult = { valid: false, error: t('Selected model configuration missing') };
        showMessage(t('Connection failed: selected model configuration missing'), 'error');
        return;
      }

      const providerId = selectedItem.providerId;
      const modelKey = selectedItem.modelKey;
      const baseUrl = selectedItem.baseUrl;
      const organization = selectedItem.organization;

      if (!baseUrl) {
        testResult = { valid: false, error: t('Base URL not configured for this provider') };
        showMessage(t('Connection failed: Base URL not configured'), 'error');
        return;
      }

      // Route the probe through the runtime (desktop sidecar / extension service
      // worker / server) rather than the webview. LLM provider APIs reject
      // browser-origin requests via CORS — and the Tauri webview cannot reach
      // them at all — so a direct in-webview fetch always failed on desktop. The
      // runtime makes the real call from Node where there is no CORS. The handler
      // is prompt-free where possible (lists models; falls back to one 1-token
      // completion only when a provider lacks a models endpoint).
      const client = await getInitializedUIClient();
      const result = await client.serviceRequest<{ valid: boolean; error?: string }>(
        'models.testConnection',
        {
          providerId,
          baseUrl,
          apiKey,
          model: modelKey,
          organization: organization ?? null,
          apiFormat: selectedItem.apiFormat ?? null,
          isCustom: selectedItem.isCustom ?? false,
        },
      );

      if (result.valid) {
        testResult = { valid: true };
        showMessage(t('Connection test successful!'), 'success');
      } else {
        const errorMsg = result.error || t('Network error');
        testResult = { valid: false, error: errorMsg };
        showMessage(t('Connection test failed: $1$', { substitutions: [errorMsg] }), 'error');
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : t('Network error');
      testResult = { valid: false, error: errorMsg };
      showMessage(t('Failed to test connection'), 'error');
    } finally {
      isTesting = false;
    }
  }

  async function clearAuth() {
    const providerName =
      currentProvider === 'openai'
        ? 'OpenAI'
        : currentProvider === 'xai'
          ? 'xAI'
          : currentProvider === 'anthropic'
            ? 'Anthropic'
            : currentProvider === 'google-ai-studio'
              ? 'Google AI Studio'
              : currentProvider === 'groq'
                ? 'Groq'
                : currentProvider;

    if (!confirm(t('Are you sure you want to remove your $1$ API key?', { substitutions: [providerName] }))) return;
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

      showMessage(t('$1$ API key removed successfully', { substitutions: [providerName] }), 'info');
      getInitializedUIClient().then(c => c.serviceRequest('agent.configUpdate')).catch(err => console.warn('[ModelSettings] Failed to send configUpdate:', err));
      onAuthUpdated?.({ isAuthenticated: false, mode: null });
    } catch (error) {
      showMessage(t('Failed to remove API key'), 'error');
    } finally {
      isClearingAuth = false;
    }
  }

  function showMessageFn(message: string, type: 'success' | 'error' | 'info') {
    saveMessage = message;
    saveMessageType = type;
    setTimeout(clearMessage, 5000);
  }
  // Keep the original name for all internal callers
  const showMessage = showMessageFn;

  function clearMessage() {
    saveMessage = '';
    saveMessageType = '';
  }

  function handleBack() {
    onBack?.();
  }

  async function handleUseOwnApiKeyToggle() {
    if (!settingsConfig || !isUserLoggedIn) return;

    try {
      const newValue = !useOwnApiKey;
      showApiKeyWarning = false; // Reset warning when switching modes

      // Send updated auth state to service worker
      // useOwnApiKey=false means route through backend
      const authPayload = {
        backendBaseUrl: newValue ? null : LLM_API_URL, // null when using own API key
        useOwnApiKey: newValue,
      };

      const response = await (await getInitializedUIClient()).serviceRequest<{
        success: boolean;
        access?: AgentAccessState;
      }>('agent.initAuth', authPayload);
      if (!response?.success) {
        throw new Error('Runtime rejected API mode update');
      }

      // Persist the user's preference after the runtime confirms the effective
      // access state. The runtime remains the source of truth for display.
      const config = settingsConfig.getConfig();
      await settingsConfig.updateConfig({
        preferences: {
          ...config.preferences,
          useOwnApiKey: newValue,
        },
      });
        useOwnApiKey = response.access ? response.access.mode === 'api_key' : newValue;

      getInitializedUIClient().then(c => c.serviceRequest('agent.configUpdate')).catch(err => console.warn('[ModelSettings] Failed to send configUpdate:', err));

      const message = newValue
        ? t('Switched to direct API mode. Please configure your API key.')
        : t('Switched to backend mode. LLM requests will route through AI Republic server.');
      showMessage(message, 'success');

      onAuthUpdated?.({
        isAuthenticated: isAuthenticated,
        mode: newValue ? 'api_key' : 'login',
      });
    } catch (error) {
      console.error('[ModelSettings] Failed to toggle useOwnApiKey:', error);
      showMessage(t('Failed to update API mode'), 'error');
    }
  }

  function handleKeydown(event: KeyboardEvent) {
    if (
      event.key === 'Enter' &&
      !isSaving &&
      !isModelSwitching &&
      !isClearingAuth &&
      !isInitializing
    ) {
      saveApiKey();
    }
  }

  async function handleModelChange(data: { modelId: string }) {
    if (!settingsConfig) return;

    try {
      isModelSwitching = true;
      const { modelId } = data;

      const selectedItem = modelSelectionItems.find((item) => item.modelId === modelId);
      if (!selectedItem) throw new Error('Model not found');

      if (selectedItem.supportsImage === false) {
        alert(
          t('Model "$1$" does not support image input. Some tools will be disabled.', { substitutions: [selectedItem.modelName] })
        );
      }

      selectedModelKey = modelId;
      loadModelData(selectedItem);
      modelValidationError = '';
      testResult = null;
      clearMessage();

      modelSelectionItems = modelSelectionItems.map((item) => ({
        ...item,
        selected: item.modelId === modelId,
      }));

      await settingsConfig.setSelectedModel(modelId);
      getInitializedUIClient().then(c => c.serviceRequest('agent.configUpdate')).catch(err => console.warn('[ModelSettings] Failed to send configUpdate:', err));

      const message = apiKey
        ? t('Model changed to $1$. Conversation preserved.', { substitutions: [selectedItem.modelName] })
        : t('Model changed to $1$. Please configure your API key.', { substitutions: [selectedItem.modelName] });
      showMessage(message, apiKey ? 'success' : 'info');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      showMessage(t('Failed to change model: $1$', { substitutions: [errorMessage] }), 'error');
      await loadSettings();
    } finally {
      isModelSwitching = false;
    }
  }

  function handleValidationError(event: CustomEvent) {
    const { errors } = event.detail;
    modelValidationError = errors.join('. ');
    showMessage(t('Cannot select model: $1$', { substitutions: [modelValidationError] }), 'error');
  }

  async function handleEfficientModelChange(event: Event) {
    if (!settingsConfig) return;

    try {
      const target = event.target as HTMLSelectElement;
      const newKey = target.value; // '' = same as task model
      await settingsConfig.setEfficientModel(newKey || null);
      efficientModelKey = newKey;
      getInitializedUIClient().then(c => c.serviceRequest('agent.configUpdate')).catch(err => console.warn('[ModelSettings] Failed to send configUpdate:', err));
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      showMessage(t('Failed to change efficient model: $1$', { substitutions: [errorMessage] }), 'error');
      // Restore the persisted value
      efficientModelKey = settingsConfig.getConfig().efficientModelKey ?? '';
    }
  }

  async function handleServiceTierChange(event: Event) {
    if (!settingsConfig) return;

    try {
      const target = event.target as HTMLSelectElement;
      const newServiceTier = target.value as 'default' | 'flex' | 'priority' | '';
      serviceTier = newServiceTier === '' ? undefined : newServiceTier;

      const modelData = settingsConfig.getModelByKey(selectedModelKey);
      if (modelData?.model) {
        const provider = settingsConfig.getProvider(modelData.provider.id);
        if (provider) {
          const modelIndex = provider.models.findIndex(
            (m) => m.modelKey === modelData.model.modelKey
          );
          if (modelIndex !== -1) {
            provider.models[modelIndex].serviceTier = serviceTier;
            settingsConfig.updateProvider(modelData.provider.id, { models: provider.models });
            getInitializedUIClient().then(c => c.serviceRequest('agent.configUpdate')).catch(err => console.warn('[ModelSettings] Failed to send configUpdate:', err));
            showMessage(t('Service tier updated to $1$', { substitutions: [serviceTier || 'default'] }), 'success');
          }
        }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      showMessage(t('Failed to update service tier: $1$', { substitutions: [errorMessage] }), 'error');
    }
  }

  function navigateToAdvancedConfig() {
    onNavigateToAdvanced?.({ modelId: selectedModelKey, providerId: currentProvider });
  }
</script>

<div class="model-settings">
  <button class="back-button" onclick={handleBack}>{@html '&#8592;'} {t("Back")}</button>

  <!-- Model Selection -->
  <div class="settings-section settings-card" data-setting-id="model-selection">
    <h3 class="section-title">{t("Model Selection")}</h3>
    <div class="form-group">
      <label class="form-label">{t("Choose AI Model")}</label>
      <ModelSelector
        selectedModel={selectedModelKey}
        modelSelectionItems={filteredModelItems}
        disabled={isInitializing || isSaving}
        onModelChange={handleModelChange}
      />
      <div class="help-text">{t("Select the AI model to use for conversations.")}</div>

      <!-- Efficient model: cheap model for internal tasks (titles, summaries).
           Gateway mode offers any model; own-API-key mode is same-provider
           only. '' = same as the task model. -->
      <div class="form-group" data-setting-id="efficient-model">
        <label for="efficient-model" class="form-label">{t("Efficient Model")}</label>
        <select
          id="efficient-model"
          value={efficientModelDisplayValue}
          onchange={handleEfficientModelChange}
          class="form-select"
          disabled={isInitializing || isSaving}
        >
          <option value="">{$_t("Auto (provider default)")}</option>
          {#each efficientModelOptions as item (item.modelId)}
            <option value={item.modelId}>{item.modelName}</option>
          {/each}
        </select>
        <div class="help-text">
          {#if isUserLoggedIn && !useOwnApiKey}
            {t("Lightweight model used for internal tasks like chat titles and summaries.")}
          {:else}
            {t("Lightweight model used for internal tasks like chat titles and summaries. Must be from the same provider as the task model.")}
          {/if}
        </div>
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
            <span class="provider-info-label">{t("Provider")}:</span>
            <span class="provider-info-value">{currentProviderName}</span>
          </span>
          <button class="more-config-btn" onclick={navigateToAdvancedConfig}>
            {t("More Config")} >>
          </button>
        </div>
        {#if currentProviderOrganization}
          <div class="provider-info-row">
            <span class="provider-info-left">
              <span class="provider-info-label">{t("Organization")}:</span>
              <span class="provider-info-value">{currentProviderOrganization}</span>
            </span>
          </div>
        {/if}
      </div>
    </div>
  </div>

  <!-- Use Own API Key Toggle (only shown when logged in) -->
  {#if isUserLoggedIn}
    <div class="settings-section settings-card" data-setting-id="use-own-api-key">
      <div class="toggle-row">
        <div class="toggle-info">
          <span class="toggle-label">{t("Use Own API Key")}</span>
          <span class="toggle-description">
            {useOwnApiKey
              ? t('LLM requests go directly to provider APIs')
              : t('LLM requests route through AI Republic backend')}
          </span>
        </div>
        <button
          class="toggle-switch {useOwnApiKey ? 'active' : ''}"
          onclick={handleUseOwnApiKeyToggle}
          aria-label={t("Toggle use own API key")}
        >
          <span class="toggle-slider"></span>
        </button>
      </div>
    </div>
  {/if}

  <!-- API Key Section -->
  <div class="settings-section settings-card">
    <div class="section-header">
      <h3 class="section-title">{t("API Key Configuration")}</h3>
      {#if isUserLoggedIn && !useOwnApiKey}
        <span class="auth-status backend-mode">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
          </svg>
          {t("Backend Mode")}
        </span>
      {:else if isAuthenticated}
        <span class="auth-status authenticated">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <polyline points="20,6 9,17 4,12"></polyline>
          </svg>
          {t("Connected")}
        </span>
      {:else}
        <span class="auth-status not-authenticated">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="15" y1="9" x2="9" y2="15"></line>
            <line x1="9" y1="9" x2="15" y2="15"></line>
          </svg>
          {t("Not Connected")}
        </span>
      {/if}
    </div>

    <!-- ChatGPT OAuth Section (OpenAI only, direct API mode) -->
    {#if currentProvider === 'openai' && (!isUserLoggedIn || useOwnApiKey)}
      <div class="form-group chatgpt-oauth-section">
        <label class="form-label">{t("ChatGPT Subscription")}</label>
        {#if chatgptOAuthConnected}
          <div class="chatgpt-oauth-status connected">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--success-color, #4ade80)" stroke-width="2">
              <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
              <polyline points="22 4 12 14.01 9 11.01"></polyline>
            </svg>
            <span>{t("Connected via ChatGPT")}</span>
            <button class="btn btn-secondary btn-sm" onclick={handleChatGPTDisconnect}>
              {t("Disconnect")}
            </button>
          </div>
        {:else if chatgptOAuthSigningIn}
          <div class="chatgpt-oauth-status signing-in">
            <svg class="spinner" width="16" height="16" viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="31.416" stroke-dashoffset="10" />
            </svg>
            <span>{t("Signing in...")}</span>
          </div>
        {:else}
          <div class="chatgpt-oauth-status disconnected">
            <button class="btn btn-primary" onclick={handleChatGPTSignIn} disabled={isInitializing}>
              {t("Sign in with ChatGPT")}
            </button>
            <div class="help-text">{t("Use your ChatGPT Plus/Pro subscription instead of an API key")}</div>
          </div>
        {/if}
        {#if chatgptOAuthError}
          <div class="message error">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="12" y1="8" x2="12" y2="12"></line>
              <line x1="12" y1="16" x2="12.01" y2="16"></line>
            </svg>
            {chatgptOAuthError}
          </div>
        {/if}
      </div>

      <div class="form-divider">
        <span class="divider-text">{t("or")}</span>
      </div>
    {/if}

    <div class="form-group">
      <label for="api-key" class="form-label">
        {$_t("$1$ API Key", { substitutions: [currentProviderName] })}
      </label>
      <div class="input-group">
        {#if showApiKey}
          <input
            id="api-key"
            type="text"
            bind:value={apiKey}
            oninput={handleApiKeyInput}
            onkeydown={handleKeydown}
            placeholder={isAuthenticated
              ? maskedApiKey
              : currentProvider === 'xai'
                ? 'xai-...'
                : currentProvider === 'anthropic'
                  ? 'sk-ant-...'
                  : currentProvider === 'groq'
                    ? 'gsk_...'
                    : 'sk-...'}
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
            oninput={handleApiKeyInput}
            onkeydown={handleKeydown}
            placeholder={isAuthenticated
              ? maskedApiKey
              : currentProvider === 'xai'
                ? 'xai-...'
                : currentProvider === 'anthropic'
                  ? 'sk-ant-...'
                  : currentProvider === 'groq'
                    ? 'gsk_...'
                    : 'sk-...'}
            class="api-key-input"
            disabled={isInitializing || isSaving}
            autocomplete="off"
            spellcheck="false"
          />
        {/if}
        <button
          type="button"
          class="visibility-toggle"
          onclick={toggleApiKeyVisibility}
          aria-label={showApiKey ? t('Hide API key') : t('Show API key')}
        >
          {#if showApiKey}
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <path
                d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"
              ></path>
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
        {#if isUserLoggedIn && !useOwnApiKey}
          {t("Chat uses backend routing. An OpenAI key here is still needed for Agent Memory.")}
        {:else}
          {t("Enter your LLM API key")}
        {/if}
      </div>

      {#if showApiKeyWarning && !apiKey.trim()}
        <div class="message warning">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="12" y1="8" x2="12" y2="12"></line>
            <line x1="12" y1="16" x2="12.01" y2="16"></line>
          </svg>
          {t("Please input a valid API key.")}
        </div>
      {/if}
    </div>

    <!-- Service Tier Selection (OpenAI only) -->
    {#if currentProvider === 'openai'}
      <div class="form-group">
        <label for="service-tier" class="form-label">{t("Service Tier")}</label>
        <select
          id="service-tier"
          bind:value={serviceTier}
          onchange={handleServiceTierChange}
          class="form-select"
          disabled={isInitializing || isSaving || (isUserLoggedIn && !useOwnApiKey)}
        >
          <option value="default">{$_t("Default")}</option>
          <option value="flex">{$_t("Flex")}</option>
          <option value="priority">{$_t("Priority")}</option>
        </select>
        <div class="help-text">
          {t("Priority tier provides faster response times with higher pricing.")}
        </div>
      </div>
    {/if}

    <!-- Action Buttons -->
    <div class="button-group">
      <button
        class="btn btn-primary"
        onclick={saveApiKey}
        disabled={isInitializing || isSaving || !apiKey.trim() || (isUserLoggedIn && !useOwnApiKey)}
      >
        {#if isSaving}
          <svg class="spinner" width="16" height="16" viewBox="0 0 24 24">
            <circle
              cx="12"
              cy="12"
              r="10"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-dasharray="31.416"
              stroke-dashoffset="31.416"
            >
              <animate
                attributeName="stroke-dasharray"
                dur="2s"
                values="0 31.416;15.708 15.708;0 31.416"
                repeatCount="indefinite"
              />
              <animate
                attributeName="stroke-dashoffset"
                dur="2s"
                values="0;-15.708;-31.416"
                repeatCount="indefinite"
              />
            </circle>
          </svg>
          {t("Saving...")}
        {:else}
          {t("Save API Key")}
        {/if}
      </button>

      <button
        class="btn btn-secondary"
        onclick={testConnection}
        disabled={isTesting || !apiKey.trim() || (isUserLoggedIn && !useOwnApiKey)}
      >
        {#if isTesting}
          <svg class="spinner" width="16" height="16" viewBox="0 0 24 24">
            <circle
              cx="12"
              cy="12"
              r="10"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-dasharray="31.416"
              stroke-dashoffset="31.416"
            >
              <animate
                attributeName="stroke-dasharray"
                dur="2s"
                values="0 31.416;15.708 15.708;0 31.416"
                repeatCount="indefinite"
              />
              <animate
                attributeName="stroke-dashoffset"
                dur="2s"
                values="0;-15.708;-31.416"
                repeatCount="indefinite"
              />
            </circle>
          </svg>
          {t("Testing...")}
        {:else}
          {t("Test Connection")}
        {/if}
      </button>

      {#if isAuthenticated && (!isUserLoggedIn || useOwnApiKey)}
        <button
          class="btn btn-danger"
          onclick={clearAuth}
          disabled={isInitializing || isSaving || (isUserLoggedIn && !useOwnApiKey)}
        >
          {t("Remove API Key")}
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
        {testResult.valid ? $_t('Connection successful!') : $_t('Connection failed: $1$', { substitutions: [testResult.error] })}
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

  <!-- Custom Endpoints (BYOK) -->
  <div class="settings-section settings-card">
    <h3 class="section-title">{t("Custom Endpoints")}</h3>
    <p class="custom-help">
      {t("Add any OpenAI-compatible LLM endpoint with your own API key. Added models appear in the model picker above and run on your own key and billing.")}
    </p>

    {#if customEndpoints.length > 0}
      <div class="custom-list">
        {#each customEndpoints as ep (ep.id)}
          <div class="custom-item">
            <div class="custom-item-info">
              <div class="custom-item-name">{ep.name}</div>
              <div class="custom-item-meta">
                {ep.modelKey} · {ep.baseUrl} · {ep.apiFormat === 'responses' ? t('Responses API') : t('Chat Completions')}
              </div>
            </div>
            <button
              type="button"
              class="btn btn-danger btn-sm"
              onclick={() => deleteCustomEndpoint(ep.id)}
              disabled={isAddingCustom}
            >
              {t("Remove")}
            </button>
          </div>
        {/each}
      </div>
    {/if}

    <div class="form-group">
      <label class="form-label" for="custom-name">{t("Display name")}</label>
      <input
        id="custom-name"
        class="api-key-input"
        bind:value={customName}
        placeholder={t("My LLM")}
        disabled={isAddingCustom}
        autocomplete="off"
      />
    </div>
    <div class="form-group">
      <label class="form-label" for="custom-base-url">{t("API base URL")}</label>
      <input
        id="custom-base-url"
        class="api-key-input"
        bind:value={customBaseUrl}
        placeholder="https://api.example.com/v1"
        disabled={isAddingCustom}
        autocomplete="off"
        spellcheck="false"
      />
    </div>
    <div class="form-group">
      <label class="form-label" for="custom-model">{t("Model handle")}</label>
      <input
        id="custom-model"
        class="api-key-input"
        bind:value={customModelHandle}
        placeholder="model-name"
        disabled={isAddingCustom}
        autocomplete="off"
        spellcheck="false"
      />
    </div>
    <div class="form-group">
      <label class="form-label" for="custom-key">{t("API key")}</label>
      <input
        id="custom-key"
        type="password"
        class="api-key-input"
        bind:value={customApiKey}
        placeholder="sk-..."
        disabled={isAddingCustom}
        autocomplete="off"
        spellcheck="false"
      />
    </div>
    <div class="form-row">
      <div class="form-group form-group-half">
        <label class="form-label" for="custom-format">{t("API format")}</label>
        <select id="custom-format" class="api-key-input" bind:value={customApiFormat} disabled={isAddingCustom}>
          <option value="chat_completions">{t("Chat Completions (recommended)")}</option>
          <option value="responses">{t("Responses API")}</option>
        </select>
      </div>
      <div class="form-group form-group-half">
        <label class="form-label" for="custom-ctx">{t("Context window")}</label>
        <input
          id="custom-ctx"
          type="number"
          min="1"
          class="api-key-input"
          bind:value={customContextWindow}
          disabled={isAddingCustom}
        />
      </div>
    </div>

    {#if customError}
      <div class="message error">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor">
          <circle cx="12" cy="12" r="10"></circle>
          <line x1="15" y1="9" x2="9" y2="15"></line>
          <line x1="9" y1="9" x2="15" y2="15"></line>
        </svg>
        {customError}
      </div>
    {/if}

    <div class="button-group">
      <button type="button" class="btn btn-primary" onclick={addCustomEndpoint} disabled={isAddingCustom}>
        {isAddingCustom ? t("Adding...") : t("Add Endpoint")}
      </button>
    </div>
  </div>

  <!-- Security Notice -->
  <div class="settings-section settings-card">
    <h3 class="section-title">{t("Security & Privacy")}</h3>
    {#if isUserLoggedIn && !useOwnApiKey}
      <div class="security-notice backend-notice">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
        </svg>
        <div>
          <div class="security-title">{t("Backend Mode Active")}</div>
          <div class="security-text">
            {t("The agent is currently using backend mode. LLM requests will route through AI Republic server. Your conversations are processed securely through our infrastructure.")}
          </div>
        </div>
      </div>
    {:else}
      <div class="security-notice">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
        </svg>
        <div>
          <div class="security-title">{t("Your API key is encrypted")}</div>
          <div class="security-text">
            {t("API keys are encrypted and stored locally in your browser. They are never sent to external servers except for API calls.")}
          </div>
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  .model-settings {
    padding: 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .back-button {
    background: none;
    border: none;
    color: var(--workx-primary);
    cursor: pointer;
    font-size: var(--text-sm);
    line-height: var(--text-sm--line-height);
    font-weight: var(--font-weight-medium);
    padding: 0.5rem 0;
    display: flex;
    align-items: center;
    gap: 0.25rem;
    transition: opacity 0.2s;
  }

  .back-button:hover {
    opacity: 0.8;
  }

  .settings-section {
    margin-bottom: 0;
  }

  .settings-card {
    background: var(--workx-surface);
    border-radius: 0.75rem;
    padding: 1rem 1.25rem;
    border: 1px solid var(--workx-border);
  }

  .section-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
  }

  .section-title {
    margin: 0 0 1rem 0;
    font-size: var(--text-lg);
    line-height: var(--text-lg--line-height);
    font-weight: var(--font-weight-semibold);
    color: var(--workx-text);
  }

  .section-header .section-title {
    margin-bottom: 0;
  }

  .auth-status {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: var(--text-sm);
    line-height: var(--text-sm--line-height);
    padding: 0.25rem 0.75rem;
    border-radius: 9999px;
    font-weight: var(--font-weight-medium);
  }

  .auth-status.authenticated {
    color: var(--workx-success);
    background: color-mix(in srgb, var(--workx-success) 10%, transparent);
  }

  .auth-status.not-authenticated {
    color: var(--workx-error);
    background: color-mix(in srgb, var(--workx-error) 10%, transparent);
  }

  .form-group {
    margin-bottom: 1.5rem;
  }

  .form-label {
    display: block;
    margin-bottom: 0.5rem;
    font-size: var(--text-sm);
    line-height: var(--text-sm--line-height);
    font-weight: var(--font-weight-medium);
    color: var(--workx-text);
  }

  .input-group {
    position: relative;
    display: flex;
  }

  .api-key-input {
    flex: 1;
    padding: 0.75rem 3rem 0.75rem 0.75rem;
    border: 1px solid var(--workx-border);
    border-radius: 0.5rem;
    background: var(--workx-surface);
    color: var(--workx-text);
    font-size: var(--text-sm);
    line-height: var(--text-sm--line-height);
    font-family: var(--font-mono);
    transition: all 0.2s;
  }

  .api-key-input:focus {
    outline: none;
    border-color: var(--workx-primary);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--workx-primary) 10%, transparent);
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
    color: var(--workx-text-secondary);
    cursor: pointer;
    padding: 0.25rem;
    border-radius: 0.25rem;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: color 0.2s;
  }

  .visibility-toggle:hover {
    color: var(--workx-text);
  }

  .form-select {
    width: 100%;
    padding: 0.75rem;
    border: 1px solid var(--workx-border);
    border-radius: 0.5rem;
    background: var(--workx-surface);
    color: var(--workx-text);
    font-size: var(--text-sm);
    line-height: var(--text-sm--line-height);
    cursor: pointer;
    transition: all 0.2s;
  }

  .form-select:focus {
    outline: none;
    border-color: var(--workx-primary);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--workx-primary) 10%, transparent);
  }

  .form-select:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .help-text {
    margin-top: 0.5rem;
    font-size: var(--text-sm);
    line-height: var(--text-sm--line-height);
    color: var(--workx-text-secondary);
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
    font-size: var(--text-sm);
    line-height: var(--text-sm--line-height);
    font-weight: var(--font-weight-medium);
    cursor: pointer;
    transition: all 0.2s;
    border: 1px solid var(--workx-primary);
    background: transparent;
    color: var(--workx-primary);
  }

  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .btn:hover:not(:disabled) {
    background: color-mix(in srgb, var(--workx-primary) 15%, transparent);
  }

  /* Modern Chat theme - filled buttons */
  :global(.settings-modal-container.modern) .btn-primary {
    background: var(--workx-primary);
    color: white;
    border: none;
  }

  :global(.settings-modal-container.modern) .btn-primary:hover:not(:disabled) {
    background: color-mix(in srgb, var(--workx-primary) 85%, black);
  }

  .btn-secondary {
    background: var(--workx-surface);
    color: var(--workx-text);
    border: 1px solid var(--workx-border);
  }

  .btn-secondary:hover:not(:disabled) {
    background: color-mix(in srgb, var(--workx-surface) 80%, var(--workx-text));
  }

  .btn-danger {
    background: var(--workx-error);
    color: white;
  }

  .btn-danger:hover:not(:disabled) {
    background: color-mix(in srgb, var(--workx-error) 90%, black);
  }

  .spinner {
    animation: spin 1s linear infinite;
  }

  @keyframes spin {
    from {
      transform: rotate(0deg);
    }
    to {
      transform: rotate(360deg);
    }
  }

  .test-result,
  .message {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.75rem;
    border-radius: 0.5rem;
    font-size: var(--text-sm);
    line-height: var(--text-sm--line-height);
    margin-top: 1rem;
  }

  .test-result.success,
  .message.success {
    color: var(--workx-success);
    background: color-mix(in srgb, var(--workx-success) 10%, transparent);
  }

  .test-result.error,
  .message.error {
    color: var(--workx-error);
    background: color-mix(in srgb, var(--workx-error) 10%, transparent);
  }

  .message.info {
    color: var(--workx-primary);
    background: color-mix(in srgb, var(--workx-primary) 10%, transparent);
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
    background: var(--workx-surface);
    border: 1px solid var(--workx-border);
  }

  .security-notice svg {
    color: var(--workx-primary);
    flex-shrink: 0;
    margin-top: 0.125rem;
  }

  .security-title {
    font-weight: var(--font-weight-semibold);
    margin-bottom: 0.25rem;
    color: var(--workx-text);
  }

  .security-text {
    font-size: var(--text-sm);
    color: var(--workx-text-secondary);
    line-height: var(--leading-normal);
  }

  /* Provider Information */
  .provider-info-container {
    margin-top: 1rem;
    padding: 0.75rem;
    background: var(--workx-surface);
    border: 1px solid var(--workx-border);
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
    border-bottom: 1px solid var(--workx-border);
  }

  .provider-info-left {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .provider-info-label {
    font-size: var(--text-sm);
    line-height: var(--text-sm--line-height);
    font-weight: var(--font-weight-medium);
    color: var(--workx-text-secondary);
    flex-shrink: 0;
  }

  .provider-info-value {
    font-size: var(--text-sm);
    line-height: var(--text-sm--line-height);
    font-weight: var(--font-weight-semibold);
    color: var(--workx-text);
    max-width: 150px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .more-config-btn {
    background: none;
    border: none;
    color: var(--workx-primary);
    cursor: pointer;
    font-size: var(--text-sm);
    line-height: var(--text-sm--line-height);
    font-weight: var(--font-weight-medium);
    padding: 0.25rem 0.5rem;
    border-radius: 0.25rem;
    transition: all 0.2s;
  }

  .more-config-btn:hover {
    background: color-mix(in srgb, var(--workx-primary) 10%, transparent);
  }

  /* Toggle Switch Styles */
  .toggle-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 0.75rem;
    background: var(--workx-surface);
    border: 1px solid var(--workx-border);
    border-radius: 0.5rem;
  }

  .toggle-info {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .toggle-label {
    font-size: var(--text-sm);
    line-height: var(--text-sm--line-height);
    font-weight: var(--font-weight-semibold);
    color: var(--workx-text);
  }

  .toggle-description {
    font-size: var(--text-sm);
    line-height: var(--text-sm--line-height);
    color: var(--workx-text-secondary);
  }

  .toggle-switch {
    position: relative;
    width: 44px;
    height: 24px;
    background: var(--workx-border);
    border: none;
    border-radius: 12px;
    cursor: pointer;
    transition: background 0.2s;
    padding: 0;
  }

  .toggle-switch.active {
    background: var(--workx-primary);
  }

  .toggle-slider {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 20px;
    height: 20px;
    background: white;
    border-radius: 50%;
    transition: transform 0.2s;
    box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
  }

  .toggle-switch.active .toggle-slider {
    transform: translateX(20px);
  }

  /* Disabled Section Styles */
  .disabled-section {
    opacity: 0.6;
    pointer-events: none;
  }

  .disabled-section .section-header,
  .disabled-section .form-group {
    pointer-events: auto;
  }

  .disabled-input {
    cursor: not-allowed;
  }

  .disabled-input input {
    cursor: not-allowed;
    background: var(--workx-background);
  }

  /* Backend Mode Status */
  .auth-status.backend-mode {
    color: var(--workx-primary);
    background: color-mix(in srgb, var(--workx-primary) 10%, transparent);
  }

  .security-notice.backend-notice {
    border-color: var(--workx-primary);
    background: color-mix(in srgb, var(--workx-primary) 5%, var(--workx-surface));
  }

  .security-notice.backend-notice svg {
    color: var(--workx-primary);
  }

  /* ChatGPT OAuth styles */
  .chatgpt-oauth-section {
    margin-bottom: 0.5rem;
  }

  .chatgpt-oauth-status {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem 0;
  }

  .chatgpt-oauth-status.connected {
    color: var(--success-color, #4ade80);
  }

  .chatgpt-oauth-status.signing-in {
    color: var(--workx-text-secondary);
  }

  .chatgpt-oauth-status .btn-sm {
    padding: 0.25rem 0.5rem;
    font-size: var(--text-sm);
    line-height: var(--text-sm--line-height);
    margin-left: auto;
  }

  .form-divider {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin: 0.5rem 0;
    color: var(--workx-text-secondary);
  }

  .form-divider::before,
  .form-divider::after {
    content: '';
    flex: 1;
    border-top: 1px solid var(--workx-border);
  }

  .divider-text {
    font-size: var(--text-xs);
    line-height: var(--text-xs--line-height);
    text-transform: uppercase;
    letter-spacing: var(--tracking-wider);
  }

  /* Custom endpoints (BYOK) */
  .custom-help {
    margin: 0 0 1rem 0;
    font-size: var(--text-sm);
    color: var(--workx-text-secondary, var(--workx-text));
    opacity: 0.8;
    line-height: var(--leading-ui);
  }

  .custom-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin-bottom: 1rem;
  }

  .custom-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.625rem 0.75rem;
    border: 1px solid var(--workx-border);
    border-radius: 0.5rem;
    background: var(--workx-surface);
  }

  .custom-item-info {
    min-width: 0;
  }

  .custom-item-name {
    font-size: var(--text-sm);
    line-height: var(--text-sm--line-height);
    font-weight: var(--font-weight-semibold);
    color: var(--workx-text);
  }

  .custom-item-meta {
    font-size: var(--text-meta);
    line-height: var(--text-meta--line-height);
    color: var(--workx-text-secondary, var(--workx-text));
    opacity: 0.75;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .form-row {
    display: flex;
    gap: 0.75rem;
  }

  .form-group-half {
    flex: 1 1 0;
    min-width: 0;
  }

  .btn-sm {
    padding: 0.35rem 0.7rem;
    font-size: var(--text-sm);
    line-height: var(--text-sm--line-height);
    flex-shrink: 0;
  }
</style>
