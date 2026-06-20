/**
 * Track 10c: PluginOptions — non-sensitive→config, sensitive→credential
 * store, validation against the userConfig schema.
 */

import { describe, it, expect, vi } from 'vitest';
import { PluginOptions } from '../PluginOptions';
import type { PluginUserConfigOption } from '../types';

function makeOpts() {
  const config: Record<string, Record<string, unknown>> = {};
  const secrets: Record<string, Record<string, unknown>> = {};
  const o = new PluginOptions({
    getConfigOptions: (id) => config[id] ?? {},
    setConfigOptions: async (id, opts) => { config[id] = opts; },
    getSecrets: async (id) => secrets[id] ?? {},
    setSecret: async (id, k, v) => { (secrets[id] ??= {})[k] = v; },
    deleteSecrets: async (id) => { delete secrets[id]; },
  });
  return { o, config, secrets };
}

const STR: PluginUserConfigOption = { type: 'string', title: 'T', description: 'D' };
const SECRET: PluginUserConfigOption = { type: 'string', title: 'T', description: 'D', sensitive: true };
const NUM: PluginUserConfigOption = { type: 'number', title: 'T', description: 'D', min: 1, max: 10 };
const REQ: PluginUserConfigOption = { type: 'string', title: 'T', description: 'D', required: true };

describe('PluginOptions', () => {
  it('non-sensitive → config store; sensitive → credential store', async () => {
    const { o, config, secrets } = makeOpts();
    await o.set('p@m', 'MAX', 5, NUM);
    await o.set('p@m', 'TOKEN', 'abc', SECRET);
    expect(config['p@m']).toEqual({ MAX: 5 });
    expect(secrets['p@m']).toEqual({ TOKEN: 'abc' });
  });

  it('get merges with credential store winning on collision', async () => {
    const { o } = makeOpts();
    await o.set('p@m', 'K', 'config-val', STR);
    await o.set('p@m', 'K', 'secret-val', SECRET);
    expect(await o.get('p@m')).toEqual({ K: 'secret-val' });
  });

  it('validates number min/max', async () => {
    const { o } = makeOpts();
    await expect(o.set('p@m', 'N', 0, NUM)).rejects.toThrow(/>= 1/);
    await expect(o.set('p@m', 'N', 11, NUM)).rejects.toThrow(/<= 10/);
    await expect(o.set('p@m', 'N', 'x', NUM)).rejects.toThrow(/must be a number/);
  });

  it('validates required', async () => {
    const { o } = makeOpts();
    await expect(o.set('p@m', 'R', '', REQ)).rejects.toThrow(/required/);
    await expect(o.set('p@m', 'R', null, REQ)).rejects.toThrow(/required/);
  });

  it('delete wipes both stores', async () => {
    const { o, config, secrets } = makeOpts();
    await o.set('p@m', 'A', '1', STR);
    await o.set('p@m', 'S', 'x', SECRET);
    await o.delete('p@m');
    expect(config['p@m']).toEqual({});
    expect(secrets['p@m']).toBeUndefined();
  });
});
