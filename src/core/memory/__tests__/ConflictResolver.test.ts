/**
 * Unit tests for ConflictResolver.
 *
 * Tests UUID-to-integer mapping, ADD/UPDATE/DELETE/NONE decisions,
 * malformed LLM responses, and fallback behavior.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConflictResolver } from '../ConflictResolver';
import {
  DEFAULT_MEMORY_CONFIG,
  type MemoryConfig,
  type MemoryFact,
} from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockLLM(response: string = '{"decisions": []}') {
  return {
    complete: vi.fn().mockResolvedValue(response),
  };
}

function createResolver(
  llmResponse: string = '{"decisions": []}',
  configOverrides: Partial<MemoryConfig> = {}
) {
  const llm = createMockLLM(llmResponse);
  const config = { ...DEFAULT_MEMORY_CONFIG, ...configOverrides };
  const resolver = new ConflictResolver(llm, config);
  return { resolver, llm };
}

function makeFact(overrides: Partial<MemoryFact> = {}): MemoryFact {
  return {
    id: 'fact-uuid-001',
    factText: 'User likes Python',
    category: 'preference',
    scope: {},
    contentHash: 'hash1',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    lastAccessedAt: Date.now(),
    accessCount: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// resolve - empty inputs
// ---------------------------------------------------------------------------

describe('ConflictResolver.resolve - empty inputs', () => {
  it('returns empty array when no new facts', async () => {
    const { resolver, llm } = createResolver();
    const result = await resolver.resolve([], []);
    expect(result).toEqual([]);
    expect(llm.complete).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// resolve - no existing memories (all ADD)
// ---------------------------------------------------------------------------

describe('ConflictResolver.resolve - no existing memories', () => {
  it('returns ADD for all facts when no existing memories', async () => {
    const { resolver, llm } = createResolver();
    const facts = ['User likes Python', 'User works at Google'];
    const result = await resolver.resolve(facts, []);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ fact: 'User likes Python', action: 'ADD' });
    expect(result[1]).toEqual({ fact: 'User works at Google', action: 'ADD' });
    expect(llm.complete).not.toHaveBeenCalled();
  });

  it('handles single fact with no existing memories', async () => {
    const { resolver } = createResolver();
    const result = await resolver.resolve(['Single fact'], []);
    expect(result).toEqual([{ fact: 'Single fact', action: 'ADD' }]);
  });
});

// ---------------------------------------------------------------------------
// resolve - with existing memories (LLM called)
// ---------------------------------------------------------------------------

describe('ConflictResolver.resolve - with existing memories', () => {
  it('calls LLM with integer-mapped IDs', async () => {
    const response = JSON.stringify({
      decisions: [{ fact: 'User likes TypeScript', action: 'ADD' }],
    });
    const { resolver, llm } = createResolver(response);

    const existing = [
      makeFact({ id: 'uuid-aaa', factText: 'User likes Python' }),
      makeFact({ id: 'uuid-bbb', factText: 'User is 30 years old' }),
    ];

    await resolver.resolve(['User likes TypeScript'], existing);

    expect(llm.complete).toHaveBeenCalledOnce();
    const [systemPrompt] = llm.complete.mock.calls[0];
    // Verify integer IDs are used in the prompt
    expect(systemPrompt).toContain('[0]');
    expect(systemPrompt).toContain('[1]');
    // UUID should NOT appear in the prompt
    expect(systemPrompt).not.toContain('uuid-aaa');
    expect(systemPrompt).not.toContain('uuid-bbb');
  });

  it('maps integer memoryId back to real UUID', async () => {
    const response = JSON.stringify({
      decisions: [
        { fact: 'User likes TypeScript now', action: 'UPDATE', memoryId: '0' },
      ],
    });
    const { resolver } = createResolver(response);

    const existing = [
      makeFact({ id: 'real-uuid-abc', factText: 'User likes Python' }),
    ];

    const result = await resolver.resolve(['User likes TypeScript now'], existing);
    expect(result).toHaveLength(1);
    expect(result[0].action).toBe('UPDATE');
    expect(result[0].memoryId).toBe('real-uuid-abc');
  });

  it('handles DELETE action with correct UUID mapping', async () => {
    const response = JSON.stringify({
      decisions: [
        {
          fact: 'User no longer likes Python',
          action: 'DELETE',
          memoryId: '1',
          reasoning: 'User explicitly said to forget',
        },
      ],
    });
    const { resolver } = createResolver(response);

    const existing = [
      makeFact({ id: 'uuid-first', factText: 'User likes TypeScript' }),
      makeFact({ id: 'uuid-second', factText: 'User likes Python' }),
    ];

    const result = await resolver.resolve(
      ['User no longer likes Python'],
      existing
    );
    expect(result[0].action).toBe('DELETE');
    expect(result[0].memoryId).toBe('uuid-second');
  });

  it('handles NONE action', async () => {
    const response = JSON.stringify({
      decisions: [
        { fact: 'User likes Python', action: 'NONE' },
      ],
    });
    const { resolver } = createResolver(response);

    const existing = [makeFact({ factText: 'User likes Python' })];
    const result = await resolver.resolve(['User likes Python'], existing);
    expect(result[0].action).toBe('NONE');
  });

  it('handles mixed decisions', async () => {
    const response = JSON.stringify({
      decisions: [
        { fact: 'User likes TypeScript', action: 'ADD' },
        { fact: 'User is 31', action: 'UPDATE', memoryId: '1' },
        { fact: 'Forget Python preference', action: 'DELETE', memoryId: '0' },
        { fact: 'Still at Google', action: 'NONE' },
      ],
    });
    const { resolver } = createResolver(response);

    const existing = [
      makeFact({ id: 'uuid-python', factText: 'User likes Python' }),
      makeFact({ id: 'uuid-age', factText: 'User is 30' }),
    ];

    const result = await resolver.resolve(
      ['User likes TypeScript', 'User is 31', 'Forget Python preference', 'Still at Google'],
      existing
    );

    expect(result).toHaveLength(4);
    expect(result[0].action).toBe('ADD');
    expect(result[1].action).toBe('UPDATE');
    expect(result[1].memoryId).toBe('uuid-age');
    expect(result[2].action).toBe('DELETE');
    expect(result[2].memoryId).toBe('uuid-python');
    expect(result[3].action).toBe('NONE');
  });
});

// ---------------------------------------------------------------------------
// resolve - custom conflict prompt
// ---------------------------------------------------------------------------

describe('ConflictResolver.resolve - custom prompt', () => {
  it('uses customConflictPrompt when configured', async () => {
    const customPrompt = 'Custom conflict prompt: {{existingMemories}} -- {{newFacts}}';
    const response = JSON.stringify({
      decisions: [{ fact: 'test', action: 'ADD' }],
    });
    const { resolver, llm } = createResolver(response, {
      customConflictPrompt: customPrompt,
    });

    await resolver.resolve(['test'], [makeFact()]);

    const [systemPrompt] = llm.complete.mock.calls[0];
    expect(systemPrompt).toContain('Custom conflict prompt:');
  });
});

// ---------------------------------------------------------------------------
// resolve - error handling
// ---------------------------------------------------------------------------

describe('ConflictResolver.resolve - error handling', () => {
  it('defaults all facts to ADD when LLM throws', async () => {
    const llm = { complete: vi.fn().mockRejectedValue(new Error('LLM error')) };
    const resolver = new ConflictResolver(llm, DEFAULT_MEMORY_CONFIG);

    const result = await resolver.resolve(
      ['Fact 1', 'Fact 2'],
      [makeFact()]
    );

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ fact: 'Fact 1', action: 'ADD' });
    expect(result[1]).toEqual({ fact: 'Fact 2', action: 'ADD' });
  });

  it('defaults to ADD when LLM returns non-JSON', async () => {
    const { resolver } = createResolver('Not valid JSON at all');

    const result = await resolver.resolve(['test'], [makeFact()]);
    // H3: parseDecisions returns [] → defaults to ADD to avoid losing facts
    expect(result).toEqual([{ fact: 'test', action: 'ADD' }]);
  });

  it('defaults to ADD when LLM returns JSON without decisions key', async () => {
    const { resolver } = createResolver('{"items": []}');

    const result = await resolver.resolve(['test'], [makeFact()]);
    // H3: parseDecisions returns [] → defaults to ADD
    expect(result).toEqual([{ fact: 'test', action: 'ADD' }]);
  });

  it('filters out decisions with invalid actions', async () => {
    const response = JSON.stringify({
      decisions: [
        { fact: 'Valid', action: 'ADD' },
        { fact: 'Invalid action', action: 'MERGE' },
        { fact: 'Missing action' },
        { fact: 'Also valid', action: 'NONE' },
      ],
    });
    const { resolver } = createResolver(response);

    const result = await resolver.resolve(
      ['Valid', 'Invalid action', 'Missing action', 'Also valid'],
      [makeFact()]
    );

    expect(result).toHaveLength(2);
    expect(result[0].fact).toBe('Valid');
    expect(result[1].fact).toBe('Also valid');
  });

  it('filters out decisions without fact field', async () => {
    const response = JSON.stringify({
      decisions: [
        { action: 'ADD' },
        { fact: 'Has both', action: 'ADD' },
      ],
    });
    const { resolver } = createResolver(response);

    const result = await resolver.resolve(
      ['test'],
      [makeFact()]
    );

    expect(result).toHaveLength(1);
    expect(result[0].fact).toBe('Has both');
  });

  it('converts numeric memoryId to string', async () => {
    const response = JSON.stringify({
      decisions: [
        { fact: 'Updated fact', action: 'UPDATE', memoryId: 0 },
      ],
    });
    const { resolver } = createResolver(response);

    const existing = [makeFact({ id: 'uuid-target' })];
    const result = await resolver.resolve(['Updated fact'], existing);

    expect(result[0].memoryId).toBe('uuid-target');
  });

  it('extracts JSON from response with surrounding text', async () => {
    const response =
      'Here are my decisions:\n{"decisions": [{"fact": "Extracted", "action": "ADD"}]}\nDone.';
    const { resolver } = createResolver(response);

    const result = await resolver.resolve(['Extracted'], [makeFact()]);
    expect(result).toHaveLength(1);
    expect(result[0].fact).toBe('Extracted');
  });
});
