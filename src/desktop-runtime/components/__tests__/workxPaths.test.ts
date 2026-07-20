import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { componentPlatform } from '../builtinCatalog';
import { resolveWorkXPaths } from '../workxPaths';

describe('WorkX private runtime paths', () => {
  it('defaults to a shared ~/.workx root', () => {
    expect(resolveWorkXPaths({ env: {}, homeDir: '/home/alice' })).toEqual({
      root: path.resolve('/home/alice/.workx'),
      components: path.resolve('/home/alice/.workx/components'),
      downloads: path.resolve('/home/alice/.workx/downloads'),
      workspaces: path.resolve('/home/alice/.workx/workspaces'),
      logs: path.resolve('/home/alice/.workx/logs'),
    });
  });

  it('accepts an absolute WORKX_HOME and rejects relative overrides', () => {
    expect(resolveWorkXPaths({ env: { WORKX_HOME: '/opt/workx-user' } }).root).toBe(
      path.resolve('/opt/workx-user')
    );
    expect(() => resolveWorkXPaths({ env: { WORKX_HOME: 'relative/workx' } })).toThrow(/absolute/);
  });

  it('normalizes supported Node platform and architecture pairs', () => {
    expect(componentPlatform('linux', 'x64')).toBe('linux-x64');
    expect(componentPlatform('darwin', 'arm64')).toBe('darwin-arm64');
    expect(componentPlatform('win32', 'arm64')).toBe('win32-arm64');
    expect(componentPlatform('aix', 'ppc64')).toBeNull();
  });
});
