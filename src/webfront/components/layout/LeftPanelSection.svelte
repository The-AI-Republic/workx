<script lang="ts">
  /**
   * A grouping section for the left panel. Renders an optional uppercase title
   * header followed by its children. Introduced so the left panel can group
   * items (e.g. primary navigation vs. "Chat History") instead of being a
   * single flat list.
   */
  import type { Snippet } from 'svelte';
  import { uiTheme } from '../../stores/themeStore';
  import { _t } from '../../lib/i18n';

  let {
    title = '',
    children,
  }: {
    /** Optional section header. When empty, no header is rendered. */
    title?: string;
    children?: Snippet;
  } = $props();

  let currentTheme = $derived($uiTheme);
</script>

<div class="flex flex-col">
  {#if title}
    <div class="px-2 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide
      {currentTheme === 'modern'
        ? 'text-chat-text-secondary dark:text-chat-text-secondary-dark'
        : 'text-term-dim-green'}">
      {$_t(title)}
    </div>
  {/if}
  <div class="flex flex-col gap-1">
    {@render children?.()}
  </div>
</div>
