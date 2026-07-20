import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import PreviewResizeHandle from '../PreviewResizeHandle.svelte';

describe('PreviewResizeHandle', () => {
  it('exposes the split range and supports keyboard adjustment', async () => {
    const onChange = vi.fn();
    render(PreviewResizeHandle, { props: { value: 60, onChange } });

    const separator = screen.getByRole('separator', {
      name: 'Resize chat and preview panels',
    });
    expect(separator.getAttribute('aria-valuemin')).toBe('40');
    expect(separator.getAttribute('aria-valuemax')).toBe('80');
    expect(separator.getAttribute('aria-valuenow')).toBe('60');
    expect(separator.getAttribute('aria-valuetext')).toBe('60% chat, 40% preview');

    await fireEvent.keyDown(separator, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith(62);
    await fireEvent.keyDown(separator, { key: 'Home' });
    expect(onChange).toHaveBeenLastCalledWith(40);
    await fireEvent.keyDown(separator, { key: 'End' });
    expect(onChange).toHaveBeenLastCalledWith(80);
  });

  it('resets to 60/40 on double click and uses terminal styling', async () => {
    const onChange = vi.fn();
    render(PreviewResizeHandle, { props: { value: 72, theme: 'terminal', onChange } });
    const separator = screen.getByRole('separator', {
      name: 'Resize chat and preview panels',
    });

    expect(separator.className).toContain('text-term-dim-green');
    await fireEvent.dblClick(separator);
    expect(onChange).toHaveBeenCalledWith(60);
  });

  it('tracks pointer movement against the chat-and-preview container', async () => {
    const onChange = vi.fn();
    render(PreviewResizeHandle, { props: { value: 60, onChange } });
    const separator = screen.getByRole('separator', {
      name: 'Resize chat and preview panels',
    });
    vi.spyOn(separator.parentElement!, 'getBoundingClientRect').mockReturnValue({
      left: 100,
      width: 1000,
      right: 1100,
      top: 0,
      bottom: 700,
      height: 700,
      x: 100,
      y: 0,
      toJSON: () => ({}),
    });

    await fireEvent.pointerDown(separator, { button: 0, pointerId: 7, clientX: 700 });
    expect(onChange).toHaveBeenLastCalledWith(60);
    expect(document.body.style.cursor).toBe('col-resize');

    await fireEvent.pointerMove(window, { pointerId: 7, clientX: 950 });
    expect(onChange).toHaveBeenLastCalledWith(80);
    await fireEvent.pointerMove(window, { pointerId: 7, clientX: 300 });
    expect(onChange).toHaveBeenLastCalledWith(40);

    await fireEvent.pointerUp(window, { pointerId: 7 });
    expect(document.body.style.cursor).toBe('');
  });
});
