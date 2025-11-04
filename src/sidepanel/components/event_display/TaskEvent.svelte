<script lang="ts">
  /**
   * TaskEvent - Renders task lifecycle events
   */
  import type { ProcessedEvent } from '../../../types/ui';

  export let event: ProcessedEvent;
</script>

<div class="task-event">
  <div class={`text-sm ${event.style.textColor}`}>
    {typeof event.content === 'string' ? event.content : JSON.stringify(event.content)}
  </div>

  {#if event.metadata}
    <div class="text-xs text-gray-500 mt-1">
      {#if event.metadata.model}
        <div>Model: {event.metadata.model}</div>
      {/if}
      {#if event.metadata.turnCount}
        <div>Turns: {event.metadata.turnCount}</div>
      {/if}
      {#if event.metadata.tokenUsage}
        <div>
          Tokens: {event.metadata.tokenUsage.total.toLocaleString()}
          (Input: {event.metadata.tokenUsage.input.toLocaleString()}, Output: {event.metadata.tokenUsage.output.toLocaleString()})
        </div>
      {/if}
    </div>
  {/if}
</div>
