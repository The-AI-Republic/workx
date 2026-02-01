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
  class="switch-root {state ? 'checked' : ''}"
  on:click={handleClick}
  on:keydown={handleKeyDown}
>
  <span class="switch-thumb {state ? 'checked' : ''}" />
</button>

<style>
  .switch-root {
    display: flex;
    height: 1.25rem;
    min-height: 1.25rem;
    width: 2.25rem;
    flex-shrink: 0;
    cursor: pointer;
    align-items: center;
    border-radius: 9999px;
    padding-left: 3px;
    padding-right: 3px;
    transition: background-color 0.2s;
    background-color: #e5e7eb;
    outline: 1px solid #f3f4f6;
    border: none;
  }

  .switch-root.checked {
    background-color: #059669;
  }

  :global(.dark) .switch-root {
    background-color: transparent;
    outline-color: #1f2937;
  }

  :global(.dark) .switch-root.checked {
    background-color: #059669;
  }

  .switch-thumb {
    pointer-events: none;
    display: block;
    width: 1rem;
    height: 1rem;
    flex-shrink: 0;
    border-radius: 9999px;
    background-color: white;
    transition: transform 0.2s;
    transform: translateX(0);
    box-shadow: 0 1px 2px 0 rgb(0 0 0 / 0.05);
  }

  .switch-thumb.checked {
    transform: translateX(0.875rem);
  }
</style>
