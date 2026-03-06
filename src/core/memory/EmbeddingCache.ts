import type { EmbeddingProvider } from './EmbeddingClient';

/**
 * LRU cache wrapper around an EmbeddingProvider.
 * Caches embedding results in memory to avoid duplicate API calls.
 */
export class CachedEmbeddingProvider implements EmbeddingProvider {
  private provider: EmbeddingProvider;
  private cache: Map<string, Float32Array>;
  private maxSize: number;
  private hits = 0;
  private misses = 0;

  constructor(provider: EmbeddingProvider, maxSize: number = 100) {
    this.provider = provider;
    this.cache = new Map();
    this.maxSize = maxSize;
  }

  async embed(text: string): Promise<Float32Array> {
    // M3: Normalize text consistently for both cache key AND provider call
    const normalized = text.replace(/\n/g, ' ').trim();
    const cached = this.cache.get(normalized);
    if (cached) {
      this.hits++;
      // Move to end (most recently used) by re-inserting
      this.cache.delete(normalized);
      this.cache.set(normalized, cached);
      return cached;
    }

    this.misses++;
    const result = await this.provider.embed(normalized);
    this.set(normalized, result);
    return result;
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    // M3: Normalize all texts consistently
    const normalized = texts.map((t) => t.replace(/\n/g, ' ').trim());
    const results: (Float32Array | null)[] = new Array(normalized.length).fill(null);
    const uncachedIndices: number[] = [];
    const uncachedTexts: string[] = [];

    // Check cache for each text
    for (let i = 0; i < normalized.length; i++) {
      const cached = this.cache.get(normalized[i]);
      if (cached) {
        this.hits++;
        // Move to end (LRU)
        this.cache.delete(normalized[i]);
        this.cache.set(normalized[i], cached);
        results[i] = cached;
      } else {
        this.misses++;
        uncachedIndices.push(i);
        uncachedTexts.push(normalized[i]);
      }
    }

    // Batch-embed uncached (already normalized) texts
    if (uncachedTexts.length > 0) {
      const embeddings = await this.provider.embedBatch(uncachedTexts);
      for (let j = 0; j < uncachedIndices.length; j++) {
        const idx = uncachedIndices[j];
        results[idx] = embeddings[j];
        this.set(normalized[idx], embeddings[j]);
      }
    }

    return results as Float32Array[];
  }

  getDimensions(): number {
    return this.provider.getDimensions();
  }

  getStats() {
    return { hits: this.hits, misses: this.misses, size: this.cache.size };
  }

  clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }

  private set(key: string, value: Float32Array): void {
    // Evict oldest if at capacity
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) {
        this.cache.delete(firstKey);
      }
    }
    this.cache.set(key, value);
  }
}
