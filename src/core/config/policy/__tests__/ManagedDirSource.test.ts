import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ManagedDirSource } from '../ManagedDirSource';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mds-'));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('ManagedDirSource', () => {
  it('merges fragments in sorted filename order; later wins; lockedKeys union', async () => {
    fs.writeFileSync(
      path.join(dir, '10-base.json'),
      JSON.stringify({ values: { 'agent.a': 1, 'agent.b': 1 }, lockedKeys: ['agent.a'] })
    );
    fs.writeFileSync(
      path.join(dir, '20-override.json'),
      JSON.stringify({ values: { 'agent.b': 2 }, lockedKeys: ['agent.b'] })
    );
    const p = await new ManagedDirSource(dir).load();
    expect(p?.values).toEqual({ 'agent.a': 1, 'agent.b': 2 });
    expect(p?.lockedKeys.sort()).toEqual(['agent.a', 'agent.b']);
    expect(p?.origin).toBe('file');
  });

  it('skips a single bad fragment, ignores non-json', async () => {
    fs.writeFileSync(path.join(dir, 'bad.json'), '{ not json');
    fs.writeFileSync(path.join(dir, 'note.txt'), 'ignored');
    fs.writeFileSync(
      path.join(dir, 'ok.json'),
      JSON.stringify({ lockedKeys: ['agent.x'] })
    );
    const p = await new ManagedDirSource(dir).load();
    expect(p?.lockedKeys).toEqual(['agent.x']);
  });

  it('fails open on a missing directory and on an empty one', async () => {
    expect(await new ManagedDirSource(path.join(dir, 'nope')).load()).toBeNull();
    expect(await new ManagedDirSource(dir).load()).toBeNull();
  });
});
