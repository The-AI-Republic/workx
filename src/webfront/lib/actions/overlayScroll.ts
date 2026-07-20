import type { Action } from 'svelte/action';

/**
 * Floating, auto-hiding scrollbar for a scroll container.
 *
 * The native scrollbar reserves gutter width and (cross-platform) either shows
 * permanently or hides on OS-controlled timing. This action instead hides the
 * native bar (`.no-native-scrollbar`) and draws a custom thumb that floats over
 * the content: hidden at rest, revealed while the user scrolls, and auto-hidden
 * a fixed delay after scrolling stops. The thumb is draggable.
 *
 * The thumb is appended to the node's parent (not the node itself) so it does
 * not scroll away with the content — the parent must be positioned
 * (`position: relative`).
 */
export interface OverlayScrollOptions {
  /** Milliseconds to keep the thumb visible after the last scroll. */
  hideDelayMs?: number;
}

const DEFAULT_HIDE_DELAY_MS = 3000;
const MIN_THUMB_HEIGHT = 24;

export const overlayScroll: Action<HTMLElement, OverlayScrollOptions | undefined> = (
  node,
  options,
) => {
  const parent = node.parentElement;
  // No positioned host to anchor the thumb, or a non-DOM environment (SSR):
  // degrade gracefully to the native scrollbar.
  if (!parent || typeof document === 'undefined') return {};

  node.classList.add('no-native-scrollbar');

  const thumb = document.createElement('div');
  thumb.className = 'overlay-scroll-thumb';
  thumb.setAttribute('aria-hidden', 'true');
  parent.appendChild(thumb);

  let hideDelay = options?.hideDelayMs ?? DEFAULT_HIDE_DELAY_MS;
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  let dragging = false;
  let dragStartY = 0;
  let dragStartScrollTop = 0;

  function scrollable(): boolean {
    return node.scrollHeight - node.clientHeight > 1;
  }

  function layout(): void {
    const { scrollHeight, clientHeight, scrollTop } = node;
    if (!scrollable()) {
      thumb.style.height = '0px';
      thumb.classList.remove('is-visible');
      return;
    }
    const track = clientHeight;
    const thumbHeight = Math.max((clientHeight / scrollHeight) * track, MIN_THUMB_HEIGHT);
    const maxScroll = scrollHeight - clientHeight;
    const maxThumbTop = track - thumbHeight;
    const thumbTop = maxScroll > 0 ? (scrollTop / maxScroll) * maxThumbTop : 0;
    thumb.style.height = `${thumbHeight}px`;
    thumb.style.transform = `translateY(${thumbTop}px)`;
  }

  function reveal(): void {
    layout();
    if (!scrollable()) return;
    thumb.classList.add('is-visible');
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (!dragging) thumb.classList.remove('is-visible');
    }, hideDelay);
  }

  function onScroll(): void {
    reveal();
  }

  function onThumbPointerDown(event: PointerEvent): void {
    if (!scrollable()) return;
    event.preventDefault();
    dragging = true;
    dragStartY = event.clientY;
    dragStartScrollTop = node.scrollTop;
    thumb.classList.add('is-visible');
    thumb.setPointerCapture(event.pointerId);
    if (hideTimer) clearTimeout(hideTimer);
  }

  function onThumbPointerMove(event: PointerEvent): void {
    if (!dragging) return;
    const track = node.clientHeight;
    const thumbHeight = thumb.offsetHeight;
    const maxThumbTop = track - thumbHeight;
    const maxScroll = node.scrollHeight - node.clientHeight;
    if (maxThumbTop <= 0) return;
    const deltaY = event.clientY - dragStartY;
    node.scrollTop = dragStartScrollTop + (deltaY / maxThumbTop) * maxScroll;
  }

  function endDrag(event: PointerEvent): void {
    if (!dragging) return;
    dragging = false;
    if (thumb.hasPointerCapture(event.pointerId)) thumb.releasePointerCapture(event.pointerId);
    reveal();
  }

  node.addEventListener('scroll', onScroll, { passive: true });
  thumb.addEventListener('pointerdown', onThumbPointerDown);
  thumb.addEventListener('pointermove', onThumbPointerMove);
  thumb.addEventListener('pointerup', endDrag);
  thumb.addEventListener('pointercancel', endDrag);

  // Keep the thumb sized correctly as the viewport or content (Load More) grows,
  // without revealing it — layout() only repositions, reveal() shows.
  const resizeObserver =
    typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => layout()) : null;
  resizeObserver?.observe(node);
  const mutationObserver =
    typeof MutationObserver !== 'undefined' ? new MutationObserver(() => layout()) : null;
  mutationObserver?.observe(node, { childList: true, subtree: true });

  layout();

  return {
    update(next) {
      hideDelay = next?.hideDelayMs ?? DEFAULT_HIDE_DELAY_MS;
    },
    destroy() {
      node.removeEventListener('scroll', onScroll);
      thumb.removeEventListener('pointerdown', onThumbPointerDown);
      thumb.removeEventListener('pointermove', onThumbPointerMove);
      thumb.removeEventListener('pointerup', endDrag);
      thumb.removeEventListener('pointercancel', endDrag);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      if (hideTimer) clearTimeout(hideTimer);
      node.classList.remove('no-native-scrollbar');
      thumb.remove();
    },
  };
};
