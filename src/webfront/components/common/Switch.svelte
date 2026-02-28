<script lang="ts">
  import { createEventDispatcher, tick } from 'svelte';
  export let state = true;

  const dispatch = createEventDispatcher();

  async function handleClick() {
    state = !state;
    await tick();
    dispatch('change', state);
  }

  function handleKeyDown(event: KeyboardEvent) {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      handleClick();
    }
  }
</script>

<button
  type="button"
  role="switch"
  aria-checked={state}
  class="flex h-5 min-h-5 w-9 shrink-0 cursor-pointer items-center rounded-full px-[3px] transition-colors duration-200 border-none
    {state ? 'bg-emerald-600' : 'bg-gray-200'}
    outline outline-1 {state ? 'outline-emerald-600' : 'outline-gray-100'}"
  on:click={handleClick}
  on:keydown={handleKeyDown}
>
  <span class="pointer-events-none block h-4 w-4 shrink-0 rounded-full bg-white shadow-sm transition-transform duration-200
    {state ? 'translate-x-3.5' : 'translate-x-0'}" />
</button>

<style>
  :global(.dark) button {
    background-color: transparent;
    outline-color: #1f2937;
  }

  :global(.dark) button[aria-checked="true"] {
    background-color: #059669;
  }
</style>
