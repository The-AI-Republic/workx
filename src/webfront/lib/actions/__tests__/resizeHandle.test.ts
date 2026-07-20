import { afterEach, describe, expect, it, vi } from 'vitest';
import { resizeHandle } from '../resizeHandle';

/**
 * jsdom has no PointerEvent constructor, so build a plain Event and graft on the
 * pointer fields the action reads (clientX / button / pointerId).
 */
function firePointer(
  node: HTMLElement,
  type: string,
  fields: { clientX?: number; button?: number; pointerId?: number } = {},
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(event, { clientX: 0, button: 0, pointerId: 1, ...fields });
  node.dispatchEvent(event);
  return event;
}

describe('resizeHandle action', () => {
  afterEach(() => {
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    document.body.innerHTML = '';
  });

  it('reports the horizontal offset from drag start via onMove', () => {
    const node = document.createElement('div');
    document.body.appendChild(node);
    const onStart = vi.fn();
    const onMove = vi.fn();
    const onEnd = vi.fn();

    const handle = resizeHandle(node, { onStart, onMove, onEnd });

    firePointer(node, 'pointerdown', { clientX: 100 });
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(node.classList.contains('is-dragging')).toBe(true);

    firePointer(node, 'pointermove', { clientX: 160 });
    firePointer(node, 'pointermove', { clientX: 80 });
    expect(onMove).toHaveBeenNthCalledWith(1, 60);
    expect(onMove).toHaveBeenNthCalledWith(2, -20);

    firePointer(node, 'pointerup', { clientX: 80 });
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(node.classList.contains('is-dragging')).toBe(false);

    handle?.destroy?.();
  });

  it('ignores non-primary buttons and moves before a drag starts', () => {
    const node = document.createElement('div');
    document.body.appendChild(node);
    const onStart = vi.fn();
    const onMove = vi.fn();

    const handle = resizeHandle(node, { onStart, onMove });

    firePointer(node, 'pointermove', { clientX: 50 });
    expect(onMove).not.toHaveBeenCalled();

    firePointer(node, 'pointerdown', { clientX: 0, button: 2 });
    expect(onStart).not.toHaveBeenCalled();

    handle?.destroy?.();
  });

  it('suppresses text selection during a drag and restores it after', () => {
    const node = document.createElement('div');
    document.body.appendChild(node);

    const handle = resizeHandle(node, {});

    firePointer(node, 'pointerdown', { clientX: 0 });
    expect(document.body.style.userSelect).toBe('none');
    expect(document.body.style.cursor).toBe('col-resize');

    firePointer(node, 'pointerup', { clientX: 0 });
    expect(document.body.style.userSelect).toBe('');
    expect(document.body.style.cursor).toBe('');

    handle?.destroy?.();
  });

  it('detaches listeners on destroy', () => {
    const node = document.createElement('div');
    document.body.appendChild(node);
    const onStart = vi.fn();

    const handle = resizeHandle(node, { onStart });
    handle?.destroy?.();

    firePointer(node, 'pointerdown', { clientX: 0 });
    expect(onStart).not.toHaveBeenCalled();
  });
});
