<script lang="ts">
  import { uiTheme } from '../stores/themeStore';

  export let message: string | null = null;
  export let visible: boolean = false;

  $: currentTheme = $uiTheme;
</script>

{#if visible && message}
  <div
    class="absolute bottom-full inset-x-0 z-40 px-3 py-1.5 mb-1 rounded text-base animate-fade-in
      border border-[var(--color-term-red,#ff0000)] bg-[rgba(40,0,0,0.95)] text-[var(--color-term-red,#ff4444)]
      {currentTheme === 'chatgpt' ? 'chatgpt-error' : ''}"
    role="alert"
  >
    <span class="font-mono {currentTheme === 'chatgpt' ? 'chatgpt-error-text' : ''}">{message}</span>
  </div>
{/if}

<style>
  @keyframes fadeIn {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .animate-fade-in {
    animation: fadeIn 0.15s ease;
  }

  /* ChatGPT theme overrides */
  .chatgpt-error {
    background-color: var(--chat-error-bg, #fef2f2);
    border: 1px solid var(--chat-error-border, #fecaca);
    border-radius: 0.75rem;
    color: var(--chat-error, #ef4444);
  }

  .chatgpt-error-text {
    font-family: var(--font-chat, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
  }

  @media (prefers-color-scheme: dark) {
    .chatgpt-error {
      background-color: rgba(127, 29, 29, 0.3);
      border-color: rgba(239, 68, 68, 0.3);
      color: #fca5a5;
    }
  }
</style>
