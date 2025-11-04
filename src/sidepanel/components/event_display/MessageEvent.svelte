<script lang="ts">
  /**
   * MessageEvent - Renders agent and user messages
   */
  import type { ProcessedEvent } from '../../../types/ui';

  export let event: ProcessedEvent;
</script>

<div class="message-event">
  <div class={`text-sm whitespace-pre-wrap ${event.style.textColor}`}>
    {typeof event.content === 'string' ? event.content : JSON.stringify(event.content)}
  </div>

  {#if event.streaming}
    <span class="streaming-cursor">▊</span>
  {/if}
</div>

<style>
  .streaming-cursor {
    display: inline-block;
    animation: blink 1s step-end infinite;
    color: currentColor;
  }

  @keyframes blink {
    0%,
    50% {
      opacity: 1;
    }
    51%,
    100% {
      opacity: 0;
    }
  }
</style>
