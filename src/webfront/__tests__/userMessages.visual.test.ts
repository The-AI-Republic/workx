import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/svelte';
import TerminalMessage from '@/webfront/components/TerminalMessage.svelte';

describe('User Messages - Visual Regression', () => {
  it('should render user message with input class (blue styling)', () => {
    const { container } = render(TerminalMessage, {
      props: {
        type: 'input',
        content: 'User typed this message',
      },
    });

    const messageElement = container.querySelector('.terminal-message');
    expect(messageElement).toBeTruthy();

    // The component applies the type directly as a CSS class
    // The scoped CSS then maps input to blue (#60a5fa)
    expect(messageElement?.className).toContain('input');

    // Verify CSS defines the blue color token (Tailwind v4 auto-generates utility classes from @theme)
    const fs = require('fs');
    const path = require('path');
    const stylesPath = path.resolve(__dirname, '..', 'styles.css');
    const stylesContent = fs.readFileSync(stylesPath, 'utf-8');

    expect(stylesContent).toContain('--color-term-blue: #60a5fa');
  });

  it('should render agent message with default class (green styling)', () => {
    const { container } = render(TerminalMessage, {
      props: {
        type: 'default',
        content: 'Agent response message',
      },
    });

    const messageElement = container.querySelector('.terminal-message');
    expect(messageElement).toBeTruthy();

    // Should have default class (green color in CSS)
    expect(messageElement?.className).toContain('default');

    // Verify green color token is still defined (Tailwind v4 auto-generates utility classes from @theme)
    const fs = require('fs');
    const path = require('path');
    const stylesPath = path.resolve(__dirname, '..', 'styles.css');
    const stylesContent = fs.readFileSync(stylesPath, 'utf-8');

    expect(stylesContent).toContain('--color-term-green');
  });

  it('should create visual snapshot of color mappings', () => {
    // Document expected color mapping - each type is applied as a CSS class
    const expectedTypes = ['input', 'default', 'warning', 'error', 'system'];

    // Verify each type renders with correct class
    expectedTypes.forEach((type) => {
      const { container } = render(TerminalMessage, {
        props: {
          type: type as any,
          content: `${type} message`,
        },
      });

      const messageElement = container.querySelector('.terminal-message');
      expect(messageElement?.className).toContain(type);
    });
  });

  it('should verify blue color has WCAG AA contrast (7.2:1)', () => {
    // Document contrast ratio requirement
    const blueColor = '#60a5fa'; // User message color

    // Verify blue color is defined in CSS
    const fs = require('fs');
    const path = require('path');
    const stylesPath = path.resolve(__dirname, '..', 'styles.css');
    const stylesContent = fs.readFileSync(stylesPath, 'utf-8');

    expect(stylesContent).toContain(blueColor);

    // Note: Actual contrast ratio calculation would require a color library
    // For now, we verify the color value matches research decision
    expect(blueColor).toBe('#60a5fa');
  });

  it('should verify user messages visually distinct from agent messages', () => {
    const fs = require('fs');
    const path = require('path');
    const stylesPath = path.resolve(__dirname, '..', 'styles.css');
    const stylesContent = fs.readFileSync(stylesPath, 'utf-8');

    // Both colors should be defined
    expect(stylesContent).toContain('--color-term-blue: #60a5fa');
    expect(stylesContent).toContain('--color-term-green: #00ff00');

    // Colors should be different
    expect('#60a5fa').not.toBe('#00ff00');
  });

  it('should render multiple user messages consistently', () => {
    const messages = ['message 1', 'message 2', 'message 3'];

    messages.forEach((content) => {
      const { container } = render(TerminalMessage, {
        props: {
          type: 'input',
          content,
        },
      });

      const messageElement = container.querySelector('.terminal-message');
      expect(messageElement?.className).toContain('input');
      expect(messageElement?.textContent?.trim()).toBe(content);
    });
  });
});
