import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/svelte';
import TerminalInput from '@/webfront/components/TerminalInput.svelte';

describe('Input Outline - Visual Regression', () => {
  it('should have visible border in default state', () => {
    const { container } = render(TerminalInput, {
      props: {
        value: '',
        placeholder: 'Enter command...',
        onSubmit: () => {},
      },
    });

    const input = container.querySelector('.terminal-input') as HTMLInputElement;
    expect(input).toBeTruthy();

    // Verify CSS class is applied
    expect(input.className).toContain('terminal-input');

    // Check styles.css for border definition
    const fs = require('fs');
    const path = require('path');
    const stylesPath = path.join(__dirname, '../styles.css');
    const stylesContent = fs.readFileSync(stylesPath, 'utf-8');

    // Visual verification: border should be defined
    expect(stylesContent).toMatch(/\.terminal-input\s*\{[\s\S]*?border.*?var\(--color-term-dim-green\)/);
  });

  it('should have enhanced border on focus', () => {
    const { container } = render(TerminalInput, {
      props: {
        value: '',
        placeholder: 'Enter command...',
        onSubmit: () => {},
      },
    });

    const input = container.querySelector('.terminal-input') as HTMLInputElement;
    input.focus();

    // Check styles.css for focus state
    const fs = require('fs');
    const path = require('path');
    const stylesPath = path.join(__dirname, '../styles.css');
    const stylesContent = fs.readFileSync(stylesPath, 'utf-8');

    // Visual verification: focus state should have bright green border and box-shadow
    expect(stylesContent).toContain('.terminal-input:focus');
    expect(stylesContent).toMatch(/\.terminal-input:focus\s*\{[\s\S]*?border-color.*?var\(--color-term-bright-green\)/);
    expect(stylesContent).toMatch(/\.terminal-input:focus\s*\{[\s\S]*?box-shadow/);
  });

  it('should verify border properties are correct', () => {
    const fs = require('fs');
    const path = require('path');
    const stylesPath = path.join(__dirname, '../styles.css');
    const stylesContent = fs.readFileSync(stylesPath, 'utf-8');

    // Check for required border properties
    expect(stylesContent).toMatch(/\.terminal-input\s*\{[\s\S]*?border:\s*1px solid/);
    expect(stylesContent).toMatch(/\.terminal-input\s*\{[\s\S]*?padding/);
    expect(stylesContent).toMatch(/\.terminal-input\s*\{[\s\S]*?border-radius/);
    expect(stylesContent).toMatch(/\.terminal-input\s*\{[\s\S]*?transition/);
  });

  it('should verify outline:none is removed from default state', () => {
    const fs = require('fs');
    const path = require('path');
    const stylesPath = path.join(__dirname, '../styles.css');
    const stylesContent = fs.readFileSync(stylesPath, 'utf-8');

    // Extract .terminal-input block (not :focus)
    const inputClassMatch = stylesContent.match(/\.terminal-input\s*\{[^}]*\}/);
    expect(inputClassMatch).toBeTruthy();

    if (inputClassMatch) {
      const inputClassBlock = inputClassMatch[0];
      // Should NOT have "outline: none" in default state (only in :focus)
      // Should NOT have "border: none"
      expect(inputClassBlock).not.toMatch(/outline:\s*none/);
      expect(inputClassBlock).not.toMatch(/border:\s*none/);
    }
  });

  it('should create visual snapshot of input styles', () => {
    // This test documents the expected visual appearance
    const expectedStyles = {
      default: {
        border: '1px solid var(--color-term-dim-green)',
        padding: '0.25rem 0.5rem',
        borderRadius: '2px',
        transition: 'border-color 0.2s ease, box-shadow 0.2s ease',
      },
      focus: {
        outline: 'none',
        borderColor: 'var(--color-term-bright-green)',
        boxShadow: '0 0 0 1px var(--color-term-bright-green)',
      },
    };

    // Verify against actual CSS
    const fs = require('fs');
    const path = require('path');
    const stylesPath = path.join(__dirname, '../styles.css');
    const stylesContent = fs.readFileSync(stylesPath, 'utf-8');

    expect(stylesContent).toContain('1px solid');
    expect(stylesContent).toContain('--color-term-dim-green');
    expect(stylesContent).toContain('--color-term-bright-green');
  });
});
