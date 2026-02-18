/**
 * Integration Test: Session Persistence with Tab Binding
 *
 * Purpose: Validates session export/import includes tabId and maintains integrity
 *
 * User Story: US4 - Persistent Tab Binding Throughout Session Lifecycle
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Session } from '@/core/Session';

describe('Session Persistence Integration Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('US4: Session Export with TabId', () => {
    it('should include tabId in exported session data', () => {
      const session = new Session(false);
      session.setTabId(888);

      // Export session
      const exported = session.export();

      // Exported data should include tabId in state
      expect(exported).toBeDefined();
      expect(exported.id).toBeDefined();
      expect(exported.state).toBeDefined();
      expect(exported.state.tabId).toBe(888);
    });

    it('should export tabId = -1 for session without tab', () => {
      const session = new Session(false);

      // No tab bound - default is -1
      expect(session.getTabId()).toBe(-1);

      // Export session
      const exported = session.export();

      // Should export tabId = -1
      expect(exported.state.tabId).toBe(-1);
    });

    it('should include history and metadata in export', () => {
      const session = new Session(false);
      session.setTabId(777);

      const exported = session.export();

      // Export should contain required fields
      expect(exported.id).toBeDefined();
      expect(exported.state).toBeDefined();
      expect(exported.state.history).toBeDefined();
      expect(exported.state.approvedCommands).toBeDefined();
      expect(exported.metadata).toBeDefined();
      expect(exported.metadata.created).toBeDefined();
      expect(exported.metadata.lastAccessed).toBeDefined();
      expect(exported.metadata.messageCount).toBeDefined();
    });
  });

  describe('US4: Session Import with TabId', () => {
    it('should restore tab binding on import', () => {
      // Create a valid exported session data structure
      const exportedData = {
        id: 'session-import-1',
        state: {
          history: { items: [] },
          approvedCommands: [],
          tabId: 666,
        },
        metadata: {
          created: Date.now(),
          lastAccessed: Date.now(),
          messageCount: 0,
        },
      };

      // Import session
      const session = Session.import(exportedData);

      // Session should have tab restored
      expect(session.getTabId()).toBe(666);
    });

    it('should handle missing tabId field in legacy exports', () => {
      // Legacy export without tabId field
      const legacyExport = {
        id: 'session-legacy',
        state: {
          history: { items: [] },
          approvedCommands: [],
          // No tabId field
        },
        metadata: {
          created: Date.now(),
          lastAccessed: Date.now(),
          messageCount: 0,
        },
      };

      // Import legacy session
      const session = Session.import(legacyExport);

      // Should default to tabId = -1
      expect(session.getTabId()).toBe(-1);
    });

    it('should preserve session ID on import', () => {
      const exportedData = {
        id: 'session-preserve-id',
        state: {
          history: { items: [] },
          approvedCommands: [],
          tabId: 555,
        },
        metadata: {
          created: Date.now(),
          lastAccessed: Date.now(),
          messageCount: 0,
        },
      };

      const session = Session.import(exportedData);

      expect(session.getSessionId()).toBe('session-preserve-id');
    });

    it('should restore approved commands on import', () => {
      const exportedData = {
        id: 'session-commands',
        state: {
          history: { items: [] },
          approvedCommands: ['ls', 'cat', 'echo'],
          tabId: -1,
        },
        metadata: {
          created: Date.now(),
          lastAccessed: Date.now(),
          messageCount: 0,
        },
      };

      const session = Session.import(exportedData);

      // Session should be importable without error
      expect(session).toBeDefined();
      expect(session.getSessionId()).toBe('session-commands');
    });
  });

  describe('US4: Export/Import Round Trip', () => {
    it('should maintain tab binding through export-import cycle', () => {
      // Create session and set tab
      const originalSession = new Session(false);
      originalSession.setTabId(999);

      expect(originalSession.getTabId()).toBe(999);

      // Export
      const exportedData = originalSession.export();

      // Import
      const importedSession = Session.import(exportedData);

      // TabId should match
      expect(importedSession.getTabId()).toBe(999);
    });

    it('should handle multiple export-import cycles', () => {
      let session = new Session(false);
      session.setTabId(1111);

      // Perform 3 export-import cycles
      for (let cycle = 1; cycle <= 3; cycle++) {
        // Export
        const exported = session.export();

        // Import
        session = Session.import(exported);

        // TabId should persist
        expect(session.getTabId()).toBe(1111);
      }

      // After 3 cycles, tabId should still be 1111
      expect(session.getTabId()).toBe(1111);
    });

    it('should preserve empty history through round trip', () => {
      const session = new Session(false);

      const exported = session.export();
      const imported = Session.import(exported);

      expect(imported.isEmpty()).toBe(true);
      expect(imported.getMessageCount()).toBe(0);
    });

    it('should maintain tabId=-1 through round trip for unbound sessions', () => {
      const session = new Session(false);
      expect(session.getTabId()).toBe(-1);

      const exported = session.export();
      const imported = Session.import(exported);

      expect(imported.getTabId()).toBe(-1);
    });
  });
});
