<script lang="ts">
  /**
   * OutputEvent - Renders terminal-style command output
   */
  import type { ProcessedEvent } from '@/types/ui';
  import { truncateOutput } from '@/utils/formatters';

  export let event: ProcessedEvent;
  export let maxLines: number = 20;

  let showAll = false;

  $: displayContent = showAll
    ? (typeof event.content === 'string' ? event.content : JSON.stringify(event.content))
    : truncateOutput(
        typeof event.content === 'string' ? event.content : JSON.stringify(event.content),
        maxLines
      );

  $: isTruncated =
    !showAll &&
    (typeof event.content === 'string' ? event.content : JSON.stringify(event.content)).split('\n')
      .length > maxLines;
</script>

<div class="output-event bg-black/30 rounded p-2 font-mono">
  <pre class="text-gray-300 text-xs whitespace-pre-wrap overflow-x-auto">{displayContent}</pre>

  {#if isTruncated}
    <button
      class="text-cyan-400 text-xs mt-2 hover:underline"
      on:click={() => (showAll = true)}
    >
      Show all
    </button>
  {:else if showAll}
    <button
      class="text-cyan-400 text-xs mt-2 hover:underline"
      on:click={() => (showAll = false)}
    >
      Show less
    </button>
  {/if}
</div>
