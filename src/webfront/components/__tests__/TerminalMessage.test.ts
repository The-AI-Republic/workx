import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/svelte';
import TerminalMessage from '@/webfront/components/TerminalMessage.svelte';

describe('TerminalMessage - Color Mapping', () => {
  it('should render input type with input class', () => {
    const { container } = render(TerminalMessage, {
      props: {
        type: 'input',
        content: 'test user message',
      },
    });

    const messageElement = container.querySelector('.terminal-message');
    expect(messageElement).toBeTruthy();
    // The component applies the type directly as a CSS class
    expect(messageElement?.className).toContain('input');
  });

  it('should render default type with default class', () => {
    const { container } = render(TerminalMessage, {
      props: {
        type: 'default',
        content: 'default message',
      },
    });

    const messageElement = container.querySelector('.terminal-message');
    expect(messageElement).toBeTruthy();
    expect(messageElement?.className).toContain('default');
  });

  it('should preserve existing color mappings for other types', () => {
    const testCases: Array<{ type: 'warning' | 'error' | 'system', expectedClass: string }> = [
      { type: 'warning', expectedClass: 'warning' },
      { type: 'error', expectedClass: 'error' },
      { type: 'system', expectedClass: 'system' },
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

  it('should verify TerminalMessage.svelte maps input to blue color', () => {
    const fs = require('fs');
    const path = require('path');
    // Resolve path relative to this test file's actual location
    const componentPath = path.resolve(__dirname, '..', 'TerminalMessage.svelte');
    const componentContent = fs.readFileSync(componentPath, 'utf-8');

    // Check that input type gets blue color (#60a5fa) in the scoped CSS
    expect(componentContent).toContain('input');
    expect(componentContent).toContain('#60a5fa');
  });
});
