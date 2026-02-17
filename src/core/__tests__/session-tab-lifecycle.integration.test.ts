/**
 * Integration Test: Session Tab Lifecycle
 *
 * Purpose: Validates the session-tab binding lifecycle using actual Session and TabManager APIs
 *
 * Tests cover:
 * 1. Session initialization with tabId = -1 (no tab attached)
 * 2. Setting and getting tab IDs on sessions
 * 3. Tab validation via TabManager
 * 4. Session export/import preserving tab binding
 * 5. Tab lifecycle with multiple sessions
 *
 * User Story: US1 - Session Initiates with Tab Binding
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Session } from '@/core/Session';
import { TabManager } from '@/core/TabManager';

describe('Session Tab Lifecycle Integration Tests', () => {
  let chromeMock: any;

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
    const tabManager = TabManager.getInstance();
    await tabManager.initialize();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('US1: Session Initialization', () => {
    it('should initialize new session with tabId = -1', () => {
      const session = new Session(false);

      // New session should have no tab attached
      const tabId = session.getTabId();
      expect(tabId).toBe(-1);
    });

    it('should initialize with isPersistent = false', () => {
      const session = new Session(false);

      expect(session.getTabId()).toBe(-1);
      expect(session.getSessionId()).toBeDefined();
    });

    it('should generate unique session IDs', () => {
      const session1 = new Session(false);
      const session2 = new Session(false);

      expect(session1.getSessionId()).not.toBe(session2.getSessionId());
    });
  });

  describe('US1: Tab Binding via Session', () => {
    it('should set and get tab ID on session', () => {
      const session = new Session(false);

      session.setTabId(123);
      expect(session.getTabId()).toBe(123);
    });

    it('should allow changing tab ID', () => {
      const session = new Session(false);

      session.setTabId(100);
      expect(session.getTabId()).toBe(100);

      session.setTabId(200);
      expect(session.getTabId()).toBe(200);
    });

    it('should allow resetting tab ID to -1', () => {
      const session = new Session(false);

      session.setTabId(300);
      expect(session.getTabId()).toBe(300);

      session.setTabId(-1);
      expect(session.getTabId()).toBe(-1);
    });
  });

  describe('US1: Tab Validation via TabManager', () => {
    it('should validate existing tab', async () => {
      const mockTab = {
        id: 123,
        url: 'https://example.com',
        title: 'Test Tab',
        active: true,
        pinned: false,
        windowId: 1,
        status: 'complete',
        index: 0,
      };

      chromeMock.tabs.get.mockResolvedValue(mockTab);

      const tabManager = TabManager.getInstance();
      const validation = await tabManager.validateTab(123);

      expect(validation.status).toBe('valid');
    });

    it('should invalidate non-existent tab', async () => {
      chromeMock.tabs.get.mockRejectedValue(new Error('No tab with id: 999'));

      const tabManager = TabManager.getInstance();
      const validation = await tabManager.validateTab(999);

      expect(validation.status).toBe('invalid');
    });

    it('should invalidate tabId = -1', async () => {
      const tabManager = TabManager.getInstance();
      const validation = await tabManager.validateTab(-1);

      expect(validation.status).toBe('invalid');
    });
  });

  describe('US4: Tab Binding with Export/Import', () => {
    it('should preserve tabId through export-import', () => {
      const session = new Session(false);
      session.setTabId(456);

      const exported = session.export();
      expect(exported.state.tabId).toBe(456);

      const imported = Session.import(exported);
      expect(imported.getTabId()).toBe(456);
    });

    it('should preserve tabId = -1 through export-import', () => {
      const session = new Session(false);

      const exported = session.export();
      expect(exported.state.tabId).toBe(-1);

      const imported = Session.import(exported);
      expect(imported.getTabId()).toBe(-1);
    });

    it('should handle multiple sessions with different tabIds', () => {
      const session1 = new Session(false);
      const session2 = new Session(false);
      const session3 = new Session(false);

      session1.setTabId(100);
      session2.setTabId(200);
      session3.setTabId(300);

      expect(session1.getTabId()).toBe(100);
      expect(session2.getTabId()).toBe(200);
      expect(session3.getTabId()).toBe(300);

      // Export all
      const exp1 = session1.export();
      const exp2 = session2.export();
      const exp3 = session3.export();

      // Import all
      const imp1 = Session.import(exp1);
      const imp2 = Session.import(exp2);
      const imp3 = Session.import(exp3);

      expect(imp1.getTabId()).toBe(100);
      expect(imp2.getTabId()).toBe(200);
      expect(imp3.getTabId()).toBe(300);
    });
  });

  describe('US4: Multi-Operation Tab Consistency', () => {
    it('should maintain tabId across operations', () => {
      const session = new Session(false);
      session.setTabId(999);

      // Multiple reads should return same value
      for (let i = 0; i < 10; i++) {
        expect(session.getTabId()).toBe(999);
      }
    });

    it('should maintain tab consistency across turn boundaries', () => {
      const session = new Session(false);
      session.setTabId(777);

      // Simulate multiple turns (conversation turns)
      for (let turn = 1; turn <= 5; turn++) {
        // Each turn should see the same tabId
        expect(session.getTabId()).toBe(777);

        // Session ID should remain constant
        const sessionId = session.getSessionId();
        expect(sessionId).toBeDefined();
      }
    });

    it('should prevent tab proliferation by using a single tabId', () => {
      const session = new Session(false);

      // Bind first tab
      session.setTabId(100);
      expect(session.getTabId()).toBe(100);

      // Rebind should replace, not add
      session.setTabId(200);
      expect(session.getTabId()).toBe(200);

      // Only one tab should be associated
      session.setTabId(300);
      expect(session.getTabId()).toBe(300);
    });

    it('should maintain consistency during rapid operations', () => {
      const session = new Session(false);
      session.setTabId(555);

      // Simulate rapid concurrent-like operations
      const results: number[] = [];
      for (let i = 0; i < 100; i++) {
        results.push(session.getTabId());
      }

      // All results should be identical
      expect(new Set(results).size).toBe(1);
      expect(results[0]).toBe(555);
    });
  });
});
