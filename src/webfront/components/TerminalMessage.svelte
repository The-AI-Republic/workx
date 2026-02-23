<script lang="ts">
  import { uiTheme, type UITheme } from '../stores/themeStore';

  export let type: 'default' | 'warning' | 'error' | 'input' | 'system' = 'default';
  export let content: string;

  let currentTheme: UITheme = 'terminal';
  uiTheme.subscribe((theme) => {
    currentTheme = theme;
  });
</script>

<div class="terminal-message {type} {currentTheme}" aria-live="polite" aria-atomic="true">
  {content}
</div>

<style>
  .terminal-message {
    font-family: inherit;
    font-size: 0.875rem;
    line-height: 1.5;
  }

  /* Terminal Theme Colors (default) */
  .terminal-message.terminal.default { color: #00ff00; }
  .terminal-message.terminal.warning { color: #ffff00; }
  .terminal-message.terminal.error { color: #ff0000; }
  .terminal-message.terminal.input { color: #60a5fa; }
  .terminal-message.terminal.system { color: #00cc00; }

  /* ChatGPT Theme Colors */
  .terminal-message.chatgpt.default { color: var(--chat-text, #0d0d0d); }
  .terminal-message.chatgpt.warning { color: var(--chat-status-warning, #f59e0b); }
  .terminal-message.chatgpt.error { color: var(--chat-status-error, #ef4444); }
  .terminal-message.chatgpt.input { color: var(--chat-primary, #60a5fa); }
  .terminal-message.chatgpt.system { color: var(--chat-text-muted, #8e8ea0); }
</style>