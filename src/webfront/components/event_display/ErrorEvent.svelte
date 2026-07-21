<script lang="ts">
  /**
   * ErrorEvent - Renders error messages with prominent styling
   */
  import type { ProcessedEvent } from '@/types/ui';
  import { uiTheme } from '../../stores/themeStore';

  let { event }: { event: ProcessedEvent } = $props();
</script>

<div class="error-event border rounded p-2
  {$uiTheme === 'modern'
    ? 'border-chat-status-error/30 dark:border-chat-status-error-dark/30 bg-chat-status-error/10 dark:bg-chat-status-error-dark/10'
    : 'border-term-red/30 bg-term-red/10'}">
  <div class="font-bold text-sm whitespace-pre-wrap
    {$uiTheme === 'modern'
      ? 'font-chat text-chat-status-error dark:text-chat-status-error-dark'
      : 'font-terminal text-term-red'}">
    {typeof event.content === 'string' ? event.content : JSON.stringify(event.content)}
  </div>
</div>
