<script lang="ts">
  /**
   * MessageEvent - Renders agent and user messages
   */
  import { marked } from 'marked';
  import type { ProcessedEvent } from '../../../types/ui';

  export let event: ProcessedEvent;

  // Parse markdown content
  function parseMarkdown(text: string): string {
    return marked.parse(text, {
      breaks: true,
      gfm: true,
      headerIds: false,
      mangle: false,
    }) as string;
  }

  $: contentHtml = typeof event.content === 'string'
    ? parseMarkdown(event.content)
    : JSON.stringify(event.content);
</script>

<div class="message-event">
  <div class={`text-sm markdown-content ${event.style.textColor}`}>
    {@html contentHtml}
  </div>

  {#if event.streaming}
    <span class="streaming-cursor">▊</span>
  {/if}
</div>

<style>
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
  }

  .markdown-content :global(pre) {
    background: #282c34;
    color: #abb2bf;
    padding: 1em;
    border-radius: 4px;
    overflow-x: auto;
    margin: 0.5em 0;
  }

  .markdown-content :global(pre code) {
    background: transparent;
    padding: 0;
    color: inherit;
    font-size: 0.9em;
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
    display: inline-block;
    animation: blink 1s step-end infinite;
    color: currentColor;
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

  /* Dark mode support */
  @media (prefers-color-scheme: dark) {
    .markdown-content :global(h1),
    .markdown-content :global(h2) {
      border-bottom-color: #444;
    }

    .markdown-content :global(code) {
      background: rgba(255, 255, 255, 0.1);
    }

    .markdown-content :global(blockquote) {
      border-left-color: #555;
      color: #aaa;
    }

    .markdown-content :global(th) {
      background: #333;
    }

    .markdown-content :global(th),
    .markdown-content :global(td) {
      border-color: #555;
    }

    .markdown-content :global(hr) {
      border-top-color: #444;
    }
  }
</style>
