<script lang="ts">
  import { uiTheme, type UITheme } from '../stores/themeStore';

  export let type: 'default' | 'warning' | 'error' | 'input' | 'system' = 'default';
  export let content: string;

  let currentTheme: UITheme = 'terminal';
  uiTheme.subscribe((theme) => {
    currentTheme = theme;
  });

  const terminalColors: Record<string, string> = {
    default: 'text-term-green',
    warning: 'text-term-yellow',
    error: 'text-term-red',
    input: 'text-term-blue',
    system: 'text-term-dim-green',
  };

  const chatgptColors: Record<string, string> = {
    default: 'text-chat-text dark:text-chat-text-dark',
    warning: 'text-chat-status-warning dark:text-chat-status-warning-dark',
    error: 'text-chat-status-error dark:text-chat-status-error-dark',
    input: 'text-chat-primary dark:text-chat-primary-dark',
    system: 'text-chat-text-muted dark:text-chat-text-muted-dark',
  };

  $: colorClasses = currentTheme === 'chatgpt'
    ? (chatgptColors[type] || chatgptColors.default)
    : (terminalColors[type] || terminalColors.default);
</script>

<div class="terminal-message {type} {currentTheme} text-sm leading-relaxed font-[inherit] {colorClasses}" aria-live="polite" aria-atomic="true">
  {content}
</div>
