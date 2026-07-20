<script lang="ts">
  import { tick } from 'svelte';
  import { uiTheme } from '../../stores/themeStore';

  let { state = $bindable(true), onChange }: {
    state?: boolean;
    onChange?: (value: boolean) => void;
  } = $props();

  async function handleClick() {
    state = !state;
    await tick();
    onChange?.(state);
  }

  function handleKeyDown(event: KeyboardEvent) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleClick();
    }
  }

  // Terminal theme uses the terminal palette; modern theme keeps the emerald/gray
  // look (with dark-mode handled by the :global(.dark) rules below).
  let trackClass = $derived($uiTheme === 'terminal'
    ? (state ? 'bg-term-green outline-term-green' : 'bg-term-bg outline-term-dim-green')
    : (state ? 'bg-emerald-600 outline-emerald-600' : 'bg-gray-200 outline-gray-100'));
  let knobClass = $derived($uiTheme === 'terminal' ? 'bg-term-bg' : 'bg-white');
</script>

<button
  type="button"
  role="switch"
  aria-checked={state}
  class="flex h-5 min-h-5 w-9 shrink-0 cursor-pointer items-center rounded-full px-[3px] transition-colors duration-200 border-none
    outline outline-1 {trackClass}"
  class:terminal={$uiTheme === 'terminal'}
  onclick={handleClick}
  onkeydown={handleKeyDown}
>
  <span class="pointer-events-none block h-4 w-4 shrink-0 rounded-full shadow-sm transition-transform duration-200 {knobClass}
    {state ? 'translate-x-3.5' : 'translate-x-0'}" />
</button>

<style>
  /* Modern dark-mode track colors. Scoped to :not(.terminal) so the terminal
     theme (which does not toggle the .dark class) keeps its own palette. */
  :global(.dark) button:not(.terminal) {
    background-color: transparent;
    outline-color: #1f2937;
  }

  :global(.dark) button:not(.terminal)[aria-checked="true"] {
    background-color: #059669;
  }
</style>
