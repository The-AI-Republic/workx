import { describe, it, expect } from 'vitest';
import { FileStateCache, normalizeCacheKey } from '../FileStateCache';

describe('normalizeCacheKey', () => {
  it('collapses ./ ../ and duplicate/backslash separators', () => {
    expect(normalizeCacheKey('/a/b/../c')).toBe('/a/c');
    expect(normalizeCacheKey('/a//b/./c')).toBe('/a/b/c');
    expect(normalizeCacheKey('\\a\\b')).toBe('/a/b');
  });
  it('keeps a windows drive prefix (case-folded)', () => {
    expect(normalizeCacheKey('C:\\a\\..\\b')).toBe('c:/b');
  });
  it('case-folds so read/edit casing differences collide (macOS/Windows)', () => {
    expect(normalizeCacheKey('/ws/Foo.ts')).toBe(normalizeCacheKey('/ws/foo.ts'));
    expect(normalizeCacheKey('/WS/SUB/File.TS')).toBe('/ws/sub/file.ts');
  });
});

describe('FileStateCache', () => {
  it('get/set/has by normalized key (path variants collide)', () => {
    const c = new FileStateCache();
    c.set('/w/a.ts', { content: 'x', mtimeFloorMs: 10, offset: 1 });
    expect(c.has('/w/./a.ts')).toBe(true);
    expect(c.get('/w/sub/../a.ts')?.content).toBe('x');
  });

  it('a Read under one casing is found when edited under another', () => {
    const c = new FileStateCache();
    c.set('/ws/Components/Button.tsx', { content: 'x', mtimeFloorMs: 5, offset: 1 });
    expect(c.get('/ws/components/button.tsx')?.content).toBe('x');
    expect(c.has('/WS/Components/Button.tsx')).toBe(true);
  });

  it('R2: read entry has offset set; edit entry undefined', () => {
    const c = new FileStateCache();
    c.set('/w/f', { content: 'a', mtimeFloorMs: 1, offset: 1 });
    expect(c.get('/w/f')?.offset).toBe(1);
    c.set('/w/f', { content: 'b', mtimeFloorMs: 2, offset: undefined });
    expect(c.get('/w/f')?.offset).toBeUndefined();
  });

  it('evicts oldest past the entry bound (LRU touch on get)', () => {
    const c = new FileStateCache(2, 1024 * 1024);
    c.set('/w/a', { content: 'a', mtimeFloorMs: 1, offset: 1 });
    c.set('/w/b', { content: 'b', mtimeFloorMs: 1, offset: 1 });
    c.get('/w/a'); // touch a → b now oldest
    c.set('/w/c', { content: 'c', mtimeFloorMs: 1, offset: 1 });
    expect(c.has('/w/b')).toBe(false);
    expect(c.has('/w/a')).toBe(true);
    expect(c.has('/w/c')).toBe(true);
  });

  it('evicts on byte bound', () => {
    const c = new FileStateCache(100, 10);
    c.set('/w/a', { content: 'x'.repeat(8), mtimeFloorMs: 1, offset: 1 });
    c.set('/w/b', { content: 'y'.repeat(8), mtimeFloorMs: 1, offset: 1 });
    expect(c.has('/w/a')).toBe(false);
    expect(c.size).toBe(1);
  });
});
