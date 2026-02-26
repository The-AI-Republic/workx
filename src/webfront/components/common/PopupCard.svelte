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

<div class="popup-card-container relative" bind:this={containerElement}>
  <!-- Trigger slot -->
  <slot name="trigger" />
</div>

<!-- Popup rendered with fixed positioning -->
{#if show && isPositioned}
  <div
    class="popup-card-fixed fixed min-w-[260px] max-w-[calc(100vw-20px)] z-[9999] animate-fadeIn
      {currentTheme === 'chatgpt'
        ? 'bg-chat-tooltip dark:bg-chat-tooltip-dark border-none rounded-xl shadow-[0_4px_16px_rgba(0,0,0,0.25)]'
        : 'bg-term-bg border border-term-dim-green rounded'}"
    style="left: {fixedLeft}px; bottom: {fixedBottom}px;"
    role="dialog"
    aria-label={title}
  >
    {#if title}
      <!-- Card Header -->
      <div class="flex justify-between items-center px-3 py-2.5
        {currentTheme === 'chatgpt'
          ? 'border-b border-white/10'
          : 'border-b border-term-dim-green'}">
        <h3 class="m-0 text-sm font-semibold
          {currentTheme === 'chatgpt'
            ? 'text-chat-tooltip-text dark:text-chat-tooltip-text-dark font-chat'
            : 'text-term-bright-green font-terminal'}">
          {title}
        </h3>
        <button
          class="bg-transparent border-none cursor-pointer p-0.5 flex items-center justify-center rounded transition-all duration-200
            {currentTheme === 'chatgpt'
              ? 'text-white/60 hover:text-chat-tooltip-text hover:bg-white/10 dark:hover:text-chat-tooltip-text-dark'
              : 'text-term-dim-green hover:text-term-bright-green hover:bg-term-green/10'}"
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
    <div class="p-3">
      <slot name="content" />
    </div>
  </div>
{/if}

<style>
  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(4px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .animate-fadeIn {
    animation: fadeIn 0.15s ease-out;
  }
</style>
