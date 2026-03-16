<script lang="ts">
  /**
   * ErrorEvent - Renders error messages with prominent styling
   */
  import type { ProcessedEvent } from '@/types/ui';

  let { event }: { event: ProcessedEvent } = $props();
</script>

<div class="error-event border border-red-400/30 bg-red-500/10 rounded p-2">
  <div class="text-red-400 font-bold text-sm whitespace-pre-wrap">
    {typeof event.content === 'string' ? event.content : JSON.stringify(event.content)}
  </div>
</div>
