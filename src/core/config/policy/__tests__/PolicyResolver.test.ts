import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerPolicySources,
  resolveActivePolicy,
  getActivePolicySync,
  getPolicyOrigin,
  getLockedKeys,
  getActivePolicySummary,
  onPolicyChanged,
  __resetPolicyResolverForTests,
} from '../PolicyResolver';
import type { PolicySource, ResolvedPolicy } from '../types';

function stub(
  origin: PolicySource['origin'],
  policy: ResolvedPolicy | null
): PolicySource {
  return { origin, load: async () => policy };
}

describe('PolicyResolver', () => {
  beforeEach(() => __resetPolicyResolverForTests());

  it('returns null when no source carries a policy', async () => {
    registerPolicySources([stub('file', null), stub('remote', { values: {}, lockedKeys: [], origin: 'remote' })]);
    expect(await resolveActivePolicy()).toBeNull();
    expect(getPolicyOrigin()).toBeNull();
  });

  it('first non-empty source wins; lower sources ignored', async () => {
    registerPolicySources([
      stub('remote', null),
      stub('file', { values: { 'agent.x': 1 }, lockedKeys: ['agent.x'], origin: 'file' }),
      stub('env', { values: { 'agent.x': 999 }, lockedKeys: [], origin: 'env' }),
    ]);
    const active = await resolveActivePolicy();
    expect(active?.origin).toBe('file');
    expect(active?.values).toEqual({ 'agent.x': 1 });
    expect(getActivePolicySync()).toBe(active);
  });

  it('a throwing source is skipped (fail-soft)', async () => {
    const boom: PolicySource = {
      origin: 'remote',
      load: async () => {
        throw new Error('network down');
      },
    };
    registerPolicySources([
      boom,
      stub('file', { values: { 'agent.y': 2 }, lockedKeys: [], origin: 'file' }),
    ]);
    const active = await resolveActivePolicy();
    expect(active?.origin).toBe('file');
  });

  it('getLockedKeys strips the namespace prefix and filters', async () => {
    registerPolicySources([
      stub('file', {
        values: {},
        lockedKeys: ['agent.approval.mode', 'server.exec.approvalPolicy'],
        origin: 'file',
      }),
    ]);
    await resolveActivePolicy();
    expect(getLockedKeys('agent')).toEqual(['approval.mode']);
    expect(getLockedKeys('server')).toEqual(['exec.approvalPolicy']);
  });

  it('notifies listeners only when the resolved policy changes', async () => {
    const seen: Array<string | null> = [];
    onPolicyChanged((p) => seen.push(p ? p.origin : null));
    registerPolicySources([stub('file', { values: { 'agent.a': 1 }, lockedKeys: [], origin: 'file' })]);
    await resolveActivePolicy();
    await resolveActivePolicy(); // unchanged — no second notify
    expect(seen).toEqual(['file']);
  });

  it('summary never exposes values', async () => {
    registerPolicySources([
      stub('file', {
        values: { 'agent.providers.openai.apiKey': 'sk-secret' },
        lockedKeys: ['agent.providers.openai'],
        origin: 'file',
      }),
    ]);
    await resolveActivePolicy();
    const s = getActivePolicySummary();
    expect(s).toEqual({
      origin: 'file',
      lockedKeys: ['agent.providers.openai'],
      valueCount: 1,
    });
    expect(JSON.stringify(s)).not.toContain('sk-secret');
  });
});
