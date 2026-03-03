import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { FileConfigStorageProvider } from '../FileConfigStorageProvider';

let tmpDir: string;
let storage: FileConfigStorageProvider;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'file-config-test-'));
  storage = new FileConfigStorageProvider(tmpDir);
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// ---------------------------------------------------------------------------
// get / set / remove
// ---------------------------------------------------------------------------

describe('get / set / remove', () => {
  it('returns null for missing key', async () => {
    expect(await storage.get('nonexistent')).toBeNull();
  });

  it('round-trips a string value', async () => {
    await storage.set('key1', 'hello');
    expect(await storage.get('key1')).toBe('hello');
  });

  it('round-trips an object value', async () => {
    const obj = { a: 1, b: [2, 3], c: { nested: true } };
    await storage.set('key2', obj);
    expect(await storage.get('key2')).toEqual(obj);
  });

  it('round-trips a number value', async () => {
    await storage.set('num', 42);
    expect(await storage.get('num')).toBe(42);
  });

  it('round-trips a boolean value', async () => {
    await storage.set('bool', false);
    expect(await storage.get('bool')).toBe(false);
  });

  it('removes a key', async () => {
    await storage.set('key3', 'value');
    await storage.remove('key3');
    expect(await storage.get('key3')).toBeNull();
  });

  it('remove on missing key does not throw', async () => {
    await expect(storage.remove('nonexistent')).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getMany / setMany / removeMany
// ---------------------------------------------------------------------------

describe('getMany / setMany / removeMany', () => {
  it('getMany returns matching keys', async () => {
    await storage.set('a', 1);
    await storage.set('b', 2);
    const result = await storage.getMany(['a', 'b', 'c']);
    expect(result).toEqual({ a: 1, b: 2 });
  });

  it('setMany stores multiple keys', async () => {
    await storage.setMany({ x: 'one', y: 'two', z: 'three' });
    expect(await storage.get('x')).toBe('one');
    expect(await storage.get('y')).toBe('two');
    expect(await storage.get('z')).toBe('three');
  });

  it('removeMany deletes multiple keys', async () => {
    await storage.setMany({ a: 1, b: 2, c: 3 });
    await storage.removeMany(['a', 'c']);
    expect(await storage.get('a')).toBeNull();
    expect(await storage.get('b')).toBe(2);
    expect(await storage.get('c')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// getAll / clear
// ---------------------------------------------------------------------------

describe('getAll / clear', () => {
  it('getAll returns all stored keys', async () => {
    await storage.setMany({ foo: 'bar', baz: 42 });
    const all = await storage.getAll();
    expect(all).toEqual({ foo: 'bar', baz: 42 });
  });

  it('getAll returns a copy', async () => {
    await storage.set('k', 'v');
    const all = await storage.getAll();
    all['k'] = 'modified';
    expect(await storage.get('k')).toBe('v');
  });

  it('clear removes all data', async () => {
    await storage.setMany({ a: 1, b: 2 });
    await storage.clear();
    expect(await storage.getAll()).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// getBytesInUse
// ---------------------------------------------------------------------------

describe('getBytesInUse', () => {
  it('returns null (not supported)', async () => {
    expect(await storage.getBytesInUse()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

describe('persistence', () => {
  it('persists data to disk and loads on new instance', async () => {
    await storage.set('persist', { value: true });

    // Create a new instance pointing at the same dir
    const storage2 = new FileConfigStorageProvider(tmpDir);
    expect(await storage2.get('persist')).toEqual({ value: true });
  });

  it('creates data dir if it does not exist', async () => {
    const nestedDir = path.join(tmpDir, 'sub', 'dir');
    const nestedStorage = new FileConfigStorageProvider(nestedDir);
    await nestedStorage.set('nested', 'yes');

    expect(fs.existsSync(path.join(nestedDir, 'config-storage.json'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Corrupt JSON handling
// ---------------------------------------------------------------------------

describe('corrupt JSON handling', () => {
  it('starts fresh when config file is corrupt', () => {
    const filePath = path.join(tmpDir, 'config-storage.json');
    fs.writeFileSync(filePath, '{corrupt json!!!');

    const corruptStorage = new FileConfigStorageProvider(tmpDir);
    // Should not throw, starts with empty data
    expect(corruptStorage).toBeDefined();
  });
});
