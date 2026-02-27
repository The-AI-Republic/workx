<script lang="ts">
  import type { UITheme } from '../stores/themeStore';

  export let theme: UITheme = 'terminal';
</script>

<div
  class="terminal-container {theme} flex flex-col h-screen overflow-hidden
    {theme === 'modern'
      ? 'font-chat bg-chat-bg dark:bg-chat-bg-dark text-chat-text dark:text-chat-text-dark'
      : 'font-terminal bg-term-bg text-term-green'}"
  role="log"
  aria-label="Terminal output"
>
  <slot />
</div>
