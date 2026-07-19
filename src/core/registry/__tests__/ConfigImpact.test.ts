import { describe, expect, it } from 'vitest';
import { CONFIG_IMPACT, getConfigImpact } from '../ConfigImpact';

describe('CONFIG_IMPACT', () => {
  it('exhaustively maps every runtime config section', () => {
    expect(Object.keys(CONFIG_IMPACT).sort()).toEqual([
      'appServer', 'approval', 'cache', 'efficientModel', 'enabledPlugins', 'extension',
      'hooks', 'model', 'policy', 'preferences', 'profile', 'provider', 'security', 'tools',
    ]);
  });

  it('treats policy as a conservative full rebuild with every manager reload', () => {
    expect(getConfigImpact('policy')).toEqual({
      rebuild: ['full'],
      actions: ['reload-hooks', 'reload-approval', 'rebind-plugins'],
    });
  });
});
