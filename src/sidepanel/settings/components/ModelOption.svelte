<script lang="ts">
  /**
   * T010, T019: ModelOption component
   * Feature: 001-multi-model-support
   * User Story 1: Model Selection in Settings
   * User Story 2: Model Information Display
   */
  import { createEventDispatcher } from 'svelte';
  import type { ModelMetadata, ConfiguredFeatures } from '../../config/types.js';
  import ModelInfoTooltip from './ModelInfoTooltip.svelte';

  export let model: ModelMetadata;
  export let isSelected = false;
  export let isFocused = false;
  export let configuredFeatures: ConfiguredFeatures;

  const dispatch = createEventDispatcher();

  // Simplified validation - both GPT-5 and Grok 4 support all features
  $: validation = { valid: true, modelId: model.id };
  $: isCompatible = true;
  $: hasErrors = false;

  // T019: Tooltip state
  let showTooltip = false;
  let buttonElement: HTMLButtonElement;

  function handleClick() {
    dispatch('click');
  }

  // T019: Show tooltip on hover
  function handleMouseEnter() {
    showTooltip = true;
  }

  function handleMouseLeave() {
    showTooltip = false;
  }

  // T019: Show tooltip on focus
  function handleFocus() {
    showTooltip = true;
  }

  function handleBlur() {
    showTooltip = false;
  }

  function formatContextWindow(tokens: number): string {
    if (tokens >= 1000000) {
      return `${(tokens / 1000000).toFixed(1)}M`;
    }
    if (tokens >= 1000) {
      return `${Math.round(tokens / 1000)}K`;
    }
    return tokens.toString();
  }
</script>

<button
  bind:this={buttonElement}
  type="button"
  class="w-full px-4 py-3 text-left transition-colors border-l-2
    {isSelected ? 'bg-gray-700/50' : ''}
    {!isSelected && !hasErrors ? 'hover:bg-gray-800/50' : ''}
    {model.deprecated ? 'border-yellow-500/50' : ''}"
  class:ring-1={isSelected}
  class:ring-cyan-400={isSelected}
  class:border-cyan-400={isSelected}
  class:bg-gray-750={isFocused && !isSelected}
  class:border-transparent={!isSelected && !model.deprecated}
  class:opacity-50={hasErrors}
  class:cursor-not-allowed={hasErrors}
  class:grayscale={hasErrors}
  on:click={handleClick}
  on:mouseenter={handleMouseEnter}
  on:mouseleave={handleMouseLeave}
  on:focus={handleFocus}
  on:blur={handleBlur}
  disabled={hasErrors}
  role="option"
  aria-selected={isSelected}
  aria-disabled={hasErrors}
>
  <div class="flex items-start justify-between gap-3">
    <div class="flex-1 min-w-0">
      <!-- Model name and badges -->
      <div class="flex items-center gap-2 mb-1">
        <span class="font-medium text-gray-100 truncate">
          {model.displayName}
        </span>

        {#if model.deprecated}
          <span class="px-1.5 py-0.5 text-xs bg-yellow-500/20 text-yellow-400 rounded">
            Deprecated
          </span>
        {/if}

        {#if isSelected}
          <svg class="w-4 h-4 text-cyan-400 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
            <path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd" />
          </svg>
        {/if}
      </div>

      <!-- Model info -->
      <div class="flex items-center gap-3 text-sm text-gray-400">
        <span class="flex items-center gap-1">
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          {formatContextWindow(model.contextWindow)} tokens
        </span>

        {#if model.supportsReasoning}
          <span class="px-1.5 py-0.5 text-xs bg-blue-500/20 text-blue-400 rounded">
            Reasoning
          </span>
        {/if}

        {#if model.supportsVerbosity}
          <span class="px-1.5 py-0.5 text-xs bg-purple-500/20 text-purple-400 rounded">
            Verbosity
          </span>
        {/if}
      </div>

      <!-- Deprecation message -->
      {#if model.deprecated && model.deprecationMessage}
        <p class="mt-1 text-xs text-yellow-400/70">
          {model.deprecationMessage}
        </p>
      {/if}

      <!-- Validation errors -->
      {#if hasErrors}
        <div class="mt-2 text-xs text-red-400">
          {#each validation.errors as error}
            <p>⚠️ {error}</p>
          {/each}
          {#if validation.incompatibleFeatures && validation.incompatibleFeatures.length > 0}
            <p class="mt-1 text-red-300">
              Incompatible features: {validation.incompatibleFeatures.join(', ')}
            </p>
          {/if}
        </div>
      {/if}

      <!-- Validation warnings (non-blocking) -->
      {#if !hasErrors && validation.warnings && validation.warnings.length > 0}
        <div class="mt-2 text-xs text-yellow-400/70">
          {#each validation.warnings as warning}
            <p>ℹ️ {warning}</p>
          {/each}
        </div>
      {/if}
    </div>
  </div>
</button>

<!-- T019: Model Information Tooltip -->
<ModelInfoTooltip
  {model}
  anchorElement={buttonElement}
  visible={showTooltip}
/>
