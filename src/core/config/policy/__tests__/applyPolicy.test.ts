import { describe, it, expect } from 'vitest';
import { applyPolicy } from '../applyPolicy';
import type { ResolvedPolicy } from '../types';

const policy = (
  values: Record<string, unknown>,
  lockedKeys: string[] = []
): ResolvedPolicy => ({ values, lockedKeys, origin: 'file' });

describe('applyPolicy', () => {
  it('deep-sets a nested value, defeating a one-level merge', () => {
    // Mimics the shape buildRuntimeConfig produces (one-level merged).
    const merged = {
      tools: { sandboxPolicy: { mode: 'workspace-write', network_access: true } },
    };
    applyPolicy(merged, policy({ 'agent.tools.sandboxPolicy.network_access': false }), 'agent');
    expect(merged.tools.sandboxPolicy.network_access).toBe(false);
    expect(merged.tools.sandboxPolicy.mode).toBe('workspace-write'); // sibling intact
  });

  it('replaces arrays (org allowlist is exactly the admin list)', () => {
    const merged = { approval: { trustedDomains: ['user.com'] } };
    applyPolicy(
      merged,
      policy({ 'agent.approval.trustedDomains': ['corp.com'] }),
      'agent'
    );
    expect(merged.approval.trustedDomains).toEqual(['corp.com']);
  });

  it('filters by namespace', () => {
    const target = { a: 1 };
    applyPolicy(
      target,
      policy({ 'server.a': 2, 'agent.a': 3 }),
      'agent'
    );
    expect(target.a).toBe(3); // only agent.* applied
  });

  it('stamps the runtime policy marker for the agent namespace', () => {
    const t: Record<string, unknown> = {};
    applyPolicy(
      t,
      policy({ 'agent.approval.mode': 'yolo' }, ['agent.approval.mode']),
      'agent'
    );
    expect(t.policy).toEqual({ lockedKeys: ['approval.mode'], origin: 'file' });
  });

  it('clears the marker when no policy is active', () => {
    const t: Record<string, unknown> = { policy: { lockedKeys: ['x'], origin: 'file' } };
    applyPolicy(t, null, 'agent');
    expect(t.policy).toBeUndefined();
  });

  it('does not stamp a marker for the server namespace', () => {
    const t: Record<string, unknown> = {};
    applyPolicy(t, policy({ 'server.port': 1 }, ['server.port']), 'server');
    expect(t.policy).toBeUndefined();
  });
});
