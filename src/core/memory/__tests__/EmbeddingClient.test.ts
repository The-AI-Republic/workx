/**
 * Unit tests for EmbeddingClient (EMBEDDING_CONFIG)
 * and CachedEmbeddingProvider.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EMBEDDING_CONFIG, type EmbeddingProvider } from '../EmbeddingClient';
import { CachedEmbeddingProvider } from '../EmbeddingCache';

// ---------------------------------------------------------------------------
// EMBEDDING_CONFIG
// ---------------------------------------------------------------------------

describe('EMBEDDING_CONFIG', () => {
  it('is hardcoded to OpenAI text-embedding-3-small at 1536 dims', () => {
    expect(EMBEDDING_CONFIG.model).toBe('text-embedding-3-small');
    expect(EMBEDDING_CONFIG.dimensions).toBe(1536);
  });
});

// ---------------------------------------------------------------------------
// CachedEmbeddingProvider
// ---------------------------------------------------------------------------

describe('CachedEmbeddingProvider', () => {
  let mockProvider: EmbeddingProvider;
  let cached: CachedEmbeddingProvider;

  beforeEach(() => {
    mockProvider = {
      embed: vi.fn().mockResolvedValue(new Float32Array([1.0, 2.0, 3.0])),
      embedBatch: vi.fn().mockImplementation((texts: string[]) =>
        Promise.resolve(
          texts.map((_, i) => new Float32Array([i + 1, i + 2, i + 3]))
        )
      ),
      getDimensions: vi.fn().mockReturnValue(3),
    };
    cached = new CachedEmbeddingProvider(mockProvider, 5);
  });

  // ---- embed ----

  describe('embed', () => {
    it('calls underlying provider on cache miss', async () => {
      const result = await cached.embed('hello world');
      expect(mockProvider.embed).toHaveBeenCalledWith('hello world');
      expect(result).toEqual(new Float32Array([1.0, 2.0, 3.0]));
    });

    it('returns cached result on cache hit', async () => {
      await cached.embed('hello');
      await cached.embed('hello');

      expect(mockProvider.embed).toHaveBeenCalledTimes(1);
      const stats = cached.getStats();
      expect(stats.hits).toBe(1);
      expect(stats.misses).toBe(1);
    });

    it('uses distinct cache keys for different texts (avoids normalization collisions)', async () => {
      await cached.embed('hello\nworld');
      await cached.embed('hello world');

      // These are semantically distinct inputs and should not collide
      expect(mockProvider.embed).toHaveBeenCalledTimes(2);
    });

    it('normalizes newlines for provider call but caches by original', async () => {
      await cached.embed('hello\nworld');

      // Provider should receive normalized text (newline→space)
      expect(mockProvider.embed).toHaveBeenCalledWith('hello world');

      // Same original text hits cache
      await cached.embed('hello\nworld');
      expect(mockProvider.embed).toHaveBeenCalledTimes(1);
    });

    it('normalizes leading/trailing whitespace', async () => {
      await cached.embed('  hello  ');
      await cached.embed('hello');

      expect(mockProvider.embed).toHaveBeenCalledTimes(1);
    });
  });

  // ---- embedBatch ----

  describe('embedBatch', () => {
    it('fetches all texts on first call', async () => {
      const results = await cached.embedBatch(['a', 'b', 'c']);
      expect(mockProvider.embedBatch).toHaveBeenCalledWith(['a', 'b', 'c']);
      expect(results).toHaveLength(3);
    });

    it('skips cached texts in batch', async () => {
      // Pre-cache 'a'
      await cached.embed('a');
      vi.mocked(mockProvider.embed).mockClear();

      // Now batch with 'a' and 'b'
      await cached.embedBatch(['a', 'b']);

      // Only 'b' should go to the provider
      expect(mockProvider.embedBatch).toHaveBeenCalledWith(['b']);
    });

    it('returns results in correct order when mixing cached/uncached', async () => {
      // Cache 'b' with a specific embedding
      (mockProvider.embed as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        new Float32Array([10, 20, 30])
      );
      await cached.embed('b');

      // Batch request: [a, b, c]
      (mockProvider.embedBatch as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
        new Float32Array([1, 2, 3]),  // for 'a'
        new Float32Array([7, 8, 9]),  // for 'c'
      ]);

      const results = await cached.embedBatch(['a', 'b', 'c']);

      expect(results[0]).toEqual(new Float32Array([1, 2, 3]));    // 'a' from provider
      expect(results[1]).toEqual(new Float32Array([10, 20, 30])); // 'b' from cache
      expect(results[2]).toEqual(new Float32Array([7, 8, 9]));    // 'c' from provider
    });

    it('does not call provider when all texts are cached', async () => {
      await cached.embedBatch(['x', 'y']);
      vi.mocked(mockProvider.embedBatch).mockClear();

      await cached.embedBatch(['x', 'y']);
      expect(mockProvider.embedBatch).not.toHaveBeenCalled();
    });
  });

  // ---- LRU eviction ----

  describe('LRU eviction', () => {
    it('evicts oldest entry when maxSize is exceeded', async () => {
      // maxSize is 5
      for (let i = 0; i < 6; i++) {
        (mockProvider.embed as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
          new Float32Array([i])
        );
        await cached.embed(`text-${i}`);
      }

      const stats = cached.getStats();
      expect(stats.size).toBe(5);

      // text-0 should have been evicted
      vi.mocked(mockProvider.embed).mockClear();
      (mockProvider.embed as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        new Float32Array([99])
      );
      await cached.embed('text-0');
      // Should be a miss (re-fetched)
      expect(mockProvider.embed).toHaveBeenCalledWith('text-0');
    });

    it('accessing a cached item refreshes its position (LRU)', async () => {
      // Fill cache: text-0, text-1, text-2, text-3, text-4
      for (let i = 0; i < 5; i++) {
        (mockProvider.embed as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
          new Float32Array([i])
        );
        await cached.embed(`text-${i}`);
      }

      // Access text-0 (moves to most recent)
      await cached.embed('text-0');

      // Add text-5 → should evict text-1 (oldest unused), not text-0
      (mockProvider.embed as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        new Float32Array([5])
      );
      await cached.embed('text-5');

      // text-0 should still be cached
      vi.mocked(mockProvider.embed).mockClear();
      await cached.embed('text-0');
      expect(mockProvider.embed).not.toHaveBeenCalled();

      // text-1 should have been evicted
      (mockProvider.embed as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        new Float32Array([1])
      );
      await cached.embed('text-1');
      expect(mockProvider.embed).toHaveBeenCalledWith('text-1');
    });
  });

  // ---- getDimensions ----

  describe('getDimensions', () => {
    it('delegates to underlying provider', () => {
      expect(cached.getDimensions()).toBe(3);
      expect(mockProvider.getDimensions).toHaveBeenCalled();
    });
  });

  // ---- getStats ----

  describe('getStats', () => {
    it('returns initial stats of 0/0/0', () => {
      expect(cached.getStats()).toEqual({ hits: 0, misses: 0, size: 0 });
    });

    it('tracks hits and misses correctly', async () => {
      await cached.embed('a'); // miss
      await cached.embed('a'); // hit
      await cached.embed('b'); // miss
      await cached.embed('a'); // hit

      expect(cached.getStats()).toEqual({ hits: 2, misses: 2, size: 2 });
    });
  });

  // ---- clear ----

  describe('clear', () => {
    it('resets cache and stats', async () => {
      await cached.embed('a');
      await cached.embed('a');

      cached.clear();

      expect(cached.getStats()).toEqual({ hits: 0, misses: 0, size: 0 });

      // Next call should be a miss
      await cached.embed('a');
      expect(cached.getStats().misses).toBe(1);
    });
  });
});
