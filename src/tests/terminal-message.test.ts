import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/svelte';
import TerminalMessage from '../extension/sidepanel/components/TerminalMessage.svelte';

describe('TerminalMessage', () => {
  it('should render default messages in green', () => {
    const { container } = render(TerminalMessage, {
      props: { type: 'default', content: 'Test message' }
    });
    const message = container.querySelector('.terminal-message');
    expect(message?.classList.contains('text-term-green')).toBe(true);
    expect(message?.textContent).toBe('Test message');
  });

  it('should render warning messages in yellow', () => {
    const { container } = render(TerminalMessage, {
      props: { type: 'warning', content: 'Warning message' }
    });
    const message = container.querySelector('.terminal-message');
    expect(message?.classList.contains('text-term-yellow')).toBe(true);
  });

  it('should render error messages in red', () => {
    const { container } = render(TerminalMessage, {
      props: { type: 'error', content: 'Error message' }
    });
    const message = container.querySelector('.terminal-message');
    expect(message?.classList.contains('text-term-red')).toBe(true);
  });

  it('should render user input in bright green', () => {
    const { container } = render(TerminalMessage, {
      props: { type: 'input', content: 'User input' }
    });
    const message = container.querySelector('.terminal-message');
    expect(message?.classList.contains('text-term-bright-green')).toBe(true);
  });

  it('should render system messages in dim green', () => {
    const { container } = render(TerminalMessage, {
      props: { type: 'system', content: 'System message' }
    });
    const message = container.querySelector('.terminal-message');
    expect(message?.classList.contains('text-term-dim-green')).toBe(true);
  });

  it('should preserve whitespace and wrap words', () => {
    const { container } = render(TerminalMessage, {
      props: { type: 'default', content: 'Line 1\n  Line 2 with spaces' }
    });
    const message = container.querySelector('.terminal-message');
    expect(message?.classList.contains('whitespace-pre-wrap')).toBe(true);
    expect(message?.classList.contains('break-words')).toBe(true);
  });
});