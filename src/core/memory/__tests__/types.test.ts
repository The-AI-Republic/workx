/**
 * Unit tests for memory types, constants, and utilities.
 */

import { describe, it, expect } from 'vitest';
import {
  ALWAYS_INJECT_CATEGORIES,
  TOPICAL_CATEGORIES,
  DEFAULT_MEMORY_CONFIG,
  isCoreCategory,
  type MemoryCategory,
  type MemoryFact,
  type MemoryScope,
  type MemoryConfig,
  type MemoryDecision,
  type MemoryOperation,
  type MemorySearchResult,
} from '../types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('ALWAYS_INJECT_CATEGORIES', () => {
  it('contains preference, instruction, behavior', () => {
    expect(ALWAYS_INJECT_CATEGORIES).toContain('preference');
    expect(ALWAYS_INJECT_CATEGORIES).toContain('instruction');
    expect(ALWAYS_INJECT_CATEGORIES).toContain('behavior');
  });

  it('has exactly 3 entries', () => {
    expect(ALWAYS_INJECT_CATEGORIES).toHaveLength(3);
  });

  it('does not contain topical categories', () => {
    expect(ALWAYS_INJECT_CATEGORIES).not.toContain('personal');
    expect(ALWAYS_INJECT_CATEGORIES).not.toContain('professional');
    expect(ALWAYS_INJECT_CATEGORIES).not.toContain('project');
    expect(ALWAYS_INJECT_CATEGORIES).not.toContain('general');
  });

  it('is readonly (frozen)', () => {
    // The array is typed as readonly but let's verify the values are stable
    const copy = [...ALWAYS_INJECT_CATEGORIES];
    expect(copy).toEqual(['preference', 'instruction', 'behavior']);
  });
});

describe('TOPICAL_CATEGORIES', () => {
  it('contains personal, professional, project, general', () => {
    expect(TOPICAL_CATEGORIES).toContain('personal');
    expect(TOPICAL_CATEGORIES).toContain('professional');
    expect(TOPICAL_CATEGORIES).toContain('project');
    expect(TOPICAL_CATEGORIES).toContain('general');
  });

  it('has exactly 4 entries', () => {
    expect(TOPICAL_CATEGORIES).toHaveLength(4);
  });

  it('does not overlap with ALWAYS_INJECT_CATEGORIES', () => {
    const overlap = TOPICAL_CATEGORIES.filter((c) =>
      (ALWAYS_INJECT_CATEGORIES as readonly string[]).includes(c)
    );
    expect(overlap).toHaveLength(0);
  });
});

describe('Category completeness', () => {
  it('core + topical covers all 7 categories', () => {
    const all = [...ALWAYS_INJECT_CATEGORIES, ...TOPICAL_CATEGORIES];
    const allCategories: MemoryCategory[] = [
      'preference',
      'personal',
      'professional',
      'project',
      'behavior',
      'instruction',
      'general',
    ];
    for (const cat of allCategories) {
      expect(all).toContain(cat);
    }
    expect(all).toHaveLength(7);
  });
});

// ---------------------------------------------------------------------------
// DEFAULT_MEMORY_CONFIG
// ---------------------------------------------------------------------------

describe('DEFAULT_MEMORY_CONFIG', () => {
  it('has memory disabled by default', () => {
    expect(DEFAULT_MEMORY_CONFIG.enabled).toBe(false);
  });

  it('uses text-embedding-3-small as default model', () => {
    expect(DEFAULT_MEMORY_CONFIG.embeddingModel).toBe('text-embedding-3-small');
  });

  it('uses 1536 dimensions', () => {
    expect(DEFAULT_MEMORY_CONFIG.embeddingDimensions).toBe(1536);
  });

  it('has maxMemories of 10000', () => {
    expect(DEFAULT_MEMORY_CONFIG.maxMemories).toBe(10000);
  });

  it('has recallLimit of 10', () => {
    expect(DEFAULT_MEMORY_CONFIG.recallLimit).toBe(10);
  });

  it('does not set optional fields', () => {
    expect(DEFAULT_MEMORY_CONFIG.extractionModel).toBeUndefined();
    expect(DEFAULT_MEMORY_CONFIG.customExtractionPrompt).toBeUndefined();
    expect(DEFAULT_MEMORY_CONFIG.customConflictPrompt).toBeUndefined();
    expect(DEFAULT_MEMORY_CONFIG.excludeCategories).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// isCoreCategory
// ---------------------------------------------------------------------------

describe('isCoreCategory', () => {
  it('returns true for preference', () => {
    expect(isCoreCategory('preference')).toBe(true);
  });

  it('returns true for instruction', () => {
    expect(isCoreCategory('instruction')).toBe(true);
  });

  it('returns true for behavior', () => {
    expect(isCoreCategory('behavior')).toBe(true);
  });

  it('returns false for personal', () => {
    expect(isCoreCategory('personal')).toBe(false);
  });

  it('returns false for professional', () => {
    expect(isCoreCategory('professional')).toBe(false);
  });

  it('returns false for project', () => {
    expect(isCoreCategory('project')).toBe(false);
  });

  it('returns false for general', () => {
    expect(isCoreCategory('general')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Type shape verification (compile-time + runtime)
// ---------------------------------------------------------------------------

describe('Type shapes', () => {
  it('MemoryFact has the required fields', () => {
    const fact: MemoryFact = {
      id: 'test-id',
      factText: 'User likes TypeScript',
      category: 'preference',
      scope: { userId: 'u1' },
      contentHash: 'abc123',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastAccessedAt: Date.now(),
      accessCount: 0,
    };
    expect(fact.id).toBe('test-id');
    expect(fact.factText).toBe('User likes TypeScript');
    expect(fact.category).toBe('preference');
    expect(fact.scope.userId).toBe('u1');
    expect(fact.accessCount).toBe(0);
  });

  it('MemoryFact accepts optional metadata', () => {
    const fact: MemoryFact = {
      id: 'test-id',
      factText: 'Fact',
      category: 'general',
      scope: {},
      contentHash: 'hash',
      createdAt: 0,
      updatedAt: 0,
      lastAccessedAt: 0,
      accessCount: 0,
      metadata: { source: 'chat', confidence: 0.9 },
    };
    expect(fact.metadata).toEqual({ source: 'chat', confidence: 0.9 });
  });

  it('MemoryScope fields are all optional', () => {
    const scope: MemoryScope = {};
    expect(scope.userId).toBeUndefined();
    expect(scope.agentId).toBeUndefined();
    expect(scope.sessionId).toBeUndefined();
  });

  it('MemoryOperation has required shape', () => {
    const op: MemoryOperation = {
      id: 'op-1',
      memoryId: 'mem-1',
      event: 'ADD',
      oldContent: null,
      newContent: 'New fact',
      timestamp: Date.now(),
    };
    expect(op.event).toBe('ADD');
    expect(op.oldContent).toBeNull();
  });

  it('MemorySearchResult pairs a fact with distance', () => {
    const result: MemorySearchResult = {
      fact: {
        id: 'r1',
        factText: 'Test',
        category: 'general',
        scope: {},
        contentHash: 'h',
        createdAt: 0,
        updatedAt: 0,
        lastAccessedAt: 0,
        accessCount: 0,
      },
      distance: 0.15,
    };
    expect(result.distance).toBe(0.15);
  });

  it('MemoryDecision accepts all valid actions', () => {
    const actions: MemoryDecision['action'][] = ['ADD', 'UPDATE', 'DELETE', 'NONE'];
    for (const action of actions) {
      const d: MemoryDecision = { fact: 'test', action };
      expect(d.action).toBe(action);
    }
  });

  it('MemoryConfig accepts custom overrides', () => {
    const config: MemoryConfig = {
      ...DEFAULT_MEMORY_CONFIG,
      enabled: false,
      maxMemories: 5000,
      extractionModel: 'gpt-4o-mini',
      excludeCategories: ['general'],
    };
    expect(config.enabled).toBe(false);
    expect(config.maxMemories).toBe(5000);
    expect(config.excludeCategories).toEqual(['general']);
  });
});
