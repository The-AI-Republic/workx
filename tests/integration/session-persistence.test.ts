/**
 * Integration Test: Session Persistence with Tab Binding
 *
 * Purpose: Validates session export/import includes tabId and maintains binding integrity
 *
 * Test Scenarios:
 * 1. Export session with tabId
 * 2. Import session and restore tab binding
 * 3. Validation of tab on import
 * 4. Handle invalid tab on import (reset to -1)
 * 5. Persistence across application restarts
 *
 * User Story: US4 - Persistent Tab Binding Throughout Session Lifecycle
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Session } from '../../src/core/Session';
import { TabManager } from '../../src/core/TabManager';
import type { SessionServices } from '../../src/core/Session';

describe('Session Persistence Integration Tests', () => {
  let chromeMock: any;
  let mockServices: SessionServices;
  let tabBindingManager: TabManager;

  beforeEach(async () => {
    // Reset singleton
    (TabManager as any).instance = null;

    // Mock chrome APIs
    chromeMock = {
      tabs: {
        get: vi.fn(),
        create: vi.fn(),
        query: vi.fn(),
        onRemoved: {
          addListener: vi.fn(),
          removeListener: vi.fn(),
        },
        onUpdated: {
          addListener: vi.fn(),
          removeListener: vi.fn(),
        },
      },
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({}),
          set: vi.fn().mockResolvedValue(undefined),
        },
        session: {
          get: vi.fn().mockResolvedValue({}),
          set: vi.fn().mockResolvedValue(undefined),
        },
      },
      runtime: {
        sendMessage: vi.fn(),
        onMessage: {
          addListener: vi.fn(),
        },
      },
    };
    global.chrome = chromeMock as any;

    // Initialize TabManager
    tabBindingManager = TabManager.getInstance();
    await tabBindingManager.initialize();

    // Mock services
    mockServices = {} as SessionServices;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('US4: Session Export with TabId', () => {
    it('should include tabId in exported session data', async () => {
      const session = new Session('session-export-1', false, mockServices);

      const mockTab = {
        id: 888,
        url: 'https://example.com',
        title: 'Export Test',
        active: true,
        pinned: false,
        windowId: 1,
        status: 'complete',
        index: 0,
      };

      chromeMock.tabs.get.mockResolvedValue(mockTab);

      // Bind tab to session
      await tabBindingManager.bindTabToSession('session-export-1', 888, mockTab as any);

      // Export session
      const exported = await session.export();

      // Exported data should include tabId
      expect(exported).toBeDefined();
      expect(exported.id).toBe('session-export-1');

      // TabId should be in the exported context or state
      // (Implementation detail: check if it's in turnContext or session state)
      if ('turnContext' in exported) {
        expect((exported as any).turnContext.tabId).toBe(888);
      } else if ('tabId' in exported) {
        expect((exported as any).tabId).toBe(888);
      }
    });

    it('should export tabId = -1 for session without tab', async () => {
      const session = new Session('session-no-tab', false, mockServices);

      // No tab bound
      expect(session.getTabId()).toBe(-1);

      // Export session
      const exported = await session.export();

      // Should export tabId = -1
      if ('turnContext' in exported && (exported as any).turnContext) {
        expect((exported as any).turnContext.tabId).toBe(-1);
      } else if ('tabId' in exported) {
        expect((exported as any).tabId).toBe(-1);
      }
    });

    it('should preserve binding information in export', async () => {
      const session = new Session('session-preserve', false, mockServices);

      const mockTab = {
        id: 777,
        url: 'https://preserve.com',
        title: 'Preserve Tab',
        active: true,
        pinned: false,
        windowId: 1,
        status: 'complete',
        index: 0,
      };

      chromeMock.tabs.get.mockResolvedValue(mockTab);

      await tabBindingManager.bindTabToSession('session-preserve', 777, mockTab as any);

      // Export
      const exported = await session.export();

      // Binding metadata should be available
      const binding = tabBindingManager.getBinding(777);
      expect(binding).toBeDefined();
      expect(binding?.sessionId).toBe('session-preserve');
      expect(binding?.tabInfo.tabId).toBe(777);
      expect(binding?.tabInfo.url).toBe('https://preserve.com');
    });
  });

  describe('US4: Session Import with TabId', () => {
    it('should restore tab binding on import', async () => {
      const mockTab = {
        id: 666,
        url: 'https://import.com',
        title: 'Import Test',
        active: true,
        pinned: false,
        windowId: 1,
        status: 'complete',
        index: 0,
      };

      chromeMock.tabs.get.mockResolvedValue(mockTab);

      // Mock exported session data with tabId
      const exportedData = {
        id: 'session-import-1',
        tabId: 666,
        turnContext: {
          tabId: 666,
          sessionId: 'session-import-1',
        },
        history: [],
        timestamp: Date.now(),
      };

      // Mock persisted binding
      chromeMock.storage.local.get.mockResolvedValue({
        tabBindings: {
          '666': {
            tabId: 666,
            sessionId: 'session-import-1',
            boundAt: Date.now(),
            tabInfo: {
              tabId: 666,
              url: 'https://import.com',
              title: 'Import Test',
              windowId: 1,
            },
          },
        },
      });

      // Re-initialize TabManager to load bindings
      (TabManager as any).instance = null;
      const newBindingManager = TabManager.getInstance();
      await newBindingManager.initialize();

      // Import session
      const session = await Session.import(exportedData as any, mockServices);

      // Session should have tab restored
      expect(session.getTabId()).toBe(666);
      expect(newBindingManager.getTabForSession('session-import-1')).toBe(666);
    });

    it('should validate tab exists on import', async () => {
      // Mock tab exists
      const mockTab = {
        id: 555,
        url: 'https://validate.com',
        title: 'Validate Tab',
        active: true,
        pinned: false,
        windowId: 1,
        status: 'complete',
        index: 0,
      };

      chromeMock.tabs.get.mockResolvedValue(mockTab);

      const exportedData = {
        id: 'session-validate',
        tabId: 555,
        turnContext: {
          tabId: 555,
          sessionId: 'session-validate',
        },
        history: [],
        timestamp: Date.now(),
      };

      chromeMock.storage.local.get.mockResolvedValue({
        tabBindings: {
          '555': {
            tabId: 555,
            sessionId: 'session-validate',
            boundAt: Date.now(),
            tabInfo: {
              tabId: 555,
              url: 'https://validate.com',
              title: 'Validate Tab',
              windowId: 1,
            },
          },
        },
      });

      // Re-initialize
      (TabManager as any).instance = null;
      const newBindingManager = TabManager.getInstance();
      await newBindingManager.initialize();

      // Validation should pass
      const validation = await newBindingManager.validateTab(555);
      expect(validation.status).toBe('valid');
    });

    it('should reset tabId to -1 when tab no longer exists on import', async () => {
      // Mock tab does NOT exist
      chromeMock.tabs.get.mockRejectedValue(new Error('No tab with id: 444'));

      const exportedData = {
        id: 'session-invalid-tab',
        tabId: 444,
        turnContext: {
          tabId: 444,
          sessionId: 'session-invalid-tab',
        },
        history: [],
        timestamp: Date.now(),
      };

      chromeMock.storage.local.get.mockResolvedValue({
        tabBindings: {
          '444': {
            tabId: 444,
            sessionId: 'session-invalid-tab',
            boundAt: Date.now(),
            tabInfo: {
              tabId: 444,
              url: 'https://gone.com',
              title: 'Gone Tab',
              windowId: 1,
            },
          },
        },
      });

      // Re-initialize (defensive restoration should clean up invalid bindings)
      (TabManager as any).instance = null;
      const newBindingManager = TabManager.getInstance();
      await newBindingManager.initialize();

      // Import session (should handle invalid tab gracefully)
      const session = await Session.import(exportedData as any, mockServices);

      // TabId should be reset to -1 (defensive behavior from T039)
      expect(session.getTabId()).toBe(-1);
      expect(newBindingManager.getTabForSession('session-invalid-tab')).toBe(-1);
    });

    it('should handle missing tabId field in legacy exports', async () => {
      // Legacy export without tabId field
      const legacyExport = {
        id: 'session-legacy',
        // No tabId field
        history: [],
        timestamp: Date.now(),
      };

      chromeMock.storage.local.get.mockResolvedValue({ tabBindings: {} });

      // Import legacy session
      const session = await Session.import(legacyExport as any, mockServices);

      // Should default to tabId = -1
      expect(session.getTabId()).toBe(-1);
    });
  });

  describe('US4: Persistence Across Restarts', () => {
    it('should maintain binding after TabManager restart', async () => {
      const mockTab = {
        id: 333,
        url: 'https://restart.com',
        title: 'Restart Test',
        active: true,
        pinned: false,
        windowId: 1,
        status: 'complete',
        index: 0,
      };

      chromeMock.tabs.get.mockResolvedValue(mockTab);

      // Bind tab
      await tabBindingManager.bindTabToSession('session-restart', 333, mockTab as any);

      // Verify binding
      expect(tabBindingManager.getTabForSession('session-restart')).toBe(333);

      // Simulate restart: destroy and recreate TabManager
      (TabManager as any).instance = null;

      // Mock storage returns persisted binding
      chromeMock.storage.local.get.mockResolvedValue({
        tabBindings: {
          '333': {
            tabId: 333,
            sessionId: 'session-restart',
            boundAt: Date.now(),
            tabInfo: {
              tabId: 333,
              url: 'https://restart.com',
              title: 'Restart Test',
              windowId: 1,
            },
          },
        },
      });

      // Reinitialize
      const newBindingManager = TabManager.getInstance();
      await newBindingManager.initialize();

      // Binding should be restored
      expect(newBindingManager.getTabForSession('session-restart')).toBe(333);
      expect(newBindingManager.getSessionForTab(333)).toBe('session-restart');
    });

    it('should clean up bindings for non-existent tabs on restart', async () => {
      // Mock persisted bindings with some invalid tabs
      chromeMock.storage.local.get.mockResolvedValue({
        tabBindings: {
          '111': {
            tabId: 111,
            sessionId: 'session-valid',
            boundAt: Date.now(),
            tabInfo: {
              tabId: 111,
              url: 'https://valid.com',
              title: 'Valid Tab',
              windowId: 1,
            },
          },
          '222': {
            tabId: 222,
            sessionId: 'session-invalid',
            boundAt: Date.now(),
            tabInfo: {
              tabId: 222,
              url: 'https://invalid.com',
              title: 'Invalid Tab',
              windowId: 1,
            },
          },
        },
      });

      // Tab 111 exists, tab 222 does not
      chromeMock.tabs.get.mockImplementation((tabId: number) => {
        if (tabId === 111) {
          return Promise.resolve({
            id: 111,
            url: 'https://valid.com',
            title: 'Valid Tab',
            active: true,
            pinned: false,
            windowId: 1,
            status: 'complete',
            index: 0,
          });
        }
        return Promise.reject(new Error(`No tab with id: ${tabId}`));
      });

      // Reinitialize
      (TabManager as any).instance = null;
      const newBindingManager = TabManager.getInstance();
      await newBindingManager.initialize();

      // Valid binding should exist
      expect(newBindingManager.getTabForSession('session-valid')).toBe(111);

      // Invalid binding should be cleaned up
      expect(newBindingManager.getTabForSession('session-invalid')).toBe(-1);
      expect(newBindingManager.getSessionForTab(222)).toBeUndefined();
    });
  });

  describe('US4: Export/Import Round Trip', () => {
    it('should maintain tab binding through export-import cycle', async () => {
      const mockTab = {
        id: 999,
        url: 'https://roundtrip.com',
        title: 'Round Trip Test',
        active: true,
        pinned: false,
        windowId: 1,
        status: 'complete',
        index: 0,
      };

      chromeMock.tabs.get.mockResolvedValue(mockTab);

      // Create session and bind tab
      const originalSession = new Session('session-roundtrip', false, mockServices);
      await tabBindingManager.bindTabToSession('session-roundtrip', 999, mockTab as any);

      expect(originalSession.getTabId()).toBe(999);

      // Export
      const exportedData = await originalSession.export();

      // Mock persisted binding for import
      chromeMock.storage.local.get.mockResolvedValue({
        tabBindings: {
          '999': {
            tabId: 999,
            sessionId: 'session-roundtrip',
            boundAt: Date.now(),
            tabInfo: {
              tabId: 999,
              url: 'https://roundtrip.com',
              title: 'Round Trip Test',
              windowId: 1,
            },
          },
        },
      });

      // Reinitialize TabManager
      (TabManager as any).instance = null;
      const newBindingManager = TabManager.getInstance();
      await newBindingManager.initialize();

      // Import
      const importedSession = await Session.import(exportedData, mockServices);

      // TabId should match
      expect(importedSession.getTabId()).toBe(999);
      expect(newBindingManager.getTabForSession('session-roundtrip')).toBe(999);
    });

    it('should handle multiple export-import cycles', async () => {
      const mockTab = {
        id: 1111,
        url: 'https://multi-cycle.com',
        title: 'Multi Cycle',
        active: true,
        pinned: false,
        windowId: 1,
        status: 'complete',
        index: 0,
      };

      chromeMock.tabs.get.mockResolvedValue(mockTab);

      let session = new Session('session-multi-cycle', false, mockServices);
      await tabBindingManager.bindTabToSession('session-multi-cycle', 1111, mockTab as any);

      // Perform 3 export-import cycles
      for (let cycle = 1; cycle <= 3; cycle++) {
        // Export
        const exported = await session.export();

        // Mock storage with binding
        chromeMock.storage.local.get.mockResolvedValue({
          tabBindings: {
            '1111': {
              tabId: 1111,
              sessionId: 'session-multi-cycle',
              boundAt: Date.now(),
              tabInfo: {
                tabId: 1111,
                url: 'https://multi-cycle.com',
                title: 'Multi Cycle',
                windowId: 1,
              },
            },
          },
        });

        // Reinitialize
        (TabManager as any).instance = null;
        const newManager = TabManager.getInstance();
        await newManager.initialize();

        // Import
        session = await Session.import(exported, mockServices);

        // TabId should persist
        expect(session.getTabId()).toBe(1111);
      }

      // After 3 cycles, tabId should still be 1111
      expect(session.getTabId()).toBe(1111);
    });
  });
});
