<script lang="ts">
  /**
   * ToolCallEvent - Renders tool call operations with metadata
   */
  import type { ProcessedEvent } from '@/types/ui';
  import { formatDuration } from '@/utils/formatters';
  import { _t } from '../../lib/i18n';
  import { uiTheme } from '../../stores/themeStore';

  let { event }: { event: ProcessedEvent } = $props();

  // Theme-aware text colors: muted for metadata, normal for content body.
  let mutedText = $derived($uiTheme === 'modern'
    ? 'text-chat-text-muted dark:text-chat-text-muted-dark'
    : 'text-term-dim-green');
  let bodyText = $derived($uiTheme === 'modern'
    ? 'text-chat-text-secondary dark:text-chat-text-secondary-dark'
    : 'text-term-dim-green');
</script>

<div class="tool-call-event">
  <div class={`text-sm ${event.style.textColor}`}>
    {#if event.metadata?.duration}
      <span class="text-meta font-normal {mutedText}">
        ({formatDuration(event.metadata.duration)})
      </span>
    {/if}
  </div>

  <div class="text-sm mt-1 whitespace-pre-wrap font-mono {bodyText}">
    {typeof event.content === 'string' ? event.content : JSON.stringify(event.content, null, 2)}
  </div>

  {#if event.metadata}
    <div class="text-meta font-normal mt-1 {mutedText}">
      {#if event.metadata.command}
        <div>{$_t("Command:")} {event.metadata.command}</div>
      {/if}
      {#if event.metadata.workingDir}
        <div>{$_t("CWD:")} {event.metadata.workingDir}</div>
      {/if}
      {#if event.metadata.exitCode !== undefined}
        <div>{$_t("Exit Code:")} {event.metadata.exitCode}</div>
      {/if}
      {#if event.metadata.toolName}
        <div>{$_t("Tool:")} {event.metadata.toolName}</div>
      {/if}
    </div>
  {/if}
</div>
