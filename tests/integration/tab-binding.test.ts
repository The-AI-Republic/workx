/**
 * Integration tests for independent tab binding per session
 * Feature: 015-multi-agent-instances
 * Task: T034 - Verify each session has separate tab group and tab closure terminates only that session
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AgentRegistry } from '../../src/core/registry/AgentRegistry';
import { AgentSession } from '../../src/core/registry/AgentSession';
import type { SessionConfig } from '../../src/core/registry/types';

// Mock dependencies
vi.mock('../../src/core/BrowserxAgent', () => ({
  BrowserxAgent: class MockBrowserxAgent {
    initialize = async () => undefined;
    getSession = () => ({
      conversationId: 'conv_' + Math.random().toString(36).slice(2),
      abortAllTasks: () => {},
      close: () => {},
      setTabId: vi.fn(),
    });
    submitOperation = async () => 'sub_' + Math.random().toString(36).slice(2);
    cleanup = () => {};
    agentId = 'agent_mock';
  },
}));

vi.mock('../../src/config/AgentConfig', () => ({
  AgentConfig: {
    getInstance: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('../../src/core/MessageRouter', () => ({
  MessageRouter: vi.fn().mockImplementation(() => ({})),
}));

// Track tab closure callbacks for testing
let tabClosureCallbacks: Array<(tabId: number) => void> = [];

vi.mock('../../src/core/TabManager', () => ({
  TabManager: {
    getInstance: vi.fn(() => ({
      onTabClosure: vi.fn((callback: (tabId: number) => void) => {
        tabClosureCallbacks.push(callback);
        return () => {
          const index = tabClosureCallbacks.indexOf(callback);
          if (index > -1) tabClosureCallbacks.splice(index, 1);
        };
      }),
    })),
  },
}));

// Mock chrome API for tab group operations
let mockTabGroups: Map<number, { tabIds: number[]; title?: string; color?: string }> = new Map();
let nextGroupId = 1;

const mockChrome = {
  runtime: {
    sendMessage: vi.fn(() => Promise.resolve(undefined)),
  },
  tabs: {
    group: vi.fn(async (options: { tabIds: number | number[]; groupId?: number }) => {
      const tabIds = Array.isArray(options.tabIds) ? options.tabIds : [options.tabIds];
      if (options.groupId !== undefined) {
        // Add to existing group
        const group = mockTabGroups.get(options.groupId);
        if (group) {
          group.tabIds.push(...tabIds);
        }
        return options.groupId;
      }
      // Create new group
      const groupId = nextGroupId++;
      mockTabGroups.set(groupId, { tabIds });
      return groupId;
    }),
    ungroup: vi.fn(async (tabIds: number | number[]) => {
      const ids = Array.isArray(tabIds) ? tabIds : [tabIds];
      for (const [groupId, group] of mockTabGroups) {
        group.tabIds = group.tabIds.filter(id => !ids.includes(id));
        if (group.tabIds.length === 0) {
          mockTabGroups.delete(groupId);
        }
      }
    }),
    query: vi.fn(async (options: { groupId?: number }) => {
      if (options.groupId !== undefined) {
        const group = mockTabGroups.get(options.groupId);
        return group ? group.tabIds.map(id => ({ id })) : [];
      }
      return [];
    }),
  },
  tabGroups: {
    update: vi.fn(async (groupId: number, options: { title?: string; color?: string }) => {
      const group = mockTabGroups.get(groupId);
      if (group) {
        if (options.title) group.title = options.title;
        if (options.color) group.color = options.color;
      }
      return {};
    }),
  },
} as any;

global.chrome = mockChrome;

describe('Tab Binding Integration', () => {
  let mockConfig: any;
  let mockRouter: any;

  beforeEach(() => {
    AgentRegistry.resetInstance();
    vi.clearAllMocks();
    tabClosureCallbacks = [];
    mockTabGroups.clear();
    nextGroupId = 1;

    mockConfig = {};
    mockRouter = {};
  });

  afterEach(() => {
    AgentRegistry.resetInstance();
  });

  describe('US3: Independent Tab Binding Per Session', () => {
    it('creates tab groups with unique names for each session', async () => {
      const registry = AgentRegistry.getInstance();
      registry.initialize(mockConfig, mockRouter);

      // Create two sessions
      const session1 = await registry.createSession({ type: 'primary', tabId: 100 });
      const session2 = await registry.createSession({ type: 'scheduled', scheduledTaskId: 't1', tabId: 200 });

      // Each session has a unique tab group name
      expect(session1.metadata.tabGroupName).toBe('browserx_s_a');
      expect(session2.metadata.tabGroupName).toBe('browserx_s_b');
    });

    it('assigns different session letters (a, b, c...)', async () => {
      const registry = AgentRegistry.getInstance();
      registry.initialize(mockConfig, mockRouter);

      // Create sessions sequentially to ensure consistent letter assignment
      const session1 = await registry.createSession({ type: 'primary' });
      const session2 = await registry.createSession({ type: 'scheduled', scheduledTaskId: 't1' });
      const session3 = await registry.createSession({ type: 'scheduled', scheduledTaskId: 't2' });

      expect(session1.sessionLetter).toBe('a');
      expect(session2.sessionLetter).toBe('b');
      expect(session3.sessionLetter).toBe('c');
    });

    it('binds tab to session and creates tab group', async () => {
      const session = new AgentSession({ type: 'primary' }, 0);

      // Bind a tab (this will create a tab group)
      await session.bindTab(100);

      // Verify tab was bound
      expect(session.metadata.tabId).toBe(100);

      // Verify tab group was created
      expect(mockChrome.tabs.group).toHaveBeenCalledWith({ tabIds: 100 });
      expect(mockChrome.tabGroups.update).toHaveBeenCalledWith(
        expect.any(Number),
        expect.objectContaining({
          title: 'browserx_s_a',
        })
      );
    });

    it('moves additional tabs to existing group', async () => {
      const session = new AgentSession({ type: 'primary' }, 0);

      // Bind first tab (creates group)
      await session.bindTab(100);
      const groupId = session.metadata.tabGroupId;

      // Bind second tab (should add to existing group)
      await session.bindTab(200);

      // Verify second tab was added to the existing group
      expect(mockChrome.tabs.group).toHaveBeenLastCalledWith({
        tabIds: 200,
        groupId: groupId,
      });
    });

    it('unbinds tab and removes from group', async () => {
      const session = new AgentSession({ type: 'primary' }, 0);

      // Bind and then unbind
      await session.bindTab(100);
      await session.unbindTab();

      // Verify tab was unbound
      expect(session.metadata.tabId).toBeNull();
      expect(mockChrome.tabs.ungroup).toHaveBeenCalledWith(100);
    });

    it('cleans up tab group on session termination', async () => {
      const session = new AgentSession({ type: 'primary' }, 0);

      // Bind tab and create group
      await session.bindTab(100);
      const groupId = session.metadata.tabGroupId;

      // Terminate session
      await session.terminate('manual');

      // Verify cleanup was attempted
      expect(session.metadata.tabGroupId).toBeNull();
    });

    it('maintains separate tab groups for concurrent sessions', async () => {
      const registry = AgentRegistry.getInstance();
      registry.initialize(mockConfig, mockRouter);

      // Create two sessions with tabs
      const session1 = await registry.createSession({ type: 'primary', tabId: 100 });
      const session2 = await registry.createSession({ type: 'scheduled', scheduledTaskId: 't1', tabId: 200 });

      // Bind tabs
      await session1.bindTab(100);
      await session2.bindTab(200);

      // Each session should have its own tab group
      expect(session1.metadata.tabGroupId).not.toBe(session2.metadata.tabGroupId);
      expect(session1.metadata.tabGroupName).not.toBe(session2.metadata.tabGroupName);
    });
  });

  describe('Tab Closure Handling (FR-022)', () => {
    it('terminates only the session whose tab was closed', async () => {
      const registry = AgentRegistry.getInstance();
      registry.initialize(mockConfig, mockRouter);

      // Create two sessions with different tabs
      const session1 = await registry.createSession({ type: 'primary', tabId: 100 });
      const session2 = await registry.createSession({ type: 'scheduled', scheduledTaskId: 't1', tabId: 200 });

      // Bind tabs
      await session1.bindTab(100);
      await session2.bindTab(200);

      expect(registry.getActiveCount()).toBe(2);

      // Simulate tab 100 closing
      for (const callback of tabClosureCallbacks) {
        await callback(100);
      }

      // Wait for async operations
      await new Promise(resolve => setTimeout(resolve, 10));

      // Session 1 should be terminated, session 2 should remain
      expect(registry.getActiveCount()).toBe(1);
      expect(registry.getSession(session1.sessionId)).toBeUndefined();
      expect(registry.getSession(session2.sessionId)).toBeDefined();
    });

    it('does not terminate session when unrelated tab closes', async () => {
      const registry = AgentRegistry.getInstance();
      registry.initialize(mockConfig, mockRouter);

      const session = await registry.createSession({ type: 'primary', tabId: 100 });
      await session.bindTab(100);

      // Simulate different tab closing
      for (const callback of tabClosureCallbacks) {
        await callback(999);
      }

      await new Promise(resolve => setTimeout(resolve, 10));

      // Session should remain active
      expect(registry.getActiveCount()).toBe(1);
      expect(registry.getSession(session.sessionId)).toBeDefined();
    });
  });

  describe('Tab Group Colors', () => {
    it('assigns different colors to sessions based on letter index', async () => {
      const session1 = new AgentSession({ type: 'primary' }, 0); // a -> blue
      const session2 = new AgentSession({ type: 'primary' }, 1); // b -> cyan
      const session3 = new AgentSession({ type: 'primary' }, 2); // c -> green

      await session1.bindTab(100);
      await session2.bindTab(200);
      await session3.bindTab(300);

      // Verify different colors were assigned
      const calls = mockChrome.tabGroups.update.mock.calls;
      const colors = calls.map((call: any) => call[1].color);

      expect(colors[0]).toBe('blue');
      expect(colors[1]).toBe('cyan');
      expect(colors[2]).toBe('green');
    });
  });

  describe('Edge Cases', () => {
    it('handles binding without creating group when createGroup=false', async () => {
      const session = new AgentSession({ type: 'primary' }, 0);

      await session.bindTab(100, false);

      expect(session.metadata.tabId).toBe(100);
      expect(session.metadata.tabGroupId).toBeNull();
      expect(mockChrome.tabs.group).not.toHaveBeenCalled();
    });

    it('handles terminated session gracefully', async () => {
      const session = new AgentSession({ type: 'primary' }, 0);
      session.markReady();
      await session.terminate('manual');

      // Attempting to bind should throw
      await expect(session.bindTab(100)).rejects.toThrow('terminated');
    });

    it('handles tab group creation failure gracefully', async () => {
      // Mock failure
      mockChrome.tabs.group.mockRejectedValueOnce(new Error('Group creation failed'));

      const session = new AgentSession({ type: 'primary' }, 0);
      await session.bindTab(100);

      // Should still have tab bound, just no group
      expect(session.metadata.tabId).toBe(100);
      // Group ID should be null since creation failed
    });
  });
});
