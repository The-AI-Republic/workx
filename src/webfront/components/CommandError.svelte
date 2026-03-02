<script lang="ts">
  import { uiTheme } from '../stores/themeStore';

  export let message: string | null = null;
  export let visible: boolean = false;

  $: currentTheme = $uiTheme;
</script>

{#if visible && message}
  <div
    class="absolute bottom-full inset-x-0 z-40 px-3 py-1.5 mb-1 text-sm animate-fade-in
      {currentTheme === 'modern'
        ? 'bg-chat-error/10 dark:bg-[rgba(127,29,29,0.3)] border border-chat-error/30 dark:border-chat-error-dark/30 text-chat-error dark:text-chat-error-dark rounded-xl'
        : 'border border-term-red bg-[rgba(40,0,0,0.95)] text-term-red rounded'}"
    role="alert"
  >
    <span class="{currentTheme === 'modern' ? 'font-chat' : 'font-mono'}">{message}</span>
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
</style>
