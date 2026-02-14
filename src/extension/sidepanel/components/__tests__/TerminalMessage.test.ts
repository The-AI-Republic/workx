import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/svelte';
import TerminalMessage from '@/sidepanel/components/TerminalMessage.svelte';

describe('TerminalMessage - Color Mapping', () => {
  it('should render input type with text-term-blue class', () => {
    const { container } = render(TerminalMessage, {
      props: {
        type: 'input',
        content: 'test user message',
      },
    });

    const messageElement = container.querySelector('.terminal-message');
    expect(messageElement).toBeTruthy();
    expect(messageElement?.className).toContain('text-term-blue');
  });

  it('should render default type with text-term-green class', () => {
    const { container } = render(TerminalMessage, {
      props: {
        type: 'default',
        content: 'default message',
      },
    });

    const messageElement = container.querySelector('.terminal-message');
    expect(messageElement).toBeTruthy();
    expect(messageElement?.className).toContain('text-term-green');
  });

  it('should preserve existing color mappings for other types', () => {
    const testCases: Array<{ type: 'warning' | 'error' | 'system', expectedClass: string }> = [
      { type: 'warning', expectedClass: 'text-term-yellow' },
      { type: 'error', expectedClass: 'text-term-red' },
      { type: 'system', expectedClass: 'text-term-dim-green' },
    ];

    testCases.forEach(({ type, expectedClass }) => {
      const { container } = render(TerminalMessage, {
        props: {
          type,
          content: `${type} message`,
        },
      });

      const messageElement = container.querySelector('.terminal-message');
      expect(messageElement?.className).toContain(expectedClass);
    });
  });

  it('should display content correctly', () => {
    const testContent = 'Hello World';
    const { container } = render(TerminalMessage, {
      props: {
        type: 'input',
        content: testContent,
      },
    });

    const messageElement = container.querySelector('.terminal-message');
    expect(messageElement?.textContent?.trim()).toBe(testContent);
  });

  it('should verify TerminalMessage.svelte maps input to blue (not bright green)', () => {
    const fs = require('fs');
    const path = require('path');
    const componentPath = path.join(__dirname, '../../src/sidepanel/components/TerminalMessage.svelte');
    const componentContent = fs.readFileSync(componentPath, 'utf-8');

    // Check that input maps to text-term-blue
    expect(componentContent).toMatch(/input:\s*['"]text-term-blue['"]/);
  });
});
