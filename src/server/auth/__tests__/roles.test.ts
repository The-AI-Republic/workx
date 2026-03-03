import { describe, it, expect } from 'vitest';
import { ROLE_DEFAULTS, ALL_SCOPES, resolveScopes, isValidRole } from '../roles';
import type { Role } from '../roles';

// ---------------------------------------------------------------------------
// ROLE_DEFAULTS
// ---------------------------------------------------------------------------

describe('ROLE_DEFAULTS', () => {
  it('operator has all operator scopes', () => {
    expect(ROLE_DEFAULTS.operator).toEqual([
      'chat',
      'sessions.read',
      'sessions.write',
      'config.read',
      'config.write',
      'operator.approvals',
      'operator.pairing',
      'admin',
    ]);
  });

  it('channel has limited scopes', () => {
    expect(ROLE_DEFAULTS.channel).toEqual(['chat', 'sessions.read']);
  });

  it('node has node-specific scopes', () => {
    expect(ROLE_DEFAULTS.node).toEqual(['node.invoke', 'node.event']);
  });

  it('no role has overlapping scope sets with node', () => {
    const nodeScopes = new Set(ROLE_DEFAULTS.node);
    const operatorScopes = new Set(ROLE_DEFAULTS.operator);
    const channelScopes = new Set(ROLE_DEFAULTS.channel);

    for (const scope of nodeScopes) {
      expect(operatorScopes.has(scope)).toBe(false);
      expect(channelScopes.has(scope)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// ALL_SCOPES
// ---------------------------------------------------------------------------

describe('ALL_SCOPES', () => {
  it('contains exactly 10 scopes', () => {
    expect(ALL_SCOPES).toHaveLength(10);
  });

  it('includes all scopes from all roles', () => {
    const allFromRoles = new Set([
      ...ROLE_DEFAULTS.operator,
      ...ROLE_DEFAULTS.channel,
      ...ROLE_DEFAULTS.node,
    ]);
    for (const scope of allFromRoles) {
      expect(ALL_SCOPES).toContain(scope);
    }
  });

  it('all ALL_SCOPES entries appear in at least one role', () => {
    const allFromRoles = new Set([
      ...ROLE_DEFAULTS.operator,
      ...ROLE_DEFAULTS.channel,
      ...ROLE_DEFAULTS.node,
    ]);
    for (const scope of ALL_SCOPES) {
      expect(allFromRoles.has(scope)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// resolveScopes
// ---------------------------------------------------------------------------

describe('resolveScopes', () => {
  it('returns full defaults when no scopes requested', () => {
    const scopes = resolveScopes('operator');
    expect(scopes).toEqual(ROLE_DEFAULTS.operator);
  });

  it('returns full defaults when empty array requested', () => {
    const scopes = resolveScopes('channel', []);
    expect(scopes).toEqual(ROLE_DEFAULTS.channel);
  });

  it('intersects requested scopes with role defaults', () => {
    const scopes = resolveScopes('operator', ['chat', 'admin', 'node.invoke']);
    expect(scopes).toEqual(['chat', 'admin']);
  });

  it('returns empty array when no intersection', () => {
    const scopes = resolveScopes('channel', ['admin', 'config.write']);
    expect(scopes).toEqual([]);
  });

  it('returns a copy, not a reference to ROLE_DEFAULTS', () => {
    const scopes = resolveScopes('node');
    expect(scopes).toEqual(ROLE_DEFAULTS.node);
    expect(scopes).not.toBe(ROLE_DEFAULTS.node);
  });
});

// ---------------------------------------------------------------------------
// isValidRole
// ---------------------------------------------------------------------------

describe('isValidRole', () => {
  it('returns true for valid roles', () => {
    expect(isValidRole('operator')).toBe(true);
    expect(isValidRole('channel')).toBe(true);
    expect(isValidRole('node')).toBe(true);
  });

  it('returns false for invalid roles', () => {
    expect(isValidRole('admin')).toBe(false);
    expect(isValidRole('')).toBe(false);
    expect(isValidRole('OPERATOR')).toBe(false);
  });
});
