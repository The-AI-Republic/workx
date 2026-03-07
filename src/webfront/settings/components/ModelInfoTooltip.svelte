<!--
  T018-T023, ModelInfoTooltip component
  Feature: 001-multi-model-support
  User Story 2: Model Information Display
-->

<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { fade } from 'svelte/transition';
  import type { ModelMetadata } from '@/config/types.js';
  import { t, _t } from '../../lib/i18n';

  let { model, anchorElement = null, visible = false }: {
    model: ModelMetadata;
    anchorElement?: HTMLElement | null;
    visible?: boolean;
  } = $props();

  let tooltipElement: HTMLDivElement;
  let position = $state({ top: 0, left: 0 });

  // Update tooltip position when visibility changes or anchor moves
  $effect(() => {
    if (visible && anchorElement && tooltipElement) {
      updatePosition();
    }
  });

  function updatePosition() {
    if (!anchorElement || !tooltipElement) return;

    const anchorRect = anchorElement.getBoundingClientRect();
    const tooltipRect = tooltipElement.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    // Default: position to the right of the anchor
    let top = anchorRect.top;
    let left = anchorRect.right + 8; // 8px gap

    // Prevent overflow - if tooltip goes off right edge, position to the left
    if (left + tooltipRect.width > viewportWidth) {
      left = anchorRect.left - tooltipRect.width - 8;
    }

    // Prevent overflow - if tooltip goes off bottom edge, adjust upward
    if (top + tooltipRect.height > viewportHeight) {
      top = viewportHeight - tooltipRect.height - 8;
    }

    // Prevent overflow - if tooltip goes off top edge, adjust downward
    if (top < 8) {
      top = 8;
    }

    position = { top, left };
  }

  onMount(() => {
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
  });

  onDestroy(() => {
    window.removeEventListener('resize', updatePosition);
    window.removeEventListener('scroll', updatePosition, true);
  });

  // Format context window for display
  function formatContextWindow(tokens: number): string {
    if (tokens >= 1000000) {
      return `${(tokens / 1000000).toFixed(1)}M tokens`;
    }
    if (tokens >= 1000) {
      return `${Math.round(tokens / 1000)}K tokens`;
    }
    return `${tokens} tokens`;
  }

  // Format release date
  function formatReleaseDate(dateStr: string | undefined): string {
    if (!dateStr) return t('Release date unknown');
    try {
      const date = new Date(dateStr);
      return date.toLocaleDateString('en-US', { year: 'numeric', month: 'long' });
    } catch {
      return dateStr;
    }
  }
</script>

{#if visible}
  <div
    bind:this={tooltipElement}
    class="model-info-tooltip fixed z-50 w-80 bg-gray-800 border border-gray-700 rounded-lg shadow-xl p-4"
    style="top: {position.top}px; left: {position.left}px;"
    role="tooltip"
    transition:fade={{ duration: 150 }}
  >
    <!-- Model Name and Provider -->
    <div class="mb-3">
      <h4 class="text-base font-semibold text-gray-100 mb-1">
        {model.name}
      </h4>
      <p class="text-sm text-gray-400">
        {$_t('Provider:')} {model.providerId.toUpperCase()}
      </p>
    </div>

    <!-- Context Window -->
    <div class="mb-3">
      <div class="flex items-center gap-2 mb-1">
        <svg class="w-4 h-4 text-cyan-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
        </svg>
        <span class="text-sm font-medium text-gray-200">{$_t('Context Window')}</span>
      </div>
      <p class="text-sm text-gray-300 ml-6">
        {formatContextWindow(model.contextWindow)}
      </p>
    </div>

    <!-- Max Output Tokens -->
    {#if model.maxOutputTokens}
      <div class="mb-3">
        <div class="flex items-center gap-2 mb-1">
          <svg class="w-4 h-4 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
          </svg>
          <span class="text-sm font-medium text-gray-200">{$_t('Max Output')}</span>
        </div>
        <p class="text-sm text-gray-300 ml-6">
          {formatContextWindow(model.maxOutputTokens)}
        </p>
      </div>
    {/if}

    <!-- Capability Badges -->
    <div class="mb-3">
      <div class="flex items-center gap-2 mb-2">
        <svg class="w-4 h-4 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
        <span class="text-sm font-medium text-gray-200">{$_t('Capabilities')}</span>
      </div>
      <div class="flex flex-wrap gap-2 ml-6">
        {#if model.supportsReasoning}
          <span class="px-2 py-1 text-sm bg-blue-500/20 text-blue-400 rounded border border-blue-500/30">
            {$_t('Reasoning')}
          </span>
        {/if}
        {#if model.supportsVerbosity}
          <span class="px-2 py-1 text-sm bg-purple-500/20 text-purple-400 rounded border border-purple-500/30">
            {$_t('Verbosity Control')}
          </span>
        {/if}
        {#if model.supportsReasoningSummaries}
          <span class="px-2 py-1 text-sm bg-indigo-500/20 text-indigo-400 rounded border border-indigo-500/30">
            {$_t('Reasoning Summaries')}
          </span>
        {/if}
        {#if !model.supportsReasoning && !model.supportsVerbosity && !model.supportsReasoningSummaries}
          <span class="text-sm text-gray-500">{$_t('Standard capabilities')}</span>
        {/if}
      </div>
    </div>

    <!-- Reasoning Effort Levels -->
    {#if model.supportsReasoning && model.reasoningEfforts && model.reasoningEfforts.length > 0}
      <div class="mb-3">
        <p class="text-sm text-gray-400 mb-1 ml-6">
          {$_t('Reasoning levels:')} {model.reasoningEfforts.join(', ')}
        </p>
      </div>
    {/if}

    <!-- Verbosity Levels -->
    {#if model.supportsVerbosity && model.verbosityLevels && model.verbosityLevels.length > 0}
      <div class="mb-3">
        <p class="text-sm text-gray-400 mb-1 ml-6">
          {$_t('Verbosity levels:')} {model.verbosityLevels.join(', ')}
        </p>
      </div>
    {/if}

    <!-- Release Date -->
    {#if model.releaseDate}
      <div class="pt-3 border-t border-gray-700">
        <p class="text-sm text-gray-400">
          {$_t('Released:')} {formatReleaseDate(model.releaseDate)}
        </p>
      </div>
    {/if}

    <!-- Deprecation Notice -->
    {#if model.deprecated && model.deprecationMessage}
      <div class="mt-3 pt-3 border-t border-yellow-500/30">
        <div class="flex items-start gap-2">
          <svg class="w-4 h-4 text-yellow-400 flex-shrink-0 mt-0.5" fill="currentColor" viewBox="0 0 20 20">
            <path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clip-rule="evenodd" />
          </svg>
          <div class="flex-1">
            <p class="text-sm font-medium text-yellow-400 mb-1">{$_t('Deprecated')}</p>
            <p class="text-sm text-yellow-400/80">
              {model.deprecationMessage}
            </p>
          </div>
        </div>
      </div>
    {/if}
  </div>
{/if}

<style>
  .model-info-tooltip {
    pointer-events: none;
  }
</style>
