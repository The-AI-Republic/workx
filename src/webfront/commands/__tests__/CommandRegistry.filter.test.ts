/**
 * CommandRegistry.filter — Fuse fuzzy ranking + recency (Track 24.1).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { commandRegistry } from '../CommandRegistry';

function reg(name: string, description: string, whenToUse?: string) {
  commandRegistry.register({ name, description, whenToUse, action: () => {} });
}

describe('CommandRegistry.filter', () => {
  beforeEach(() => {
    commandRegistry.reset();
    reg('doctor', 'Run a health diagnostic report');
    reg('docs', 'Open the documentation');
    reg('clear', 'Clear the current conversation');
    reg('compact', 'Compact the conversation history', 'shrink long chats');
  });

  it('keeps exact-prefix matches as a hard top tier', () => {
    const r = commandRegistry.filter('doc');
    // /doctor and /docs both prefix-match and must precede any fuzzy result.
    expect(r.slice(0, 2).map((x) => x.command.name).sort()).toEqual(['docs', 'doctor']);
    expect(r[0].matchType).toBe('name');
  });

  it('surfaces a typo via fuzzy match (old startsWith would not)', () => {
    const r = commandRegistry.filter('dctr');
    expect(r.some((x) => x.command.name === 'doctor')).toBe(true);
  });

  it('matches on description/whenToUse and only ever returns name|description', () => {
    const r = commandRegistry.filter('shrink');
    expect(r.some((x) => x.command.name === 'compact')).toBe(true);
    for (const x of r) {
      expect(['name', 'description']).toContain(x.matchType);
    }
  });

  it('empty query returns all; recency reorders when provided', () => {
    const all = commandRegistry.filter('');
    expect(all).toHaveLength(4);
    // Legacy (no recency): localeCompare order.
    expect(all.map((x) => x.command.name)).toEqual(['clear', 'compact', 'docs', 'doctor']);

    const recency = new Map<string, number>([['compact', Date.now()]]);
    const withRecency = commandRegistry.filter('', recency);
    expect(withRecency[0].command.name).toBe('compact');
  });

  it('regression guard: absent recency keeps the exact-prefix tier in legacy localeCompare order', () => {
    const r = commandRegistry.filter('c');
    const prefix = r.filter((x) => x.command.name.startsWith('c')).map((x) => x.command.name);
    expect(prefix).toEqual(['clear', 'compact']);
  });
});
