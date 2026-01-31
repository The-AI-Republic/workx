<script lang="ts">
  /**
   * ReasoningEvent - Renders agent reasoning/thinking process
   */
  import type { ProcessedEvent } from '../../../../open_source/src/types/ui';

  export let event: ProcessedEvent;
</script>

<div class="reasoning-event">
  <div class={`text-sm whitespace-pre-wrap ${event.style.textColor} ${event.style.textStyle === 'italic' ? 'italic' : ''}`}>
    {typeof event.content === 'string' ? event.content : JSON.stringify(event.content)}
  </div>
</div>
