<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { marked } from 'marked';
  import type { UIUpdate } from '@/core/StreamProcessor';
  import { t, _t } from '../lib/i18n';
  import { uiTheme, type UITheme } from '../stores/themeStore';

  export let message: {
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp?: number;
    streaming?: boolean;
  };

  let currentTheme: UITheme = 'terminal';
  uiTheme.subscribe((theme) => {
    currentTheme = theme;
  });

  let content = message.content || '';
  let isStreaming = message.streaming || false;
  let streamBuffer = '';
  let updateTimer: number | null = null;

  function handleStreamUpdate(event: CustomEvent<UIUpdate>) {
    const update = event.detail;

    if (update.type === 'append') {
      streamBuffer += update.content;
    } else if (update.type === 'replace') {
      streamBuffer = update.content;
    } else if (update.type === 'clear') {
      streamBuffer = '';
      content = '';
    }

    // Batch UI updates for performance
    if (!updateTimer) {
      updateTimer = window.setTimeout(() => {
        content = streamBuffer;
        updateTimer = null;
      }, 50); // Update UI every 50ms max
    }

    isStreaming = true;
  }

  function handleStreamComplete(event: CustomEvent) {
    isStreaming = false;

    // Flush any remaining buffer
    if (updateTimer) {
      clearTimeout(updateTimer);
      updateTimer = null;
    }
    content = streamBuffer || content;
  }

  function handleStreamError(event: CustomEvent<{ error: string }>) {
    isStreaming = false;
    console.error('Stream error:', event.detail.error);

    // Add error indicator to content
    content += '\n\n' + t('[Error: Stream interrupted]');
  }

  onMount(() => {
    // Listen for stream events if this is a streaming message
    if (message.streaming) {
      window.addEventListener('stream-update', handleStreamUpdate as EventListener);
      window.addEventListener('stream-complete', handleStreamComplete as EventListener);
      window.addEventListener('stream-error', handleStreamError as EventListener);
    }
  });

  onDestroy(() => {
    // Cleanup event listeners
    if (message.streaming) {
      window.removeEventListener('stream-update', handleStreamUpdate as EventListener);
      window.removeEventListener('stream-complete', handleStreamComplete as EventListener);
      window.removeEventListener('stream-error', handleStreamError as EventListener);
    }

    // Clear any pending timer
    if (updateTimer) {
      clearTimeout(updateTimer);
    }
  });

  // Format timestamp
  function formatTime(timestamp: number): string {
    const date = new Date(timestamp);
    return date.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  // Parse content for code blocks and markdown using marked
  function parseContent(text: string): string {
    // Use marked for proper markdown parsing
    return marked.parse(text, {
      breaks: true, // Convert \n to <br>
      gfm: true, // GitHub Flavored Markdown
      headerIds: false, // Don't generate header IDs
      mangle: false, // Don't escape email addresses
    }) as string;
  }

  // Role-specific background classes
  $: roleBgClasses = message.role === 'user'
    ? (currentTheme === 'chatgpt'
      ? 'bg-blue-50 dark:bg-blue-900/30 ml-5'
      : 'bg-term-bg ml-5')
    : message.role === 'assistant'
      ? (currentTheme === 'chatgpt'
        ? 'bg-chat-surface dark:bg-chat-surface-dark mr-5'
        : 'bg-term-bg mr-5')
      : (currentTheme === 'chatgpt'
        ? 'bg-orange-50 dark:bg-orange-900/30 text-sm opacity-80'
        : 'bg-term-bg text-sm opacity-80');

  // Role label color
  $: roleLabelClasses = currentTheme === 'chatgpt'
    ? 'text-chat-text-secondary dark:text-chat-text-secondary-dark'
    : 'text-term-dim-green';

  // Timestamp color
  $: timestampClasses = currentTheme === 'chatgpt'
    ? 'text-chat-text-muted dark:text-chat-text-muted-dark'
    : 'text-term-dim-green';

  // Text color for content
  $: textColorClasses = currentTheme === 'chatgpt'
    ? 'text-chat-text dark:text-chat-text-dark'
    : 'text-term-green';

  // System message special text color
  $: systemTextClasses = message.role === 'system'
    ? (currentTheme === 'chatgpt'
      ? 'text-chat-text dark:text-chat-text-dark'
      : 'text-term-yellow')
    : '';
</script>

<div
  class="px-4 py-3 my-2 rounded-lg transition-all duration-200 {roleBgClasses} {systemTextClasses} {textColorClasses}"
  class:streaming={isStreaming}
>
  <div class="flex justify-between mb-2 text-sm">
    <span class="font-semibold {roleLabelClasses}">
      {#if message.role === 'user'}
        {$_t("You")}
      {:else if message.role === 'assistant'}
        {$_t("Browserx")}
      {:else}
        {$_t("System")}
      {/if}
    </span>
    {#if message.timestamp}
      <span class="{timestampClasses}">{formatTime(message.timestamp)}</span>
    {/if}
  </div>

  <div class="leading-normal min-w-0 overflow-hidden">
    {#if isStreaming}
      <div class="content-text break-words overflow-wrap-anywhere min-w-0">
        {@html parseContent(content)}
        <span class="cursor-blink inline-block font-normal
          {currentTheme === 'chatgpt'
            ? 'text-chat-primary dark:text-chat-primary-dark'
            : 'text-blue-500'}">▊</span>
      </div>
    {:else}
      <div class="content-text break-words overflow-wrap-anywhere min-w-0">
        {@html parseContent(content)}
      </div>
    {/if}
  </div>

  {#if isStreaming}
    <div class="flex gap-1 mt-2">
      <span class="dot w-2 h-2 rounded-full
        {currentTheme === 'chatgpt'
          ? 'bg-chat-primary dark:bg-chat-primary-dark'
          : 'bg-blue-500'}"></span>
      <span class="dot dot-2 w-2 h-2 rounded-full
        {currentTheme === 'chatgpt'
          ? 'bg-chat-primary dark:bg-chat-primary-dark'
          : 'bg-blue-500'}"></span>
      <span class="dot dot-3 w-2 h-2 rounded-full
        {currentTheme === 'chatgpt'
          ? 'bg-chat-primary dark:bg-chat-primary-dark'
          : 'bg-blue-500'}"></span>
    </div>
  {/if}
</div>

<style>
  .streaming {
    background-size: 200% 100%;
    animation: streaming-bg 2s ease-in-out infinite;
  }

  @keyframes streaming-bg {
    0% {
      background-position: 200% 0;
    }
    100% {
      background-position: -200% 0;
    }
  }

  .cursor-blink {
    animation: blink 1s infinite;
  }

  @keyframes blink {
    0%, 50% {
      opacity: 1;
    }
    51%, 100% {
      opacity: 0;
    }
  }

  .dot {
    animation: pulse 1.5s ease-in-out infinite;
  }

  .dot-2 {
    animation-delay: 0.2s;
  }

  .dot-3 {
    animation-delay: 0.4s;
  }

  @keyframes pulse {
    0%, 60%, 100% {
      opacity: 0.3;
      transform: scale(0.8);
    }
    30% {
      opacity: 1;
      transform: scale(1);
    }
  }

  /* Markdown styling — :global() selectors for rendered content */
  .content-text :global(h1),
  .content-text :global(h2),
  .content-text :global(h3),
  .content-text :global(h4),
  .content-text :global(h5),
  .content-text :global(h6) {
    margin-top: 1em;
    margin-bottom: 0.5em;
    font-weight: 600;
    line-height: 1.25;
  }

  .content-text :global(h1) {
    font-size: 1.5em;
    border-bottom: 1px solid #e0e0e0;
    padding-bottom: 0.3em;
  }

  .content-text :global(h2) {
    font-size: 1.3em;
    border-bottom: 1px solid #e0e0e0;
    padding-bottom: 0.3em;
  }

  .content-text :global(h3) {
    font-size: 1.15em;
  }

  .content-text :global(p) {
    margin: 0.5em 0;
    line-height: 1.6;
  }

  .content-text :global(ul),
  .content-text :global(ol) {
    margin: 0.5em 0;
    padding-left: 2em;
  }

  .content-text :global(li) {
    margin: 0.25em 0;
  }

  .content-text :global(code) {
    background: rgba(0, 0, 0, 0.05);
    padding: 0.2em 0.4em;
    border-radius: 3px;
    font-family: 'Monaco', 'Menlo', 'Courier New', monospace;
    font-size: 0.9em;
    word-break: break-word;
  }

  .content-text :global(pre) {
    background: #282c34;
    color: #abb2bf;
    padding: 1em;
    border-radius: 4px;
    margin: 0.5em 0;
    max-width: 100%;
    white-space: pre-wrap;
    word-wrap: break-word;
    overflow: visible;
  }

  .content-text :global(pre code) {
    background: transparent;
    padding: 0;
    color: inherit;
    font-size: 0.9em;
    white-space: pre-wrap;
    word-break: break-all;
    overflow: visible;
  }

  .content-text :global(blockquote) {
    border-left: 4px solid #ddd;
    padding-left: 1em;
    margin: 0.5em 0;
    color: #666;
  }

  .content-text :global(strong) {
    font-weight: 600;
  }

  .content-text :global(em) {
    font-style: italic;
  }

  .content-text :global(a) {
    color: #2196f3;
    text-decoration: none;
  }

  .content-text :global(a:hover) {
    text-decoration: underline;
  }

  .content-text :global(hr) {
    border: none;
    border-top: 1px solid #e0e0e0;
    margin: 1em 0;
  }

  .content-text :global(table) {
    border-collapse: collapse;
    width: 100%;
    margin: 0.5em 0;
  }

  .content-text :global(th),
  .content-text :global(td) {
    border: 1px solid #ddd;
    padding: 0.5em;
    text-align: left;
  }

  .content-text :global(th) {
    background: #f5f5f5;
    font-weight: 600;
  }

  .content-text :global(img) {
    max-width: 100%;
    height: auto;
  }

  /* Dark mode support for markdown content */
  @media (prefers-color-scheme: dark) {
    .content-text :global(h1),
    .content-text :global(h2) {
      border-bottom-color: #444;
    }

    .content-text :global(code) {
      background: rgba(255, 255, 255, 0.1);
    }

    .content-text :global(blockquote) {
      border-left-color: #555;
      color: #aaa;
    }

    .content-text :global(th) {
      background: #333;
    }

    .content-text :global(th),
    .content-text :global(td) {
      border-color: #555;
    }

    .content-text :global(hr) {
      border-top-color: #444;
    }
  }
</style>
