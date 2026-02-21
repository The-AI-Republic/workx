import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/svelte';
import TerminalContainer from '../extension/sidepanel/components/TerminalContainer.svelte';

describe('TerminalContainer', () => {
  it('should render with black background', () => {
    const { container } = render(TerminalContainer);
    const terminalDiv = container.querySelector('.terminal-container');
    expect(terminalDiv).toBeTruthy();
    expect(terminalDiv?.classList.contains('bg-term-bg')).toBe(true);
  });

  it('should apply monospace font', () => {
    const { container } = render(TerminalContainer);
    const terminalDiv = container.querySelector('.terminal-container');
    expect(terminalDiv?.classList.contains('font-terminal')).toBe(true);
  });

  it('should have proper padding', () => {
    const { container } = render(TerminalContainer);
    const terminalDiv = container.querySelector('.terminal-container');
    expect(terminalDiv?.classList.contains('p-4')).toBe(true);
  });

  it('should have minimum height of screen', () => {
    const { container } = render(TerminalContainer);
    const terminalDiv = container.querySelector('.terminal-container');
    expect(terminalDiv?.classList.contains('min-h-screen')).toBe(true);
  });

  it('should have overflow auto for scrolling', () => {
    const { container } = render(TerminalContainer);
    const terminalDiv = container.querySelector('.terminal-container');
    expect(terminalDiv?.classList.contains('overflow-auto')).toBe(true);
  });
});