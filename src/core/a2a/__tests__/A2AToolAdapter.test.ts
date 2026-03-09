/**
 * Tests for A2AConfig.ts and A2AToolAdapter.ts
 *
 * Covers:
 * - Zod validation schemas (name, URL, timeout, auth, platform)
 * - Config CRUD operations (create, update, validate)
 * - Storage helpers (load, save, debug logging)
 * - Skill-to-tool adaptation (adaptSkill, parsePrefixedName, formatA2AResult)
 * - Risk assessment (A2ARiskAssessor)
 * - Handler creation and registration/unregistration
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setConfigStorage, type ConfigStorageProvider } from '../../storage/ConfigStorageProvider';

// Map-based ConfigStorageProvider mock
const store = new Map<string, any>();

function createMockConfigStorage(): ConfigStorageProvider {
  return {
    get: vi.fn(async <T>(key: string): Promise<T | null> => (store.get(key) as T) ?? null),
    set: vi.fn(async <T>(key: string, value: T): Promise<void> => { store.set(key, value); }),
    remove: vi.fn(async (key: string): Promise<void> => { store.delete(key); }),
    getMany: vi.fn(async <T>(keys: string[]): Promise<Record<string, T>> => {
      const result: Record<string, T> = {};
      for (const key of keys) {
        if (store.has(key)) result[key] = store.get(key);
      }
      return result;
    }),
    setMany: vi.fn(async <T>(items: Record<string, T>): Promise<void> => {
      for (const [key, value] of Object.entries(items)) {
        store.set(key, value);
      }
    }),
    removeMany: vi.fn(async (keys: string[]): Promise<void> => {
      for (const key of keys) store.delete(key);
    }),
    getAll: vi.fn(async (): Promise<Record<string, unknown>> => Object.fromEntries(store)),
    clear: vi.fn(async (): Promise<void> => { store.clear(); }),
    getBytesInUse: vi.fn(async (): Promise<number | null> => null),
  };
}

// A2AConfig imports
import {
  A2AAgentNameSchema,
  A2AAgentUrlSchema,
  A2ATimeoutSchema,
  A2AAuthTypeSchema,
  A2APlatformScopeSchema,
  A2AAgentConfigSchema,
  A2AAgentConfigCreateSchema,
  A2AAgentConfigUpdateSchema,
  loadAgents,
  saveAgents,
  createAgentConfig,
  updateAgentConfig,
  isDebugLoggingEnabled,
  setDebugLogging,
  validateAgentConfig,
} from '../A2AConfig';

// A2AToolAdapter imports
import {
  parsePrefixedName,
  formatA2AResult,
  adaptSkill,
  A2ARiskAssessor,
  createHandler,
  registerA2ASkills,
  unregisterA2ASkills,
} from '../A2AToolAdapter';

import { RiskLevel } from '../../approval/types';
import type { IA2AAgentConfig, IA2ASkill, IA2AManager, IA2AContent } from '../types';
import type { ToolContext } from '../../../tools/BaseTool';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeValidAgent(overrides: Partial<IA2AAgentConfig> = {}): IA2AAgentConfig {
  return {
    id: crypto.randomUUID(),
    name: 'test-agent',
    url: 'https://example.com/a2a',
    authType: 'none',
    enabled: true,
    trusted: false,
    timeout: 30000,
    platform: 'shared',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeSkill(overrides: Partial<IA2ASkill> = {}): IA2ASkill {
  return {
    id: 'summarize',
    name: 'Summarize',
    description: 'Summarize content',
    tags: ['nlp'],
    ...overrides,
  };
}

function makeToolContext(): ToolContext {
  return {
    sessionId: 'session-1',
    turnId: 'turn-1',
    toolName: 'test-tool',
  };
}

function makeMockManager(overrides: Partial<IA2AManager> = {}): IA2AManager {
  return {
    addAgent: vi.fn(),
    updateAgent: vi.fn(),
    removeAgent: vi.fn(),
    getAgents: vi.fn().mockReturnValue([]),
    getAgent: vi.fn(),
    getAgentByName: vi.fn(),
    connect: vi.fn(),
    disconnect: vi.fn(),
    getConnection: vi.fn(),
    getConnections: vi.fn().mockReturnValue([]),
    getAllSkills: vi.fn().mockReturnValue([]),
    executeSkill: vi.fn(),
    executeSkillStream: vi.fn(),
    cancelTask: vi.fn(),
    getTaskStatus: vi.fn(),
    setSessionContextId: vi.fn(),
    getSessionContextId: vi.fn(),
    clearSessionContexts: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    getPlatform: vi.fn().mockReturnValue('shared'),
    ...overrides,
  } as unknown as IA2AManager;
}

// ============================================================================
// Setup
// ============================================================================

beforeEach(() => {
  store.clear();
  const mockStorage = createMockConfigStorage();
  setConfigStorage(mockStorage);
});

// ============================================================================
// A2AConfig — Zod Validation Schemas
// ============================================================================

describe('A2AConfig — Zod Validation Schemas', () => {
  // ---- Name Schema ----
  describe('A2AAgentNameSchema', () => {
    it('accepts a valid alphanumeric name', () => {
      expect(A2AAgentNameSchema.parse('my-agent')).toBe('my-agent');
    });

    it('accepts a single character name', () => {
      expect(A2AAgentNameSchema.parse('a')).toBe('a');
    });

    it('rejects an empty name', () => {
      expect(() => A2AAgentNameSchema.parse('')).toThrow();
    });

    it('rejects a name longer than 50 characters', () => {
      expect(() => A2AAgentNameSchema.parse('a'.repeat(51))).toThrow();
    });

    it('rejects a name with spaces', () => {
      expect(() => A2AAgentNameSchema.parse('my agent')).toThrow();
    });

    it('rejects a name with underscores', () => {
      expect(() => A2AAgentNameSchema.parse('my_agent')).toThrow();
    });

    it('accepts a name at the 50-character limit', () => {
      expect(A2AAgentNameSchema.parse('a'.repeat(50))).toBe('a'.repeat(50));
    });
  });

  // ---- URL Schema ----
  describe('A2AAgentUrlSchema', () => {
    it('accepts a valid https URL', () => {
      expect(A2AAgentUrlSchema.parse('https://example.com')).toBe('https://example.com');
    });

    it('accepts a valid http URL', () => {
      expect(A2AAgentUrlSchema.parse('http://localhost:3000')).toBe('http://localhost:3000');
    });

    it('rejects a non-URL string', () => {
      expect(() => A2AAgentUrlSchema.parse('not-a-url')).toThrow();
    });

    it('rejects ftp protocol', () => {
      expect(() => A2AAgentUrlSchema.parse('ftp://example.com')).toThrow();
    });
  });

  // ---- Timeout Schema ----
  describe('A2ATimeoutSchema', () => {
    it('accepts a valid timeout within range', () => {
      expect(A2ATimeoutSchema.parse(30000)).toBe(30000);
    });

    it('accepts the minimum timeout (5000)', () => {
      expect(A2ATimeoutSchema.parse(5000)).toBe(5000);
    });

    it('accepts the maximum timeout (180000)', () => {
      expect(A2ATimeoutSchema.parse(180000)).toBe(180000);
    });

    it('rejects a timeout below minimum', () => {
      expect(() => A2ATimeoutSchema.parse(4999)).toThrow();
    });

    it('rejects a timeout above maximum', () => {
      expect(() => A2ATimeoutSchema.parse(180001)).toThrow();
    });
  });

  // ---- Auth Type Schema ----
  describe('A2AAuthTypeSchema', () => {
    it('accepts "apiKey"', () => {
      expect(A2AAuthTypeSchema.parse('apiKey')).toBe('apiKey');
    });

    it('accepts "bearer"', () => {
      expect(A2AAuthTypeSchema.parse('bearer')).toBe('bearer');
    });

    it('accepts "none"', () => {
      expect(A2AAuthTypeSchema.parse('none')).toBe('none');
    });

    it('rejects an invalid auth type', () => {
      expect(() => A2AAuthTypeSchema.parse('oauth')).toThrow();
    });
  });

  // ---- Platform Scope Schema ----
  describe('A2APlatformScopeSchema', () => {
    it('accepts "shared"', () => {
      expect(A2APlatformScopeSchema.parse('shared')).toBe('shared');
    });

    it('accepts "extension"', () => {
      expect(A2APlatformScopeSchema.parse('extension')).toBe('extension');
    });

    it('accepts "desktop"', () => {
      expect(A2APlatformScopeSchema.parse('desktop')).toBe('desktop');
    });

    it('accepts "server"', () => {
      expect(A2APlatformScopeSchema.parse('server')).toBe('server');
    });

    it('rejects an invalid platform scope', () => {
      expect(() => A2APlatformScopeSchema.parse('web')).toThrow();
    });
  });
});

// ============================================================================
// A2AConfig — Config CRUD Operations
// ============================================================================

describe('A2AConfig — Config CRUD', () => {
  describe('createAgentConfig', () => {
    it('creates a valid agent config with all required fields', () => {
      const input = { name: 'research', url: 'https://research.example.com', timeout: 30000 };
      const result = createAgentConfig(input, []);

      expect(result.name).toBe('research');
      expect(result.url).toBe('https://research.example.com');
      expect(result.id).toBeTruthy();
      expect(result.enabled).toBe(true);
      expect(result.trusted).toBe(false);
      expect(result.authType).toBe('none');
      expect(result.platform).toBe('shared');
      expect(result.createdAt).toBeGreaterThan(0);
      expect(result.updatedAt).toBe(result.createdAt);
    });

    it('applies custom optional fields', () => {
      const input = {
        name: 'secure-agent',
        url: 'https://secure.example.com',
        apiKey: 'sk-123',
        authType: 'apiKey' as const,
        enabled: false,
        trusted: true,
        timeout: 60000,
        platform: 'extension' as const,
      };
      const result = createAgentConfig(input, []);

      expect(result.apiKey).toBe('sk-123');
      expect(result.authType).toBe('apiKey');
      expect(result.enabled).toBe(false);
      expect(result.trusted).toBe(true);
      expect(result.timeout).toBe(60000);
      expect(result.platform).toBe('extension');
    });

    it('throws on duplicate name (case-insensitive)', () => {
      const existing = [makeValidAgent({ name: 'research' })];
      const input = { name: 'Research', url: 'https://other.example.com', timeout: 30000 };

      expect(() => createAgentConfig(input, existing)).toThrow('already exists');
    });

    it('throws on invalid name', () => {
      const input = { name: 'bad name!', url: 'https://example.com', timeout: 30000 };
      expect(() => createAgentConfig(input, [])).toThrow();
    });

    it('throws on invalid URL', () => {
      const input = { name: 'good-name', url: 'not-a-url', timeout: 30000 };
      expect(() => createAgentConfig(input, [])).toThrow();
    });
  });

  describe('updateAgentConfig', () => {
    it('updates only specified fields', () => {
      const existing = makeValidAgent({ name: 'original', url: 'https://original.example.com' });
      const result = updateAgentConfig(existing, { name: 'updated' }, [existing]);

      expect(result.name).toBe('updated');
      expect(result.url).toBe('https://original.example.com');
      expect(result.updatedAt).toBeGreaterThanOrEqual(existing.updatedAt);
    });

    it('preserves existing apiKey when not in update', () => {
      const existing = makeValidAgent({ apiKey: 'sk-old' });
      const result = updateAgentConfig(existing, { name: 'new-name' }, [existing]);

      expect(result.apiKey).toBe('sk-old');
    });

    it('preserves apiKey when update sets apiKey to undefined (Zod strips undefined)', () => {
      const existing = makeValidAgent({ apiKey: 'sk-old' });
      // Zod's optional() strips undefined, so validated.apiKey is undefined,
      // and the code falls back to existing.apiKey
      const result = updateAgentConfig(existing, { apiKey: undefined }, [existing]);

      expect(result.apiKey).toBe('sk-old');
    });

    it('clears apiKey when update sets it to empty string', () => {
      const existing = makeValidAgent({ apiKey: 'sk-old' });
      const result = updateAgentConfig(existing, { apiKey: '' }, [existing]);

      expect(result.apiKey).toBe('');
    });

    it('throws on duplicate name when renaming', () => {
      const agent1 = makeValidAgent({ id: 'id-1', name: 'agent-1' });
      const agent2 = makeValidAgent({ id: 'id-2', name: 'agent-2' });
      const allAgents = [agent1, agent2];

      expect(() => updateAgentConfig(agent1, { name: 'agent-2' }, allAgents)).toThrow('already exists');
    });

    it('allows keeping the same name (case-insensitive) on update', () => {
      const existing = makeValidAgent({ name: 'my-agent' });
      const result = updateAgentConfig(existing, { name: 'my-agent' }, [existing]);

      expect(result.name).toBe('my-agent');
    });
  });

  describe('validateAgentConfig', () => {
    it('returns success for valid input', () => {
      const result = validateAgentConfig({
        name: 'valid-agent',
        url: 'https://example.com',
        timeout: 30000,
      });
      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
    });

    it('returns error for invalid input', () => {
      const result = validateAgentConfig({
        name: '',
        url: 'not-a-url',
      });
      expect(result.success).toBe(false);
      expect(result.error).toBeTruthy();
    });

    it('returns error details including field path', () => {
      const result = validateAgentConfig({ name: '' });
      expect(result.success).toBe(false);
      expect(result.error).toContain('name');
    });
  });
});

// ============================================================================
// A2AConfig — Storage Helpers
// ============================================================================

describe('A2AConfig — Storage Helpers', () => {
  describe('loadAgents', () => {
    it('returns empty array when storage is empty', async () => {
      const agents = await loadAgents();
      expect(agents).toEqual([]);
    });

    it('returns empty array when storage has non-array value', async () => {
      store.set('a2aAgents', 'not-an-array');
      const agents = await loadAgents();
      expect(agents).toEqual([]);
    });

    it('loads valid agents from storage', async () => {
      const agent = makeValidAgent();
      store.set('a2aAgents', [agent]);

      const agents = await loadAgents();
      expect(agents).toHaveLength(1);
      expect(agents[0].name).toBe(agent.name);
    });

    it('skips invalid agents during load', async () => {
      const validAgent = makeValidAgent();
      const invalidAgent = { name: 123, url: 'bad' }; // invalid
      store.set('a2aAgents', [validAgent, invalidAgent]);

      const agents = await loadAgents();
      expect(agents).toHaveLength(1);
      expect(agents[0].id).toBe(validAgent.id);
    });
  });

  describe('saveAgents', () => {
    it('saves valid agents to storage', async () => {
      const agent = makeValidAgent();
      await saveAgents([agent]);

      const stored = store.get('a2aAgents');
      expect(stored).toHaveLength(1);
      expect(stored[0].id).toBe(agent.id);
    });

    it('throws on validation failure', async () => {
      const badAgent = { name: 123 } as unknown as IA2AAgentConfig;
      await expect(saveAgents([badAgent])).rejects.toThrow('Failed to save');
    });
  });

  describe('isDebugLoggingEnabled', () => {
    it('returns false when not set', async () => {
      const result = await isDebugLoggingEnabled();
      expect(result).toBe(false);
    });

    it('returns true when enabled', async () => {
      store.set('a2aDebugLogging', true);
      const result = await isDebugLoggingEnabled();
      expect(result).toBe(true);
    });

    it('returns false for non-boolean values', async () => {
      store.set('a2aDebugLogging', 'yes');
      const result = await isDebugLoggingEnabled();
      expect(result).toBe(false);
    });
  });

  describe('setDebugLogging', () => {
    it('enables debug logging', async () => {
      await setDebugLogging(true);
      const stored = store.get('a2aDebugLogging');
      expect(stored).toBe(true);
    });

    it('disables debug logging', async () => {
      store.set('a2aDebugLogging', true);
      await setDebugLogging(false);
      const stored = store.get('a2aDebugLogging');
      expect(stored).toBe(false);
    });
  });
});

// ============================================================================
// A2AToolAdapter — parsePrefixedName
// ============================================================================

describe('A2AToolAdapter — parsePrefixedName', () => {
  it('parses a valid prefixed name', () => {
    const result = parsePrefixedName('research__summarize');
    expect(result).toEqual({ agentName: 'research', skillId: 'summarize' });
  });

  it('returns null for empty string', () => {
    expect(parsePrefixedName('')).toBeNull();
  });

  it('returns null for name without separator', () => {
    expect(parsePrefixedName('research-summarize')).toBeNull();
  });

  it('returns null for name with more than two parts', () => {
    expect(parsePrefixedName('a__b__c')).toBeNull();
  });

  it('returns null when agent name part is empty', () => {
    expect(parsePrefixedName('__summarize')).toBeNull();
  });

  it('returns null when skill ID part is empty', () => {
    expect(parsePrefixedName('research__')).toBeNull();
  });
});

// ============================================================================
// A2AToolAdapter — formatA2AResult
// ============================================================================

describe('A2AToolAdapter — formatA2AResult', () => {
  it('returns "(no content)" for empty array', () => {
    expect(formatA2AResult([])).toBe('(no content)');
  });

  it('returns "(no content)" for null/undefined input', () => {
    expect(formatA2AResult(null as unknown as IA2AContent[])).toBe('(no content)');
    expect(formatA2AResult(undefined as unknown as IA2AContent[])).toBe('(no content)');
  });

  it('formats text content', () => {
    const content: IA2AContent[] = [{ type: 'text', text: 'Hello world' }];
    expect(formatA2AResult(content)).toBe('Hello world');
  });

  it('formats file content with all fields', () => {
    const content: IA2AContent[] = [
      { type: 'file', uri: 'file:///tmp/doc.pdf', mimeType: 'application/pdf', name: 'doc.pdf' },
    ];
    expect(formatA2AResult(content)).toBe('[File: doc.pdf] (application/pdf) file:///tmp/doc.pdf');
  });

  it('formats file content with missing optional fields', () => {
    const content: IA2AContent[] = [{ type: 'file', uri: 'file:///tmp/file.bin' }];
    expect(formatA2AResult(content)).toBe('[File: unnamed] (unknown) file:///tmp/file.bin');
  });

  it('formats data content as JSON', () => {
    const content: IA2AContent[] = [{ type: 'data', data: { key: 'value' } }];
    expect(formatA2AResult(content)).toBe(JSON.stringify({ key: 'value' }, null, 2));
  });

  it('joins multiple parts with double newline', () => {
    const content: IA2AContent[] = [
      { type: 'text', text: 'Part 1' },
      { type: 'text', text: 'Part 2' },
    ];
    expect(formatA2AResult(content)).toBe('Part 1\n\nPart 2');
  });

  it('handles unknown content type gracefully', () => {
    const content = [{ type: 'image', src: 'data:...' }] as unknown as IA2AContent[];
    expect(formatA2AResult(content)).toContain('[Unknown content type: image]');
  });
});

// ============================================================================
// A2AToolAdapter — adaptSkill
// ============================================================================

describe('A2AToolAdapter — adaptSkill', () => {
  it('creates a tool definition with prefixed name', () => {
    const skill = makeSkill({ id: 'summarize', description: 'Summarize text' });
    const tool = adaptSkill(skill, 'research');

    expect(tool.type).toBe('function');
    if (tool.type === 'function') {
      expect(tool.function.name).toBe('research__summarize');
    }
  });

  it('prefixes description with agent name', () => {
    const skill = makeSkill({ description: 'Summarize text' });
    const tool = adaptSkill(skill, 'research');

    if (tool.type === 'function') {
      expect(tool.function.description).toBe('[research] Summarize text');
    }
  });

  it('has a message parameter as required', () => {
    const skill = makeSkill();
    const tool = adaptSkill(skill, 'agent');

    if (tool.type === 'function') {
      const params = tool.function.parameters as { required: string[]; properties: Record<string, unknown> };
      expect(params.required).toContain('message');
      expect(params.properties.message).toBeDefined();
    }
  });

  it('sets strict to false', () => {
    const skill = makeSkill();
    const tool = adaptSkill(skill, 'agent');

    if (tool.type === 'function') {
      expect(tool.function.strict).toBe(false);
    }
  });
});

// ============================================================================
// A2AToolAdapter — A2ARiskAssessor
// ============================================================================

describe('A2AToolAdapter — A2ARiskAssessor', () => {
  it('returns auto_approve with low score for trusted agent', () => {
    const assessor = new A2ARiskAssessor(true);
    const result = assessor.assess('tool', {});

    expect(result.score).toBe(10);
    expect(result.level).toBe(RiskLevel.None);
    expect(result.action).toBe('auto_approve');
    expect(result.factors).toContain('Trusted A2A agent');
  });

  it('returns ask_user with medium score for untrusted agent', () => {
    const assessor = new A2ARiskAssessor(false);
    const result = assessor.assess('tool', {});

    expect(result.score).toBe(45);
    expect(result.level).toBe(RiskLevel.Medium);
    expect(result.action).toBe('ask_user');
    expect(result.factors).toContain('External A2A agent call');
    expect(result.factors).toContain('Network boundary crossing');
  });

  it('ignores tool name and parameters (always same result for same trust)', () => {
    const assessor = new A2ARiskAssessor(false);
    const r1 = assessor.assess('tool-a', { foo: 'bar' });
    const r2 = assessor.assess('tool-b', { baz: 'qux' });

    expect(r1.score).toBe(r2.score);
    expect(r1.action).toBe(r2.action);
  });
});

// ============================================================================
// A2AToolAdapter — createHandler
// ============================================================================

describe('A2AToolAdapter — createHandler', () => {
  it('throws when message parameter is missing', async () => {
    const manager = makeMockManager();
    const handler = createHandler(manager, 'agent', 'skill');

    await expect(handler({}, makeToolContext())).rejects.toThrow('Missing required parameter: message');
  });

  it('calls executeSkill for non-streaming agent and returns formatted result', async () => {
    const manager = makeMockManager({
      getAgentByName: vi.fn().mockReturnValue(makeValidAgent({ id: 'agent-id' })),
      getConnection: vi.fn().mockReturnValue({
        configId: 'agent-id',
        status: 'connected',
        skills: [],
        agentCard: { capabilities: { streaming: false } },
      }),
      executeSkill: vi.fn().mockResolvedValue({
        success: true,
        content: [{ type: 'text', text: 'Result text' }],
        isError: false,
      }),
    });

    const handler = createHandler(manager, 'my-agent', 'summarize');
    const result = await handler({ message: 'Summarize this' }, makeToolContext());

    expect(manager.executeSkill).toHaveBeenCalledWith('my-agent__summarize', { message: 'Summarize this' });
    expect(result).toBe('Result text');
  });

  it('calls executeSkillStream for streaming-capable agent', async () => {
    const manager = makeMockManager({
      getAgentByName: vi.fn().mockReturnValue(makeValidAgent({ id: 'agent-id' })),
      getConnection: vi.fn().mockReturnValue({
        configId: 'agent-id',
        status: 'connected',
        skills: [],
        agentCard: { capabilities: { streaming: true } },
      }),
      executeSkillStream: vi.fn().mockResolvedValue({
        success: true,
        content: [{ type: 'text', text: 'Streamed result' }],
        isError: false,
      }),
    });

    const handler = createHandler(manager, 'my-agent', 'summarize');
    const result = await handler({ message: 'Summarize this' }, makeToolContext());

    expect(manager.executeSkillStream).toHaveBeenCalledWith('my-agent__summarize', { message: 'Summarize this' });
    expect(result).toBe('Streamed result');
  });

  it('throws when result has isError true', async () => {
    const manager = makeMockManager({
      getAgentByName: vi.fn().mockReturnValue(makeValidAgent({ id: 'agent-id' })),
      getConnection: vi.fn().mockReturnValue({
        configId: 'agent-id',
        status: 'connected',
        skills: [],
        agentCard: { capabilities: {} },
      }),
      executeSkill: vi.fn().mockResolvedValue({
        success: false,
        content: [{ type: 'text', text: 'Something went wrong' }],
        isError: true,
      }),
    });

    const handler = createHandler(manager, 'my-agent', 'summarize');
    await expect(handler({ message: 'Do it' }, makeToolContext())).rejects.toThrow('Something went wrong');
  });

  it('falls back to executeSkill when agent not found', async () => {
    const manager = makeMockManager({
      getAgentByName: vi.fn().mockReturnValue(undefined),
      getConnection: vi.fn().mockReturnValue(undefined),
      executeSkill: vi.fn().mockResolvedValue({
        success: true,
        content: [{ type: 'text', text: 'Fallback result' }],
        isError: false,
      }),
    });

    const handler = createHandler(manager, 'unknown-agent', 'summarize');
    const result = await handler({ message: 'test' }, makeToolContext());

    expect(manager.executeSkill).toHaveBeenCalled();
    expect(result).toBe('Fallback result');
  });

  it('falls back to executeSkill when connection has no agentCard', async () => {
    const manager = makeMockManager({
      getAgentByName: vi.fn().mockReturnValue(makeValidAgent({ id: 'agent-id' })),
      getConnection: vi.fn().mockReturnValue({
        configId: 'agent-id',
        status: 'connected',
        skills: [],
      }),
      executeSkill: vi.fn().mockResolvedValue({
        success: true,
        content: [{ type: 'text', text: 'No card result' }],
        isError: false,
      }),
    });

    const handler = createHandler(manager, 'my-agent', 'summarize');
    const result = await handler({ message: 'test' }, makeToolContext());

    expect(manager.executeSkill).toHaveBeenCalled();
    expect(result).toBe('No card result');
  });
});

// ============================================================================
// A2AToolAdapter — registerA2ASkills / unregisterA2ASkills
// ============================================================================

describe('A2AToolAdapter — registerA2ASkills', () => {
  it('registers all skills with the tool registry', async () => {
    const manager = makeMockManager();
    const registry = { register: vi.fn(), unregister: vi.fn() };
    const skills = [
      makeSkill({ id: 'summarize' }),
      makeSkill({ id: 'translate' }),
    ];

    await registerA2ASkills(manager, 'research', skills, registry, true);

    expect(registry.register).toHaveBeenCalledTimes(2);

    // Verify first call has correct tool definition
    const firstCall = registry.register.mock.calls[0];
    const toolDef = firstCall[0];
    if (toolDef.type === 'function') {
      expect(toolDef.function.name).toBe('research__summarize');
    }
  });

  it('passes trusted risk assessor', async () => {
    const manager = makeMockManager();
    const registry = { register: vi.fn(), unregister: vi.fn() };
    const skills = [makeSkill()];

    await registerA2ASkills(manager, 'agent', skills, registry, true);

    const riskAssessor = registry.register.mock.calls[0][2];
    const assessment = riskAssessor.assess('tool', {});
    expect(assessment.action).toBe('auto_approve');
  });

  it('passes untrusted risk assessor', async () => {
    const manager = makeMockManager();
    const registry = { register: vi.fn(), unregister: vi.fn() };
    const skills = [makeSkill()];

    await registerA2ASkills(manager, 'agent', skills, registry, false);

    const riskAssessor = registry.register.mock.calls[0][2];
    const assessment = riskAssessor.assess('tool', {});
    expect(assessment.action).toBe('ask_user');
  });

  it('handles empty skills array', async () => {
    const manager = makeMockManager();
    const registry = { register: vi.fn(), unregister: vi.fn() };

    await registerA2ASkills(manager, 'agent', [], registry, true);
    expect(registry.register).not.toHaveBeenCalled();
  });
});

describe('A2AToolAdapter — unregisterA2ASkills', () => {
  it('unregisters all skills from the tool registry', async () => {
    const registry = { unregister: vi.fn() };
    const skills = [
      makeSkill({ id: 'summarize' }),
      makeSkill({ id: 'translate' }),
    ];

    await unregisterA2ASkills('research', skills, registry);

    expect(registry.unregister).toHaveBeenCalledTimes(2);
    expect(registry.unregister).toHaveBeenCalledWith('research__summarize');
    expect(registry.unregister).toHaveBeenCalledWith('research__translate');
  });

  it('ignores errors when unregistering non-existent tools', async () => {
    const registry = { unregister: vi.fn().mockRejectedValue(new Error('Not found')) };
    const skills = [makeSkill({ id: 'missing' })];

    // Should not throw
    await expect(unregisterA2ASkills('agent', skills, registry)).resolves.toBeUndefined();
  });

  it('handles empty skills array', async () => {
    const registry = { unregister: vi.fn() };
    await unregisterA2ASkills('agent', [], registry);
    expect(registry.unregister).not.toHaveBeenCalled();
  });
});
