<script lang="ts">
  /**
   * ModelSelector component for multi-provider system
   * Displays models grouped by provider with "[Model Name] - [Provider Name]" format
   * Now uses pre-built modelSelectionItems from parent
   */
  import { createEventDispatcher } from 'svelte';
  import type { ConfiguredFeatures } from '../../config/types';

  // Props
  export let selectedModel: string;
  export let modelSelectionItems: Array<{
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
    pricing?: {
      inputToken: string;
      outputToken: string;
      link: string;
    };
  }> = [];
  export let disabled = false;

  const dispatch = createEventDispatcher();

  let isOpen = false;
  let focusedIndex = -1;
  let selectorRef: HTMLDivElement;

  function toggleDropdown() {
    if (disabled) return;
    isOpen = !isOpen;
    if (isOpen) {
      focusedIndex = modelSelectionItems.findIndex(m => m.modelId === selectedModel);
    }
  }

  function selectModel(modelId: string) {
    if (disabled) return;

    // Dispatch model change event
    dispatch('modelChange', { modelId });
    isOpen = false;
  }

  function handleKeyDown(event: KeyboardEvent) {
    if (disabled) return;

    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        if (!isOpen) {
          isOpen = true;
          focusedIndex = modelSelectionItems.findIndex(m => m.modelId === selectedModel);
        } else {
          focusedIndex = Math.min(focusedIndex + 1, modelSelectionItems.length - 1);
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
          selectModel(modelSelectionItems[focusedIndex].modelId);
        } else {
          toggleDropdown();
        }
        break;
      case 'Escape':
        event.preventDefault();
        isOpen = false;
        break;
      case 'Home':
        event.preventDefault();
        if (isOpen) focusedIndex = 0;
        break;
      case 'End':
        event.preventDefault();
        if (isOpen) focusedIndex = modelSelectionItems.length - 1;
        break;
    }
  }

  function handleClickOutside(event: MouseEvent) {
    if (selectorRef && !selectorRef.contains(event.target as Node)) {
      isOpen = false;
    }
  }

  // Get current model with provider name for display
  $: currentModelData = modelSelectionItems.find(m => m.modelId === selectedModel);
  $: currentModelDisplay = currentModelData
    ? `${currentModelData.modelName} - ${currentModelData.providerName}`
    : disabled && modelSelectionItems.length === 0
      ? 'Loading...'
      : modelSelectionItems.length > 0
        ? `Unknown model (${selectedModel})`
        : 'No models available';

  // Debug logging for prop changes
  $: {
    console.log('[ModelSelector] selectedModel prop changed to:', selectedModel);
    console.log('[ModelSelector] modelSelectionItems length:', modelSelectionItems?.length || 0);
    console.log('[ModelSelector] modelSelectionItems:', modelSelectionItems);
    console.log('[ModelSelector] currentModelData:', currentModelData);
    console.log('[ModelSelector] currentModelDisplay:', currentModelDisplay);
    if (modelSelectionItems?.length > 0) {
      console.log('[ModelSelector] First model:', modelSelectionItems[0]);
      console.log('[ModelSelector] Model IDs:', modelSelectionItems.map(m => m.modelId));
    }
  }

  $: if (typeof window !== 'undefined') {
    if (isOpen) {
      document.addEventListener('click', handleClickOutside);
    } else {
      document.removeEventListener('click', handleClickOutside);
    }
  }
</script>

<!-- Model selector with "[Model Name] - [Provider Name]" format -->
<div
  bind:this={selectorRef}
  class="model-selector relative"
  role="listbox"
  aria-expanded={isOpen}
  aria-label="Select model: {currentModelDisplay}"
  aria-disabled={disabled}
  on:keydown={handleKeyDown}
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
    on:click={toggleDropdown}
    disabled={disabled}
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

  <!-- Dropdown list -->
  {#if isOpen}
    <div
      class="absolute z-50 w-full mt-2 bg-gray-800 border border-gray-700 rounded-lg shadow-xl max-h-96 overflow-y-auto"
    >
      {#each modelSelectionItems as item, index (item.modelId)}
        <button
          type="button"
          class="w-full px-4 py-3 text-left transition-colors border-b border-gray-700 last:border-b-0"
          class:bg-gray-700={item.modelId === selectedModel}
          class:bg-gray-750={index === focusedIndex && item.modelId !== selectedModel}
          class:hover:bg-gray-700={item.modelId !== selectedModel}
          on:click={() => selectModel(item.modelId)}
        >
          <div class="flex items-center justify-between">
            <span class="font-medium text-gray-100">
              {item.modelName} - {item.providerName}
            </span>
            {#if item.apiKey}
              <span class="px-2 py-0.5 text-xs bg-green-500/20 text-green-400 rounded">
                Configured
              </span>
            {/if}
          </div>
          {#if item.pricing}
            <div class="mt-1 flex items-center justify-between gap-2">
              <div class="text-xs text-gray-400">
                <div>Input: {item.pricing.inputToken}</div>
                <div>Output: {item.pricing.outputToken}</div>
              </div>
              <a
                href={item.pricing.link}
                target="_blank"
                rel="noopener noreferrer"
                class="flex-shrink-0 text-cyan-400 hover:text-cyan-300 transition-colors"
                on:click={(e) => e.stopPropagation()}
                aria-label="View pricing details"
              >
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
              </a>
            </div>
          {:else}
            <div class="mt-1 text-xs text-gray-400">
              {item.contextWindow.toLocaleString()} tokens
            </div>
          {/if}
        </button>
      {/each}
    </div>
  {/if}
</div>

<style>
  .model-selector:focus {
    outline: none;
  }
</style>
