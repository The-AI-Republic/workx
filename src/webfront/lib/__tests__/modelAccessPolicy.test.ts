import { describe, expect, it } from 'vitest';
import { modelAccessPolicy } from '../modelAccessPolicy';

describe('OSS model access policy', () => {
  it('does not impose account-based model locks', () => {
    expect(
      modelAccessPolicy.isLocked(
        { isAuthenticated: true, accountTier: 0 },
        { modelKey: 'any-built-in-model' },
      ),
    ).toBe(false);
  });

  it('does not impose a distribution-specific default model', () => {
    expect(
      modelAccessPolicy.getPreferredModelId(
        { isAuthenticated: true, accountTier: 0 },
        'initial',
      ),
    ).toBeNull();
  });
});
