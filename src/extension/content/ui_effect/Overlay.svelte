<script lang="ts">
  /**
   * Overlay Component
   *
   * Dotted pattern overlay that provides visual feedback during agent operations.
   * Independent from ripple effects - visibility controlled separately.
   *
   * Features:
   * - Full viewport coverage WITHOUT blocking interactions (pointer-events: none)
   * - Evenly distributed gray dots (half white half black) pattern
   * - Removed when user takes over control
   *
   * @component
   */

  import { overlayState } from './stores';

  // Subscribe to overlay state
  let visible = false;
  let takeoverActive = false;

  overlayState.subscribe(state => {
    visible = state.visible;
    takeoverActive = state.takeoverActive;
  });
</script>

{#if visible && !takeoverActive}
  <div class="overlay" data-testid="visual-effect-overlay"></div>
{/if}

<style>
  .overlay {
    /* Position and size */
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    z-index: 2147483645; /* Below ripple (2147483646) and cursor/buttons (2147483647) */

    /* Visual appearance - dotted pattern with gray dots (half white half black) */
    /* Using radial gradient to create evenly distributed dots */
    background-image:
      radial-gradient(circle, rgba(128, 128, 128, 0.5) 1px, transparent 1px);
    background-size: 16px 16px;
    background-position: 0 0, 8px 8px;
    background-color: transparent;

    /* Visual only - no input blocking */
    pointer-events: none;

    /* Performance */
    will-change: opacity;
    transition: opacity 200ms ease-out;

    /* Animation */
    animation: fadeIn 200ms ease-out;
  }

  /* Fade in animation */
  @keyframes fadeIn {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }
</style>
