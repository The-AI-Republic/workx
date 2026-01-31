<script lang="ts">
  /**
   * ModelSelection component for chat input bar
   * Allows user to quickly select a model from the chat interface
   * Aggregates models from providers and groups by model name
   */
  import { onMount, createEventDispatcher } from 'svelte';
  import { AgentConfig } from '../../../../open_source/src/config/AgentConfig';
  import { userStore } from '../../stores/userStore';
  import { uiTheme, type UITheme } from '../../stores/themeStore';
  import Tooltip from '../common/Tooltip.svelte';
  import PopupCard from '../common/PopupCard.svelte';
  import { _t } from '../../lib/i18n';

  const dispatch = createEventDispatcher<{
    modelChanged: { modelId: string; modelName: string };
  }>();

  // State
  let isOpen = false;
  let isLoading = true;
  let selectedModelKey = '';
  let selectedModelName = '';
  let useOwnApiKey = false;
  let currentTheme: UITheme = 'terminal';

  // Model data
  interface ModelSelectionItem {
    modelId: string; // Composite key: "providerId:modelKey"
    modelName: string;
    modelKey: string;
    providerId: string;
    providerName: string;
    supportBackendMode?: number;
  }
  let modelSelectionItems: ModelSelectionItem[] = [];

  // Subscribe to stores
  $: isUserLoggedIn = $userStore.isLoggedIn;
  $: isFreeUser = $userStore.userType === 0;

  // Default model for free users (Kimi K2 Thinking)
  const FREE_USER_DEFAULT_MODEL = 'kimi-k2-thinking';
  const FREE_USER_DEFAULT_COMPOUND_KEY = 'fireworks:fireworks/models/kimi-k2-thinking';

  // Check if a model is available for free users
  function isModelAvailableForFreeUser(modelKey: string): boolean {
    return modelKey.toLowerCase().includes(FREE_USER_DEFAULT_MODEL);
  }

  uiTheme.subscribe((theme) => {
    currentTheme = theme;
  });

  // Filter models based on useOwnApiKey setting
  $: filteredModelItems = isUserLoggedIn && !useOwnApiKey
    ? modelSelectionItems.filter(item => (item.supportBackendMode ?? 0) > 0)
    : modelSelectionItems;

  // Group models by name
  interface GroupedModel {
    modelName: string;
    modelKey: string; // First provider's modelKey, used for free user check
    providers: Array<{
      modelId: string;
      modelKey: string;
      providerId: string;
      providerName: string;
    }>;
  }

  $: groupedModels = (() => {
    const groups = new Map<string, GroupedModel>();

    for (const item of filteredModelItems) {
      const existing = groups.get(item.modelName);
      if (existing) {
        // Check for duplicate provider before adding
        const isDuplicate = existing.providers.some(p => p.providerId === item.providerId);
        if (!isDuplicate) {
          existing.providers.push({
            modelId: item.modelId,
            modelKey: item.modelKey,
            providerId: item.providerId,
            providerName: item.providerName,
          });
        }
      } else {
        groups.set(item.modelName, {
          modelName: item.modelName,
          modelKey: item.modelKey,
          providers: [{
            modelId: item.modelId,
            modelKey: item.modelKey,
            providerId: item.providerId,
            providerName: item.providerName,
          }]
        });
      }
    }

    return Array.from(groups.values());
  })();

  // Get the selected model's group
  $: selectedGroup = groupedModels.find(g =>
    g.providers.some(p => p.modelId === selectedModelKey)
  );

  onMount(async () => {
    await loadModels();
  });

  async function loadModels() {
    try {
      isLoading = true;
      const config = await AgentConfig.getInstance();
      const agentConfig = config.getConfig();

      selectedModelKey = agentConfig.selectedModelKey;
      useOwnApiKey = agentConfig.preferences?.useOwnApiKey ?? false;

      // Build model selection array
      const tempModelItems: ModelSelectionItem[] = [];
      const providers = config.getProviders();

      for (const [providerId, provider] of Object.entries(providers)) {
        if (!provider.models || !Array.isArray(provider.models)) {
          continue;
        }

        for (const model of provider.models) {
          const compositeKey = `${providerId}:${model.modelKey}`;
          tempModelItems.push({
            modelId: compositeKey,
            modelName: model.name,
            modelKey: model.modelKey,
            providerId: provider.id,
            providerName: provider.name,
            supportBackendMode: model.supportBackendMode,
          });
        }
      }

      modelSelectionItems = tempModelItems;

      // If no model is selected, default to the free user model
      if (!selectedModelKey || selectedModelKey === '') {
        const freeUserDefault = modelSelectionItems.find(m => m.modelId === FREE_USER_DEFAULT_COMPOUND_KEY);
        if (freeUserDefault) {
          selectedModelKey = FREE_USER_DEFAULT_COMPOUND_KEY;
          await config.setSelectedModel(selectedModelKey);
          console.log('[ModelSelection] Set default model to:', selectedModelKey);
        } else if (modelSelectionItems.length > 0) {
          selectedModelKey = modelSelectionItems[0].modelId;
          await config.setSelectedModel(selectedModelKey);
          console.log('[ModelSelection] Free user default not found, using first model:', selectedModelKey);
        }
      }

      // Set the selected model name
      const selectedItem = modelSelectionItems.find(m => m.modelId === selectedModelKey);
      if (selectedItem) {
        selectedModelName = selectedItem.modelName;
      }
    } catch (error) {
      console.error('[ModelSelection] Failed to load models:', error);
    } finally {
      isLoading = false;
    }
  }

  function toggleDropdown(event?: MouseEvent) {
    if (event) {
      event.stopPropagation();
    }
    isOpen = !isOpen;
  }

  function closeDropdown() {
    isOpen = false;
  }

  async function selectModel(modelId: string, modelName: string, modelKey: string) {
    if (modelId === selectedModelKey) {
      isOpen = false;
      return;
    }

    // Block selection for free users trying to select premium models
    if (isUserLoggedIn && isFreeUser && !isModelAvailableForFreeUser(modelKey)) {
      // Model is locked for free users - don't allow selection
      return;
    }

    // Confirm model switch
    if (!confirm('The model switch will clear the current conversation. Do you want to continue?')) {
      isOpen = false;
      return;
    }

    try {
      const config = await AgentConfig.getInstance();
      await config.setSelectedModel(modelId);

      selectedModelKey = modelId;
      selectedModelName = modelName;
      isOpen = false;

      // Notify service worker
      chrome.runtime.sendMessage({ type: 'CONFIG_UPDATE' }).catch(() => {});

      dispatch('modelChanged', { modelId, modelName });
    } catch (error) {
      console.error('[ModelSelection] Failed to change model:', error);
    }
  }

  function handleKeyDown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      isOpen = false;
    }
  }
</script>

<svelte:window on:keydown={handleKeyDown} />

<div class="model-selection {currentTheme}">
  <PopupCard title="" show={isOpen} onClose={closeDropdown}>
    <div slot="trigger">
      <Tooltip content={$_t("Click to select a model")} disabled={isOpen}>
        <button
          type="button"
          class="model-trigger {currentTheme}"
          on:click={toggleDropdown}
          disabled={isLoading}
          aria-label="Select model: {selectedModelName}"
          aria-expanded={isOpen}
          aria-haspopup="listbox"
        >
          <span class="model-name">
            {#if isLoading}
              ...
            {:else}
              {selectedModelName || 'Select Model'}
            {/if}
          </span>
          <svg
            class="chevron-icon"
            class:rotate={isOpen}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>
      </Tooltip>
    </div>

    <div slot="content" class="model-dropdown-content {currentTheme}" role="listbox" aria-label="Available models">
      {#each groupedModels as group (group.modelName)}
        {@const isSelected = selectedGroup?.modelName === group.modelName}
        {@const hasMultipleProviders = group.providers.length > 1}
        {@const isLockedForFreeUser = isUserLoggedIn && isFreeUser && !isModelAvailableForFreeUser(group.modelKey)}

        <div class="model-item">
          {#if hasMultipleProviders}
            <!-- Model with multiple providers -->
            <div class="model-group" class:locked={isLockedForFreeUser}>
              <div class="model-group-header">
                <span class="group-name">{group.modelName}</span>
                {#if isLockedForFreeUser}
                  <svg class="lock-icon" viewBox="0 0 20 20" fill="currentColor">
                    <path fill-rule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clip-rule="evenodd" />
                  </svg>
                {:else if isSelected}
                  <svg class="check-icon" viewBox="0 0 20 20" fill="currentColor">
                    <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd" />
                  </svg>
                {/if}
              </div>
              {#if isLockedForFreeUser}
                <div class="locked-message">Upgrade to explore world's most powerful models</div>
              {:else}
                <div class="provider-options">
                  {#each group.providers as provider (provider.modelId)}
                    {@const isProviderSelected = provider.modelId === selectedModelKey}
                    <button
                      type="button"
                      class="provider-option"
                      class:selected={isProviderSelected}
                      on:click={() => selectModel(provider.modelId, group.modelName, provider.modelKey)}
                      role="option"
                      aria-selected={isProviderSelected}
                    >
                      {provider.providerName}
                    </button>
                  {/each}
                </div>
              {/if}
            </div>
          {:else}
            <!-- Model with single provider -->
            {#if isLockedForFreeUser}
              <Tooltip content={$_t("Upgrade your subscription to explore world's most powerful models")}>
                <button
                  type="button"
                  class="model-option locked"
                  disabled
                  role="option"
                  aria-selected={false}
                  aria-disabled="true"
                >
                  <span class="option-name">{group.modelName}</span>
                  <svg class="lock-icon" viewBox="0 0 20 20" fill="currentColor">
                    <path fill-rule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clip-rule="evenodd" />
                  </svg>
                </button>
              </Tooltip>
            {:else}
              <button
                type="button"
                class="model-option"
                class:selected={isSelected}
                on:click={() => selectModel(group.providers[0].modelId, group.modelName, group.providers[0].modelKey)}
                role="option"
                aria-selected={isSelected}
              >
                <span class="option-name">{group.modelName}</span>
                {#if isSelected}
                  <svg class="check-icon" viewBox="0 0 20 20" fill="currentColor">
                    <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd" />
                  </svg>
                {/if}
              </button>
            {/if}
          {/if}
        </div>
      {/each}
    </div>
  </PopupCard>
</div>

<style>
  .model-selection {
    position: relative;
    display: inline-flex;
  }

  /* ============================================
     Terminal Theme (default)
     ============================================ */

  .model-trigger {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    background: transparent;
    border: 1px solid var(--color-term-dim-green, #00cc00);
    border-radius: 4px;
    color: var(--color-term-green, #00ff00);
    font-size: 12px;
    font-family: 'Monaco', 'Courier New', monospace;
    cursor: pointer;
    transition: all 0.2s ease;
    max-width: 150px;
  }

  .model-trigger:hover:not(:disabled) {
    border-color: var(--color-term-bright-green, #33ff00);
    background: rgba(0, 255, 0, 0.05);
  }

  .model-trigger:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .model-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chevron-icon {
    width: 14px;
    height: 14px;
    flex-shrink: 0;
    transition: transform 0.2s ease;
  }

  .chevron-icon.rotate {
    transform: rotate(180deg);
  }

  /* Dropdown Content */
  .model-dropdown-content {
    min-width: 180px;
    max-width: 250px;
    max-height: 300px;
    overflow-y: auto;
  }

  .model-item {
    border-bottom: 1px solid rgba(0, 204, 0, 0.2);
  }

  .model-item:last-child {
    border-bottom: none;
  }

  .model-option {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 8px 12px;
    text-align: left;
    font-size: 12px;
    font-family: 'Monaco', 'Courier New', monospace;
    color: var(--color-term-dim-green, #00cc00);
    background: transparent;
    border: none;
    cursor: pointer;
    transition: background 0.15s ease;
  }

  .model-option:hover {
    background: rgba(0, 255, 0, 0.1);
    color: var(--color-term-green, #00ff00);
  }

  .model-option.selected {
    background: rgba(0, 255, 0, 0.15);
    color: var(--color-term-bright-green, #33ff00);
  }

  .model-group-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 8px 12px 4px 12px;
    text-align: left;
    font-size: 12px;
    font-family: 'Monaco', 'Courier New', monospace;
    color: var(--color-term-dim-green, #00cc00);
    background: transparent;
    border: none;
    cursor: default;
    font-weight: 500;
  }

  .group-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .provider-options {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 4px 12px 8px 12px;
  }

  .provider-option {
    padding: 4px 8px;
    font-size: 11px;
    font-family: 'Monaco', 'Courier New', monospace;
    background: transparent;
    border: 1px solid rgba(0, 204, 0, 0.4);
    border-radius: 3px;
    color: var(--color-term-dim-green, #00cc00);
    cursor: pointer;
    transition: all 0.15s ease;
  }

  .provider-option:hover {
    border-color: var(--color-term-green, #00ff00);
    background: rgba(0, 255, 0, 0.1);
  }

  .provider-option.selected {
    background: rgba(0, 255, 0, 0.2);
    border-color: var(--color-term-bright-green, #33ff00);
    color: var(--color-term-bright-green, #33ff00);
  }

  .option-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .check-icon {
    width: 14px;
    height: 14px;
    flex-shrink: 0;
    color: var(--color-term-bright-green, #33ff00);
  }

  .lock-icon {
    width: 14px;
    height: 14px;
    flex-shrink: 0;
    color: var(--color-term-dim-green, #666666);
  }

  /* Locked/greyed out styles for free users */
  .model-option.locked {
    opacity: 0.5;
    cursor: not-allowed;
    color: #666666;
  }

  .model-option.locked:hover {
    background: transparent;
  }

  .model-group.locked {
    opacity: 0.5;
  }

  .model-group.locked .model-group-header {
    color: #666666;
  }

  .locked-message {
    padding: 4px 12px 8px 12px;
    font-size: 10px;
    font-family: 'Monaco', 'Courier New', monospace;
    color: #888888;
    font-style: italic;
  }

  /* ============================================
     ChatGPT Theme Overrides
     ============================================ */

  .model-trigger.chatgpt {
    background: var(--chat-input-bg, #f4f4f4);
    border: 1px solid var(--chat-border, #e5e5e5);
    border-radius: 1rem;
    color: var(--chat-text, #0d0d0d);
    font-family: var(--font-chat, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
    font-size: 13px;
    padding: 6px 10px;
  }

  .model-trigger.chatgpt:hover:not(:disabled) {
    background: var(--chat-button-hover, #ececec);
    border-color: var(--chat-border, #e5e5e5);
  }

  .model-dropdown-content.chatgpt .model-item {
    border-bottom-color: rgba(255, 255, 255, 0.1);
  }

  .model-dropdown-content.chatgpt .model-option {
    font-family: var(--font-chat, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
    font-size: 13px;
    color: var(--chat-tooltip-text, #ffffff);
    padding: 10px 14px;
  }

  .model-dropdown-content.chatgpt .model-group-header {
    font-family: var(--font-chat, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
    font-size: 13px;
    color: var(--chat-tooltip-text, #ffffff);
    padding: 10px 14px 4px 14px;
  }

  .model-dropdown-content.chatgpt .model-option:hover {
    background: rgba(255, 255, 255, 0.1);
  }

  .model-dropdown-content.chatgpt .model-option.selected {
    background: rgba(96, 165, 250, 0.2);
    color: var(--chat-primary, #60a5fa);
  }

  .model-dropdown-content.chatgpt .provider-options {
    padding: 6px 14px 10px 14px;
  }

  .model-dropdown-content.chatgpt .provider-option {
    font-family: var(--font-chat, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
    font-size: 12px;
    background: rgba(255, 255, 255, 0.1);
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 1rem;
    color: rgba(255, 255, 255, 0.8);
    padding: 4px 10px;
  }

  .model-dropdown-content.chatgpt .provider-option:hover {
    background: rgba(255, 255, 255, 0.15);
    border-color: rgba(255, 255, 255, 0.3);
    color: var(--chat-tooltip-text, #ffffff);
  }

  .model-dropdown-content.chatgpt .provider-option.selected {
    background: rgba(96, 165, 250, 0.25);
    border-color: var(--chat-primary, #60a5fa);
    color: var(--chat-primary, #60a5fa);
  }

  .model-dropdown-content.chatgpt .check-icon {
    color: var(--chat-primary, #60a5fa);
  }

  .model-dropdown-content.chatgpt .lock-icon {
    color: rgba(255, 255, 255, 0.4);
  }

  .model-dropdown-content.chatgpt .model-option.locked {
    color: rgba(255, 255, 255, 0.4);
  }

  .model-dropdown-content.chatgpt .model-group.locked .model-group-header {
    color: rgba(255, 255, 255, 0.4);
  }

  .model-dropdown-content.chatgpt .locked-message {
    font-family: var(--font-chat, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
    color: rgba(255, 255, 255, 0.5);
    padding: 6px 14px 10px 14px;
  }
</style>
