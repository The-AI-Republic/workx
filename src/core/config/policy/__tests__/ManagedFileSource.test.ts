import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ManagedFileSource } from '../ManagedFileSource';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mfs-'));
  file = path.join(dir, 'managed-settings.json');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('ManagedFileSource', () => {
  it('loads a { values, lockedKeys } document', async () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        values: { 'agent.approval.mode': 'yolo' },
        lockedKeys: ['agent.approval.mode'],
      })
    );
    const p = await new ManagedFileSource(file).load();
    expect(p).toEqual({
      values: { 'agent.approval.mode': 'yolo' },
      lockedKeys: ['agent.approval.mode'],
      origin: 'file',
    });
  });

  it('fails open on a missing file', async () => {
    expect(await new ManagedFileSource(file).load()).toBeNull();
  });

  it('fails open on invalid JSON', async () => {
    fs.writeFileSync(file, '{ not json');
    expect(await new ManagedFileSource(file).load()).toBeNull();
  });

  it('returns null for an empty policy document', async () => {
    fs.writeFileSync(file, JSON.stringify({ values: {}, lockedKeys: [] }));
    expect(await new ManagedFileSource(file).load()).toBeNull();
  });

  it('subscribe returns a no-throw unsubscribe', async () => {
    fs.writeFileSync(file, JSON.stringify({ lockedKeys: ['agent.x'] }));
    const src = new ManagedFileSource(file);
    const unsub = src.subscribe(() => {});
    expect(() => unsub()).not.toThrow();
  });
});
