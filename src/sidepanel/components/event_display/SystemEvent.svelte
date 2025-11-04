<script lang="ts">
  /**
   * SystemEvent - Renders system notifications and metadata
   */
  import type { ProcessedEvent } from '../../../types/ui';

  export let event: ProcessedEvent;
</script>

<div class="system-event">
  <div class="text-xs text-gray-500 whitespace-pre-wrap font-mono">
    {typeof event.content === 'string' ? event.content : JSON.stringify(event.content, null, 2)}
  </div>
</div>
