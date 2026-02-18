<script lang="ts">
  import { uiTheme, type UITheme } from '../stores/themeStore';

  export let message: string | null = null;
  export let visible: boolean = false;

  let currentTheme: UITheme = 'terminal';

  uiTheme.subscribe((theme) => {
    currentTheme = theme;
  });
</script>

{#if visible && message}
  <div class="command-error {currentTheme}" role="alert">
    <span class="error-message">{message}</span>
  </div>
{/if}

<style>
  .command-error {
    position: absolute;
    bottom: 100%;
    left: 0;
    right: 0;
    z-index: 40;
    padding: 6px 12px;
    margin-bottom: 4px;
    border-radius: 4px;
    font-size: 12px;
    animation: fadeIn 0.15s ease;

    /* Terminal theme defaults */
    background-color: rgba(40, 0, 0, 0.95);
    border: 1px solid var(--color-term-red, #ff0000);
    color: var(--color-term-red, #ff4444);
  }

  .error-message {
    font-family: 'Monaco', 'Courier New', monospace;
  }

  /* ChatGPT theme */
  .command-error.chatgpt {
    background-color: var(--chat-error-bg, #fef2f2);
    border: 1px solid var(--chat-error-border, #fecaca);
    border-radius: 0.75rem;
    color: var(--chat-error, #ef4444);
  }

  .command-error.chatgpt .error-message {
    font-family: var(--font-chat, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
  }

  @media (prefers-color-scheme: dark) {
    .command-error.chatgpt {
      background-color: rgba(127, 29, 29, 0.3);
      border-color: rgba(239, 68, 68, 0.3);
      color: #fca5a5;
    }
  }

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
</style>
