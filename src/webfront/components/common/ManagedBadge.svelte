<script lang="ts">
  // Track 20: "Managed by your organization" affordance for policy-locked
  // settings. Render next to a disabled control when `locked` is true.
  import { uiTheme } from '../../stores/themeStore';

  let {
    locked = false,
    tooltip = 'Managed by your organization — contact your administrator to change this.',
  }: {
    locked?: boolean;
    tooltip?: string;
  } = $props();

  // Terminal theme uses the terminal amber/yellow; modern keeps the amber badge
  // with a dark-mode variant so it stays legible in modern-dark.
  let badgeClass = $derived($uiTheme === 'terminal'
    ? 'bg-term-yellow/10 text-term-yellow border border-term-yellow/30'
    : 'bg-amber-100 dark:bg-amber-400/20 text-amber-800 dark:text-amber-300');
</script>

{#if locked}
  <span
    class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium align-middle {badgeClass}"
    title={tooltip}
    data-testid="managed-badge"
  >
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 20 20"
      fill="currentColor"
      class="h-3 w-3"
      aria-hidden="true"
    >
      <path
        fill-rule="evenodd"
        d="M10 1a4.5 4.5 0 0 0-4.5 4.5V9H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-.5V5.5A4.5 4.5 0 0 0 10 1Zm3 8V5.5a3 3 0 1 0-6 0V9h6Z"
        clip-rule="evenodd"
      />
    </svg>
    Managed by your organization
  </span>
{/if}
