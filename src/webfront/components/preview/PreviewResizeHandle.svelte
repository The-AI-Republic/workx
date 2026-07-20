<script lang="ts">
  import { onDestroy } from 'svelte';
  import {
    DEFAULT_CHAT_SPLIT_PERCENT,
    MAX_CHAT_SPLIT_PERCENT,
    MIN_CHAT_SPLIT_PERCENT,
    chatSplitPercentFromClientX,
    chatSplitPercentFromKey,
  } from './splitModel';

  let {
    value = DEFAULT_CHAT_SPLIT_PERCENT,
    theme = 'modern',
    onChange,
  }: {
    value?: number;
    theme?: 'modern' | 'terminal';
    onChange: (value: number) => void;
  } = $props();

  let handle: HTMLDivElement | null = $state(null);
  let dragging = $state(false);
  let activePointerId: number | null = null;
  let previousBodyCursor = '';
  let previousBodyUserSelect = '';

  function updateFromClientX(clientX: number): void {
    const container = handle?.parentElement;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    onChange(chatSplitPercentFromClientX(clientX, rect.left, rect.width));
  }

  function startResize(event: PointerEvent): void {
    if (event.button !== 0) return;
    event.preventDefault();
    dragging = true;
    activePointerId = event.pointerId;
    previousBodyCursor = document.body.style.cursor;
    previousBodyUserSelect = document.body.style.userSelect;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    handle?.setPointerCapture?.(event.pointerId);
    updateFromClientX(event.clientX);
  }

  function moveResize(event: PointerEvent): void {
    if (!dragging || event.pointerId !== activePointerId) return;
    updateFromClientX(event.clientX);
  }

  function stopResize(event?: PointerEvent): void {
    if (!dragging) return;
    if (event && activePointerId !== null && event.pointerId !== activePointerId) return;
    if (activePointerId !== null && handle?.hasPointerCapture?.(activePointerId)) {
      handle.releasePointerCapture(activePointerId);
    }
    dragging = false;
    activePointerId = null;
    document.body.style.cursor = previousBodyCursor;
    document.body.style.userSelect = previousBodyUserSelect;
  }

  function handleKeydown(event: KeyboardEvent): void {
    const next = chatSplitPercentFromKey(value, event.key);
    if (next === null) return;
    event.preventDefault();
    onChange(next);
  }

  function resizeInteraction(node: HTMLDivElement): { destroy: () => void } {
    handle = node;
    const resetSplit = () => onChange(DEFAULT_CHAT_SPLIT_PERCENT);
    node.addEventListener('pointerdown', startResize);
    node.addEventListener('keydown', handleKeydown);
    node.addEventListener('dblclick', resetSplit);
    return {
      destroy: () => {
        node.removeEventListener('pointerdown', startResize);
        node.removeEventListener('keydown', handleKeydown);
        node.removeEventListener('dblclick', resetSplit);
        if (handle === node) handle = null;
      },
    };
  }

  onDestroy(() => stopResize());
</script>

<svelte:window
  onpointermove={moveResize}
  onpointerup={stopResize}
  onpointercancel={stopResize}
  onblur={() => stopResize()}
/>

<!-- A focusable ARIA separator is the prescribed pattern for an adjustable split pane. -->
<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
  use:resizeInteraction
  class="group relative w-2 shrink-0 touch-none cursor-col-resize border-0 p-0 outline-none
    {theme === 'terminal'
      ? 'text-term-dim-green focus-visible:bg-term-green/10'
      : 'text-chat-border dark:text-chat-border-dark focus-visible:bg-chat-primary/10 dark:focus-visible:bg-chat-primary-dark/10'}
    {dragging
      ? (theme === 'terminal' ? 'bg-term-green/20' : 'bg-chat-primary/10 dark:bg-chat-primary-dark/10')
      : ''}"
  role="separator"
  aria-label="Resize chat and preview panels"
  aria-orientation="vertical"
  aria-valuemin={MIN_CHAT_SPLIT_PERCENT}
  aria-valuemax={MAX_CHAT_SPLIT_PERCENT}
  aria-valuenow={value}
  aria-valuetext={`${value}% chat, ${100 - value}% preview`}
  tabindex="0"
  title={`${value}% chat / ${100 - value}% preview`}
>
  <span
    class="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-current opacity-70
      transition-[width,opacity] group-hover:w-0.5 group-hover:opacity-100"
  ></span>
</div>
