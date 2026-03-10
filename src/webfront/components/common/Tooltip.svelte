<script lang="ts">
  /**
   * Tooltip component using Tippy.js
   * Usage: <Tooltip content="Tooltip text"><button>Hover me</button></Tooltip>
   */
  import { onMount, onDestroy } from 'svelte';
  import type { Snippet } from 'svelte';
  import tippy, { type Instance, type Placement } from 'tippy.js';
  import 'tippy.js/dist/tippy.css';
  import { uiTheme } from '../../stores/themeStore';

  // Props
  let {
    className = '',
    style = '',
    fill = false,
    zIndex = 9999,
    content = '',
    placement = 'top' as Placement,
    delay = [200, 0] as number | [number, number],
    duration = [200, 150] as number | [number, number],
    arrow = true,
    interactive = false,
    disabled = false,
    maxWidth = 300 as number | string,
    offset = [0, 8] as [number, number],
    trigger = 'mouseenter focus',
    hideOnClick = true as boolean | 'toggle',
    fixedPosition = false,
    children,
  }: {
    className?: string;
    style?: string;
    fill?: boolean;
    zIndex?: number;
    content?: string;
    placement?: Placement;
    delay?: number | [number, number];
    duration?: number | [number, number];
    arrow?: boolean;
    interactive?: boolean;
    disabled?: boolean;
    maxWidth?: number | string;
    offset?: [number, number];
    trigger?: string;
    hideOnClick?: boolean | 'toggle';
    fixedPosition?: boolean;
    children?: Snippet;
  } = $props();

  let containerRef: HTMLSpanElement;
  let tippyInstance: Instance | null = null;

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
        theme: $uiTheme === 'modern' ? 'modern' : 'terminal',
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

  // Reactive updates - update theme when store changes
  $effect(() => {
    if (tippyInstance) {
      tippyInstance.setProps({
        theme: $uiTheme === 'modern' ? 'modern' : 'terminal',
      });
    }
  });

  // Update content reactively
  $effect(() => {
    if (tippyInstance) {
      tippyInstance.setContent(content);
    }
  });

  // Update disabled state reactively
  $effect(() => {
    if (tippyInstance) {
      if (disabled) {
        tippyInstance.disable();
      } else {
        tippyInstance.enable();
      }
    }
  });

  // Update other props reactively
  $effect(() => {
    if (tippyInstance) {
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
  });
</script>

<span
  class="inline-flex {className}"
  style="{fill ? 'width: 100%; height: 100%; ' : ''}{style}"
  bind:this={containerRef}
>
  {@render children?.()}
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
