/**
 * Fresh session creation integration test
 * Tests clean session initialization with new architecture
 * Tests must fail until implementation is complete (TDD)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Session } from '../../../Session';
import { SessionState } from '../SessionState';
import { createSessionServices } from '../SessionServices';
import type { InputItem } from '../../../protocol/types';

describe('Fresh Session Creation', () => {
  describe('Session Creation', () => {
    it('should create session with default constructor', async () => {
      const session = new Session(false);
      await session.initialize();

      expect(session).toBeDefined();
      expect(session.getSessionId().length).toBeGreaterThan(0);
    });

    it('should create session with SessionServices', async () => {
      const services = await createSessionServices({}, false);
      const session = new Session(false);
      await session.initialize();

      expect(session).toBeDefined();
    });

    it('should start with clean state', async () => {
      const session = new Session(false);
      await session.initialize();

      expect(session.isEmpty()).toBe(true);
      expect(session.getMessageCount()).toBe(0);

      const history = session.getConversationHistory();
      expect(history.items).toHaveLength(0);
    });

    it('should start with no active turn', async () => {
      const session = new Session(false);
      await session.initialize();

      const currentTurn = session.getCurrentTurnItems();
      expect(currentTurn).toEqual([]);
    });

    it('should have default turn context', async () => {
      const session = new Session(false);
      await session.initialize();

      const context = session.getTurnContext();

      expect(context).toBeDefined();
      expect(context.cwd).toBeDefined();
      expect(context.approval_policy).toBeDefined();
    });
  });

  describe('SessionState Creation', () => {
    it('should create empty SessionState', () => {
      const state = new SessionState();

      const snapshot = state.historySnapshot();
      expect(snapshot).toEqual([]);

      const exported = state.export();
      expect(exported.history.items).toHaveLength(0);
      expect(exported.approvedCommands).toEqual([]);
      expect(exported.tokenInfo).toBeUndefined();
      expect(exported.latestRateLimits).toBeUndefined();
    });

    it('should create independent SessionState instances', () => {
      const state1 = new SessionState();
      const state2 = new SessionState();

      state1.recordItems([
        { role: 'user' as const, content: 'Test', timestamp: Date.now() },
      ]);

      expect(state1.historySnapshot()).toHaveLength(1);
      expect(state2.historySnapshot()).toHaveLength(0);
    });
  });

  describe('First Turn', () => {
    let session: Session;

    beforeEach(async () => {
      session = new Session(false);
      await session.initialize();
    });

    it('should record first user input', async () => {
      const items: InputItem[] = [
        { type: 'text', text: 'Hello, this is my first message!' },
      ];

      await session.recordInput(items);

      expect(session.isEmpty()).toBe(false);
    });

    it('should add first history entry', async () => {
      await session.addToHistory({
        timestamp: Date.now(),
        text: 'First message',
        type: 'user',
      });

      const history = session.getConversationHistory();
      expect(history.items).toHaveLength(1);
      expect(session.getMessageCount()).toBe(1);
    });

    it('should handle first turn with response', async () => {
      await session.addToHistory({
        timestamp: Date.now(),
        text: 'User: Hello',
        type: 'user',
      });

      await session.addToHistory({
        timestamp: Date.now(),
        text: 'Agent: Hi there!',
        type: 'agent',
      });

      expect(session.getMessageCount()).toBe(2);
    });
  });

  describe('Export Format', () => {
    it('should export fresh session with correct structure', async () => {
      const session = new Session(false);
      await session.initialize();

      const exported = session.export();

      // Verify structure
      expect(exported).toHaveProperty('id');
      expect(exported).toHaveProperty('state');
      expect(exported).toHaveProperty('metadata');

      // Verify state structure
      expect(exported.state).toHaveProperty('history');
      expect(exported.state).toHaveProperty('approvedCommands');

      // Verify metadata structure
      expect(exported.metadata).toHaveProperty('created');
      expect(exported.metadata).toHaveProperty('lastAccessed');
      expect(exported.metadata).toHaveProperty('messageCount');
    });

    it('should export fresh state with correct structure', () => {
      const state = new SessionState();
      const exported = state.export();

      expect(exported).toHaveProperty('history');
      expect(exported).toHaveProperty('approvedCommands');
      expect(exported.history).toHaveProperty('items');

      expect(Array.isArray(exported.history.items)).toBe(true);
      expect(Array.isArray(exported.approvedCommands)).toBe(true);
    });

    it('should have empty arrays for fresh session', async () => {
      const session = new Session(false);
      await session.initialize();

      const exported = session.export();

      expect(exported.state.history.items).toEqual([]);
      expect(exported.state.approvedCommands).toEqual([]);
      expect(exported.metadata.messageCount).toBe(0);
    });
  });

  describe('Initialization Options', () => {
    it('should create non-persistent session', async () => {
      const session = new Session(false);
      await session.initialize();

      expect(session).toBeDefined();
      expect(session.getSessionId()).toBeDefined();
    });

    it('should create persistent session', async () => {
      const session = new Session(true);
      await session.initialize();

      expect(session).toBeDefined();
      expect(session.getSessionId()).toBeDefined();
    });
  });

  describe('Service Configuration', () => {
    it('should create services with defaults', async () => {
      const services = await createSessionServices({}, false);

      expect(services).toBeDefined();
      expect(services.notifier).toBeDefined();
      expect(typeof services.showRawAgentReasoning).toBe('boolean');
    });

    it('should create services in test mode', async () => {
      const services = await createSessionServices({}, true);

      expect(services).toBeDefined();
      expect(services.notifier).toBeDefined();
    });

    it('should create services with custom config', async () => {
      const services = await createSessionServices(
        {
          showRawAgentReasoning: true,
        },
        false
      );

      expect(services.showRawAgentReasoning).toBe(true);
    });
  });

  describe('Multiple Fresh Sessions', () => {
    it('should create multiple independent sessions', async () => {
      const session1 = new Session(false);
      const session2 = new Session(false);

      await session1.initialize();
      await session2.initialize();

      expect(session1.getSessionId()).not.toBe(session2.getSessionId());

      await session1.addToHistory({
        timestamp: Date.now(),
        text: 'Session 1 message',
        type: 'user',
      });

      expect(session1.getMessageCount()).toBe(1);
      expect(session2.getMessageCount()).toBe(0);
    });

    it('should isolate session states', async () => {
      const session1 = new Session(false);
      const session2 = new Session(false);

      await session1.initialize();
      await session2.initialize();

      session1.updateTurnContext({ model: 'gpt-4' });
      session2.updateTurnContext({ model: 'gpt-3.5' });

      expect(session1.getTurnContext().model).toBe('gpt-4');
      expect(session2.getTurnContext().model).toBe('gpt-3.5');
    });
  });

  describe('Memory and Performance', () => {
    it('should create sessions efficiently', async () => {
      const startTime = Date.now();
      const sessions: Session[] = [];

      for (let i = 0; i < 10; i++) {
        const session = new Session(false);
        await session.initialize();
        sessions.push(session);
      }

      const elapsed = Date.now() - startTime;

      // Should create 10 sessions quickly (< 500ms)
      expect(elapsed).toBeLessThan(500);
      expect(sessions).toHaveLength(10);
    });

    it('should have minimal memory footprint for empty session', async () => {
      const session = new Session(false);
      await session.initialize();

      const exported = session.export();
      const serialized = JSON.stringify(exported);

      // Fresh session export should be small (< 1KB)
      expect(serialized.length).toBeLessThan(1024);
    });
  });

  describe('Immediate Operations', () => {
    it('should support operations immediately after creation', async () => {
      const session = new Session(false);
      await session.initialize();

      // Should be able to perform all operations right away
      await expect(
        session.recordInput([{ type: 'text', text: 'Test' }])
      ).resolves.not.toThrow();

      await expect(
        session.addToHistory({
          timestamp: Date.now(),
          text: 'Test',
          type: 'user',
        })
      ).resolves.not.toThrow();

      expect(() => session.getTurnContext()).not.toThrow();
      expect(() => session.getConversationHistory()).not.toThrow();
      expect(() => session.export()).not.toThrow();
    });
  });

  describe('Cleanup', () => {
    it('should handle session disposal gracefully', async () => {
      const session = new Session(false);
      await session.initialize();

      await session.addToHistory({
        timestamp: Date.now(),
        text: 'Test',
        type: 'user',
      });

      // Clear state
      session.clearHistory();
      session.clearCurrentTurn();

      expect(session.isEmpty()).toBe(true);
      expect(session.getCurrentTurnItems()).toEqual([]);
    });
  });
});
