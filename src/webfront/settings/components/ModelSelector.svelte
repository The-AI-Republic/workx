<script lang="ts">
  /**
   * ModelSelector component for multi-provider system
   * Groups models by name and shows provider capsule buttons when multiple providers exist
   * Now uses pre-built modelSelectionItems from parent
   */
  import type { ConfiguredFeatures } from '@/config/types';
  import { onMount } from 'svelte';
  import { userStore } from '../../stores/userStore';
  import Tooltip from '../../components/common/Tooltip.svelte';
  import { t, _t } from '../../lib/i18n';
  import { registerShortcut, registerShortcutContext } from '../../shortcuts/useShortcut';
  import { isModelAvailableForFreeUser } from '../../lib/freeUserModels';

  // Props
  let {
    selectedModel,
    modelSelectionItems = [],
    disabled = false,
    onModelChange,
  }: {
    selectedModel: string;
    modelSelectionItems?: Array<{
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
      selected: boolean;
      isCustom?: boolean;
      pricing?: {
        inputToken: string;
        outputToken: string;
        link: string;
      };
    }>;
    disabled?: boolean;
    onModelChange?: (data: { modelId: string }) => void;
  } = $props();

  // Subscribe to user store
  let isUserLoggedIn = $derived($userStore.isLoggedIn);
  let isFreeUser = $derived($userStore.userType === 0);

  let isOpen = $state(false);
  let focusedIndex = $state(-1);
  let selectorRef: HTMLDivElement;

  // Track pending provider selection per model name (when user clicks model row but hasn't selected provider)
  let pendingSelectionModelName: string | null = $state(null);
  let pendingProviderErrors: Map<string, boolean> = $state(new Map());

  // Group models by model name for UI display
  interface GroupedModel {
    modelName: string;
    modelKey: string; // First provider's modelKey, used for free user check
    isCustom: boolean; // True for user-defined custom endpoints (BYOK) — bypass free-tier lock
    providers: Array<{
      modelId: string;
      modelKey: string;
      providerId: string;
      providerName: string;
      apiKey: string | null;
      contextWindow: number;
      maxOutputTokens: number;
      pricing?: {
        inputToken: string;
        outputToken: string;
        link: string;
      };
    }>;
  }

  // Computed: group models by name
  let groupedModels = $derived((() => {
    const groups = new Map<string, GroupedModel>();

    for (const item of modelSelectionItems) {
      const existing = groups.get(item.modelName);
      if (existing) {
        // A group is "custom" only if EVERY provider in it is custom, so a name
        // collision between a built-in and a BYOK endpoint can't unlock the
        // built-in for free users (mixed groups safe-fail to non-custom).
        existing.isCustom = existing.isCustom && (item.isCustom ?? false);
        // Check for duplicate provider before adding
        const isDuplicate = existing.providers.some((p) => p.providerId === item.providerId);
        if (isDuplicate) {
          console.warn(
            '[ModelSelector] Skipping duplicate provider:',
            item.providerName,
            'for model:',
            item.modelName
          );
          continue;
        }
        existing.providers.push({
          modelId: item.modelId,
          modelKey: item.modelKey,
          providerId: item.providerId,
          providerName: item.providerName,
          apiKey: item.apiKey,
          contextWindow: item.contextWindow,
          maxOutputTokens: item.maxOutputTokens,
          pricing: item.pricing,
        });
      } else {
        groups.set(item.modelName, {
          modelName: item.modelName,
          modelKey: item.modelKey, // Store modelKey for free user check
          isCustom: item.isCustom ?? false,
          providers: [
            {
              modelId: item.modelId,
              modelKey: item.modelKey,
              providerId: item.providerId,
              providerName: item.providerName,
              apiKey: item.apiKey,
              contextWindow: item.contextWindow,
              maxOutputTokens: item.maxOutputTokens,
              pricing: item.pricing,
            },
          ],
        });
      }
    }

    return Array.from(groups.values());
  })());

  // Get selected model's name and provider
  let selectedModelData = $derived(modelSelectionItems.find((m) => m.modelId === selectedModel));
  let selectedModelName = $derived(selectedModelData?.modelName || '');
  let selectedProviderId = $derived(selectedModelData?.providerId || '');

  function toggleDropdown() {
    if (disabled) return;
    isOpen = !isOpen;
    if (isOpen) {
      focusedIndex = groupedModels.findIndex((g) => g.modelName === selectedModelName);
      // Clear pending selections when opening dropdown
      pendingSelectionModelName = null;
      pendingProviderErrors.clear();
    }
  }

  function handleModelRowClick(group: GroupedModel) {
    if (disabled) return;

    // Block selection for free users trying to select premium models
    if (isUserLoggedIn && isFreeUser && !isModelAvailableForFreeUser(group.modelKey, group.isCustom)) {
      // Model is locked for free users - don't allow selection
      return;
    }

    // If only one provider, select it directly
    if (group.providers.length === 1) {
      selectModel(group.providers[0].modelId);
      return;
    }

    // If this model name is already selected, don't require re-selection
    if (group.modelName === selectedModelName) {
      // Model already selected, close dropdown
      isOpen = false;
      return;
    }

    // Multiple providers: mark as pending selection and show error
    pendingSelectionModelName = group.modelName;
    pendingProviderErrors.set(group.modelName, true);
    pendingProviderErrors = pendingProviderErrors; // Trigger reactivity
  }

  function handleProviderClick(
    event: MouseEvent,
    modelId: string,
    modelName: string,
    modelKey: string,
    isCustom = false
  ) {
    if (disabled) {
      event.stopPropagation();
      return;
    }

    // Block selection for free users trying to select premium models
    if (isUserLoggedIn && isFreeUser && !isModelAvailableForFreeUser(modelKey, isCustom)) {
      // Model is locked for free users - don't allow selection
      // We don't stop propagation here so parent tooltip can catch the click
      return;
    }

    event.stopPropagation();

    // Clear error for this model name
    pendingProviderErrors.delete(modelName);
    pendingProviderErrors = pendingProviderErrors;
    pendingSelectionModelName = null;

    selectModel(modelId);
  }

  function selectModel(modelId: string) {
    if (disabled) return;

    // Dispatch model change event
    onModelChange?.({ modelId });
    isOpen = false;
  }

  function handleKeyDown(event: KeyboardEvent) {
    if (disabled) return;

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        if (!isOpen) {
          isOpen = true;
          focusedIndex = groupedModels.findIndex((g) => g.modelName === selectedModelName);
        } else {
          focusedIndex = Math.min(focusedIndex + 1, groupedModels.length - 1);
        }
        break;
      case 'ArrowUp':
        event.preventDefault();
        if (isOpen) {
          focusedIndex = Math.max(focusedIndex - 1, 0);
        }
        break;
      case 'Enter':
      case ' ':
        event.preventDefault();
        if (isOpen && focusedIndex >= 0) {
          const group = groupedModels[focusedIndex];
          if (group.providers.length === 1) {
            selectModel(group.providers[0].modelId);
          }
          // For multiple providers, user must click provider button
        } else {
          toggleDropdown();
        }
        break;
      case 'Escape':
        event.preventDefault();
        isOpen = false;
        pendingSelectionModelName = null;
        pendingProviderErrors.clear();
        break;
      case 'Home':
        event.preventDefault();
        if (isOpen) focusedIndex = 0;
        break;
      case 'End':
        event.preventDefault();
        if (isOpen) focusedIndex = groupedModels.length - 1;
        break;
    }
  }

  function handleClickOutside(event: MouseEvent) {
    if (selectorRef && !selectorRef.contains(event.target as Node)) {
      isOpen = false;
      pendingSelectionModelName = null;
      pendingProviderErrors.clear();
    }
  }

  // Get current model with provider name for display
  let currentModelData = $derived(modelSelectionItems.find((m) => m.modelId === selectedModel));
  let currentModelDisplay = $derived(currentModelData
    ? `${currentModelData.modelName} - ${currentModelData.providerName}`
    : disabled && modelSelectionItems.length === 0
      ? t('Loading...')
      : modelSelectionItems.length > 0
        ? t('Unknown model ($1$)', { substitutions: [selectedModel] })
        : t('No models available'));

  $effect(() => {
    if (typeof window !== 'undefined') {
      if (isOpen) {
        document.addEventListener('click', handleClickOutside);
      } else {
        document.removeEventListener('click', handleClickOutside);
      }
    }
    return () => {
      if (typeof window !== 'undefined') {
        document.removeEventListener('click', handleClickOutside);
      }
    };
  });

  onMount(() => {
    const unregisterContext = registerShortcutContext('SettingsModelSelector', {
      active: () => !disabled && (isOpen || document.activeElement === selectorRef),
    });
    const unregisterNext = registerShortcut('settingsModelSelector:next', 'SettingsModelSelector', () => {
      if (!isOpen) {
        isOpen = true;
        focusedIndex = groupedModels.findIndex((g) => g.modelName === selectedModelName);
      } else {
        focusedIndex = Math.min(focusedIndex + 1, groupedModels.length - 1);
      }
    });
    const unregisterPrevious = registerShortcut('settingsModelSelector:previous', 'SettingsModelSelector', () => {
      if (isOpen) {
        focusedIndex = Math.max(focusedIndex - 1, 0);
      }
    });
    const unregisterAccept = registerShortcut('settingsModelSelector:accept', 'SettingsModelSelector', () => {
      if (isOpen && focusedIndex >= 0) {
        const group = groupedModels[focusedIndex];
        if (group.providers.length === 1) {
          selectModel(group.providers[0].modelId);
        }
      } else {
        toggleDropdown();
      }
    });
    const unregisterDismiss = registerShortcut('settingsModelSelector:dismiss', 'SettingsModelSelector', () => {
      isOpen = false;
      pendingSelectionModelName = null;
      pendingProviderErrors.clear();
    });
    const unregisterFirst = registerShortcut('settingsModelSelector:first', 'SettingsModelSelector', () => {
      if (isOpen) focusedIndex = 0;
    });
    const unregisterLast = registerShortcut('settingsModelSelector:last', 'SettingsModelSelector', () => {
      if (isOpen) focusedIndex = groupedModels.length - 1;
    });

    return () => {
      unregisterContext();
      unregisterNext();
      unregisterPrevious();
      unregisterAccept();
      unregisterDismiss();
      unregisterFirst();
      unregisterLast();
    };
  });
</script>

<!-- Model selector with grouped providers -->
<div
  bind:this={selectorRef}
  class="model-selector relative"
  role="listbox"
  aria-expanded={isOpen}
  aria-label={$_t('Select model: $1$', { substitutions: [currentModelDisplay] })}
  aria-disabled={disabled}
  onkeydown={handleKeyDown}
  tabindex={disabled ? -1 : 0}
>
  <!-- Trigger button -->
  <button
    type="button"
    class="w-full px-4 py-2 bg-gray-800 border border-gray-700 rounded-lg text-left flex items-center justify-between transition-colors"
    class:opacity-50={disabled}
    class:cursor-not-allowed={disabled}
    class:hover:bg-gray-700={!disabled}
    class:ring-2={isOpen}
    class:ring-cyan-400={isOpen}
    onclick={toggleDropdown}
    {disabled}
  >
    <span class="flex items-center gap-2">
      <span class="font-medium text-gray-100">
        {currentModelDisplay}
      </span>
    </span>
    <svg
      class="w-5 h-5 text-gray-400 transition-transform"
      class:rotate-180={isOpen}
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
    >
      <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
    </svg>
  </button>

  <!-- Dropdown list with grouped models -->
  {#if isOpen}
    <div
      class="absolute z-50 w-full mt-2 bg-gray-800 border border-gray-700 rounded-lg shadow-xl max-h-96 overflow-y-auto"
    >
      {#each groupedModels as group, index (group.modelName)}
        {@const isSelectedModelName = group.modelName === selectedModelName}
        {@const hasMultipleProviders = group.providers.length > 1}
        {@const hasError = pendingProviderErrors.get(group.modelName)}
        {@const firstProvider = group.providers[0]}
        {@const isLockedForFreeUser =
          isUserLoggedIn && isFreeUser && !isModelAvailableForFreeUser(group.modelKey, group.isCustom)}

        <Tooltip
          content={$_t("Please upgrade the plan to unblock world's most advanced models")}
          disabled={!isLockedForFreeUser}
          placement="top"
          trigger="mouseenter click"
          hideOnClick={false}
          fill={true}
          style="display: block;"
        >
          <div class="model-row-wrapper relative">
            <div
              class="model-row w-full px-4 py-3 text-left transition-colors border-b border-gray-700 last:border-b-0"
              class:bg-gray-700={isSelectedModelName && !isLockedForFreeUser}
              class:bg-gray-750={index === focusedIndex &&
                !isSelectedModelName &&
                !isLockedForFreeUser}
              class:hover:bg-gray-700={!isSelectedModelName && !isLockedForFreeUser}
              class:cursor-pointer={!hasMultipleProviders && !isLockedForFreeUser}
              class:locked-model={isLockedForFreeUser}
              role="option"
              aria-selected={isSelectedModelName}
              aria-disabled={isLockedForFreeUser}
              onclick={() => handleModelRowClick(group)}
              onkeydown={(e) => e.key === 'Enter' && handleModelRowClick(group)}
              tabindex={isLockedForFreeUser ? -1 : 0}
            >
              <!-- Model name with providers: "<Model Name> - <provider1> <provider2> ..." format -->
              <div class="model-name-row flex items-start flex-wrap gap-x-2 gap-y-1">
                <span
                  class="font-medium flex-shrink-0"
                  class:text-gray-100={!isLockedForFreeUser}
                  class:text-gray-500={isLockedForFreeUser}
                >
                  {group.modelName}
                </span>
                {#if isLockedForFreeUser}
                  <svg
                    class="lock-icon w-4 h-4 text-gray-500 flex-shrink-0"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                  >
                    <path
                      fill-rule="evenodd"
                      d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z"
                      clip-rule="evenodd"
                    />
                  </svg>
                {/if}

                {#if hasMultipleProviders}
                  <!-- Multiple providers: show dash then capsule buttons inline -->
                  <span
                    class="flex-shrink-0"
                    class:text-gray-500={!isLockedForFreeUser}
                    class:text-gray-600={isLockedForFreeUser}>-</span
                  >
                  <div class="provider-buttons flex flex-wrap gap-1.5 items-center">
                    {#each group.providers as provider (provider.modelId)}
                      {@const isProviderSelected = provider.modelId === selectedModel}
                      {@const tooltipText = provider.pricing
                        ? `Input: ${provider.pricing.inputToken}\nOutput: ${provider.pricing.outputToken}`
                        : `${provider.contextWindow.toLocaleString()} tokens context`}
                      <div class="provider-tooltip-wrapper">
                        <button
                          type="button"
                          class="provider-capsule px-2.5 py-0.5 text-sm rounded-full border transition-all"
                          class:provider-selected={isProviderSelected && !isLockedForFreeUser}
                          class:provider-unselected={!isProviderSelected && !isLockedForFreeUser}
                          class:provider-locked={isLockedForFreeUser}
                          aria-disabled={isLockedForFreeUser}
                          onclick={(e) =>
                            handleProviderClick(
                              e,
                              provider.modelId,
                              group.modelName,
                              provider.modelKey,
                              group.isCustom
                            )}
                        >
                          <span class="provider-name">{provider.providerName}</span>
                          {#if provider.apiKey && !isLockedForFreeUser}
                            <span class="ml-1 text-sm opacity-70">✓</span>
                          {/if}
                        </button>
                        {#if !isLockedForFreeUser}
                          <div class="provider-tooltip">
                            {#if provider.pricing}
                              <div class="tooltip-line">{$_t('In:')} {provider.pricing.inputToken}</div>
                              <div class="tooltip-line">{$_t('Out:')} {provider.pricing.outputToken}</div>
                            {:else}
                              <div class="tooltip-line">
                                {provider.contextWindow.toLocaleString()} {$_t('tokens')}
                              </div>
                            {/if}
                          </div>
                        {/if}
                      </div>
                    {/each}
                    {#if isSelectedModelName && !isLockedForFreeUser}
                      <span
                        class="selected-tag px-2 py-0.5 text-xs bg-cyan-500/20 text-cyan-400 rounded border border-cyan-500/30"
                      >
                        {$_t('Selected')}
                      </span>
                    {/if}
                  </div>
                {:else}
                  <!-- Single provider: show provider name, configured badge, and selected indicator -->
                  <span
                    class="flex-shrink-0"
                    class:text-gray-500={!isLockedForFreeUser}
                    class:text-gray-600={isLockedForFreeUser}>-</span
                  >
                  <span
                    class="text-sm"
                    class:text-gray-400={!isLockedForFreeUser}
                    class:text-gray-600={isLockedForFreeUser}
                  >
                    {firstProvider.providerName}
                  </span>
                  {#if firstProvider.apiKey && !isLockedForFreeUser}
                    <span class="px-2 py-0.5 text-sm bg-green-500/20 text-green-400 rounded">
                      {$_t('Configured')}
                    </span>
                  {/if}
                  {#if isSelectedModelName && !isLockedForFreeUser}
                    <span
                      class="selected-tag px-2 py-0.5 text-xs bg-cyan-500/20 text-cyan-400 rounded border border-cyan-500/30"
                    >
                      {$_t('Selected')}
                    </span>
                  {/if}
                {/if}
              </div>

              <!-- Error message when no provider selected (for multi-provider models) -->
              {#if hasMultipleProviders && hasError && !isLockedForFreeUser}
                <div class="provider-error mt-2 text-sm text-red-400 flex items-center gap-1">
                  <svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <circle cx="12" cy="12" r="10"></circle>
                    <line x1="12" y1="8" x2="12" y2="12"></line>
                    <line x1="12" y1="16" x2="12.01" y2="16"></line>
                  </svg>
                  {$_t('Please select a provider')}
                </div>
              {/if}

              <!-- Pricing info (show from first provider or selected provider) - hide for locked models -->
              {#if !isLockedForFreeUser}
                {#if hasMultipleProviders}
                  {@const displayProvider =
                    group.providers.find((p) => p.modelId === selectedModel) || firstProvider}
                  {#if displayProvider.pricing}
                    <div class="mt-2 flex items-center justify-between gap-2">
                      <div class="text-sm text-gray-400">
                        <div>{$_t('Input:')} {displayProvider.pricing.inputToken}</div>
                        <div>{$_t('Output:')} {displayProvider.pricing.outputToken}</div>
                      </div>
                      <a
                        href={displayProvider.pricing.link}
                        target="_blank"
                        rel="noopener noreferrer"
                        class="flex-shrink-0 text-cyan-400 hover:text-cyan-300 transition-colors"
                        onclick={(e) => e.stopPropagation()}
                        aria-label={$_t("View pricing details")}
                      >
                        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            stroke-width="2"
                            d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                          />
                        </svg>
                      </a>
                    </div>
                  {:else}
                    <div class="mt-1 text-meta font-normal text-gray-400">
                      {displayProvider.contextWindow.toLocaleString()} {$_t('tokens')}
                    </div>
                  {/if}
                {:else if firstProvider.pricing}
                  <div class="mt-2 flex items-center justify-between gap-2">
                    <div class="text-meta font-normal text-gray-400">
                      <div>{$_t('Input:')} {firstProvider.pricing.inputToken}</div>
                      <div>{$_t('Output:')} {firstProvider.pricing.outputToken}</div>
                    </div>
                    <a
                      href={firstProvider.pricing.link}
                      target="_blank"
                      rel="noopener noreferrer"
                      class="flex-shrink-0 text-cyan-400 hover:text-cyan-300 transition-colors"
                      onclick={(e) => e.stopPropagation()}
                      aria-label={$_t("View pricing details")}
                    >
                      <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path
                          stroke-linecap="round"
                          stroke-linejoin="round"
                          stroke-width="2"
                          d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                        />
                      </svg>
                    </a>
                  </div>
                {:else}
                  <div class="mt-1 text-meta font-normal text-gray-400">
                    {firstProvider.contextWindow.toLocaleString()} {$_t('tokens')}
                  </div>
                {/if}
              {/if}
            </div>

            {#if isLockedForFreeUser}
              <!-- High-priority overlay to capture all interactions and propagate to Tooltip wrapper -->
              <div
                class="absolute inset-0 z-50 cursor-not-allowed bg-transparent"
                style="pointer-events: all; display: block;"
              ></div>
            {/if}
          </div>
        </Tooltip>
      {/each}
    </div>
  {/if}
</div>

<style>
  .model-selector:focus {
    outline: none;
  }

  .model-row {
    cursor: default;
  }

  .model-row:focus {
    outline: none;
  }

  /* Provider capsule button styles */
  .provider-capsule {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    font-weight: var(--font-weight-medium);
    cursor: pointer;
  }

  .provider-capsule:focus {
    outline: none;
    box-shadow: 0 0 0 2px rgba(34, 197, 94, 0.3);
  }

  /* Selected provider: bright green border */
  .provider-selected {
    border-color: rgb(34, 197, 94);
    background-color: rgba(34, 197, 94, 0.15);
    color: rgb(134, 239, 172);
  }

  .provider-selected:hover {
    background-color: rgba(34, 197, 94, 0.25);
  }

  /* Unselected provider: grey border */
  .provider-unselected {
    border-color: rgb(75, 85, 99);
    background-color: transparent;
    color: rgb(156, 163, 175);
  }

  .provider-unselected:hover {
    border-color: rgb(107, 114, 128);
    background-color: rgba(107, 114, 128, 0.1);
    color: rgb(209, 213, 219);
  }

  /* Provider buttons container - allow wrapping */
  .provider-buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  /* Provider tooltip wrapper */
  .provider-tooltip-wrapper {
    position: relative;
    display: inline-flex;
  }

  /* Provider tooltip */
  .provider-tooltip {
    position: absolute;
    bottom: calc(100% + 8px);
    left: 0;
    background-color: rgb(17, 24, 39);
    border: 1px solid rgb(55, 65, 81);
    border-radius: 6px;
    padding: 6px 10px;
    z-index: 100;
    opacity: 0;
    visibility: hidden;
    transition:
      opacity 0.2s,
      visibility 0.2s;
    pointer-events: none;
    box-shadow:
      0 4px 6px -1px rgba(0, 0, 0, 0.3),
      0 2px 4px -1px rgba(0, 0, 0, 0.2);
    max-width: 240px;
    width: max-content;
  }

  /* Tooltip arrow */
  .provider-tooltip::after {
    content: '';
    position: absolute;
    top: 100%;
    left: 12px;
    border: 6px solid transparent;
    border-top-color: rgb(55, 65, 81);
  }

  .provider-tooltip::before {
    content: '';
    position: absolute;
    top: 100%;
    left: 13px;
    border: 5px solid transparent;
    border-top-color: rgb(17, 24, 39);
    margin-top: -1px;
    z-index: 1;
  }

  /* Show tooltip on hover */
  .provider-tooltip-wrapper:hover .provider-tooltip {
    opacity: 1;
    visibility: visible;
  }

  /* Tooltip line styling */
  .tooltip-line {
    font-size: var(--text-meta);
    color: rgb(209, 213, 219);
    line-height: var(--text-meta--line-height);
    word-wrap: break-word;
  }

  .tooltip-line:not(:last-child) {
    margin-bottom: 1px;
  }

  /* Error message styling */
  .provider-error {
    animation: shake 0.3s ease-in-out;
  }

  @keyframes shake {
    0%,
    100% {
      transform: translateX(0);
    }
    25% {
      transform: translateX(-4px);
    }
    75% {
      transform: translateX(4px);
    }
  }

  /* Locked model styles for free users */
  .locked-model {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .locked-model:hover {
    background-color: transparent !important;
  }

  .lock-icon {
    margin-top: 0.125rem;
  }

  /* Ensure tooltip wrapper takes full width for model rows in dropdown */

  /* Locked provider capsule button */
  .provider-locked {
    border-color: rgb(75, 85, 99);
    background-color: transparent;
    color: rgb(107, 114, 128);
    cursor: not-allowed;
    opacity: 0.6;
  }

  .provider-locked:hover {
    border-color: rgb(75, 85, 99);
    background-color: transparent;
    color: rgb(107, 114, 128);
  }
</style>
