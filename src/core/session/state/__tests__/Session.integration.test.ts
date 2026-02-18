/**
 * Session integration tests
 * Tests the refactored Session class to ensure backward compatibility
 * Tests must fail until Session refactoring is complete (TDD)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Session } from '../../../Session';
import type { InputItem } from '../../../protocol/types';

describe('Session Integration (Refactored)', () => {
  let session: Session;

  beforeEach(async () => {
    // Create non-persistent session for testing
    session = new Session(false);
    await session.initialize();
  });

  describe('Initialization', () => {
    it('should initialize with default state', async () => {
      const newSession = new Session(false);
      await newSession.initialize();

      expect(newSession.getSessionId()).toBeDefined();
      expect(newSession.getSessionId().length).toBeGreaterThan(0);
      expect(newSession.isEmpty()).toBe(true);
      expect(newSession.getMessageCount()).toBe(0);
    });

    it('should initialize with persistent storage', async () => {
      const persistentSession = new Session(true);
      await persistentSession.initialize();

      expect(persistentSession.getSessionId()).toBeDefined();
    });
  });

  describe('History Management (State Delegation)', () => {
    it('should record input items', async () => {
      const items: InputItem[] = [
        { type: 'text', text: 'Hello, world!' },
      ];

      await session.recordInput(items);

      expect(session.isEmpty()).toBe(false);
      expect(session.getMessageCount()).toBeGreaterThan(0);
    });

    it('should get conversation history', async () => {
      await session.addToHistory({
        timestamp: Date.now(),
        text: 'Test message',
        type: 'user',
      });

      const history = session.getConversationHistory();

      expect(history).toBeDefined();
      expect(history.items).toBeDefined();
      expect(history.items.length).toBeGreaterThan(0);
    });

    it('should track message count', async () => {
      const initialCount = session.getMessageCount();

      await session.addToHistory({
        timestamp: Date.now(),
        text: 'Message 1',
        type: 'user',
      });

      await session.addToHistory({
        timestamp: Date.now(),
        text: 'Message 2',
        type: 'agent',
      });

      expect(session.getMessageCount()).toBe(initialCount + 2);
    });

    it('should clear history', async () => {
      await session.addToHistory({
        timestamp: Date.now(),
        text: 'Test',
        type: 'user',
      });

      session.clearHistory();

      expect(session.isEmpty()).toBe(true);
      expect(session.getMessageCount()).toBe(0);
    });

    it('should get last message', async () => {
      await session.addToHistory({
        timestamp: Date.now(),
        text: 'First',
        type: 'user',
      });

      await session.addToHistory({
        timestamp: Date.now(),
        text: 'Last',
        type: 'agent',
      });

      const lastMessage = session.getLastMessage();
      expect(lastMessage).toBeDefined();
    });

    it('should filter messages by type', async () => {
      await session.addToHistory({
        timestamp: Date.now(),
        text: 'User message',
        type: 'user',
      });

      await session.addToHistory({
        timestamp: Date.now(),
        text: 'Agent message',
        type: 'agent',
      });

      const userMessages = session.getMessagesByType('user');
      const agentMessages = session.getMessagesByType('agent');

      expect(userMessages.length).toBeGreaterThan(0);
      expect(agentMessages.length).toBeGreaterThan(0);
    });
  });

  describe('Export/Import (State Preservation)', () => {
    it('should export session state', async () => {
      await session.addToHistory({
        timestamp: Date.now(),
        text: 'Test message',
        type: 'user',
      });

      const exported = session.export();

      expect(exported).toBeDefined();
      expect(exported.id).toBe(session.getSessionId());
      expect(exported.state).toBeDefined();
      expect(exported.metadata).toBeDefined();
    });

    it('should import session state', async () => {
      await session.addToHistory({
        timestamp: Date.now(),
        text: 'Original message',
        type: 'user',
      });

      const exported = session.export();
      const imported = Session.import(exported);

      expect(imported.getSessionId()).toBe(session.getSessionId());
      expect(imported.getMessageCount()).toBe(session.getMessageCount());
    });

    it('should preserve history through export/import', async () => {
      await session.addToHistory({
        timestamp: Date.now(),
        text: 'Message 1',
        type: 'user',
      });

      await session.addToHistory({
        timestamp: Date.now(),
        text: 'Message 2',
        type: 'agent',
      });

      const exported = session.export();
      const imported = Session.import(exported);

      const originalHistory = session.getConversationHistory();
      const importedHistory = imported.getConversationHistory();

      expect(importedHistory.items.length).toBe(originalHistory.items.length);
    });

    it('should preserve message count through export/import', async () => {
      const exported = session.export();
      const imported = Session.import(exported);

      expect(imported.getMessageCount()).toBe(session.getMessageCount());
    });
  });

  describe('Turn Context Management', () => {
    it('should get turn context', () => {
      const context = session.getTurnContext();

      expect(context).toBeDefined();
      expect(context.getApprovalPolicy()).toBeDefined();
    });

    it('should update turn context', () => {
      session.updateTurnContext({ model: 'gpt-4' });

      const context = session.getTurnContext();
      expect(context.getModel()).toBe('gpt-4');
    });

    it('should preserve unchanged context fields', () => {
      const originalPolicy = session.getTurnContext().getApprovalPolicy();

      session.updateTurnContext({ model: 'new-model' });

      const newContext = session.getTurnContext();
      expect(newContext.getModel()).toBe('new-model');
      expect(newContext.getApprovalPolicy()).toBe(originalPolicy);
    });
  });

  describe('Current Turn Management', () => {
    it('should set and get current turn items', () => {
      const items: InputItem[] = [
        { type: 'text', text: 'Turn item' },
      ];

      session.setCurrentTurnItems(items);

      const retrieved = session.getCurrentTurnItems();
      expect(retrieved).toEqual(items);
    });

    it('should clear current turn', () => {
      const items: InputItem[] = [
        { type: 'text', text: 'Turn item' },
      ];

      session.setCurrentTurnItems(items);
      session.clearCurrentTurn();

      const retrieved = session.getCurrentTurnItems();
      expect(retrieved).toEqual([]);
    });
  });

  describe('Event Emission', () => {
    it('should set event emitter', () => {
      const emitter = vi.fn();

      session.setEventEmitter(emitter);

      // Verify emitter is set (will test actual emission in other tests)
      expect(() => session.setEventEmitter(emitter)).not.toThrow();
    });

    it('should emit events when emitter is set', async () => {
      const emitter = vi.fn().mockResolvedValue(undefined);

      session.setEventEmitter(emitter);

      const event = {
        id: 'test-event',
        msg: { type: 'AgentMessage', data: { message: 'Test' } },
      } as any;

      await session.emitEvent(event);

      expect(emitter).toHaveBeenCalledWith(event);
    });

    it('should not throw when emitting without emitter', async () => {
      const event = {
        id: 'test-event',
        msg: { type: 'AgentMessage', data: { message: 'Test' } },
      } as any;

      await expect(session.emitEvent(event)).resolves.not.toThrow();
    });
  });

  describe('Backward Compatibility', () => {
    it('should maintain all existing public methods', () => {
      // Verify all expected methods exist
      expect(typeof session.initialize).toBe('function');
      expect(typeof session.getSessionId).toBe('function');
      expect(typeof session.getConversationHistory).toBe('function');
      expect(typeof session.addToHistory).toBe('function');
      expect(typeof session.recordInput).toBe('function');
      expect(typeof session.getTurnContext).toBe('function');
      expect(typeof session.updateTurnContext).toBe('function');
      expect(typeof session.setCurrentTurnItems).toBe('function');
      expect(typeof session.getCurrentTurnItems).toBe('function');
      expect(typeof session.clearCurrentTurn).toBe('function');
      expect(typeof session.clearHistory).toBe('function');
      expect(typeof session.getMessageCount).toBe('function');
      expect(typeof session.isEmpty).toBe('function');
      expect(typeof session.getLastMessage).toBe('function');
      expect(typeof session.getMessagesByType).toBe('function');
      expect(typeof session.export).toBe('function');
      expect(typeof session.setEventEmitter).toBe('function');
      expect(typeof session.emitEvent).toBe('function');
    });

    it('should maintain export format compatibility', async () => {
      const exported = session.export();

      // Verify export has expected structure
      expect(exported).toHaveProperty('id');
      expect(exported).toHaveProperty('state');
      expect(exported).toHaveProperty('metadata');
      expect(exported.metadata).toHaveProperty('created');
      expect(exported.metadata).toHaveProperty('lastAccessed');
      expect(exported.metadata).toHaveProperty('messageCount');
    });
  });
});
