import { describe, it, expect } from 'vitest';
import { isPolicyLocked, policyOrigin, managedTooltip } from '../policyLock';
import type { IAgentConfig } from '@/config/types';

const cfg = (lockedKeys: string[], origin: any = 'file') =>
  ({ policy: { lockedKeys, origin } } as Pick<IAgentConfig, 'policy'>);

describe('policyLock UI helper', () => {
  it('exact and ancestor matches are locked', () => {
    const c = cfg(['approval.mode', 'providers.openai']);
    expect(isPolicyLocked(c, 'approval.mode')).toBe(true);
    expect(isPolicyLocked(c, 'providers.openai.apiKey')).toBe(true);
    expect(isPolicyLocked(c, 'providers.xai.apiKey')).toBe(false);
  });

  it('no policy → nothing locked', () => {
    expect(isPolicyLocked(undefined, 'approval.mode')).toBe(false);
    expect(isPolicyLocked({ policy: undefined }, 'approval.mode')).toBe(false);
    expect(isPolicyLocked(cfg([]), 'approval.mode')).toBe(false);
  });

  it('origin + tooltip reflect the source', () => {
    expect(policyOrigin(cfg([], 'chrome-managed'))).toBe('chrome-managed');
    expect(managedTooltip(cfg([], 'file'))).toContain('source: file');
    expect(managedTooltip(undefined)).toContain('Managed by your organization');
  });
});
