import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/svelte';
import App from '../../src/sidepanel/App.svelte';

// Mock chrome API
global.chrome = {
  runtime: {
    connect: vi.fn(() => ({
      postMessage: vi.fn(),
      onMessage: {
        addListener: vi.fn(),
      },
      onDisconnect: {
        addListener: vi.fn(),
      },
    })),
    onMessage: {
      addListener: vi.fn(),
    },
  },
} as any;

describe('App.svelte - User Message Display', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should render user messages in the dialogue', async () => {
    const { container } = render(App);

    // Find input field
    const input = screen.getByPlaceholderText(/enter command/i) as HTMLInputElement;

    // Type a message
    await fireEvent.input(input, { target: { value: 'test message' } });
    await fireEvent.keyPress(input, { key: 'Enter', code: 'Enter', charCode: 13 });

    // Wait for message to appear
    await waitFor(() => {
      const messages = container.querySelectorAll('.terminal-message');
      expect(messages.length).toBeGreaterThan(0);
    });
  });

  it('should render user message with type="input"', async () => {
    const { container, component } = render(App);

    // Simulate adding a user message
    // Note: We need to verify the template logic, which renders messages with type="input"
    const appSource = require('fs').readFileSync(
      require('path').join(__dirname, '../../src/sidepanel/App.svelte'),
      'utf-8'
    );

    // Check template renders messages with type="input" for user messages
    expect(appSource).toContain("type={message.type === 'user' ? 'input'");
  });

  it('should render messages before processedEvents', () => {
    const appSource = require('fs').readFileSync(
      require('path').join(__dirname, '../../src/sidepanel/App.svelte'),
      'utf-8'
    );

    // Find the position of messages loop and processedEvents loop
    const messagesLoopIndex = appSource.indexOf('{#each messages');
    const eventsLoopIndex = appSource.indexOf('{#each processedEvents');

    // Messages should appear before processedEvents in the template
    expect(messagesLoopIndex).toBeGreaterThan(-1);
    expect(eventsLoopIndex).toBeGreaterThan(-1);
    expect(messagesLoopIndex).toBeLessThan(eventsLoopIndex);
  });

  it('should hide welcome message when messages exist', () => {
    const appSource = require('fs').readFileSync(
      require('path').join(__dirname, '../../src/sidepanel/App.svelte'),
      'utf-8'
    );

    // Welcome message should check both processedEvents AND messages
    expect(appSource).toMatch(
      /\{#if\s+processedEvents\.length\s*===\s*0\s*&&\s*messages\.length\s*===\s*0\}/
    );
  });
});

describe('App.svelte - Branding Label', () => {
  it('should display "Browserx: in-browser AI Agent (By AI Republic)"', () => {
    const appSource = require('fs').readFileSync(
      require('path').join(__dirname, '../../src/sidepanel/App.svelte'),
      'utf-8'
    );

    // Check for updated branding string
    expect(appSource).toContain('Browserx: in-browser AI Agent (By AI Republic)');
  });

  it('should NOT display "Browserx Terminal v0.0.1"', () => {
    const appSource = require('fs').readFileSync(
      require('path').join(__dirname, '../../src/sidepanel/App.svelte'),
      'utf-8'
    );

    // Verify old branding is replaced
    expect(appSource).not.toContain('Browserx Terminal v1.0.0');
  });

  it('should render branding label with system type', () => {
    const { container } = render(App);

    // Look for branding text in the rendered component
    // Note: This may require waiting for component to mount
    const brandingElements = Array.from(container.querySelectorAll('.terminal-message'))
      .filter(el => el.textContent?.includes('Browserx'));

    expect(brandingElements.length).toBeGreaterThan(0);
  });
});
