<script lang="ts">
  /**
   * MessageEvent - Renders agent and user messages
   */
  import type { ProcessedEvent } from '@/types/ui';
  import { uiTheme } from '../../stores/themeStore';
  import { parseMarkdownWithDiff } from './diffMarkdown';

  let { event }: { event: ProcessedEvent } = $props();

  let contentHtml = $derived(typeof event.content === 'string'
    ? parseMarkdownWithDiff(event.content)
    : JSON.stringify(event.content));

  let isUserMessage = $derived(event.title === 'user');

  // Modern Chat theme text color depends on user vs agent message
  let modernTextClasses = $derived(isUserMessage
    ? 'text-white'
    : 'text-chat-text dark:text-chat-text-dark');

  // Content text classes based on theme
  let contentClasses = $derived($uiTheme === 'modern'
    ? modernTextClasses
    : event.style.textColor);
</script>

<div class="message-event {$uiTheme}" class:user-message={isUserMessage}>
  <div class="markdown-content text-sm min-w-0 overflow-hidden {contentClasses}">
    {@html contentHtml}
  </div>

  {#if event.streaming}
    <span class="streaming-cursor inline-block
      {$uiTheme === 'modern' && isUserMessage
        ? 'text-white'
        : 'text-current'}">▊</span>
  {/if}
</div>

<style>
  /* Markdown styling — :global() selectors for rendered content */
  .markdown-content :global(h1),
  .markdown-content :global(h2),
  .markdown-content :global(h3),
  .markdown-content :global(h4),
  .markdown-content :global(h5),
  .markdown-content :global(h6) {
    margin-top: 1em;
    margin-bottom: 0.5em;
    font-weight: 600;
    line-height: 1.25;
  }

  .markdown-content :global(h1) {
    font-size: 1.5em;
    border-bottom: 1px solid #e0e0e0;
    padding-bottom: 0.3em;
  }

  .markdown-content :global(h2) {
    font-size: 1.3em;
    border-bottom: 1px solid #e0e0e0;
    padding-bottom: 0.3em;
  }

  .markdown-content :global(h3) {
    font-size: 1.15em;
  }

  .markdown-content :global(p) {
    margin: 0.5em 0;
    line-height: 1.6;
  }

  .markdown-content :global(ul),
  .markdown-content :global(ol) {
    margin: 0.5em 0;
    padding-left: 2em;
  }

  .markdown-content :global(li) {
    margin: 0.25em 0;
  }

  .markdown-content :global(code) {
    background: rgba(0, 0, 0, 0.05);
    padding: 0.2em 0.4em;
    border-radius: 3px;
    font-family: 'Monaco', 'Menlo', 'Courier New', monospace;
    font-size: 0.9em;
    word-break: break-word;
  }

  .markdown-content :global(pre) {
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

  .markdown-content :global(pre code) {
    background: transparent;
    padding: 0;
    color: inherit;
    font-size: 0.9em;
    white-space: pre-wrap;
    word-break: break-all;
    overflow: visible;
  }

  .markdown-content :global(.diff-block) {
    background: #0f172a;
    color: #cbd5e1;
    padding: 0.75em 0;
    overflow-x: auto;
  }

  .markdown-content :global(.diff-line) {
    display: block;
    padding: 0 1em;
    min-height: 1.35em;
    white-space: pre;
  }

  .markdown-content :global(.diff-add) {
    color: #86efac;
    background: rgba(34, 197, 94, 0.16);
  }

  .markdown-content :global(.diff-del) {
    color: #fca5a5;
    background: rgba(239, 68, 68, 0.16);
  }

  .markdown-content :global(.diff-hunk) {
    color: #93c5fd;
    background: rgba(59, 130, 246, 0.14);
  }

  .markdown-content :global(.diff-file) {
    color: #fde68a;
    background: rgba(245, 158, 11, 0.12);
  }

  .markdown-content :global(blockquote) {
    border-left: 4px solid #ddd;
    padding-left: 1em;
    margin: 0.5em 0;
    color: #666;
  }

  .markdown-content :global(a) {
    color: #2196f3;
    text-decoration: none;
  }

  .markdown-content :global(a:hover) {
    text-decoration: underline;
  }

  .markdown-content :global(strong) {
    font-weight: 600;
  }

  .markdown-content :global(em) {
    font-style: italic;
  }

  .markdown-content :global(hr) {
    border: none;
    border-top: 1px solid #e0e0e0;
    margin: 1em 0;
  }

  .markdown-content :global(table) {
    border-collapse: collapse;
    width: 100%;
    margin: 0.5em 0;
  }

  .markdown-content :global(th),
  .markdown-content :global(td) {
    border: 1px solid #ddd;
    padding: 0.5em;
    text-align: left;
  }

  .markdown-content :global(th) {
    background: #f5f5f5;
    font-weight: 600;
  }

  .markdown-content :global(img) {
    max-width: 100%;
    height: auto;
  }

  .streaming-cursor {
    animation: blink 1s step-end infinite;
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

  /* Dark mode support for markdown content */
  :global(.dark) .markdown-content :global(h1),
  :global(.dark) .markdown-content :global(h2) {
    border-bottom-color: #444;
  }

  :global(.dark) .markdown-content :global(code) {
    background: rgba(255, 255, 255, 0.1);
  }

  :global(.dark) .markdown-content :global(blockquote) {
    border-left-color: #555;
    color: #aaa;
  }

  :global(.dark) .markdown-content :global(th) {
    background: #333;
  }

  :global(.dark) .markdown-content :global(th),
  :global(.dark) .markdown-content :global(td) {
    border-color: #555;
  }

  :global(.dark) .markdown-content :global(hr) {
    border-top-color: #444;
  }

  /* Modern Chat theme overrides for rendered markdown — :global() selectors */
  .message-event.modern .markdown-content :global(a) {
    color: var(--color-chat-primary);
  }

  .message-event.modern .markdown-content :global(code) {
    background: rgba(0, 0, 0, 0.08);
  }

  .message-event.modern .markdown-content :global(blockquote) {
    color: var(--color-chat-text-secondary);
  }

  /* Modern Chat theme — user messages rendered markdown overrides */
  .message-event.modern.user-message .markdown-content :global(a) {
    color: rgba(255, 255, 255, 0.9);
    text-decoration: underline;
  }

  .message-event.modern.user-message .markdown-content :global(code) {
    background: rgba(255, 255, 255, 0.2);
    color: #ffffff;
  }

  .message-event.modern.user-message .markdown-content :global(blockquote) {
    border-left-color: rgba(255, 255, 255, 0.5);
    color: rgba(255, 255, 255, 0.9);
  }
</style>
