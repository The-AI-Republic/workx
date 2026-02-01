<script lang="ts">
  import type { UITheme } from '../stores/themeStore';

  export let theme: UITheme = 'terminal';
</script>

<div class="terminal-container {theme}" role="log" aria-label="Terminal output">
  <slot />
</div>

<style>
  .terminal-container {
    display: flex;
    flex-direction: column;
    height: 100vh;
    overflow: hidden;
    /* Terminal theme (default) */
    font-family: 'Menlo', 'Monaco', 'Consolas', 'Liberation Mono', 'Courier New', monospace;
    background: #000000;
    color: #00ff00;
  }

  /* ChatGPT theme override */
  .terminal-container.chatgpt {
    font-family: var(--font-chat, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif);
    background: var(--chat-bg, #ffffff);
    color: var(--chat-text, #0d0d0d);
  }
</style>