import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent, screen, waitFor } from '@testing-library/svelte';
import App from '@/extension/sidepanel/App.svelte';
import '@testing-library/jest-dom';

// Mock the MessageRouter
vi.mock('../../src/core/MessageRouter', () => ({
  MessageRouter: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    send: vi.fn().mockResolvedValue({ type: 'PONG' }),
    sendSubmission: vi.fn(),
    cleanup: vi.fn(),
  })),
  MessageType: {
    EVENT: 'EVENT',
    STATE_UPDATE: 'STATE_UPDATE',
    PING: 'PING',
    PONG: 'PONG',
  },
}));

// Mock chrome storage API
global.chrome = {
  storage: {
    local: {
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    },
    sync: {
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn().mockResolvedValue(undefined),
    },
  },
  runtime: {
    lastError: null,
  },
} as any;

describe('Settings Gear Icon', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should display gear icon at bottom of sidepanel', async () => {
    const { container } = render(App);

    // Check for gear button
    const gearButton = container.querySelector('.settings-button');
    expect(gearButton).toBeInTheDocument();
    expect(gearButton).toHaveAttribute('aria-label', 'Settings');
  });

  it('should show tooltip "setting" on hover', async () => {
    const { container } = render(App);

    const gearButton = container.querySelector('.settings-button');
    expect(gearButton).toBeInTheDocument();

    // Hover over gear button
    await fireEvent.mouseEnter(gearButton!);

    // Wait for tooltip to appear
    await waitFor(() => {
      const tooltip = container.querySelector('.tooltip');
      expect(tooltip).toBeInTheDocument();
      expect(tooltip).toHaveTextContent('setting');
    });

    // Mouse leave should hide tooltip
    await fireEvent.mouseLeave(gearButton!);

    await waitFor(() => {
      const tooltip = container.querySelector('.tooltip');
      expect(tooltip).not.toBeInTheDocument();
    });
  });

  it('should open settings modal when gear icon is clicked', async () => {
    const { container } = render(App);

    const gearButton = container.querySelector('.settings-button');
    expect(gearButton).toBeInTheDocument();

    // Click gear button
    await fireEvent.click(gearButton!);

    // Wait for modal to appear
    await waitFor(() => {
      const modal = container.querySelector('.fixed.inset-0.z-50');
      expect(modal).toBeInTheDocument();

      // Check for Settings component content
      const settingsTitle = screen.getByText('Settings');
      expect(settingsTitle).toBeInTheDocument();
    });
  });

  it('should close settings modal when close is triggered', async () => {
    const { container } = render(App);

    const gearButton = container.querySelector('.settings-button');
    await fireEvent.click(gearButton!);

    // Wait for modal to appear
    await waitFor(() => {
      const modal = container.querySelector('.fixed.inset-0.z-50');
      expect(modal).toBeInTheDocument();
    });

    // Find and click close button
    const closeButton = container.querySelector('.close-button');
    expect(closeButton).toBeInTheDocument();

    await fireEvent.click(closeButton!);

    // Wait for modal to disappear
    await waitFor(() => {
      const modal = container.querySelector('.fixed.inset-0.z-50');
      expect(modal).not.toBeInTheDocument();
    });
  });

  it('should rotate gear icon on hover', async () => {
    const { container } = render(App);

    const gearButton = container.querySelector('.settings-button');
    expect(gearButton).toBeInTheDocument();

    // Check that hover style is applied
    const styles = window.getComputedStyle(gearButton as Element);
    expect(styles.transition).toContain('all');
  });
});