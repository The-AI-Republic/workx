import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/svelte';
import TabContext from '../../src/extension/sidepanel/components/common/TabContext.svelte';

describe('TabContext Component', () => {
  // Mock chrome.tabs API
  beforeEach(() => {
    global.chrome = {
      tabs: {
        get: vi.fn(),
        query: vi.fn().mockResolvedValue([]),
        onUpdated: {
          addListener: vi.fn(),
          removeListener: vi.fn(),
        },
        onActivated: {
          addListener: vi.fn(),
          removeListener: vi.fn(),
        },
      },
    } as any;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Tab Title Display', () => {
    it('should display full tab title when under 25 characters', async () => {
      const shortTitle = 'Google Search';
      (chrome.tabs.get as any).mockResolvedValue({
        id: 123,
        title: shortTitle,
        url: 'https://google.com',
      });

      render(TabContext, {
        props: {
          tabId: 123,
        },
      });

      await waitFor(() => {
        const display = screen.getByTestId('tab-context-display');
        expect(display.textContent).toContain(shortTitle);
      });
    });

    it('should truncate tab title to 25 characters', async () => {
      const longTitle = 'This is a very long tab title that exceeds 25 characters';
      (chrome.tabs.get as any).mockResolvedValue({
        id: 123,
        title: longTitle,
        url: 'https://example.com',
      });

      render(TabContext, {
        props: {
          tabId: 123,
        },
      });

      await waitFor(() => {
        const display = screen.getByTestId('tab-context-display');
        const displayedText = display.textContent || '';
        // Should be truncated to 25 chars + ellipsis
        expect(displayedText.length).toBeLessThanOrEqual(28); // 25 chars + "..."
        expect(displayedText).toMatch(/^This is a very long tab t/);
      });
    });

    it('should show full title in tooltip on hover', async () => {
      const longTitle = 'This is a very long tab title that exceeds 25 characters';
      (chrome.tabs.get as any).mockResolvedValue({
        id: 123,
        title: longTitle,
        url: 'https://example.com',
      });

      render(TabContext, {
        props: {
          tabId: 123,
        },
      });

      await waitFor(() => {
        const display = screen.getByTestId('tab-context-display');
        // Native HTML title attribute should contain full title
        expect(display.getAttribute('title')).toBe(longTitle);
      });
    });
  });

  describe('No Tab Attached State (tabId = -1)', () => {
    it('should display "No tab attached" when tabId is -1', () => {
      render(TabContext, {
        props: {
          tabId: -1,
        },
      });

      const display = screen.getByTestId('tab-context-display');
      expect(display.textContent).toContain('No tab attached');
    });

    it('should not attempt to fetch tab when tabId is -1', () => {
      render(TabContext, {
        props: {
          tabId: -1,
        },
      });

      expect(chrome.tabs.get).not.toHaveBeenCalled();
    });
  });

  describe('Missing/Empty Tab Titles', () => {
    it('should show "Untitled" when tab title is empty', async () => {
      (chrome.tabs.get as any).mockResolvedValue({
        id: 123,
        title: '',
        url: 'https://example.com',
      });

      render(TabContext, {
        props: {
          tabId: 123,
        },
      });

      await waitFor(() => {
        const display = screen.getByTestId('tab-context-display');
        expect(display.textContent).toContain('Untitled');
      });
    });

    it('should show URL when tab title is missing', async () => {
      (chrome.tabs.get as any).mockResolvedValue({
        id: 123,
        url: 'https://example.com/path',
      });

      render(TabContext, {
        props: {
          tabId: 123,
        },
      });

      await waitFor(() => {
        const display = screen.getByTestId('tab-context-display');
        // Should show hostname or full URL
        expect(display.textContent).toMatch(/example\.com|https:\/\/example\.com/);
      });
    });

    it('should handle tab fetch errors gracefully', async () => {
      (chrome.tabs.get as any).mockRejectedValue(new Error('Tab not found'));

      render(TabContext, {
        props: {
          tabId: 123,
        },
      });

      await waitFor(() => {
        const display = screen.getByTestId('tab-context-display');
        expect(display.textContent).toContain('Tab unavailable');
      });
    });
  });

  describe('Tab Title Updates', () => {
    it('should register listener for tab title changes', () => {
      render(TabContext, {
        props: {
          tabId: 123,
        },
      });

      expect(chrome.tabs.onUpdated.addListener).toHaveBeenCalled();
    });

    it('should update display when tab title changes', async () => {
      const initialTitle = 'Initial Title';
      const updatedTitle = 'Updated Title';

      (chrome.tabs.get as any).mockResolvedValue({
        id: 123,
        title: initialTitle,
        url: 'https://example.com',
      });

      const { component } = render(TabContext, {
        props: {
          tabId: 123,
        },
      });

      // Wait for initial render
      await waitFor(() => {
        const display = screen.getByTestId('tab-context-display');
        expect(display.textContent).toContain(initialTitle);
      });

      // Simulate tab title change
      (chrome.tabs.get as any).mockResolvedValue({
        id: 123,
        title: updatedTitle,
        url: 'https://example.com',
      });

      // Get the listener that was registered
      const listener = (chrome.tabs.onUpdated.addListener as any).mock.calls[0][0];

      // Trigger the listener with updated tab info
      await listener(123, { title: updatedTitle }, {
        id: 123,
        title: updatedTitle,
        url: 'https://example.com',
      });

      // Verify UI updated
      await waitFor(() => {
        const display = screen.getByTestId('tab-context-display');
        expect(display.textContent).toContain(updatedTitle);
      });
    });

    it('should only update for the correct tabId', async () => {
      (chrome.tabs.get as any).mockResolvedValue({
        id: 123,
        title: 'My Tab',
        url: 'https://example.com',
      });

      render(TabContext, {
        props: {
          tabId: 123,
        },
      });

      await waitFor(() => {
        const display = screen.getByTestId('tab-context-display');
        expect(display.textContent).toContain('My Tab');
      });

      // Get the listener
      const listener = (chrome.tabs.onUpdated.addListener as any).mock.calls[0][0];

      // Trigger listener for different tab
      const getCallsBefore = (chrome.tabs.get as any).mock.calls.length;
      await listener(999, { title: 'Different Tab' }, {
        id: 999,
        title: 'Different Tab',
        url: 'https://other.com',
      });

      // Should not have called chrome.tabs.get again
      expect((chrome.tabs.get as any).mock.calls.length).toBe(getCallsBefore);
    });

    it('should clean up listener on component unmount', () => {
      const { unmount } = render(TabContext, {
        props: {
          tabId: 123,
        },
      });

      const listener = (chrome.tabs.onUpdated.addListener as any).mock.calls[0][0];

      unmount();

      expect(chrome.tabs.onUpdated.removeListener).toHaveBeenCalledWith(listener);
    });
  });

  describe('Performance Requirements (SC-007)', () => {
    it('should update UI within 500ms of tab title change', async () => {
      (chrome.tabs.get as any).mockImplementation(() =>
        new Promise(resolve => {
          // Simulate fast API response (under 100ms)
          setTimeout(() => {
            resolve({
              id: 123,
              title: 'Fast Update',
              url: 'https://example.com',
            });
          }, 50);
        })
      );

      const startTime = Date.now();

      render(TabContext, {
        props: {
          tabId: 123,
        },
      });

      await waitFor(() => {
        const display = screen.getByTestId('tab-context-display');
        expect(display.textContent).toContain('Fast Update');
      });

      const endTime = Date.now();
      const updateTime = endTime - startTime;

      // Should complete well within 500ms requirement
      expect(updateTime).toBeLessThan(500);
    });
  });

  describe('CSS Styling', () => {
    it('should apply text-overflow ellipsis for truncation', async () => {
      const longTitle = 'This is a very long tab title that exceeds 25 characters';
      (chrome.tabs.get as any).mockResolvedValue({
        id: 123,
        title: longTitle,
        url: 'https://example.com',
      });

      render(TabContext, {
        props: {
          tabId: 123,
        },
      });

      await waitFor(() => {
        const display = screen.getByTestId('tab-context-display');
        const styles = window.getComputedStyle(display);

        // Note: JSDOM might not fully compute CSS, so we check the class
        expect(display.className).toMatch(/tab-context|truncate/);
      });
    });
  });

  describe('Reactive Updates', () => {
    it('should fetch new tab when tabId prop changes', async () => {
      (chrome.tabs.get as any).mockResolvedValue({
        id: 123,
        title: 'First Tab',
        url: 'https://example.com',
      });

      const { component } = render(TabContext, {
        props: {
          tabId: 123,
        },
      });

      await waitFor(() => {
        const display = screen.getByTestId('tab-context-display');
        expect(display.textContent).toContain('First Tab');
      });

      // Change tabId prop
      (chrome.tabs.get as any).mockResolvedValue({
        id: 456,
        title: 'Second Tab',
        url: 'https://example2.com',
      });

      component.$set({ tabId: 456 });

      await waitFor(() => {
        const display = screen.getByTestId('tab-context-display');
        expect(display.textContent).toContain('Second Tab');
      });

      // Should have been called twice (once for each tabId)
      expect((chrome.tabs.get as any).mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Active Tab Tracking', () => {
    it('should register onActivated listener on mount', async () => {
      (chrome.tabs.get as any).mockResolvedValue({
        id: 123,
        title: 'Test Tab',
        url: 'https://example.com',
      });

      render(TabContext, {
        props: { tabId: 123 },
      });

      await waitFor(() => {
        expect(chrome.tabs.onActivated.addListener).toHaveBeenCalled();
      });
    });

    it('should clean up onActivated listener on unmount', async () => {
      (chrome.tabs.get as any).mockResolvedValue({
        id: 123,
        title: 'Test Tab',
        url: 'https://example.com',
      });

      const { unmount } = render(TabContext, {
        props: { tabId: 123 },
      });

      await waitFor(() => {
        expect(chrome.tabs.onActivated.addListener).toHaveBeenCalled();
      });

      unmount();

      expect(chrome.tabs.onActivated.removeListener).toHaveBeenCalled();
    });

    it('should query initial active tab on mount', async () => {
      (chrome.tabs.get as any).mockResolvedValue({
        id: 123,
        title: 'Test Tab',
        url: 'https://example.com',
      });

      render(TabContext, {
        props: { tabId: 123 },
      });

      await waitFor(() => {
        expect(chrome.tabs.query).toHaveBeenCalledWith({ active: true, currentWindow: true });
      });
    });

    it('should display "(current)" marker on the active tab in dropdown', async () => {
      const activeTab = { id: 100, title: 'Active Tab', url: 'https://active.com' };
      const otherTab = { id: 200, title: 'Other Tab', url: 'https://other.com' };

      (chrome.tabs.get as any).mockResolvedValue(activeTab);

      // Mock query: return active tab for initial query, all tabs for dropdown
      (chrome.tabs.query as any).mockImplementation((params: any) => {
        if (params.active) {
          return Promise.resolve([activeTab]);
        }
        return Promise.resolve([activeTab, otherTab]);
      });

      render(TabContext, {
        props: { tabId: 100 },
      });

      // Wait for onActivated listener to be registered and initial active tab query to resolve
      await waitFor(() => {
        expect(chrome.tabs.onActivated.addListener).toHaveBeenCalled();
      });

      // Open dropdown by clicking the tab context display
      const display = screen.getByTestId('tab-context-display');
      display.click();

      // Wait for dropdown to populate with tabs
      await waitFor(() => {
        const items = screen.getAllByTestId('tab-dropdown-item');
        expect(items.length).toBe(2);
      });

      // Verify active tab shows "(current)" marker
      const items = screen.getAllByTestId('tab-dropdown-item');
      expect(items[0].textContent).toContain('(current)');
      expect(items[0].textContent).toContain('Active Tab');

      // Verify other tab does NOT show "(current)" marker
      expect(items[1].textContent).not.toContain('(current)');
      expect(items[1].textContent).toContain('Other Tab');
    });
  });
});
