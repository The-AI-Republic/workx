<script lang="ts">
  /**
   * ToolCallEvent - Renders tool call operations with metadata
   */
  import type { ProcessedEvent } from '../../../../open_source/src/types/ui';
  import { formatDuration } from '../../../../open_source/src/utils/formatters';

  export let event: ProcessedEvent;
</script>

<div class="tool-call-event">
  <div class={`text-sm ${event.style.textColor}`}>
    {#if event.metadata?.duration}
      <span class="text-gray-500">
        ({formatDuration(event.metadata.duration)})
      </span>
    {/if}
  </div>

  <div class="text-sm text-gray-300 mt-1 whitespace-pre-wrap font-mono">
    {typeof event.content === 'string' ? event.content : JSON.stringify(event.content, null, 2)}
  </div>

  {#if event.metadata}
    <div class="text-xs text-gray-500 mt-1">
      {#if event.metadata.command}
        <div>Command: {event.metadata.command}</div>
      {/if}
      {#if event.metadata.workingDir}
        <div>CWD: {event.metadata.workingDir}</div>
      {/if}
      {#if event.metadata.exitCode !== undefined}
        <div>Exit Code: {event.metadata.exitCode}</div>
      {/if}
      {#if event.metadata.toolName}
        <div>Tool: {event.metadata.toolName}</div>
      {/if}
    </div>
  {/if}
</div>
