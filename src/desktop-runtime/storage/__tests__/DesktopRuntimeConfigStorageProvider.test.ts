import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopRuntimeConfigStorageProvider } from '../DesktopRuntimeConfigStorageProvider';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'apcfg-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('DesktopRuntimeConfigStorageProvider', () => {
  it('writes valid JSON to the exact config.json path, no server-style files', async () => {
    const fp = join(dir, 'config.json');
    const p = new DesktopRuntimeConfigStorageProvider(fp);
    await p.set('a', { x: 1 });
    expect(JSON.parse(readFileSync(fp, 'utf-8'))).toEqual({ a: { x: 1 } });
    expect(existsSync(join(dir, 'config-storage.json'))).toBe(false);
    // temp file is renamed away atomically — none left behind
    expect(readdirSync(dir).filter((f) => f.endsWith('.config.tmp'))).toEqual([]);
  });

  it('preserves existing config on construction', async () => {
    const fp = join(dir, 'config.json');
    writeFileSync(fp, JSON.stringify({ existing: true }), 'utf-8');
    const p = new DesktopRuntimeConfigStorageProvider(fp);
    expect(await p.get('existing')).toBe(true);
  });

  it('reloads before write so a concurrent external write is not clobbered', async () => {
    const fp = join(dir, 'config.json');
    writeFileSync(fp, JSON.stringify({ keep: 1 }), 'utf-8');
    const p = new DesktopRuntimeConfigStorageProvider(fp);
    // An external writer (e.g. the legacy Tauri path) mutates the file after
    // this provider already cached its snapshot.
    writeFileSync(fp, JSON.stringify({ keep: 1, external: 2 }), 'utf-8');
    await p.set('mine', 3);
    expect(JSON.parse(readFileSync(fp, 'utf-8'))).toEqual({
      keep: 1,
      external: 2,
      mine: 3,
    });
  });
});
