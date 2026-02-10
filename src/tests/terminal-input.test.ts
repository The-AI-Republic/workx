import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import TerminalInput from '../extension/sidepanel/components/TerminalInput.svelte';

describe('TerminalInput', () => {
  it('should render with transparent background', () => {
    const { container } = render(TerminalInput);
    const input = container.querySelector('input');
    expect(input?.classList.contains('bg-transparent')).toBe(true);
  });

  it('should render text in bright green', () => {
    const { container } = render(TerminalInput);
    const input = container.querySelector('input');
    expect(input?.classList.contains('text-term-bright-green')).toBe(true);
  });

  it('should have no border or outline', () => {
    const { container } = render(TerminalInput);
    const input = container.querySelector('input');
    expect(input?.classList.contains('outline-none')).toBe(true);
    expect(input?.classList.contains('border-none')).toBe(true);
  });

  it('should occupy full width', () => {
    const { container } = render(TerminalInput);
    const input = container.querySelector('input');
    expect(input?.classList.contains('w-full')).toBe(true);
  });

  it('should handle value binding', async () => {
    const { container, component } = render(TerminalInput, {
      props: { value: 'initial value' }
    });
    const input = container.querySelector('input') as HTMLInputElement;
    expect(input.value).toBe('initial value');

    await fireEvent.input(input, { target: { value: 'new value' } });
    expect(input.value).toBe('new value');
  });

  it('should trigger onSubmit when Enter is pressed', async () => {
    const handleSubmit = vi.fn();
    const { container } = render(TerminalInput, {
      props: { onSubmit: handleSubmit, value: 'test command' }
    });
    const input = container.querySelector('input') as HTMLInputElement;

    await fireEvent.keyPress(input, { key: 'Enter', code: 'Enter' });
    expect(handleSubmit).toHaveBeenCalledWith('test command');
  });

  it('should show placeholder text in dim green', () => {
    const { container } = render(TerminalInput, {
      props: { placeholder: 'Enter command...' }
    });
    const input = container.querySelector('input');
    expect(input?.classList.contains('placeholder:text-term-dim-green')).toBe(true);
    expect(input?.getAttribute('placeholder')).toBe('Enter command...');
  });
});