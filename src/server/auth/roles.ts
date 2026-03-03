/**
 * RBAC Role Definitions
 *
 * Defines roles, their default scopes, and scope-to-method mappings.
 *
 * @module server/auth/roles
 */

import type { Scope } from '@applepi/ws-server';

// ─────────────────────────────────────────────────────────────────────────
// Roles
// ─────────────────────────────────────────────────────────────────────────

export type Role = 'operator' | 'channel' | 'node';

/**
 * Default scopes granted to each role.
 */
export const ROLE_DEFAULTS: Record<Role, Scope[]> = {
  operator: [
    'chat',
    'sessions.read',
    'sessions.write',
    'config.read',
    'config.write',
    'operator.approvals',
    'operator.pairing',
    'admin',
  ],
  channel: ['chat', 'sessions.read'],
  node: ['node.invoke', 'node.event'],
};

// ─────────────────────────────────────────────────────────────────────────
// Scope helpers
// ─────────────────────────────────────────────────────────────────────────

/** All known scopes */
export const ALL_SCOPES: Scope[] = [
  'chat',
  'sessions.read',
  'sessions.write',
  'config.read',
  'config.write',
  'operator.approvals',
  'operator.pairing',
  'admin',
  'node.invoke',
  'node.event',
];

/**
 * Resolve effective scopes for a connection.
 *
 * If the client requests specific scopes, intersect with the role defaults.
 * Otherwise, grant the full role defaults.
 */
export function resolveScopes(role: Role, requestedScopes?: string[]): Scope[] {
  const defaults = ROLE_DEFAULTS[role];
  if (!requestedScopes || requestedScopes.length === 0) {
    return [...defaults];
  }

  // Intersect: only grant scopes that are both requested AND allowed for the role
  return requestedScopes.filter((s) => defaults.includes(s as Scope)) as Scope[];
}

/**
 * Check whether a role is valid.
 */
export function isValidRole(role: string): role is Role {
  return role === 'operator' || role === 'channel' || role === 'node';
}
