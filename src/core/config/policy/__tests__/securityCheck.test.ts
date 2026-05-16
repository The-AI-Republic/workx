import { describe, it, expect, beforeEach } from 'vitest';
import {
  assessPolicyChange,
  assessAndRecord,
  redactSecrets,
  __resetSecurityCheckForTests,
} from '../securityCheck';
import type { ResolvedPolicy } from '../types';

const pol = (values: Record<string, unknown>): ResolvedPolicy => ({
  values,
  lockedKeys: [],
  origin: 'remote',
});

describe('assessPolicyChange', () => {
  it('flags approval mode set to yolo', () => {
    const a = assessPolicyChange(
      pol({ 'agent.approval.mode': 'balanced' }),
      pol({ 'agent.approval.mode': 'yolo' })
    );
    expect(a.weakened).toBe(true);
    expect(a.changedKeys).toContain('agent.approval.mode');
    expect(a.reasons.join()).toMatch(/yolo/);
  });

  it('flags a widened trusted-domain allowlist', () => {
    const a = assessPolicyChange(
      pol({ 'agent.approval.trustedDomains': ['a.com'] }),
      pol({ 'agent.approval.trustedDomains': ['a.com', 'b.com'] })
    );
    expect(a.weakened).toBe(true);
  });

  it('flags a risky tool being enabled and sandbox network opening', () => {
    expect(
      assessPolicyChange(null, pol({ 'agent.tools.execCommand': true })).weakened
    ).toBe(true);
    expect(
      assessPolicyChange(
        null,
        pol({ 'agent.tools.sandboxPolicy.network_access': true })
      ).weakened
    ).toBe(true);
  });

  it('does not flag a neutral/strengthening change', () => {
    const a = assessPolicyChange(
      pol({ 'agent.approval.mode': 'yolo' }),
      pol({ 'agent.approval.mode': 'balanced' })
    );
    expect(a.weakened).toBe(false);
    expect(a.changedKeys).toContain('agent.approval.mode');
  });

  it('assessAndRecord is stateful across calls', () => {
    __resetSecurityCheckForTests();
    expect(assessAndRecord(pol({ 'agent.approval.mode': 'balanced' })).weakened).toBe(
      false
    );
    expect(assessAndRecord(pol({ 'agent.approval.mode': 'yolo' })).weakened).toBe(
      true
    );
  });
});

describe('redactSecrets', () => {
  beforeEach(() => __resetSecurityCheckForTests());

  it('redacts secret-bearing strings recursively', () => {
    const out = redactSecrets({
      a: 'sk-abcdefghijklmnopqrstuvwxyz',
      b: { c: 'Bearer tok_123', d: 'safe-value' },
      e: ['token: hunter2hunter2'],
    });
    expect(JSON.stringify(out)).not.toContain('sk-abcdefghijkl');
    expect(JSON.stringify(out)).not.toContain('hunter2');
    expect((out as any).b.d).toBe('safe-value');
  });
});
