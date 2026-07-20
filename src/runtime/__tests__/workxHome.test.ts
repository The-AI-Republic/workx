import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveWorkXHome } from '../workxHome';

describe('resolveWorkXHome', () => {
  it('shares ~/.workx by default and honors an absolute override', () => {
    expect(resolveWorkXHome({ env: {}, homeDir: '/home/alice' })).toBe(
      path.resolve('/home/alice/.workx')
    );
    expect(resolveWorkXHome({ env: { WORKX_HOME: '/srv/workx/alice' } })).toBe(
      path.resolve('/srv/workx/alice')
    );
  });

  it('rejects ambiguous relative overrides', () => {
    expect(() => resolveWorkXHome({ env: { WORKX_HOME: './workx' } })).toThrow(/absolute/);
  });
});
