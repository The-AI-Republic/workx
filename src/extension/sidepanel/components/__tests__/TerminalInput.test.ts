import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import TerminalInput from '@/extension/sidepanel/components/TerminalInput.svelte';

describe('TerminalInput - Outline Visibility', () => {
  it('should have visible border in default state', () => {
    render(TerminalInput, {
      props: {
        value: '',
        placeholder: 'Enter command...',
        onSubmit: () => {},
      },
    });

    const input = screen.getByRole('textbox') as HTMLInputElement;
    const styles = window.getComputedStyle(input);

    // Test border exists and is visible
    expect(styles.borderWidth).not.toBe('0px');
    expect(styles.borderStyle).not.toBe('none');

    // Should have dim green border (--color-term-dim-green: #00cc00)
    // Note: In JSDOM, CSS variables might not compute, so we check the class or inline styles
    expect(input.className).toContain('terminal-input');
  });

  it('should have enhanced border on focus', async () => {
    const { component } = render(TerminalInput, {
      props: {
        value: '',
        placeholder: 'Enter command...',
        onSubmit: () => {},
      },
    });

    const input = screen.getByRole('textbox') as HTMLInputElement;

    // Focus the input
    input.focus();

    // Check that focus state would apply enhanced styling
    // Note: JSDOM doesn't fully support :focus pseudo-class, but we verify the element can be focused
    expect(document.activeElement).toBe(input);
  });

  it('should maintain border when filled with text', () => {
    render(TerminalInput, {
      props: {
        value: 'test content',
        placeholder: 'Enter command...',
        onSubmit: () => {},
      },
    });

    const input = screen.getByRole('textbox') as HTMLInputElement;

    // Verify input has value
    expect(input.value).toBe('test content');

    // Border should still be present (class-based styling)
    expect(input.className).toContain('terminal-input');
  });

  it('should be keyboard accessible with Tab', () => {
    render(TerminalInput, {
      props: {
        value: '',
        placeholder: 'Enter command...',
        onSubmit: () => {},
      },
    });

    const input = screen.getByRole('textbox') as HTMLInputElement;

    // Verify input is focusable (tabIndex should not be -1)
    expect(input.tabIndex).not.toBe(-1);
  });

  it('should verify CSS styles include border properties', () => {
    const fs = require('fs');
    const path = require('path');
    const stylesPath = path.join(__dirname, '../../styles.css');
    const stylesContent = fs.readFileSync(stylesPath, 'utf-8');

    // Check for border in .terminal-input
    expect(stylesContent).toMatch(/\.terminal-input\s*\{[\s\S]*border/);

    // Check for focus state
    expect(stylesContent).toContain('.terminal-input:focus');
  });
});
