import type { Action } from 'svelte/action';

/**
 * Horizontal drag-to-resize handle.
 *
 * Attach to a thin "splitter" element sitting on the boundary between two
 * regions (e.g. the docked left panel and the main content). On pointer drag it
 * reports the horizontal offset from where the drag started via `onMove`, so the
 * host can translate that delta into a new width and clamp it however it likes —
 * the action itself is layout-agnostic and owns no size state.
 *
 * During a drag the document's text selection and cursor are suppressed so the
 * pointer reads as a resize everywhere, not just over the handle. Pointer
 * capture keeps events flowing to the handle even when the cursor outruns it.
 */
export interface ResizeHandleOptions {
  /** Called when a drag begins (pointer down on the handle). */
  onStart?: () => void;
  /** Called on every move with the signed horizontal offset (px) from drag start. */
  onMove?: (deltaX: number) => void;
  /** Called when the drag ends (pointer up / cancel). */
  onEnd?: () => void;
}

export const resizeHandle: Action<HTMLElement, ResizeHandleOptions | undefined> = (
  node,
  options,
) => {
  // Non-DOM environment (SSR): nothing to wire up.
  if (typeof document === 'undefined') return {};

  let opts = options;
  let dragging = false;
  let startX = 0;

  function setDragCursor(on: boolean): void {
    document.body.style.userSelect = on ? 'none' : '';
    document.body.style.cursor = on ? 'col-resize' : '';
  }

  function onPointerDown(event: PointerEvent): void {
    // Primary button only; ignore right/middle clicks.
    if (event.button !== 0) return;
    event.preventDefault();
    dragging = true;
    startX = event.clientX;
    // setPointerCapture is absent under jsdom — guard so tests don't throw.
    if (typeof node.setPointerCapture === 'function') node.setPointerCapture(event.pointerId);
    node.classList.add('is-dragging');
    setDragCursor(true);
    opts?.onStart?.();
  }

  function onPointerMove(event: PointerEvent): void {
    if (!dragging) return;
    opts?.onMove?.(event.clientX - startX);
  }

  function endDrag(event: PointerEvent): void {
    if (!dragging) return;
    dragging = false;
    if (
      typeof node.hasPointerCapture === 'function' &&
      node.hasPointerCapture(event.pointerId) &&
      typeof node.releasePointerCapture === 'function'
    ) {
      node.releasePointerCapture(event.pointerId);
    }
    node.classList.remove('is-dragging');
    setDragCursor(false);
    opts?.onEnd?.();
  }

  node.addEventListener('pointerdown', onPointerDown);
  node.addEventListener('pointermove', onPointerMove);
  node.addEventListener('pointerup', endDrag);
  node.addEventListener('pointercancel', endDrag);

  return {
    update(next) {
      opts = next;
    },
    destroy() {
      node.removeEventListener('pointerdown', onPointerDown);
      node.removeEventListener('pointermove', onPointerMove);
      node.removeEventListener('pointerup', endDrag);
      node.removeEventListener('pointercancel', endDrag);
      // Restore document styling if we're torn down mid-drag.
      if (dragging) setDragCursor(false);
    },
  };
};
