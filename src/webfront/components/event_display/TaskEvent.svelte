<script lang="ts">
  /**
   * TaskEvent - Renders task lifecycle events
   * Hides task completion card entirely when showTokenUsage setting is disabled
   */
  import type { ProcessedEvent } from '@/types/ui';
  import { uiTheme, type UITheme } from '../../stores/themeStore';
  import { showTokenUsage } from '../../stores/tokenUsageStore';
  import { _t } from '../../lib/i18n';

  export let event: ProcessedEvent;

  let currentTheme: UITheme = 'terminal';
  uiTheme.subscribe((theme) => {
    currentTheme = theme;
  });

  let shouldShowTokenUsage = false;
  showTokenUsage.subscribe((show) => {
    shouldShowTokenUsage = show;
  });

  // Hide all task cards (started, complete, etc.) when setting is disabled
  $: shouldHideCard = !shouldShowTokenUsage;
</script>

{#if !shouldHideCard}
  <div class="task-event {currentTheme}">
    <div class="task-content text-sm">
      {typeof event.content === 'string' ? event.content : JSON.stringify(event.content)}
    </div>

    {#if event.metadata}
      <div class="task-metadata text-xs mt-1">
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
      </div>
    {/if}
  </div>
{/if}

<style>
  /* Terminal theme (default) */
  .task-event.terminal .task-content {
    color: #00ff00;
  }

  .task-event.terminal .task-metadata {
    color: #6b7280;
  }

  /* ChatGPT theme */
  .task-event.chatgpt .task-content {
    color: var(--chat-text-secondary, #6e6e80);
  }

  .task-event.chatgpt .task-metadata {
    color: var(--chat-text-muted, #8e8ea0);
  }
</style>
