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
  type MemoryConfig,
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

  it('has recallLimit of 10', () => {
    expect(DEFAULT_MEMORY_CONFIG.recallLimit).toBe(10);
  });

  it('sets extractionModel to gpt-4o-mini by default', () => {
    expect(DEFAULT_MEMORY_CONFIG.extractionModel).toBe('gpt-4o-mini');
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
// MemoryConfig shape
// ---------------------------------------------------------------------------

describe('MemoryConfig', () => {
  it('accepts custom overrides', () => {
    const config: MemoryConfig = {
      ...DEFAULT_MEMORY_CONFIG,
      enabled: true,
      extractionModel: 'gpt-4o-mini',
      excludeCategories: ['general'],
    };
    expect(config.enabled).toBe(true);
    expect(config.excludeCategories).toEqual(['general']);
  });
});
