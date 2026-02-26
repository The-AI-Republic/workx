<script lang="ts">
  /**
   * Portal Component
   *
   * Renders children at the document body level, escaping any parent stacking contexts.
   * This ensures fixed-position elements (modals, popups, tooltips) always appear above
   * all other content regardless of where they are declared in the component tree.
   *
   * Usage:
   *   <Portal show={isVisible}>
   *     <div class="my-modal">Modal content</div>
   *   </Portal>
   */
  import { onMount, onDestroy, tick } from 'svelte';

  export let show: boolean = false;

  let portalContainer: HTMLDivElement | null = null;
  let contentWrapper: HTMLDivElement;
  let isMounted = false;

  onMount(() => {
    // Create portal container at body level
    portalContainer = document.createElement('div');
    portalContainer.className = 'svelte-portal-root';
    portalContainer.style.cssText = 'position: absolute; top: 0; left: 0; pointer-events: none;';
    document.body.appendChild(portalContainer);
    isMounted = true;
  });

  onDestroy(() => {
    // Clean up portal container
    if (portalContainer?.parentNode) {
      portalContainer.parentNode.removeChild(portalContainer);
    }
  });

  // Move content to portal when show changes
  async function moveToPortal() {
    if (!isMounted || !portalContainer || !contentWrapper) return;

    await tick(); // Wait for Svelte to finish rendering

    if (show && contentWrapper.parentNode !== portalContainer) {
      portalContainer.appendChild(contentWrapper);
    }
  }

  $: if (show && isMounted) {
    moveToPortal();
  }
</script>

{#if show}
  <div
    bind:this={contentWrapper}
    class="portal-content pointer-events-auto"
  >
    <slot />
  </div>
{/if}
