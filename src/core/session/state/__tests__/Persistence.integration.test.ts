/**
 * Persistence integration test
 * Tests export/import round-trip and state preservation
 * Tests must fail until implementation is complete (TDD)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Session } from '../../../Session';
import { SessionState } from '../SessionState';
import type { InputItem } from '../../../protocol/types';

describe('Persistence Integration', () => {
  describe('Session Export/Import Round-Trip', () => {
    let session: Session;

    beforeEach(async () => {
      session = new Session(false);
      await session.initialize();
    });

    it('should preserve conversation history', async () => {
      // Add conversation history
      await session.addToHistory({
        timestamp: Date.now(),
        text: 'User message 1',
        type: 'user',
      });

      await session.addToHistory({
        timestamp: Date.now(),
        text: 'Agent response 1',
        type: 'agent',
      });

      await session.addToHistory({
        timestamp: Date.now(),
        text: 'User message 2',
        type: 'user',
      });

      // Export
      const exported = session.export();

      // Import
      const imported = Session.import(exported);

      // Verify
      const originalHistory = session.getConversationHistory();
      const importedHistory = imported.getConversationHistory();

      expect(importedHistory.items.length).toBe(originalHistory.items.length);
      expect(importedHistory.items[0].content).toEqual(
        originalHistory.items[0].content
      );
    });

    it('should preserve session ID', async () => {
      const originalId = session.getSessionId();

      const exported = session.export();
      const imported = Session.import(exported);

      expect(imported.getSessionId()).toBe(originalId);
    });

    it('should preserve message count', async () => {
      await session.addToHistory({
        timestamp: Date.now(),
        text: 'Test',
        type: 'user',
      });

      const exported = session.export();
      const imported = Session.import(exported);

      expect(imported.getMessageCount()).toBe(session.getMessageCount());
    });

    it('should preserve turn context', async () => {
      session.updateTurnContext({
        model: 'gpt-4',
        cwd: '/test/directory',
      });

      const exported = session.export();
      const imported = Session.import(exported);

      const context = imported.getTurnContext();

      expect(context.model).toBe('gpt-4');
      expect(context.cwd).toBe('/test/directory');
    });

    it('should handle empty session export/import', async () => {
      const exported = session.export();
      const imported = Session.import(exported);

      expect(imported.isEmpty()).toBe(true);
      expect(imported.getMessageCount()).toBe(0);
    });

    it('should handle large conversation export/import', async () => {
      // Add many messages
      for (let i = 0; i < 100; i++) {
        await session.addToHistory({
          timestamp: Date.now(),
          text: `Message ${i}`,
          type: i % 2 === 0 ? 'user' : 'agent',
        });
      }

      const exported = session.export();
      const imported = Session.import(exported);

      expect(imported.getMessageCount()).toBe(100);
    });
  });

  describe('SessionState Export/Import Round-Trip', () => {
    let state: SessionState;

    beforeEach(() => {
      state = new SessionState();
    });

    it('should preserve history through export/import', () => {
      const items = [
        { role: 'user' as const, content: 'Message 1', timestamp: Date.now() },
        {
          role: 'assistant' as const,
          content: 'Response 1',
          timestamp: Date.now(),
        },
      ];

      state.recordItems(items);

      const exported = state.export();
      const imported = SessionState.import(exported);

      const originalSnapshot = state.historySnapshot();
      const importedSnapshot = imported.historySnapshot();

      expect(importedSnapshot.length).toBe(originalSnapshot.length);
      expect(importedSnapshot[0].content).toBe(originalSnapshot[0].content);
    });

    it('should preserve token info through export/import', () => {
      state.addTokenUsage(100);
      state.addTokenUsage(50);

      const exported = state.export();
      const imported = SessionState.import(exported);

      const reimported = imported.export();
      expect(reimported.tokenInfo?.total_tokens).toBe(150);
    });

    it('should preserve approved commands through export/import', () => {
      state.addApprovedCommand('npm install');
      state.addApprovedCommand('git commit');
      state.addApprovedCommand('docker build');

      const exported = state.export();
      const imported = SessionState.import(exported);

      expect(imported.isCommandApproved('npm install')).toBe(true);
      expect(imported.isCommandApproved('git commit')).toBe(true);
      expect(imported.isCommandApproved('docker build')).toBe(true);
    });

    it('should preserve rate limits through export/import', () => {
      state.updateRateLimits({
        limit_requests: 1000,
        remaining_requests: 950,
        limit_tokens: 100000,
        remaining_tokens: 95000,
      });

      const exported = state.export();
      const imported = SessionState.import(exported);

      const reimported = imported.export();
      expect(reimported.latestRateLimits?.remaining_requests).toBe(950);
      expect(reimported.latestRateLimits?.remaining_tokens).toBe(95000);
    });

    it('should handle complete state export/import', () => {
      // Populate all fields
      state.recordItems([
        { role: 'user' as const, content: 'Test', timestamp: Date.now() },
      ]);
      state.addTokenUsage(200);
      state.updateRateLimits({ remaining_requests: 500 });
      state.addApprovedCommand('test-command');

      const exported = state.export();
      const imported = SessionState.import(exported);
      const reimported = imported.export();

      expect(reimported.history.items.length).toBe(1);
      expect(reimported.tokenInfo?.total_tokens).toBe(200);
      expect(reimported.latestRateLimits?.remaining_requests).toBe(500);
      expect(reimported.approvedCommands).toContain('test-command');
    });
  });

  describe('Deep Copy Isolation', () => {
    it('should create independent session copies', async () => {
      const session1 = new Session(false);
      await session1.initialize();

      await session1.addToHistory({
        timestamp: Date.now(),
        text: 'Original',
        type: 'user',
      });

      const exported = session1.export();
      const session2 = Session.import(exported);

      // Modify session2
      await session2.addToHistory({
        timestamp: Date.now(),
        text: 'Modified',
        type: 'user',
      });

      // Verify session1 unchanged
      expect(session1.getMessageCount()).toBe(1);
      expect(session2.getMessageCount()).toBe(2);
    });

    it('should create independent state copies', () => {
      const state1 = new SessionState();
      state1.recordItems([
        { role: 'user' as const, content: 'Original', timestamp: Date.now() },
      ]);

      const state2 = state1.deepCopy();

      state2.recordItems([
        { role: 'user' as const, content: 'Modified', timestamp: Date.now() },
      ]);

      expect(state1.historySnapshot().length).toBe(1);
      expect(state2.historySnapshot().length).toBe(2);
    });

    it('should isolate approved commands in copies', () => {
      const state1 = new SessionState();
      state1.addApprovedCommand('cmd1');

      const state2 = state1.deepCopy();
      state2.addApprovedCommand('cmd2');

      expect(state1.isCommandApproved('cmd1')).toBe(true);
      expect(state1.isCommandApproved('cmd2')).toBe(false);

      expect(state2.isCommandApproved('cmd1')).toBe(true);
      expect(state2.isCommandApproved('cmd2')).toBe(true);
    });
  });

  describe('Serialization Edge Cases', () => {
    it('should handle undefined optional fields', () => {
      const state = new SessionState();
      const exported = state.export();

      // No token info, no rate limits
      expect(exported.tokenInfo).toBeUndefined();
      expect(exported.latestRateLimits).toBeUndefined();

      // Should import without errors
      const imported = SessionState.import(exported);
      expect(imported).toBeDefined();
    });

    it('should handle special characters in content', async () => {
      const session = new Session(false);
      await session.initialize();

      const specialText = 'Test with\nnewlines\tand\ttabs and "quotes" and \'apostrophes\'';

      await session.addToHistory({
        timestamp: Date.now(),
        text: specialText,
        type: 'user',
      });

      const exported = session.export();
      const imported = Session.import(exported);

      const history = imported.getConversationHistory();
      const content = history.items[0].content;

      expect(typeof content === 'string' && content.includes('newlines')).toBe(
        true
      );
    });

    it('should handle very long content', async () => {
      const session = new Session(false);
      await session.initialize();

      const longText = 'x'.repeat(10000);

      await session.addToHistory({
        timestamp: Date.now(),
        text: longText,
        type: 'user',
      });

      const exported = session.export();
      const imported = Session.import(exported);

      expect(imported.getMessageCount()).toBe(1);
    });

    it('should handle timestamps correctly', async () => {
      const session = new Session(false);
      await session.initialize();

      const timestamp = Date.now();

      await session.addToHistory({
        timestamp,
        text: 'Test',
        type: 'user',
      });

      const exported = session.export();
      const imported = Session.import(exported);

      const history = imported.getConversationHistory();
      expect(history.items[0].timestamp).toBe(timestamp);
    });
  });

  describe('Migration Compatibility', () => {
    it('should handle export format from current Session', async () => {
      // This test ensures new SessionState can import from current Session export format
      const session = new Session(false);
      await session.initialize();

      await session.addToHistory({
        timestamp: Date.now(),
        text: 'Test message',
        type: 'user',
      });

      const exported = session.export();

      // Verify export has expected structure
      expect(exported).toHaveProperty('id');
      expect(exported).toHaveProperty('state');
      expect(exported).toHaveProperty('metadata');

      // Should be importable
      const imported = Session.import(exported);
      expect(imported.getMessageCount()).toBeGreaterThan(0);
    });
  });
});
