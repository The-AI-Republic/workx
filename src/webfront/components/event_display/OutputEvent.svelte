<script lang="ts">
  /**
   * OutputEvent - Renders terminal-style command output
   */
  import type { ProcessedEvent } from '@/types/ui';
  import { truncateOutput } from '@/utils/formatters';
  import { _t } from '../../lib/i18n';

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
</script>

<div class="output-event bg-black/30 rounded p-2 font-mono">
  <pre class="text-gray-300 text-sm whitespace-pre-wrap overflow-x-auto">{displayContent}</pre>

  {#if isTruncated}
    <button
      class="text-cyan-400 text-sm mt-2 hover:underline"
      onclick={() => (showAll = true)}
    >
      {$_t("Show all")}
    </button>
  {:else if showAll}
    <button
      class="text-cyan-400 text-sm mt-2 hover:underline"
      onclick={() => (showAll = false)}
    >
      {$_t("Show less")}
    </button>
  {/if}
</div>
