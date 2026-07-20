<script lang="ts">
  /**
   * OutputEvent - Renders terminal-style command output
   */
  import type { ProcessedEvent } from '@/types/ui';
  import { truncateOutput } from '@/utils/formatters';
  import { _t } from '../../lib/i18n';
  import { uiTheme } from '../../stores/themeStore';

  let { event, maxLines = 20 }: {
    event: ProcessedEvent;
    maxLines?: number;
  } = $props();

  let showAll = $state(false);

  let displayContent = $derived(showAll
    ? (typeof event.content === 'string' ? event.content : JSON.stringify(event.content))
    : truncateOutput(
        typeof event.content === 'string' ? event.content : JSON.stringify(event.content),
        maxLines
      ));

  let isTruncated = $derived(
    !showAll &&
    (typeof event.content === 'string' ? event.content : JSON.stringify(event.content)).split('\n')
      .length > maxLines);

  // Theme-aware styling for the output card, its text, and the toggle button.
  let cardClass = $derived($uiTheme === 'modern'
    ? 'bg-chat-code-bg dark:bg-chat-code-bg-dark'
    : 'bg-black/30');
  let textClass = $derived($uiTheme === 'modern'
    ? 'text-chat-text-secondary dark:text-chat-text-secondary-dark'
    : 'text-term-dim-green');
  let buttonClass = $derived($uiTheme === 'modern'
    ? 'text-chat-primary dark:text-chat-primary-dark'
    : 'text-term-blue');
</script>

<div class="output-event rounded p-2 font-mono {cardClass}">
  <pre class="text-sm whitespace-pre-wrap overflow-x-auto {textClass}">{displayContent}</pre>

  {#if isTruncated}
    <button
      class="text-sm mt-2 hover:underline {buttonClass}"
      onclick={() => (showAll = true)}
    >
      {$_t("Show all")}
    </button>
  {:else if showAll}
    <button
      class="text-sm mt-2 hover:underline {buttonClass}"
      onclick={() => (showAll = false)}
    >
      {$_t("Show less")}
    </button>
  {/if}
</div>
