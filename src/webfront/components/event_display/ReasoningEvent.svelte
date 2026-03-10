<script lang="ts">
  /**
   * ReasoningEvent - Renders agent reasoning/thinking process
   */
  import type { ProcessedEvent } from '@/types/ui';

  let { event }: { event: ProcessedEvent } = $props();
</script>

<div class="reasoning-event">
  <div class={`text-sm whitespace-pre-wrap ${event.style.textColor} ${event.style.textStyle === 'italic' ? 'italic' : ''}`}>
    {typeof event.content === 'string' ? event.content : JSON.stringify(event.content)}
  </div>
</div>
