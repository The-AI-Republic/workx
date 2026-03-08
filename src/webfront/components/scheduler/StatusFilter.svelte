<script lang="ts">
  import { uiTheme } from '../../stores/themeStore';
  import { t } from '../../lib/i18n';

  let {
    statuses = [],
    selected = new Set<string>(),
    onchange,
  }: {
    statuses?: string[];
    selected?: Set<string>;
    onchange?: (next: Set<string>) => void;
  } = $props();

  let currentTheme = $derived($uiTheme);

  function getStatusColor(status: string): string {
    switch (status) {
      case 'completed': return 'bg-[rgba(16,185,129,0.2)] text-emerald-500 border-emerald-500/30';
      case 'failed': return 'bg-[rgba(239,68,68,0.2)] text-red-500 border-red-500/30';
      case 'cancelled': return 'bg-[rgba(128,128,128,0.2)] text-gray-400 border-gray-500/30';
      default: return 'bg-[rgba(128,128,128,0.2)] text-gray-400 border-gray-500/30';
    }
  }

  function toggle(status: string) {
    const next = new Set(selected);
    if (next.has(status)) {
      // Don't allow deselecting all
      if (next.size > 1) {
        next.delete(status);
      }
    } else {
      next.add(status);
    }
    selected = next;
    onchange?.(next);
  }

  function getLabel(status: string): string {
    return t(status.charAt(0).toUpperCase() + status.slice(1));
  }
</script>

<div class="flex gap-1.5 flex-wrap">
  {#each statuses as status}
    <button
      class="px-2 py-0.5 text-xs rounded-full cursor-pointer transition-all duration-200 border
        {selected.has(status)
          ? getStatusColor(status)
          : currentTheme === 'modern'
            ? 'bg-transparent border-chat-border dark:border-chat-border-dark text-chat-text-muted dark:text-chat-text-muted-dark opacity-50'
            : 'bg-transparent border-[rgba(0,255,0,0.15)] text-term-dim-green opacity-50'}"
      onclick={() => toggle(status)}
    >
      {getLabel(status)}
    </button>
  {/each}
</div>
