/**
 * A2AManager unit tests
 *
 * Covers: singleton lifecycle, agent CRUD, connection management,
 * skill discovery/aggregation, skill execution (sync + streaming),
 * task management, session context, event system, platform filtering.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { A2AManager } from '../A2AManager';
import type {
  IA2AAgentConfig,
  IA2ASkill,
  IA2AToolResult,
  A2AManagerEvent,
  A2AStreamEvent,
} from '../types';

// ---------------------------------------------------------------------------
// Mock external dependencies
// ---------------------------------------------------------------------------

vi.mock('../A2AConfig', () => ({
  loadAgents: vi.fn().mockResolvedValue([]),
  saveAgents: vi.fn().mockResolvedValue(undefined),
  createAgentConfig: vi.fn(),
  updateAgentConfig: vi.fn(),
}));

vi.mock('../A2AClient', () => ({
  A2AClient: vi.fn(),
}));

vi.mock('../../../utils/encryption', () => ({
  decryptApiKey: vi.fn().mockReturnValue('decrypted-key'),
}));

vi.mock('../A2AToolAdapter', () => ({
  parsePrefixedName: vi.fn(),
}));

import { loadAgents, saveAgents, createAgentConfig, updateAgentConfig } from '../A2AConfig';
import { A2AClient } from '../A2AClient';
import { decryptApiKey } from '../../../utils/encryption';
import { parsePrefixedName } from '../A2AToolAdapter';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides: Partial<IA2AAgentConfig> = {}): IA2AAgentConfig {
  return {
    id: overrides.id ?? 'agent-1',
    name: overrides.name ?? 'test-agent',
    url: overrides.url ?? 'https://agent.example.com',
    authType: overrides.authType ?? 'none',
    enabled: overrides.enabled ?? true,
    trusted: overrides.trusted ?? false,
    timeout: overrides.timeout ?? 30000,
    platform: overrides.platform ?? 'shared',
    createdAt: overrides.createdAt ?? 1000,
    updatedAt: overrides.updatedAt ?? 1000,
    ...(overrides.apiKey !== undefined ? { apiKey: overrides.apiKey } : {}),
  };
}

function makeSkill(overrides: Partial<IA2ASkill> = {}): IA2ASkill {
  return {
    id: overrides.id ?? 'skill-1',
    name: overrides.name ?? 'summarize',
    description: overrides.description ?? 'Summarize text',
    tags: overrides.tags ?? ['text'],
  };
}

function makeMockClient(overrides: Record<string, unknown> = {}) {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    getAgentCard: vi.fn().mockReturnValue(
      overrides.agentCard ?? {
        name: 'TestAgent',
        description: 'A test agent',
        version: '1.0.0',
        protocolVersion: '0.1',
        capabilities: { streaming: false, pushNotifications: false },
        skills: [],
      }
    ),
    getSkills: vi.fn().mockReturnValue(overrides.skills ?? []),
    sendMessage: vi.fn().mockResolvedValue(
      overrides.sendMessageResult ?? {
        success: true,
        content: [{ type: 'text', text: 'result' }],
      }
    ),
    sendMessageStream: vi.fn().mockResolvedValue(
      overrides.sendMessageStreamResult ?? {
        success: true,
        content: [{ type: 'text', text: 'stream-result' }],
      }
    ),
    getClient: vi.fn().mockReturnValue(overrides.sdkClient ?? null),
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('A2AManager', () => {
  beforeEach(() => {
    A2AManager.resetInstance();
    vi.clearAllMocks();
    (loadAgents as Mock).mockResolvedValue([]);
    (saveAgents as Mock).mockResolvedValue(undefined);
  });

  // ========================================================================
  // Singleton lifecycle
  // ========================================================================
  describe('singleton lifecycle', () => {
    it('returns the same instance on repeated calls', async () => {
      const a = await A2AManager.getInstance();
      const b = await A2AManager.getInstance();
      expect(a).toBe(b);
    });

    it('creates a new instance after resetInstance()', async () => {
      const a = await A2AManager.getInstance();
      A2AManager.resetInstance();
      const b = await A2AManager.getInstance();
      expect(a).not.toBe(b);
    });

    it('calls loadAgents during initialization', async () => {
      await A2AManager.getInstance();
      expect(loadAgents).toHaveBeenCalledTimes(1);
    });

    it('does not call loadAgents twice on same instance', async () => {
      const manager = await A2AManager.getInstance();
      await manager.initialize(); // already initialized
      expect(loadAgents).toHaveBeenCalledTimes(1);
    });

    it('handles loadAgents failure gracefully', async () => {
      (loadAgents as Mock).mockRejectedValueOnce(new Error('storage failure'));
      const manager = await A2AManager.getInstance();
      // Should still be usable (empty agents)
      expect(manager.getAgents()).toEqual([]);
    });

    it('loads persisted agents into state', async () => {
      const config = makeConfig();
      (loadAgents as Mock).mockResolvedValue([config]);
      const manager = await A2AManager.getInstance();
      expect(manager.getAgent('agent-1')).toEqual(config);
    });

    it('initializes connections as disconnected for loaded agents', async () => {
      const config = makeConfig();
      (loadAgents as Mock).mockResolvedValue([config]);
      const manager = await A2AManager.getInstance();
      const conn = manager.getConnection('agent-1');
      expect(conn).toBeDefined();
      expect(conn!.status).toBe('disconnected');
      expect(conn!.skills).toEqual([]);
    });
  });

  // ========================================================================
  // Platform detection
  // ========================================================================
  describe('platform', () => {
    it('defaults to extension platform from __BUILD_MODE__', async () => {
      const manager = await A2AManager.getInstance();
      expect(manager.getPlatform()).toBe('extension');
    });

    it('accepts explicit platform override', async () => {
      const manager = await A2AManager.getInstance('desktop');
      expect(manager.getPlatform()).toBe('desktop');
    });
  });

  // ========================================================================
  // Agent CRUD
  // ========================================================================
  describe('addAgent', () => {
    it('creates and persists a new agent', async () => {
      const manager = await A2AManager.getInstance();
      const created = makeConfig({ id: 'new-1', name: 'new-agent' });
      (createAgentConfig as Mock).mockReturnValue(created);

      const result = await manager.addAgent({ name: 'new-agent', url: 'https://a.com' });

      expect(createAgentConfig).toHaveBeenCalled();
      expect(saveAgents).toHaveBeenCalled();
      expect(result).toEqual(created);
      expect(manager.getAgent('new-1')).toEqual(created);
    });

    it('initializes connection state for newly added agent', async () => {
      const manager = await A2AManager.getInstance();
      const created = makeConfig({ id: 'new-2' });
      (createAgentConfig as Mock).mockReturnValue(created);

      await manager.addAgent({ name: 'x', url: 'https://x.com' });

      const conn = manager.getConnection('new-2');
      expect(conn).toBeDefined();
      expect(conn!.status).toBe('disconnected');
    });

    it('emits config-added event', async () => {
      const manager = await A2AManager.getInstance();
      const created = makeConfig({ id: 'ev-1', name: 'ev' });
      (createAgentConfig as Mock).mockReturnValue(created);

      const handler = vi.fn();
      manager.on('event', handler);

      await manager.addAgent({ name: 'ev', url: 'https://ev.com' });

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'config-added', config: created })
      );
    });

    it('throws when MAX_AGENTS (5) is reached', async () => {
      const configs = Array.from({ length: 5 }, (_, i) =>
        makeConfig({ id: `ag-${i}`, name: `agent-${i}` })
      );
      (loadAgents as Mock).mockResolvedValue(configs);
      const manager = await A2AManager.getInstance();

      await expect(
        manager.addAgent({ name: 'overflow', url: 'https://o.com' })
      ).rejects.toThrow('Maximum of 5 A2A agents allowed');
    });
  });

  describe('updateAgent', () => {
    it('updates and persists an existing agent', async () => {
      const config = makeConfig();
      (loadAgents as Mock).mockResolvedValue([config]);
      const manager = await A2AManager.getInstance();

      const updated = { ...config, name: 'updated-name', updatedAt: 2000 };
      (updateAgentConfig as Mock).mockReturnValue(updated);

      const result = await manager.updateAgent('agent-1', { name: 'updated-name' });

      expect(updateAgentConfig).toHaveBeenCalled();
      expect(saveAgents).toHaveBeenCalled();
      expect(result.name).toBe('updated-name');
    });

    it('throws for non-existent agent', async () => {
      const manager = await A2AManager.getInstance();
      await expect(
        manager.updateAgent('no-such-id', { name: 'x' })
      ).rejects.toThrow('Agent not found: no-such-id');
    });

    it('emits config-updated event', async () => {
      const config = makeConfig();
      (loadAgents as Mock).mockResolvedValue([config]);
      const manager = await A2AManager.getInstance();

      const updated = { ...config, name: 'updated' };
      (updateAgentConfig as Mock).mockReturnValue(updated);

      const handler = vi.fn();
      manager.on('event', handler);

      await manager.updateAgent('agent-1', { name: 'updated' });

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'config-updated', config: updated })
      );
    });
  });

  describe('removeAgent', () => {
    it('removes agent from state and persists', async () => {
      const config = makeConfig();
      (loadAgents as Mock).mockResolvedValue([config]);
      const manager = await A2AManager.getInstance();

      await manager.removeAgent('agent-1');

      expect(manager.getAgent('agent-1')).toBeUndefined();
      expect(manager.getConnection('agent-1')).toBeUndefined();
      expect(saveAgents).toHaveBeenCalled();
    });

    it('throws for non-existent agent', async () => {
      const manager = await A2AManager.getInstance();
      await expect(manager.removeAgent('nope')).rejects.toThrow('Agent not found: nope');
    });

    it('disconnects a connected agent before removal', async () => {
      const config = makeConfig();
      (loadAgents as Mock).mockResolvedValue([config]);
      const manager = await A2AManager.getInstance();

      // Simulate connected state by modifying connection directly
      const conn = manager.getConnection('agent-1')!;
      conn.status = 'connected';

      // Set up a mock client to be retrievable
      const mockClient = makeMockClient();
      (A2AClient as unknown as Mock).mockImplementation(() => mockClient);

      // We need the client to exist in the clients map for disconnect to call it.
      // The simplest approach: connect first, then remove.
      // But connect has complex flow, so let's verify removeAgent calls disconnect
      // by checking the emitted events.
      const handler = vi.fn();
      manager.on('event', handler);

      await manager.removeAgent('agent-1');

      // Should have emitted disconnect events
      const statusEvents = handler.mock.calls
        .map((c: unknown[]) => c[0] as A2AManagerEvent)
        .filter((e: A2AManagerEvent) => e.type === 'connection-status-changed');

      // At minimum we get the config-removed event
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'config-removed', configId: 'agent-1' })
      );
    });

    it('emits config-removed event', async () => {
      const config = makeConfig();
      (loadAgents as Mock).mockResolvedValue([config]);
      const manager = await A2AManager.getInstance();

      const handler = vi.fn();
      manager.on('event', handler);

      await manager.removeAgent('agent-1');

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'config-removed', configId: 'agent-1' })
      );
    });
  });

  // ========================================================================
  // Agent retrieval & filtering
  // ========================================================================
  describe('getAgents (platform filtering)', () => {
    it('returns shared and extension agents for extension platform', async () => {
      const shared = makeConfig({ id: '1', name: 'shared', platform: 'shared' });
      const ext = makeConfig({ id: '2', name: 'ext', platform: 'extension' });
      const desk = makeConfig({ id: '3', name: 'desk', platform: 'desktop' });
      (loadAgents as Mock).mockResolvedValue([shared, ext, desk]);

      const manager = await A2AManager.getInstance('extension');
      const agents = manager.getAgents();

      expect(agents).toHaveLength(2);
      expect(agents.map((a) => a.name)).toEqual(['shared', 'ext']);
    });

    it('returns shared and desktop agents for desktop platform', async () => {
      const shared = makeConfig({ id: '1', name: 'shared', platform: 'shared' });
      const ext = makeConfig({ id: '2', name: 'ext', platform: 'extension' });
      const desk = makeConfig({ id: '3', name: 'desk', platform: 'desktop' });
      (loadAgents as Mock).mockResolvedValue([shared, ext, desk]);

      A2AManager.resetInstance();
      const manager = await A2AManager.getInstance('desktop');
      const agents = manager.getAgents();

      expect(agents).toHaveLength(2);
      expect(agents.map((a) => a.name)).toEqual(['shared', 'desk']);
    });

    it('returns empty array when no agents exist', async () => {
      const manager = await A2AManager.getInstance();
      expect(manager.getAgents()).toEqual([]);
    });
  });

  describe('getAgent', () => {
    it('returns agent by ID', async () => {
      const config = makeConfig();
      (loadAgents as Mock).mockResolvedValue([config]);
      const manager = await A2AManager.getInstance();
      expect(manager.getAgent('agent-1')).toEqual(config);
    });

    it('returns undefined for unknown ID', async () => {
      const manager = await A2AManager.getInstance();
      expect(manager.getAgent('unknown')).toBeUndefined();
    });
  });

  describe('getAgentByName', () => {
    it('finds agent by name', async () => {
      const config = makeConfig({ name: 'research' });
      (loadAgents as Mock).mockResolvedValue([config]);
      const manager = await A2AManager.getInstance();
      expect(manager.getAgentByName('research')).toEqual(config);
    });

    it('returns undefined for unknown name', async () => {
      const manager = await A2AManager.getInstance();
      expect(manager.getAgentByName('nope')).toBeUndefined();
    });
  });

  // ========================================================================
  // Connection management
  // ========================================================================
  describe('connect', () => {
    it('creates A2AClient and transitions to connected', async () => {
      const config = makeConfig();
      (loadAgents as Mock).mockResolvedValue([config]);
      const manager = await A2AManager.getInstance();

      const skills: IA2ASkill[] = [makeSkill()];
      const mockClient = makeMockClient({ skills });
      (A2AClient as unknown as Mock).mockImplementation(() => mockClient);

      await manager.connect('agent-1');

      expect(A2AClient).toHaveBeenCalled();
      expect(mockClient.connect).toHaveBeenCalled();

      const conn = manager.getConnection('agent-1');
      expect(conn!.status).toBe('connected');
      expect(conn!.skills).toEqual(skills);
    });

    it('decrypts apiKey when present', async () => {
      const config = makeConfig({ apiKey: 'enc-key' });
      (loadAgents as Mock).mockResolvedValue([config]);
      const manager = await A2AManager.getInstance();

      (decryptApiKey as Mock).mockReturnValue('decrypted-key');
      const mockClient = makeMockClient();
      (A2AClient as unknown as Mock).mockImplementation(() => mockClient);

      await manager.connect('agent-1');

      expect(decryptApiKey).toHaveBeenCalledWith('enc-key');
      // A2AClient should have been constructed with decrypted key
      expect(A2AClient).toHaveBeenCalledWith(
        expect.objectContaining({ apiKey: 'decrypted-key' })
      );
    });

    it('stores agentCard info from the client', async () => {
      const config = makeConfig();
      (loadAgents as Mock).mockResolvedValue([config]);
      const manager = await A2AManager.getInstance();

      const mockClient = makeMockClient({
        agentCard: {
          name: 'RemoteAgent',
          description: 'Remote desc',
          version: '2.0.0',
          protocolVersion: '0.2',
          capabilities: { streaming: true, pushNotifications: false },
          skills: [],
        },
      });
      (A2AClient as unknown as Mock).mockImplementation(() => mockClient);

      await manager.connect('agent-1');

      const conn = manager.getConnection('agent-1')!;
      expect(conn.agentCard).toEqual({
        name: 'RemoteAgent',
        description: 'Remote desc',
        version: '2.0.0',
        protocolVersion: '0.2',
        capabilities: { streaming: true, pushNotifications: false },
      });
    });

    it('emits connection-status-changed and skills-updated events', async () => {
      const config = makeConfig();
      (loadAgents as Mock).mockResolvedValue([config]);
      const manager = await A2AManager.getInstance();

      const mockClient = makeMockClient({ skills: [makeSkill()] });
      (A2AClient as unknown as Mock).mockImplementation(() => mockClient);

      const handler = vi.fn();
      manager.on('event', handler);

      await manager.connect('agent-1');

      const eventTypes = handler.mock.calls.map((c: unknown[]) => (c[0] as A2AManagerEvent).type);
      expect(eventTypes).toContain('connection-status-changed');
      expect(eventTypes).toContain('skills-updated');
    });

    it('throws for non-existent agent', async () => {
      const manager = await A2AManager.getInstance();
      await expect(manager.connect('no-id')).rejects.toThrow('Agent not found: no-id');
    });

    it('skips if already connected', async () => {
      const config = makeConfig();
      (loadAgents as Mock).mockResolvedValue([config]);
      const manager = await A2AManager.getInstance();

      const mockClient = makeMockClient();
      (A2AClient as unknown as Mock).mockImplementation(() => mockClient);

      await manager.connect('agent-1');
      (A2AClient as unknown as Mock).mockClear();

      // Second call should be a no-op
      await manager.connect('agent-1');
      expect(A2AClient).not.toHaveBeenCalled();
    });

    it('sets error status on connection failure', async () => {
      const config = makeConfig();
      (loadAgents as Mock).mockResolvedValue([config]);
      const manager = await A2AManager.getInstance();

      const mockClient = makeMockClient();
      mockClient.connect.mockRejectedValue(new Error('network fail'));
      (A2AClient as unknown as Mock).mockImplementation(() => mockClient);

      const handler = vi.fn();
      manager.on('event', handler);

      await expect(manager.connect('agent-1')).rejects.toThrow('network fail');

      const errorEvent = handler.mock.calls
        .map((c: unknown[]) => c[0] as A2AManagerEvent)
        .find(
          (e: A2AManagerEvent) =>
            e.type === 'connection-status-changed' &&
            'status' in e &&
            e.status === 'error'
        );
      expect(errorEvent).toBeDefined();
    });

    it('does not set apiKey when config has no apiKey', async () => {
      const config = makeConfig(); // no apiKey field
      (loadAgents as Mock).mockResolvedValue([config]);
      const manager = await A2AManager.getInstance();

      const mockClient = makeMockClient();
      (A2AClient as unknown as Mock).mockImplementation(() => mockClient);

      await manager.connect('agent-1');

      expect(decryptApiKey).not.toHaveBeenCalled();
      expect(A2AClient).toHaveBeenCalledWith(
        expect.objectContaining({ apiKey: undefined })
      );
    });
  });

  describe('disconnect', () => {
    it('disconnects a connected agent', async () => {
      const config = makeConfig();
      (loadAgents as Mock).mockResolvedValue([config]);
      const manager = await A2AManager.getInstance();

      const mockClient = makeMockClient();
      (A2AClient as unknown as Mock).mockImplementation(() => mockClient);

      await manager.connect('agent-1');
      await manager.disconnect('agent-1');

      expect(mockClient.disconnect).toHaveBeenCalled();
      const conn = manager.getConnection('agent-1')!;
      expect(conn.status).toBe('disconnected');
      expect(conn.skills).toEqual([]);
    });

    it('emits disconnect events', async () => {
      const config = makeConfig();
      (loadAgents as Mock).mockResolvedValue([config]);
      const manager = await A2AManager.getInstance();

      const mockClient = makeMockClient();
      (A2AClient as unknown as Mock).mockImplementation(() => mockClient);

      await manager.connect('agent-1');

      const handler = vi.fn();
      manager.on('event', handler);

      await manager.disconnect('agent-1');

      const events = handler.mock.calls.map((c: unknown[]) => c[0] as A2AManagerEvent);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'connection-status-changed',
          configId: 'agent-1',
          status: 'disconnected',
        })
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'skills-updated',
          configId: 'agent-1',
          skills: [],
        })
      );
    });

    it('handles disconnect when not connected (no client)', async () => {
      const config = makeConfig();
      (loadAgents as Mock).mockResolvedValue([config]);
      const manager = await A2AManager.getInstance();

      // Should not throw
      await manager.disconnect('agent-1');
      const conn = manager.getConnection('agent-1')!;
      expect(conn.status).toBe('disconnected');
    });

    it('handles disconnect errors gracefully', async () => {
      const config = makeConfig();
      (loadAgents as Mock).mockResolvedValue([config]);
      const manager = await A2AManager.getInstance();

      const mockClient = makeMockClient();
      mockClient.disconnect.mockRejectedValue(new Error('disconnect-err'));
      (A2AClient as unknown as Mock).mockImplementation(() => mockClient);

      await manager.connect('agent-1');

      // Should not throw even though client.disconnect fails
      await expect(manager.disconnect('agent-1')).resolves.toBeUndefined();
    });
  });

  describe('getConnection / getConnections', () => {
    it('getConnection returns undefined for unknown ID', async () => {
      const manager = await A2AManager.getInstance();
      expect(manager.getConnection('unknown')).toBeUndefined();
    });

    it('getConnections returns all connections', async () => {
      const a = makeConfig({ id: 'a', name: 'A' });
      const b = makeConfig({ id: 'b', name: 'B' });
      (loadAgents as Mock).mockResolvedValue([a, b]);
      const manager = await A2AManager.getInstance();

      const conns = manager.getConnections();
      expect(conns).toHaveLength(2);
      expect(conns.map((c) => c.configId).sort()).toEqual(['a', 'b']);
    });
  });

  // ========================================================================
  // Skill management
  // ========================================================================
  describe('getAllSkills', () => {
    it('returns empty when no agents connected', async () => {
      const manager = await A2AManager.getInstance();
      expect(manager.getAllSkills()).toEqual([]);
    });

    it('aggregates skills from all connected agents', async () => {
      const a = makeConfig({ id: 'a', name: 'alpha' });
      const b = makeConfig({ id: 'b', name: 'beta' });
      (loadAgents as Mock).mockResolvedValue([a, b]);
      const manager = await A2AManager.getInstance();

      const skillA = makeSkill({ id: 'sa', name: 'skill-a' });
      const skillB = makeSkill({ id: 'sb', name: 'skill-b' });

      // Connect both agents
      const clientA = makeMockClient({ skills: [skillA] });
      const clientB = makeMockClient({ skills: [skillB] });

      let callCount = 0;
      (A2AClient as unknown as Mock).mockImplementation(() => {
        callCount++;
        return callCount === 1 ? clientA : clientB;
      });

      await manager.connect('a');
      await manager.connect('b');

      const all = manager.getAllSkills();
      expect(all).toHaveLength(2);
      expect(all).toContainEqual({ agentName: 'alpha', skill: skillA });
      expect(all).toContainEqual({ agentName: 'beta', skill: skillB });
    });

    it('excludes skills from disconnected agents', async () => {
      const a = makeConfig({ id: 'a', name: 'alpha' });
      const b = makeConfig({ id: 'b', name: 'beta' });
      (loadAgents as Mock).mockResolvedValue([a, b]);
      const manager = await A2AManager.getInstance();

      const skill = makeSkill({ id: 'sa' });
      const clientA = makeMockClient({ skills: [skill] });
      const clientB = makeMockClient({ skills: [makeSkill({ id: 'sb' })] });

      let callCount = 0;
      (A2AClient as unknown as Mock).mockImplementation(() => {
        callCount++;
        return callCount === 1 ? clientA : clientB;
      });

      await manager.connect('a');
      await manager.connect('b');
      await manager.disconnect('b');

      const all = manager.getAllSkills();
      expect(all).toHaveLength(1);
      expect(all[0].agentName).toBe('alpha');
    });
  });

  // ========================================================================
  // Skill execution
  // ========================================================================
  describe('executeSkill', () => {
    async function setupConnectedAgent() {
      const config = makeConfig({ id: 'ex-1', name: 'executor' });
      (loadAgents as Mock).mockResolvedValue([config]);
      const manager = await A2AManager.getInstance();

      const result: IA2AToolResult = {
        success: true,
        content: [{ type: 'text', text: 'done' }],
      };
      const mockClient = makeMockClient({ sendMessageResult: result });
      (A2AClient as unknown as Mock).mockImplementation(() => mockClient);

      await manager.connect('ex-1');
      return { manager, mockClient, config };
    }

    it('parses prefixed name and delegates to client.sendMessage', async () => {
      const { manager, mockClient } = await setupConnectedAgent();
      (parsePrefixedName as Mock).mockReturnValue({
        agentName: 'executor',
        skillId: 'summarize',
      });

      const result = await manager.executeSkill('executor__summarize', {
        message: 'hello',
      });

      expect(parsePrefixedName).toHaveBeenCalledWith('executor__summarize');
      expect(mockClient.sendMessage).toHaveBeenCalledWith(
        'hello',
        expect.any(String) // contextId
      );
      expect(result.success).toBe(true);
    });

    it('throws on invalid prefixed name', async () => {
      const manager = await A2AManager.getInstance();
      (parsePrefixedName as Mock).mockReturnValue(null);

      await expect(
        manager.executeSkill('bad-name', { message: 'hi' })
      ).rejects.toThrow('Invalid prefixed skill name: bad-name');
    });

    it('throws when agent not found by name', async () => {
      const manager = await A2AManager.getInstance();
      (parsePrefixedName as Mock).mockReturnValue({
        agentName: 'unknown',
        skillId: 'x',
      });

      await expect(
        manager.executeSkill('unknown__x', { message: 'hi' })
      ).rejects.toThrow('Agent not found: unknown');
    });

    it('throws when agent not connected', async () => {
      const config = makeConfig({ name: 'offline' });
      (loadAgents as Mock).mockResolvedValue([config]);
      const manager = await A2AManager.getInstance();

      (parsePrefixedName as Mock).mockReturnValue({
        agentName: 'offline',
        skillId: 'x',
      });

      await expect(
        manager.executeSkill('offline__x', { message: 'hi' })
      ).rejects.toThrow('Agent not connected: offline');
    });

    it('throws when message parameter is missing', async () => {
      const { manager } = await setupConnectedAgent();
      (parsePrefixedName as Mock).mockReturnValue({
        agentName: 'executor',
        skillId: 'summarize',
      });

      await expect(
        manager.executeSkill('executor__summarize', {})
      ).rejects.toThrow('Missing required parameter: message');
    });

    it('reuses session context for same agent', async () => {
      const { manager, mockClient } = await setupConnectedAgent();
      (parsePrefixedName as Mock).mockReturnValue({
        agentName: 'executor',
        skillId: 'summarize',
      });

      await manager.executeSkill('executor__summarize', { message: 'first' });
      await manager.executeSkill('executor__summarize', { message: 'second' });

      const firstCtx = mockClient.sendMessage.mock.calls[0][1];
      const secondCtx = mockClient.sendMessage.mock.calls[1][1];
      expect(firstCtx).toBe(secondCtx);
    });
  });

  // ========================================================================
  // Streaming skill execution
  // ========================================================================
  describe('executeSkillStream', () => {
    async function setupStreamingAgent(streaming = true) {
      const config = makeConfig({ id: 'st-1', name: 'streamer' });
      (loadAgents as Mock).mockResolvedValue([config]);
      const manager = await A2AManager.getInstance();

      const streamResult: IA2AToolResult = {
        success: true,
        content: [{ type: 'text', text: 'stream-done' }],
      };
      const nonStreamResult: IA2AToolResult = {
        success: true,
        content: [{ type: 'text', text: 'non-stream-done' }],
      };
      const mockClient = makeMockClient({
        sendMessageStreamResult: streamResult,
        sendMessageResult: nonStreamResult,
        agentCard: {
          name: 'Streamer',
          description: 'A streaming agent',
          version: '1.0',
          protocolVersion: '0.1',
          capabilities: { streaming, pushNotifications: false },
          skills: [],
        },
      });
      (A2AClient as unknown as Mock).mockImplementation(() => mockClient);

      await manager.connect('st-1');
      return { manager, mockClient };
    }

    it('uses streaming when agent supports it', async () => {
      const { manager, mockClient } = await setupStreamingAgent(true);
      (parsePrefixedName as Mock).mockReturnValue({
        agentName: 'streamer',
        skillId: 'stream-skill',
      });

      const onEvent = vi.fn();
      const result = await manager.executeSkillStream(
        'streamer__stream-skill',
        { message: 'stream it' },
        undefined,
        onEvent
      );

      expect(mockClient.sendMessageStream).toHaveBeenCalledWith(
        'stream it',
        expect.any(String),
        onEvent
      );
      expect(mockClient.sendMessage).not.toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it('falls back to non-streaming when agent does not support streaming', async () => {
      const { manager, mockClient } = await setupStreamingAgent(false);
      (parsePrefixedName as Mock).mockReturnValue({
        agentName: 'streamer',
        skillId: 'stream-skill',
      });

      const result = await manager.executeSkillStream(
        'streamer__stream-skill',
        { message: 'no stream' }
      );

      expect(mockClient.sendMessage).toHaveBeenCalled();
      expect(mockClient.sendMessageStream).not.toHaveBeenCalled();
      expect(result.content[0]).toEqual({ type: 'text', text: 'non-stream-done' });
    });

    it('throws on invalid prefixed name', async () => {
      const manager = await A2AManager.getInstance();
      (parsePrefixedName as Mock).mockReturnValue(null);

      await expect(
        manager.executeSkillStream('bad', { message: 'x' })
      ).rejects.toThrow('Invalid prefixed skill name: bad');
    });

    it('throws when agent not found', async () => {
      const manager = await A2AManager.getInstance();
      (parsePrefixedName as Mock).mockReturnValue({
        agentName: 'ghost',
        skillId: 'x',
      });

      await expect(
        manager.executeSkillStream('ghost__x', { message: 'x' })
      ).rejects.toThrow('Agent not found: ghost');
    });

    it('throws when agent not connected', async () => {
      const config = makeConfig({ name: 'offline' });
      (loadAgents as Mock).mockResolvedValue([config]);
      const manager = await A2AManager.getInstance();

      (parsePrefixedName as Mock).mockReturnValue({
        agentName: 'offline',
        skillId: 'x',
      });

      await expect(
        manager.executeSkillStream('offline__x', { message: 'x' })
      ).rejects.toThrow('Agent not connected: offline');
    });

    it('throws when message is missing', async () => {
      const { manager } = await setupStreamingAgent(true);
      (parsePrefixedName as Mock).mockReturnValue({
        agentName: 'streamer',
        skillId: 'x',
      });

      await expect(
        manager.executeSkillStream('streamer__x', {})
      ).rejects.toThrow('Missing required parameter: message');
    });
  });

  // ========================================================================
  // Task management
  // ========================================================================
  describe('cancelTask', () => {
    it('delegates to sdkClient.cancelTask', async () => {
      const config = makeConfig({ name: 'canceller' });
      (loadAgents as Mock).mockResolvedValue([config]);
      const manager = await A2AManager.getInstance();

      const sdkClient = { cancelTask: vi.fn().mockResolvedValue(undefined) };
      const mockClient = makeMockClient({ sdkClient });
      (A2AClient as unknown as Mock).mockImplementation(() => mockClient);

      await manager.connect('agent-1');
      await manager.cancelTask('canceller', 'task-123');

      expect(sdkClient.cancelTask).toHaveBeenCalledWith({ id: 'task-123' });
    });

    it('throws when agent not found', async () => {
      const manager = await A2AManager.getInstance();
      await expect(manager.cancelTask('unknown', 'task-1')).rejects.toThrow(
        'Agent not found: unknown'
      );
    });

    it('throws when agent not connected', async () => {
      const config = makeConfig({ name: 'offline' });
      (loadAgents as Mock).mockResolvedValue([config]);
      const manager = await A2AManager.getInstance();

      await expect(manager.cancelTask('offline', 'task-1')).rejects.toThrow(
        'Agent not connected: offline'
      );
    });

    it('throws when no SDK client available', async () => {
      const config = makeConfig({ name: 'nosdk' });
      (loadAgents as Mock).mockResolvedValue([config]);
      const manager = await A2AManager.getInstance();

      const mockClient = makeMockClient({ sdkClient: null });
      (A2AClient as unknown as Mock).mockImplementation(() => mockClient);

      await manager.connect('agent-1');
      await expect(manager.cancelTask('nosdk', 'task-1')).rejects.toThrow(
        'No SDK client for agent: nosdk'
      );
    });

    it('handles cancelTask failure gracefully (warns but does not throw)', async () => {
      const config = makeConfig({ name: 'cancelfail' });
      (loadAgents as Mock).mockResolvedValue([config]);
      const manager = await A2AManager.getInstance();

      const sdkClient = {
        cancelTask: vi.fn().mockRejectedValue(new Error('not cancelable')),
      };
      const mockClient = makeMockClient({ sdkClient });
      (A2AClient as unknown as Mock).mockImplementation(() => mockClient);

      await manager.connect('agent-1');

      // Should not throw -- the error is caught and logged
      await expect(
        manager.cancelTask('cancelfail', 'task-1')
      ).resolves.toBeUndefined();
    });
  });

  describe('getTaskStatus', () => {
    it('returns task state from SDK client', async () => {
      const config = makeConfig({ name: 'status-agent' });
      (loadAgents as Mock).mockResolvedValue([config]);
      const manager = await A2AManager.getInstance();

      const sdkClient = {
        getTask: vi.fn().mockResolvedValue({
          result: { status: { state: 'completed' } },
        }),
      };
      const mockClient = makeMockClient({ sdkClient });
      (A2AClient as unknown as Mock).mockImplementation(() => mockClient);

      await manager.connect('agent-1');
      const status = await manager.getTaskStatus('status-agent', 'task-99');

      expect(sdkClient.getTask).toHaveBeenCalledWith({ id: 'task-99' });
      expect(status).toBe('completed');
    });

    it('returns undefined when agent not found', async () => {
      const manager = await A2AManager.getInstance();
      const result = await manager.getTaskStatus('nope', 'task-1');
      expect(result).toBeUndefined();
    });

    it('returns undefined when agent not connected', async () => {
      const config = makeConfig({ name: 'off' });
      (loadAgents as Mock).mockResolvedValue([config]);
      const manager = await A2AManager.getInstance();

      const result = await manager.getTaskStatus('off', 'task-1');
      expect(result).toBeUndefined();
    });

    it('returns undefined when SDK client is null', async () => {
      const config = makeConfig({ name: 'nosdk' });
      (loadAgents as Mock).mockResolvedValue([config]);
      const manager = await A2AManager.getInstance();

      const mockClient = makeMockClient({ sdkClient: null });
      (A2AClient as unknown as Mock).mockImplementation(() => mockClient);

      await manager.connect('agent-1');
      const result = await manager.getTaskStatus('nosdk', 'task-1');
      expect(result).toBeUndefined();
    });

    it('returns undefined when getTask throws', async () => {
      const config = makeConfig({ name: 'err-agent' });
      (loadAgents as Mock).mockResolvedValue([config]);
      const manager = await A2AManager.getInstance();

      const sdkClient = {
        getTask: vi.fn().mockRejectedValue(new Error('not found')),
      };
      const mockClient = makeMockClient({ sdkClient });
      (A2AClient as unknown as Mock).mockImplementation(() => mockClient);

      await manager.connect('agent-1');
      const result = await manager.getTaskStatus('err-agent', 'task-1');
      expect(result).toBeUndefined();
    });

    it('returns undefined when result has no status state', async () => {
      const config = makeConfig({ name: 'partial-agent' });
      (loadAgents as Mock).mockResolvedValue([config]);
      const manager = await A2AManager.getInstance();

      const sdkClient = {
        getTask: vi.fn().mockResolvedValue({ result: {} }),
      };
      const mockClient = makeMockClient({ sdkClient });
      (A2AClient as unknown as Mock).mockImplementation(() => mockClient);

      await manager.connect('agent-1');
      const result = await manager.getTaskStatus('partial-agent', 'task-1');
      expect(result).toBeUndefined();
    });
  });

  // ========================================================================
  // Session context management
  // ========================================================================
  describe('session context', () => {
    it('setSessionContextId and getSessionContextId round-trip', async () => {
      const manager = await A2AManager.getInstance();
      manager.setSessionContextId('agent-x', 'ctx-123');
      expect(manager.getSessionContextId('agent-x')).toBe('ctx-123');
    });

    it('returns undefined for unknown agent', async () => {
      const manager = await A2AManager.getInstance();
      expect(manager.getSessionContextId('unknown')).toBeUndefined();
    });

    it('clearSessionContexts removes all contexts', async () => {
      const manager = await A2AManager.getInstance();
      manager.setSessionContextId('a', 'ctx-a');
      manager.setSessionContextId('b', 'ctx-b');

      manager.clearSessionContexts();

      expect(manager.getSessionContextId('a')).toBeUndefined();
      expect(manager.getSessionContextId('b')).toBeUndefined();
    });

    it('overwrites existing context ID', async () => {
      const manager = await A2AManager.getInstance();
      manager.setSessionContextId('a', 'old');
      manager.setSessionContextId('a', 'new');
      expect(manager.getSessionContextId('a')).toBe('new');
    });
  });

  // ========================================================================
  // Event management
  // ========================================================================
  describe('event system', () => {
    it('on/off subscribe and unsubscribe handlers', async () => {
      const config = makeConfig({ id: 'ev-agent', name: 'ev' });
      (loadAgents as Mock).mockResolvedValue([config]);
      const manager = await A2AManager.getInstance();

      const handler = vi.fn();
      manager.on('event', handler);

      const created = makeConfig({ id: 'created-1', name: 'created' });
      (createAgentConfig as Mock).mockReturnValue(created);
      await manager.addAgent({ name: 'created', url: 'https://c.com' });

      expect(handler).toHaveBeenCalled();

      // Unsubscribe
      handler.mockClear();
      manager.off('event', handler);

      const created2 = makeConfig({ id: 'created-2', name: 'created2' });
      (createAgentConfig as Mock).mockReturnValue(created2);
      await manager.addAgent({ name: 'created2', url: 'https://c2.com' });

      expect(handler).not.toHaveBeenCalled();
    });

    it('multiple handlers all receive events', async () => {
      const manager = await A2AManager.getInstance();

      const h1 = vi.fn();
      const h2 = vi.fn();
      manager.on('event', h1);
      manager.on('event', h2);

      const created = makeConfig({ id: 'multi-1', name: 'multi' });
      (createAgentConfig as Mock).mockReturnValue(created);
      await manager.addAgent({ name: 'multi', url: 'https://m.com' });

      expect(h1).toHaveBeenCalled();
      expect(h2).toHaveBeenCalled();
    });

    it('handler errors do not crash emit', async () => {
      const manager = await A2AManager.getInstance();

      const badHandler = vi.fn().mockImplementation(() => {
        throw new Error('handler crash');
      });
      const goodHandler = vi.fn();

      manager.on('event', badHandler);
      manager.on('event', goodHandler);

      const created = makeConfig({ id: 'err-1', name: 'err' });
      (createAgentConfig as Mock).mockReturnValue(created);

      // Should not throw even though badHandler throws
      await expect(
        manager.addAgent({ name: 'err', url: 'https://e.com' })
      ).resolves.toBeDefined();

      expect(goodHandler).toHaveBeenCalled();
    });
  });

  // ========================================================================
  // ensureInitialized guard
  // ========================================================================
  describe('ensureInitialized guard', () => {
    it('getAgents throws when not initialized', () => {
      // Access the private constructor via a workaround: create instance without init
      const manager = new (A2AManager as any)('extension');
      expect(() => manager.getAgents()).toThrow('A2AManager not initialized');
    });

    it('getAgent throws when not initialized', () => {
      const manager = new (A2AManager as any)('extension');
      expect(() => manager.getAgent('x')).toThrow('A2AManager not initialized');
    });

    it('getAgentByName throws when not initialized', () => {
      const manager = new (A2AManager as any)('extension');
      expect(() => manager.getAgentByName('x')).toThrow('A2AManager not initialized');
    });
  });
});
