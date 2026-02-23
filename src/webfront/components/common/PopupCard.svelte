<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { uiTheme, type UITheme } from '../../stores/themeStore';
  import { t } from '../../lib/i18n';

  export let title: string = '';
  export let show: boolean = false;
  export let onClose: () => void = () => {};

  let containerElement: HTMLElement;
  let isPositioned: boolean = false;
  let currentTheme: UITheme = 'terminal';

  // Fixed positioning values
  let fixedLeft: number = 0;
  let fixedBottom: number = 0;

  // Subscribe to theme store
  uiTheme.subscribe((theme) => {
    currentTheme = theme;
  });

  function calculateCardPosition() {
    if (!containerElement) return;

    const containerRect = containerElement.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const margin = 10; // Minimum margin from viewport edges
    const cardWidth = 280; // Approximate card width

    // Calculate fixed position based on trigger element
    let leftPos = containerRect.left;

    // Check if card would overflow right edge
    if (leftPos + cardWidth > viewportWidth - margin) {
      leftPos = viewportWidth - cardWidth - margin;
    }

    // Ensure card doesn't overflow left edge
    if (leftPos < margin) {
      leftPos = margin;
    }

    fixedLeft = leftPos;
    // Position above the trigger element
    fixedBottom = viewportHeight - containerRect.top + 8;

    isPositioned = true;
  }

  function handleClickOutside(event: MouseEvent) {
    // Only process if popup is showing
    if (!show) return;

    const target = event.target as HTMLElement;

    // Check if click is inside popup container or popup content
    if (!target.closest('.popup-card-container') && !target.closest('.popup-card-fixed')) {
      onClose();
    }
  }

  // Pre-calculate position before showing
  $: if (show && containerElement) {
    calculateCardPosition();
  } else if (!show) {
    isPositioned = false;
  }

  // Handle window resize
  function handleResize() {
    if (show && containerElement) {
      calculateCardPosition();
    }
  }

  // Handle scroll events to reposition
  function handleScroll() {
    if (show && containerElement) {
      calculateCardPosition();
    }
  }

  onMount(() => {
    window.addEventListener('resize', handleResize);
    window.addEventListener('scroll', handleScroll, true);
  });

  onDestroy(() => {
    window.removeEventListener('resize', handleResize);
    window.removeEventListener('scroll', handleScroll, true);
  });
</script>

<svelte:window on:click={handleClickOutside} />

<div class="popup-card-container {currentTheme}" bind:this={containerElement}>
  <!-- Trigger slot -->
  <slot name="trigger" />
</div>

<!-- Popup rendered with fixed positioning -->
{#if show && isPositioned}
  <div
    class="popup-card-fixed {currentTheme}"
    style="left: {fixedLeft}px; bottom: {fixedBottom}px;"
    role="dialog"
    aria-label={title}
  >
    {#if title}
      <!-- Card Header -->
      <div class="popup-header">
        <h3 class="popup-title">{title}</h3>
        <button
          class="popup-close"
          on:click|stopPropagation={onClose}
          aria-label={t("Close")}
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
        </button>
      </div>
    {/if}

    <!-- Content slot -->
    <div class="popup-content">
      <slot name="content" />
    </div>
  </div>
{/if}

<style>
  .popup-card-container {
    position: relative;
  }

  .popup-card-fixed {
    position: fixed;
    min-width: 260px;
    max-width: calc(100vw - 20px);
    z-index: 9999;
    animation: fadeIn 0.15s ease-out;
  }

  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(4px); }
    to { opacity: 1; transform: translateY(0); }
  }

  /* Terminal Theme (default) */
  .popup-card-fixed {
    background: #000000;
    border: 1px solid var(--color-term-dim-green, #00cc00);
    border-radius: 4px;
  }

  .popup-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px 12px;
    border-bottom: 1px solid var(--color-term-dim-green, #00cc00);
  }

  .popup-title {
    margin: 0;
    font-size: 13px;
    font-weight: 600;
    color: var(--color-term-bright-green, #00ff00);
    font-family: 'Monaco', 'Courier New', monospace;
  }

  .popup-close {
    background: transparent;
    border: none;
    color: var(--color-term-dim-green, #00cc00);
    cursor: pointer;
    padding: 2px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 4px;
    transition: all 0.2s ease;
  }

  .popup-close:hover {
    color: var(--color-term-bright-green, #00ff00);
    background: rgba(0, 255, 0, 0.1);
  }

  .popup-content {
    padding: 12px;
  }

  /* ============================================
     ChatGPT Theme Overrides
     ============================================ */

  .popup-card-fixed.chatgpt {
    background: var(--chat-tooltip-bg, #0d0d0d);
    border: none;
    border-radius: 0.75rem;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
  }

  .popup-card-fixed.chatgpt .popup-header {
    border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  }

  .popup-card-fixed.chatgpt .popup-title {
    color: var(--chat-tooltip-text, #ffffff);
    font-family: var(--font-chat, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);
  }

  .popup-card-fixed.chatgpt .popup-close {
    color: rgba(255, 255, 255, 0.6);
  }

  .popup-card-fixed.chatgpt .popup-close:hover {
    color: var(--chat-tooltip-text, #ffffff);
    background: rgba(255, 255, 255, 0.1);
  }

  /* Ensure card content is responsive */
  @media (max-width: 380px) {
    .popup-card-fixed {
      font-size: 0.875rem;
    }
  }
</style>
