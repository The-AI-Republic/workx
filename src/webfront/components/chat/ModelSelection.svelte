<script lang="ts">
  /**
   * ModelSelection component for chat input bar
   * Allows user to quickly select a model from the chat interface
   * Aggregates models from providers and groups by model name
   */
  import { onMount } from 'svelte';
  import { AgentConfig } from '@/config/AgentConfig';
  import { userStore } from '../../stores/userStore';
  import { uiTheme } from '../../stores/themeStore';
  import { selectedModelKey as modelKeyStore } from '../../stores/modelStore';
  import Tooltip from '../common/Tooltip.svelte';
  import PopupCard from '../common/PopupCard.svelte';
  import { t, _t } from '../../lib/i18n';
  import { FREE_USER_DEFAULT_COMPOUND_KEY, isModelAvailableForFreeUser } from '../../lib/freeUserModels';
  import { getInitializedUIClient } from '@/core/messaging';
  import { registerShortcut, registerShortcutContext } from '../../shortcuts/useShortcut';

  let { onModelChanged }: {
    onModelChanged?: (value: { modelId: string; modelName: string }) => void;
  } = $props();

  // State
  let isOpen = $state(false);
  let isLoading = $state(true);
  let useOwnApiKey = $state(false);
  let currentTheme = $derived($uiTheme);

  // Reactive selected model — backed by AgentConfig 'config-changed' events so
  // changes made elsewhere (e.g. ModelSettings) are reflected here without a remount.
  let selectedModelKey = $derived($modelKeyStore);

  // Model data
  interface ModelSelectionItem {
    modelId: string; // Composite key: "providerId:modelKey"
    modelName: string;
    modelKey: string;
    providerId: string;
    providerName: string;
    supportBackendMode?: number;
    isCustom?: boolean;
  }
  let modelSelectionItems: ModelSelectionItem[] = $state([]);

  // Derived name lookup — recomputes whenever selectedModelKey or modelSelectionItems change.
  let selectedModelName = $derived(
    modelSelectionItems.find((m) => m.modelId === selectedModelKey)?.modelName ?? ''
  );

  // Subscribe to stores
  let isUserLoggedIn = $derived($userStore.isLoggedIn);
  let isFreeUser = $derived($userStore.userType === 0);


  // Filter models based on useOwnApiKey setting
  let filteredModelItems = $derived(isUserLoggedIn && !useOwnApiKey
    ? modelSelectionItems.filter(item => (item.supportBackendMode ?? 0) > 0)
    : modelSelectionItems);

  // Group models by name
  interface GroupedModel {
    modelName: string;
    modelKey: string; // First provider's modelKey, used for free user check
    isCustom: boolean; // True for user-defined custom endpoints (BYOK) — bypass free-tier lock
    providers: Array<{
      modelId: string;
      modelKey: string;
      providerId: string;
      providerName: string;
    }>;
  }

  let groupedModels = $derived((() => {
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
          isCustom: item.isCustom ?? false,
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
  })());

  // Get the selected model's group
  let selectedGroup = $derived(groupedModels.find(g =>
    g.providers.some(p => p.modelId === selectedModelKey)
  ));

  onMount(async () => {
    await loadModels();
  });

  async function loadModels() {
    try {
      isLoading = true;
      const config = await AgentConfig.getInstance();
      const agentConfig = config.getConfig();

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
            isCustom: provider.isCustom ?? false,
          });
        }
      }

      modelSelectionItems = tempModelItems;

      // If no model is selected, fall back to the free user default (or first
      // available). setSelectedModel fires a 'model' change event, which the
      // modelStore picks up — selectedModelKey updates reactively.
      const currentKey = agentConfig.selectedModelKey;
      if (!currentKey || currentKey === '') {
        const freeUserDefault = modelSelectionItems.find(m => m.modelId === FREE_USER_DEFAULT_COMPOUND_KEY);
        if (freeUserDefault) {
          await config.setSelectedModel(FREE_USER_DEFAULT_COMPOUND_KEY);
          console.log('[ModelSelection] Set default model to:', FREE_USER_DEFAULT_COMPOUND_KEY);
        } else if (modelSelectionItems.length > 0) {
          const firstId = modelSelectionItems[0].modelId;
          await config.setSelectedModel(firstId);
          console.log('[ModelSelection] Free user default not found, using first model:', firstId);
        }
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

  async function selectModel(modelId: string, modelName: string, modelKey: string, isCustom = false) {
    if (modelId === selectedModelKey) {
      isOpen = false;
      return;
    }

    // Block selection for free users trying to select premium models
    if (isUserLoggedIn && isFreeUser && !isModelAvailableForFreeUser(modelKey, isCustom)) {
      // Model is locked for free users - don't allow selection
      return;
    }

    try {
      const config = await AgentConfig.getInstance();
      await config.setSelectedModel(modelId);
      // selectedModelKey / selectedModelName update reactively via modelStore

      isOpen = false;

      // Notify backend of config update
      getInitializedUIClient().then(c => c.serviceRequest('agent.configUpdate')).catch(e => console.warn('[messaging] config update failed:', e));

      onModelChanged?.({ modelId, modelName });
    } catch (error) {
      console.error('[ModelSelection] Failed to change model:', error);
    }
  }

  $effect(() => {
    const unregisterContext = registerShortcutContext('ModelPicker', { active: () => isOpen });
    const unregisterDismiss = registerShortcut('modelPicker:dismiss', 'ModelPicker', () => {
      isOpen = false;
    });

    return () => {
      unregisterContext();
      unregisterDismiss();
    };
  });
</script>

<div class="relative inline-flex">
  <PopupCard title="" show={isOpen} onClose={closeDropdown}>
    {#snippet trigger()}
      <Tooltip content={$_t("Click to select a model")} disabled={isOpen}>
        <button
          type="button"
          class="flex items-center gap-1 max-w-[150px] cursor-pointer transition-all duration-200
            {currentTheme === 'modern'
              ? 'bg-chat-input dark:bg-chat-input-dark border border-chat-border dark:border-chat-border-dark rounded-2xl text-chat-text dark:text-chat-text-dark font-chat text-sm py-1.5 px-2.5 hover:bg-chat-button-hover dark:hover:bg-chat-button-hover-dark'
              : 'bg-transparent border border-term-dim-green rounded text-term-green font-terminal text-sm py-1 px-2 hover:border-term-bright-green hover:bg-term-green/5'}"
          onclick={toggleDropdown}
          disabled={isLoading}
          aria-label={$_t('Select model: $1$', { substitutions: [selectedModelName] })}
          aria-expanded={isOpen}
          aria-haspopup="listbox"
        >
          <span class="overflow-hidden text-ellipsis whitespace-nowrap">
            {#if isLoading}
              ...
            {:else}
              {selectedModelName || $_t('Select Model')}
            {/if}
          </span>
          <svg
            class="w-3.5 h-3.5 shrink-0 transition-transform duration-200 {isOpen ? 'rotate-180' : ''}"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
          >
            <path stroke-linecap="round" stroke-linejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>
      </Tooltip>
    {/snippet}

    {#snippet content()}
      <div class="min-w-[180px] max-w-[250px] max-h-[300px] overflow-y-auto" role="listbox" aria-label="Available models">
      {#each groupedModels as group (group.modelName)}
        {@const isSelected = selectedGroup?.modelName === group.modelName}
        {@const hasMultipleProviders = group.providers.length > 1}
        {@const isLockedForFreeUser = isUserLoggedIn && isFreeUser && !isModelAvailableForFreeUser(group.modelKey, group.isCustom)}

        <div class="{currentTheme === 'modern'
          ? 'border-b border-white/10 last:border-b-0'
          : 'border-b border-term-dim-green/20 last:border-b-0'}">
          {#if hasMultipleProviders}
            <!-- Model with multiple providers -->
            <div class="{isLockedForFreeUser ? 'opacity-50' : ''}">
              <div class="flex items-center justify-between w-full text-left cursor-default font-medium
                {currentTheme === 'modern'
                  ? 'font-chat text-sm py-2.5 px-3.5 ' + (isLockedForFreeUser ? 'text-white/40' : 'text-chat-tooltip-text dark:text-chat-tooltip-text-dark')
                  : 'font-terminal text-sm py-2 px-3 ' + (isLockedForFreeUser ? 'text-[#666666]' : 'text-term-dim-green')}">
                <span class="overflow-hidden text-ellipsis whitespace-nowrap">{group.modelName}</span>
                {#if isLockedForFreeUser}
                  <svg class="w-3.5 h-3.5 shrink-0
                    {currentTheme === 'modern' ? 'text-white/40' : 'text-[#666666]'}" viewBox="0 0 20 20" fill="currentColor">
                    <path fill-rule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clip-rule="evenodd" />
                  </svg>
                {:else if isSelected}
                  <svg class="w-3.5 h-3.5 shrink-0
                    {currentTheme === 'modern' ? 'text-chat-primary dark:text-chat-primary-dark' : 'text-term-bright-green'}" viewBox="0 0 20 20" fill="currentColor">
                    <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd" />
                  </svg>
                {/if}
              </div>
              {#if isLockedForFreeUser}
                <div class="italic
                  {currentTheme === 'modern'
                    ? 'font-chat text-white/50 py-1.5 px-3.5 pb-2.5 text-sm'
                    : 'font-terminal text-[#888888] py-1 px-3 pb-2 text-sm'}">{$_t("Upgrade to explore world's most powerful models")}</div>
              {:else}
                <div class="flex flex-wrap gap-1
                  {currentTheme === 'modern' ? 'py-1.5 px-3.5 pb-2.5' : 'py-1 px-3 pb-2'}">
                  {#each group.providers as provider (provider.modelId)}
                    {@const isProviderSelected = provider.modelId === selectedModelKey}
                    <button
                      type="button"
                      class="cursor-pointer transition-all duration-150 text-sm
                        {currentTheme === 'modern'
                          ? 'font-chat bg-white/10 border border-white/20 rounded-2xl text-white/80 py-1 px-2.5 hover:bg-white/15 hover:border-white/30 hover:text-chat-tooltip-text dark:hover:text-chat-tooltip-text-dark ' + (isProviderSelected ? 'bg-blue-400/25 border-chat-primary dark:border-chat-primary-dark text-chat-primary dark:text-chat-primary-dark' : '')
                          : 'font-terminal bg-transparent border border-term-dim-green/40 rounded py-1 px-2 text-term-dim-green hover:border-term-green hover:bg-term-green/10 ' + (isProviderSelected ? 'bg-term-green/20 border-term-bright-green text-term-bright-green' : '')}"
                      onclick={() => selectModel(provider.modelId, group.modelName, provider.modelKey, group.isCustom)}
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
                  class="flex items-center justify-between w-full text-left bg-transparent border-none cursor-not-allowed opacity-50 transition-colors duration-150
                    {currentTheme === 'modern'
                      ? 'font-chat text-sm text-white/40 py-2.5 px-3.5'
                      : 'font-terminal text-sm text-[#666666] py-2 px-3'}"
                  disabled
                  role="option"
                  aria-selected={false}
                  aria-disabled="true"
                >
                  <span class="overflow-hidden text-ellipsis whitespace-nowrap">{group.modelName}</span>
                  <svg class="w-3.5 h-3.5 shrink-0
                    {currentTheme === 'modern' ? 'text-white/40' : 'text-[#666666]'}" viewBox="0 0 20 20" fill="currentColor">
                    <path fill-rule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clip-rule="evenodd" />
                  </svg>
                </button>
              </Tooltip>
            {:else}
              <button
                type="button"
                class="flex items-center justify-between w-full text-left bg-transparent border-none cursor-pointer transition-colors duration-150
                  {currentTheme === 'modern'
                    ? 'font-chat text-sm py-2.5 px-3.5 text-chat-tooltip-text dark:text-chat-tooltip-text-dark hover:bg-white/10 ' + (isSelected ? 'bg-blue-400/20 text-chat-primary dark:text-chat-primary-dark' : '')
                    : 'font-terminal text-sm py-2 px-3 text-term-dim-green hover:bg-term-green/10 hover:text-term-green ' + (isSelected ? 'bg-term-green/15 text-term-bright-green' : '')}"
                onclick={() => selectModel(group.providers[0].modelId, group.modelName, group.providers[0].modelKey, group.isCustom)}
                role="option"
                aria-selected={isSelected}
              >
                <span class="overflow-hidden text-ellipsis whitespace-nowrap">{group.modelName}</span>
                {#if isSelected}
                  <svg class="w-3.5 h-3.5 shrink-0
                    {currentTheme === 'modern' ? 'text-chat-primary dark:text-chat-primary-dark' : 'text-term-bright-green'}" viewBox="0 0 20 20" fill="currentColor">
                    <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd" />
                  </svg>
                {/if}
              </button>
            {/if}
          {/if}
        </div>
      {/each}
      </div>
    {/snippet}
  </PopupCard>
</div>
