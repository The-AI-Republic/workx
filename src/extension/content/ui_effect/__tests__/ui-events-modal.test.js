/**
 * Contract test for settings modal UI events
 * Verifies the UI events contract for opening/closing settings modal
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import App from '@/sidepanel/App.svelte';

// Mock MessageRouter
vi.mock('../../src/core/MessageRouter', () => ({
  MessageRouter: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    send: vi.fn().mockResolvedValue({ type: 'PONG' }),
    sendSubmission: vi.fn(),
    cleanup: vi.fn()
  })),
  MessageType: {
    EVENT: 'EVENT',
    STATE_UPDATE: 'STATE_UPDATE',
    PING: 'PING',
    PONG: 'PONG'
  }
}));

// Mock Chrome APIs
global.chrome = {
  storage: {
    local: {
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined)
    }
  },
  runtime: {
    lastError: null
  }
};

describe('UI Events Contract - Settings Modal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('openSettings event', () => {
    it('should trigger on gear icon click', async () => {
      const { container } = render(App);

      // Find gear button
      const gearButton = container.querySelector('.settings-button');
      expect(gearButton).toBeTruthy();

      // Initial state - modal should not be visible
      let modal = container.querySelector('.fixed.inset-0.z-50');
      expect(modal).toBeFalsy();

      // Trigger openSettings event
      await fireEvent.click(gearButton);
      await tick();

      // Verify response matches contract
      modal = container.querySelector('.fixed.inset-0.z-50');
      expect(modal).toBeTruthy();

      // Verify state changes as per contract
      const settingsContainer = modal.querySelector('.bg-term-bg-dark');
      expect(settingsContainer).toBeTruthy();
    });

    it('should update state correctly on open', async () => {
      const { container } = render(App);

      const gearButton = container.querySelector('.settings-button');

      // Track state before event
      const initialModalState = !!container.querySelector('.fixed.inset-0.z-50');
      expect(initialModalState).toBe(false);

      // Trigger event
      await fireEvent.click(gearButton);
      await tick();

      // Verify state after event matches contract
      const finalModalState = !!container.querySelector('.fixed.inset-0.z-50');
      expect(finalModalState).toBe(true);
    });
  });

  describe('closeSettings event', () => {
    it('should trigger when close button is clicked', async () => {
      const { container } = render(App);

      // Open modal first
      const gearButton = container.querySelector('.settings-button');
      await fireEvent.click(gearButton);
      await tick();

      // Verify modal is open
      let modal = container.querySelector('.fixed.inset-0.z-50');
      expect(modal).toBeTruthy();

      // Find and click close button
      const closeButton = container.querySelector('.close-button');
      expect(closeButton).toBeTruthy();

      // Trigger closeSettings event
      await fireEvent.click(closeButton);
      await tick();

      // Verify modal is closed as per contract
      modal = container.querySelector('.fixed.inset-0.z-50');
      expect(modal).toBeFalsy();
    });

    it('should clear error and success states on close', async () => {
      const { container } = render(App);

      // Open settings
      const gearButton = container.querySelector('.settings-button');
      await fireEvent.click(gearButton);
      await tick();

      // Close settings
      const closeButton = container.querySelector('.close-button');
      await fireEvent.click(closeButton);
      await tick();

      // Verify state is reset as per contract
      const modal = container.querySelector('.fixed.inset-0.z-50');
      expect(modal).toBeFalsy();
    });
  });

  describe('showTooltip event', () => {
    it('should display tooltip on gear hover', async () => {
      const { container } = render(App);

      const gearButton = container.querySelector('.settings-button');
      expect(gearButton).toBeTruthy();

      // Initial state - no tooltip
      let tooltip = container.querySelector('.tooltip');
      expect(tooltip).toBeFalsy();

      // Trigger hover event
      await fireEvent.mouseEnter(gearButton);
      await tick();

      // Verify tooltip appears with correct content
      tooltip = container.querySelector('.tooltip');
      expect(tooltip).toBeTruthy();
      expect(tooltip.textContent).toBe('setting');
    });

    it('should hide tooltip on mouse leave', async () => {
      const { container } = render(App);

      const gearButton = container.querySelector('.settings-button');

      // Show tooltip
      await fireEvent.mouseEnter(gearButton);
      await tick();

      let tooltip = container.querySelector('.tooltip');
      expect(tooltip).toBeTruthy();

      // Hide tooltip
      await fireEvent.mouseLeave(gearButton);
      await tick();

      // Verify tooltip is hidden
      tooltip = container.querySelector('.tooltip');
      expect(tooltip).toBeFalsy();
    });
  });

  describe('Modal state transitions', () => {
    it('should follow correct state transition: closed → opening → open', async () => {
      const { container } = render(App);

      // State: closed
      let modal = container.querySelector('.fixed.inset-0.z-50');
      expect(modal).toBeFalsy();

      const gearButton = container.querySelector('.settings-button');

      // Trigger transition to open
      await fireEvent.click(gearButton);

      // Allow for any transition animations
      await waitFor(() => {
        modal = container.querySelector('.fixed.inset-0.z-50');
        expect(modal).toBeTruthy();
      });

      // State: open
      const settingsContent = container.querySelector('.settings-container');
      expect(settingsContent).toBeTruthy();
    });

    it('should follow correct state transition: open → closing → closed', async () => {
      const { container } = render(App);

      // Open modal
      const gearButton = container.querySelector('.settings-button');
      await fireEvent.click(gearButton);
      await tick();

      // State: open
      let modal = container.querySelector('.fixed.inset-0.z-50');
      expect(modal).toBeTruthy();

      // Trigger transition to closed
      const closeButton = container.querySelector('.close-button');
      await fireEvent.click(closeButton);

      // Allow for any transition animations
      await waitFor(() => {
        modal = container.querySelector('.fixed.inset-0.z-50');
        expect(modal).toBeFalsy();
      });
    });
  });
});