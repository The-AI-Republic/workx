/**
 * Track 10: user-config substitution semantics.
 *
 * Covers the three-function model, the sensitive placeholder fingerprint,
 * non-recursive behavior, and CLAUDE_PLUGIN_OPTION_<KEY> env sanitization.
 */

import { describe, it, expect } from 'vitest';
import {
  substitutePluginVariables,
  substituteUserConfigVariables,
  substituteUserConfigInContent,
  buildPluginOptionEnvVars,
  sensitiveContentPlaceholder,
} from '../userConfigSubstitution';
import type { PluginUserConfigOption } from '../types';

describe('substitutePluginVariables', () => {
  it('substitutes CLAUDE_PLUGIN_ROOT', () => {
    const result = substitutePluginVariables('cd ${CLAUDE_PLUGIN_ROOT}/skills', {
      path: '/home/user/.airepublic-pi/plugins/foo',
    });
    expect(result).toBe('cd /home/user/.airepublic-pi/plugins/foo/skills');
  });

  it('substitutes CLAUDE_PLUGIN_DATA when dataPath present', () => {
    const result = substitutePluginVariables('cat ${CLAUDE_PLUGIN_DATA}/log.txt', {
      path: '/p',
      dataPath: '/var/lib/foo',
    });
    expect(result).toBe('cat /var/lib/foo/log.txt');
  });

  it('leaves CLAUDE_PLUGIN_DATA literal when dataPath absent', () => {
    const result = substitutePluginVariables('cat ${CLAUDE_PLUGIN_DATA}/log.txt', {
      path: '/p',
    });
    expect(result).toBe('cat ${CLAUDE_PLUGIN_DATA}/log.txt');
  });

  it('normalizes backslashes to forward slashes (Windows paths)', () => {
    const result = substitutePluginVariables('${CLAUDE_PLUGIN_ROOT}/x', {
      path: 'C:\\Users\\me\\plugins\\foo',
    });
    expect(result).toBe('C:/Users/me/plugins/foo/x');
  });

  it('does not reinterpret $$ / $\' / $& as replacement patterns', () => {
    // If we used a string-form replace, these would be eaten.
    const result = substitutePluginVariables('${CLAUDE_PLUGIN_ROOT}', {
      path: "/a/$$/b/$'/c/$&",
    });
    expect(result).toBe("/a/$$/b/$'/c/$&");
  });
});

describe('substituteUserConfigVariables (strict)', () => {
  it('substitutes a known key', () => {
    const result = substituteUserConfigVariables('token=${user_config.GH_TOKEN}', {
      GH_TOKEN: 'abc123',
    });
    expect(result).toBe('token=abc123');
  });

  it('throws on missing key (plugin authoring bug)', () => {
    expect(() =>
      substituteUserConfigVariables('${user_config.MISSING}', {}),
    ).toThrow(/Missing user_config value/);
  });

  it('substitutes sensitive values (passes to stdio/stdin)', () => {
    const result = substituteUserConfigVariables('${user_config.SECRET}', {
      SECRET: 'super-secret',
    });
    expect(result).toBe('super-secret');
  });

  it('coerces null/undefined values to empty string', () => {
    const result = substituteUserConfigVariables('x=${user_config.X}', {
      X: null,
    });
    expect(result).toBe('x=');
  });
});

describe('substituteUserConfigInContent (content-safe)', () => {
  const schema: Record<string, PluginUserConfigOption> = {
    GH_TOKEN: {
      type: 'string',
      title: 'GitHub Token',
      description: '...',
      sensitive: true,
    },
    MAX_RETRIES: {
      type: 'number',
      title: 'Max Retries',
      description: '...',
    },
  };

  it('renders sensitive values as the literal placeholder', () => {
    const result = substituteUserConfigInContent(
      'Use token: ${user_config.GH_TOKEN}',
      { GH_TOKEN: 'abc123' },
      schema,
    );
    expect(result).toBe(
      `Use token: ${sensitiveContentPlaceholder('GH_TOKEN')}`,
    );
  });

  it('substitutes non-sensitive known values', () => {
    const result = substituteUserConfigInContent(
      'Retries: ${user_config.MAX_RETRIES}',
      { MAX_RETRIES: 5 },
      schema,
    );
    expect(result).toBe('Retries: 5');
  });

  it('leaves unknown keys literal', () => {
    const result = substituteUserConfigInContent(
      'Foo: ${user_config.UNDECLARED}',
      {},
      schema,
    );
    expect(result).toBe('Foo: ${user_config.UNDECLARED}');
  });

  it('placeholder fingerprint is verbatim claudy-compatible', () => {
    // Plugins ported from claudy expect this exact string.
    expect(sensitiveContentPlaceholder('GH_TOKEN')).toBe(
      "[sensitive option 'GH_TOKEN' not available in skill content]",
    );
  });

  it('NOT recursive — substituted value containing ${...} is not re-scanned', () => {
    // If we resolve MAX_RETRIES to a string that contains a user_config ref,
    // it stays literal in the output.
    const result = substituteUserConfigInContent(
      '${user_config.MAX_RETRIES}',
      { MAX_RETRIES: '${user_config.GH_TOKEN}' },
      schema,
    );
    expect(result).toBe('${user_config.GH_TOKEN}');
  });
});

describe('buildPluginOptionEnvVars', () => {
  it('emits CLAUDE_PLUGIN_OPTION_<KEY> env vars, uppercased', () => {
    const env = buildPluginOptionEnvVars({
      GH_TOKEN: 'abc',
      MaxRetries: 5,
    });
    expect(env).toEqual({
      CLAUDE_PLUGIN_OPTION_GH_TOKEN: 'abc',
      CLAUDE_PLUGIN_OPTION_MAXRETRIES: '5',
    });
  });

  it('sanitizes non-identifier chars to underscore', () => {
    // Schema regex `/^[A-Za-z_]\w*$/` makes this a belt-and-suspenders;
    // still verify the sanitization itself.
    const env = buildPluginOptionEnvVars({ 'my-key.dot': 'v' });
    expect(env).toEqual({ CLAUDE_PLUGIN_OPTION_MY_KEY_DOT: 'v' });
  });

  it('sensitive values are INCLUDED in env (same trust boundary as hooks)', () => {
    // Caller (hook executor) decides which to pass; this helper doesn't gate.
    const env = buildPluginOptionEnvVars({ SECRET: 'leakable-to-hook-script' });
    expect(env.CLAUDE_PLUGIN_OPTION_SECRET).toBe('leakable-to-hook-script');
  });

  it('coerces null/undefined to empty string', () => {
    const env = buildPluginOptionEnvVars({ X: null, Y: undefined });
    expect(env.CLAUDE_PLUGIN_OPTION_X).toBe('');
    expect(env.CLAUDE_PLUGIN_OPTION_Y).toBe('');
  });
});
