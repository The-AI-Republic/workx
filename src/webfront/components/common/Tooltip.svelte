<script lang="ts">
  /**
   * Tooltip component using Tippy.js
   * Usage: <Tooltip content="Tooltip text"><button>Hover me</button></Tooltip>
   */
  import { onMount, onDestroy } from 'svelte';
  import tippy, { type Instance, type Placement } from 'tippy.js';
  import 'tippy.js/dist/tippy.css';
  import { uiTheme, type UITheme } from '../../stores/themeStore';

  // Props
  export let className: string = '';
  export let style: string = '';
  export let fill: boolean = false;
  export let zIndex: number = 9999;
  export let content: string = '';
  export let placement: Placement = 'top';
  export let delay: number | [number, number] = [200, 0];
  export let duration: number | [number, number] = [200, 150];
  export let arrow: boolean = true;
  export let interactive: boolean = false;
  export let disabled: boolean = false;
  export let maxWidth: number | string = 300;
  export let offset: [number, number] = [0, 8];
  export let trigger: string = 'mouseenter focus'; // 'mouseenter', 'focus', 'click', or combinations
  export let hideOnClick: boolean | 'toggle' = true;
  export let fixedPosition: boolean = false; // When true, tooltip stays at initial position on scroll

  let containerRef: HTMLSpanElement;
  let tippyInstance: Instance | null = null;
  let currentTheme: UITheme = 'terminal';

  // Subscribe to theme store
  uiTheme.subscribe((theme) => {
    currentTheme = theme;
    if (tippyInstance) {
      tippyInstance.setProps({
        theme: theme === 'modern' ? 'modern' : 'terminal',
      });
    }
  });

  onMount(() => {
    if (containerRef) {
      tippyInstance = tippy(containerRef, {
        content,
        placement,
        delay,
        duration,
        arrow,
        interactive,
        maxWidth,
        offset,
        trigger,
        hideOnClick,
        zIndex,
        theme: currentTheme === 'modern' ? 'modern' : 'terminal',
        // Append to body to escape overflow constraints
        appendTo: () => document.body,
        ...(fixedPosition ? {
          popperOptions: {
            modifiers: [
              {
                name: 'eventListeners',
                options: { scroll: false, resize: true },
              },
            ],
          },
        } : {}),
      });

      // Handle disabled state
      if (disabled) {
        tippyInstance.disable();
      }
    }
  });

  onDestroy(() => {
    if (tippyInstance) {
      tippyInstance.destroy();
      tippyInstance = null;
    }
  });

  // Reactive updates
  $: if (tippyInstance) {
    tippyInstance.setContent(content);
  }

  $: if (tippyInstance) {
    if (disabled) {
      tippyInstance.disable();
    } else {
      tippyInstance.enable();
    }
  }

  $: if (tippyInstance) {
    tippyInstance.setProps({
      placement,
      delay,
      duration,
      arrow,
      interactive,
      maxWidth,
      offset,
      trigger,
      hideOnClick,
      zIndex,
    });
  }
</script>

<span
  class="inline-flex {className}"
  style="{fill ? 'width: 100%; height: 100%; ' : ''}{style}"
  bind:this={containerRef}
>
  <slot />
</span>

<style>
  /* Terminal theme for Tippy */
  :global(.tippy-box[data-theme~='terminal']) {
    background-color: #000000;
    border: 1px solid #00cc00;
    border-radius: 4px;
    color: #00ff00;
    font-family: 'Monaco', 'Courier New', monospace;
    font-size: 14px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
  }

  :global(.tippy-box[data-theme~='terminal'] > .tippy-content) {
    padding: 4px 8px;
  }

  :global(.tippy-box[data-theme~='terminal'] > .tippy-arrow::before) {
    color: #00cc00;
  }

  :global(.tippy-box[data-theme~='terminal'][data-placement^='top'] > .tippy-arrow::before) {
    border-top-color: #00cc00;
  }

  :global(.tippy-box[data-theme~='terminal'][data-placement^='bottom'] > .tippy-arrow::before) {
    border-bottom-color: #00cc00;
  }

  :global(.tippy-box[data-theme~='terminal'][data-placement^='left'] > .tippy-arrow::before) {
    border-left-color: #00cc00;
  }

  :global(.tippy-box[data-theme~='terminal'][data-placement^='right'] > .tippy-arrow::before) {
    border-right-color: #00cc00;
  }

  /* Modern Chat theme for Tippy */
  :global(.tippy-box[data-theme~='modern']) {
    background-color: #0d0d0d;
    border: none;
    border-radius: 0.375rem;
    color: #ffffff;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 14px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
  }

  :global(.tippy-box[data-theme~='modern'] > .tippy-content) {
    padding: 6px 10px;
  }

  :global(.tippy-box[data-theme~='modern'] > .tippy-arrow::before) {
    color: #0d0d0d;
  }

  :global(.tippy-box[data-theme~='modern'][data-placement^='top'] > .tippy-arrow::before) {
    border-top-color: #0d0d0d;
  }

  :global(.tippy-box[data-theme~='modern'][data-placement^='bottom'] > .tippy-arrow::before) {
    border-bottom-color: #0d0d0d;
  }

  :global(.tippy-box[data-theme~='modern'][data-placement^='left'] > .tippy-arrow::before) {
    border-left-color: #0d0d0d;
  }

  :global(.tippy-box[data-theme~='modern'][data-placement^='right'] > .tippy-arrow::before) {
    border-right-color: #0d0d0d;
  }
</style>
