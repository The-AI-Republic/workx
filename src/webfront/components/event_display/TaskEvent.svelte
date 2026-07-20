<script lang="ts">
  /**
   * TaskEvent - Renders task lifecycle events
   * Hides task completion card entirely when showTokenUsage setting is disabled
   */
  import type { ProcessedEvent } from '@/types/ui';
  import { uiTheme } from '../../stores/themeStore';
  import { showTokenUsage } from '../../stores/tokenUsageStore';
  import { formatCost } from '@/core/models/cost/cost';
  import { _t } from '../../lib/i18n';

  let { event }: {
    event: ProcessedEvent;
  } = $props();

  let currentTheme = $derived($uiTheme);
  let shouldShowTokenUsage = $derived($showTokenUsage);
  // Failure cards carry the error reason in `content` — they must render even
  // when token usage display is off (which only targets completion stats).
  let shouldHideCard = $derived(!shouldShowTokenUsage && event.status !== 'error');
</script>

{#if !shouldHideCard}
  <div class="task-event {currentTheme}">
    <div class="text-sm
      {currentTheme === 'modern'
        ? 'text-chat-text-secondary dark:text-chat-text-secondary-dark'
        : 'text-term-green'}">
      {typeof event.content === 'string' ? event.content : JSON.stringify(event.content)}
    </div>

    {#if event.metadata}
      <div class="text-meta font-normal mt-1
        {currentTheme === 'modern'
          ? 'text-chat-text-muted dark:text-chat-text-muted-dark'
          : 'text-gray-500'}">
        {#if event.metadata.model}
          <div>{$_t("Model:")} {event.metadata.model}</div>
        {/if}
        {#if event.metadata.turnCount}
          <div>{$_t("Turns:")} {event.metadata.turnCount}</div>
        {/if}
        {#if event.metadata.tokenUsage}
          <div>
            {$_t("Tokens:")} {event.metadata.tokenUsage.total.toLocaleString()}
            ({$_t("Input:")} {event.metadata.tokenUsage.input.toLocaleString()}, {$_t("Output:")} {event.metadata.tokenUsage.output.toLocaleString()})
          </div>
        {/if}
        {#if typeof event.metadata.costUSD === 'number'}
          <div>{$_t("Cost:")} {formatCost(event.metadata.costUSD)}{event.metadata.costEstimated ? ' ≈' : ''}</div>
        {/if}
      </div>
    {/if}
  </div>
{/if}
