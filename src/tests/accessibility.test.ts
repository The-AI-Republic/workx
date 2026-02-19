import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/svelte';
import TerminalContainer from '../extension/sidepanel/components/TerminalContainer.svelte';
import TerminalMessage from '../extension/sidepanel/components/TerminalMessage.svelte';
import TerminalInput from '../extension/sidepanel/components/TerminalInput.svelte';

describe('Accessibility', () => {
  it('should meet WCAG AA contrast ratios for green on black', () => {
    // Green (#00ff00) on black (#000000) should have ratio >= 5.95:1
    const greenHex = '#00ff00';
    const blackHex = '#000000';
    const ratio = calculateContrastRatio(greenHex, blackHex);
    expect(ratio).toBeGreaterThanOrEqual(5.95);
  });

  it('should meet WCAG AA contrast ratios for yellow on black', () => {
    // Yellow (#ffff00) on black (#000000) should have ratio >= 10.8:1
    const yellowHex = '#ffff00';
    const blackHex = '#000000';
    const ratio = calculateContrastRatio(yellowHex, blackHex);
    expect(ratio).toBeGreaterThanOrEqual(10.8);
  });

  it('should meet WCAG AA contrast ratios for red on black', () => {
    // Red (#ff0000) on black (#000000) should have ratio >= 5.25:1
    const redHex = '#ff0000';
    const blackHex = '#000000';
    const ratio = calculateContrastRatio(redHex, blackHex);
    expect(ratio).toBeGreaterThanOrEqual(5.25);
  });

  it('should have proper ARIA attributes on container', () => {
    const { container } = render(TerminalContainer);
    const terminalDiv = container.querySelector('[role="log"]');
    expect(terminalDiv).toBeTruthy();
    expect(terminalDiv?.getAttribute('aria-label')).toBe('Terminal output');
  });

  it('should have proper ARIA attributes on messages', () => {
    const { container } = render(TerminalMessage, {
      props: { type: 'default', content: 'Test' }
    });
    const message = container.querySelector('[aria-live="polite"]');
    expect(message).toBeTruthy();
    expect(message?.getAttribute('aria-atomic')).toBe('true');
  });

  it('should have proper ARIA attributes on input', () => {
    const { container } = render(TerminalInput);
    const input = container.querySelector('input[aria-label="Terminal input"]');
    expect(input).toBeTruthy();
  });

  it('should support keyboard navigation', () => {
    const { container } = render(TerminalInput);
    const input = container.querySelector('input');
    expect(input?.getAttribute('tabindex')).not.toBe('-1');
  });
});

// Helper function to calculate contrast ratio
function calculateContrastRatio(color1: string, color2: string): number {
  // Convert hex to RGB
  const rgb1 = hexToRgb(color1);
  const rgb2 = hexToRgb(color2);

  // Calculate relative luminance
  const l1 = getRelativeLuminance(rgb1);
  const l2 = getRelativeLuminance(rgb2);

  // Calculate contrast ratio
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

function hexToRgb(hex: string): { r: number, g: number, b: number } {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : { r: 0, g: 0, b: 0 };
}

function getRelativeLuminance(rgb: { r: number, g: number, b: number }): number {
  const { r, g, b } = rgb;
  const sRGB = [r, g, b].map(val => {
    val = val / 255;
    return val <= 0.03928 ? val / 12.92 : Math.pow((val + 0.055) / 1.055, 2.4);
  });
  return sRGB[0] * 0.2126 + sRGB[1] * 0.7152 + sRGB[2] * 0.0722;
}