<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { UITheme } from '../stores/themeStore';

  let { theme = 'terminal' as UITheme, children }: {
    theme?: UITheme;
    children?: Snippet;
  } = $props();
</script>

<div
  class="terminal-container {theme} flex flex-col h-screen overflow-hidden
    {theme === 'modern'
      ? 'font-chat bg-chat-bg dark:bg-chat-bg-dark text-chat-text dark:text-chat-text-dark'
      : 'font-terminal bg-term-bg text-term-green'}"
  role="log"
  aria-label="Terminal output"
>
  {@render children?.()}
</div>
