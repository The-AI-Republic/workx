import type { CacheEntry, CacheConfig } from '../types/storage';
import type { StorageAdapter } from './StorageAdapter';
import { IndexedDBAdapter, STORE_NAMES } from './IndexedDBAdapter';

const DEFAULT_CONFIG: CacheConfig = {
  maxSize: 50 * 1024 * 1024, // 50MB
  defaultTTL: 3600000, // 1 hour
  evictionPolicy: 'lru',
  compressionThreshold: 50 * 1024, // Compress entries > 50KB
  persistToStorage: true
};

/**
 * Storage entry for IndexedDB rollout_cache store
 */
interface RolloutCacheEntry {
  key: string;
  entry: CacheEntry;
}

export class CacheManager {
  private memoryCache: Map<string, CacheEntry> = new Map();
  private accessOrder: string[] = [];
  private config: CacheConfig;
  private currentSize = 0;
  private compressionWorker: Worker | null = null;
  private dbAdapter: StorageAdapter;
  private initPromise: Promise<void> | null = null;

  constructor(config?: Partial<CacheConfig>, dbAdapter?: StorageAdapter) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.dbAdapter = dbAdapter || new IndexedDBAdapter();
    this.initializeCompressionWorker();
    // Initialize database in background
    this.initPromise = this.dbAdapter.initialize().catch(err => {
      console.error('Failed to initialize IndexedDB for CacheManager:', err);
      // Continue without persistent storage
      this.config.persistToStorage = false;
    });
  }

  /**
   * Ensure database is initialized before storage operations
   */
  private async ensureInitialized(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise;
    }
  }

  private initializeCompressionWorker(): void {
    // Create inline worker for compression if supported
    // Check for window to avoid errors in service worker initialization
    if (typeof Worker !== 'undefined' && typeof URL !== 'undefined' && typeof Blob !== 'undefined') {
      const workerCode = `
        self.onmessage = async function(e) {
          const { action, data } = e.data;

          if (action === 'compress') {
            try {
              const encoder = new TextEncoder();
              const bytes = encoder.encode(JSON.stringify(data));
              const cs = new CompressionStream('gzip');
              const writer = cs.writable.getWriter();
              writer.write(bytes);
              writer.close();

              const compressed = [];
              const reader = cs.readable.getReader();
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                compressed.push(value);
              }

              const blob = new Blob(compressed);
              const arrayBuffer = await blob.arrayBuffer();
              self.postMessage({ success: true, data: Array.from(new Uint8Array(arrayBuffer)) });
            } catch (error) {
              self.postMessage({ success: false, error: error.message });
            }
          }

          if (action === 'decompress') {
            try {
              const bytes = new Uint8Array(data);
              const ds = new DecompressionStream('gzip');
              const writer = ds.writable.getWriter();
              writer.write(bytes);
              writer.close();

              const decompressed = [];
              const reader = ds.readable.getReader();
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                decompressed.push(value);
              }

              const blob = new Blob(decompressed);
              const text = await blob.text();
              self.postMessage({ success: true, data: JSON.parse(text) });
            } catch (error) {
              self.postMessage({ success: false, error: error.message });
            }
          }
        };
      `;

      try {
        const blob = new Blob([workerCode], { type: 'application/javascript' });
        const workerUrl = URL.createObjectURL(blob);
        this.compressionWorker = new Worker(workerUrl);
      } catch (error) {
        console.warn('Failed to create compression worker:', error);
        this.compressionWorker = null;
      }
    }
  }

  async get(key: string): Promise<any | null> {
    // Check memory cache first
    const memEntry = this.memoryCache.get(key);
    if (memEntry && !this.isExpired(memEntry)) {
      memEntry.hits++;
      this.updateAccessOrder(key);
      return memEntry.compressed ? await this.decompress(memEntry.value) : memEntry.value;
    }

    // Check persistent storage if enabled
    if (this.config.persistToStorage) {
      try {
        await this.ensureInitialized();
        const stored = await this.dbAdapter.get<RolloutCacheEntry>(
          STORE_NAMES.ROLLOUT_CACHE,
          key
        );

        if (stored && stored.entry) {
          const entry = stored.entry;
          if (!this.isExpired(entry)) {
            // Update memory cache
            this.memoryCache.set(key, entry);
            this.currentSize += entry.size;
            this.updateAccessOrder(key);

            return entry.compressed ? await this.decompress(entry.value) : entry.value;
          } else {
            // Remove expired entry from storage
            await this.dbAdapter.delete(STORE_NAMES.ROLLOUT_CACHE, key);
          }
        }
      } catch (error) {
        console.error('Failed to read from IndexedDB storage:', error);
      }
    }

    return null;
  }

  async set(key: string, value: any, ttl?: number, tags?: string[]): Promise<void> {
    const size = this.calculateSize(value);

    // Check if eviction needed
    if (await this.shouldEvict(size)) {
      await this.evict(size);
    }

    // Compress if needed
    let finalValue = value;
    let compressed = false;
    if (size > this.config.compressionThreshold && this.compressionWorker) {
      try {
        finalValue = await this.compress(value);
        compressed = true;
      } catch (error) {
        console.warn('Compression failed, storing uncompressed:', error);
      }
    }

    const entry: CacheEntry = {
      key,
      value: finalValue,
      timestamp: Date.now(),
      ttl: ttl || this.config.defaultTTL,
      hits: 0,
      size: compressed ? this.calculateSize(finalValue) : size,
      compressed,
      tags
    };

    // Remove old entry if exists
    if (this.memoryCache.has(key)) {
      const oldEntry = this.memoryCache.get(key)!;
      this.currentSize -= oldEntry.size;
    }

    // Store in memory cache
    this.memoryCache.set(key, entry);
    this.currentSize += entry.size;
    this.updateAccessOrder(key);

    // Store in persistent storage if enabled
    if (this.config.persistToStorage) {
      try {
        await this.ensureInitialized();
        const rolloutEntry: RolloutCacheEntry = { key, entry };
        await this.dbAdapter.put(STORE_NAMES.ROLLOUT_CACHE, rolloutEntry);
      } catch (error) {
        console.error('Failed to persist to IndexedDB storage:', error);
        // If storage fails, keep in memory only
      }
    }
  }

  async delete(key: string): Promise<boolean> {
    const entry = this.memoryCache.get(key);
    if (entry) {
      this.currentSize -= entry.size;
      this.memoryCache.delete(key);
      this.removeFromAccessOrder(key);

      if (this.config.persistToStorage) {
        try {
          await this.ensureInitialized();
          await this.dbAdapter.delete(STORE_NAMES.ROLLOUT_CACHE, key);
        } catch (error) {
          console.error('Failed to remove from IndexedDB storage:', error);
        }
      }

      return true;
    }
    return false;
  }

  async clear(): Promise<void> {
    this.memoryCache.clear();
    this.accessOrder = [];
    this.currentSize = 0;

    if (this.config.persistToStorage) {
      try {
        await this.ensureInitialized();
        await this.dbAdapter.clear(STORE_NAMES.ROLLOUT_CACHE);
      } catch (error) {
        console.error('Failed to clear IndexedDB storage:', error);
      }
    }
  }

  async cleanup(): Promise<number> {
    let removedCount = 0;
    const now = Date.now();
    const keysToRemove: string[] = [];

    // Find expired entries
    for (const [key, entry] of this.memoryCache.entries()) {
      if (this.isExpired(entry, now)) {
        keysToRemove.push(key);
        this.currentSize -= entry.size;
        removedCount++;
      }
    }

    // Remove expired entries
    for (const key of keysToRemove) {
      this.memoryCache.delete(key);
      this.removeFromAccessOrder(key);
    }

    // Clean persistent storage
    if (this.config.persistToStorage && keysToRemove.length > 0) {
      try {
        await this.ensureInitialized();
        await this.dbAdapter.batchDelete(STORE_NAMES.ROLLOUT_CACHE, keysToRemove);
      } catch (error) {
        console.error('Failed to clean IndexedDB storage:', error);
      }
    }

    return removedCount;
  }

  async getByTags(tags: string[]): Promise<Map<string, any>> {
    const results = new Map<string, any>();

    for (const [key, entry] of this.memoryCache.entries()) {
      if (entry.tags && tags.some(tag => entry.tags?.includes(tag))) {
        if (!this.isExpired(entry)) {
          const value = entry.compressed ? await this.decompress(entry.value) : entry.value;
          results.set(key, value);
        }
      }
    }

    return results;
  }

  async deleteByTags(tags: string[]): Promise<number> {
    const keysToDelete: string[] = [];

    for (const [key, entry] of this.memoryCache.entries()) {
      if (entry.tags && tags.some(tag => entry.tags?.includes(tag))) {
        keysToDelete.push(key);
      }
    }

    let deletedCount = 0;
    for (const key of keysToDelete) {
      if (await this.delete(key)) {
        deletedCount++;
      }
    }

    return deletedCount;
  }

  getStatistics(): {
    entries: number;
    size: number;
    maxSize: number;
    hitRate: number;
    averageAge: number;
  } {
    const now = Date.now();
    let totalHits = 0;
    let totalAge = 0;

    for (const entry of this.memoryCache.values()) {
      totalHits += entry.hits;
      totalAge += now - entry.timestamp;
    }

    const entries = this.memoryCache.size;
    const averageAge = entries > 0 ? totalAge / entries : 0;
    const hitRate = entries > 0 ? totalHits / entries : 0;

    return {
      entries,
      size: this.currentSize,
      maxSize: this.config.maxSize,
      hitRate,
      averageAge
    };
  }

  private isExpired(entry: CacheEntry, now = Date.now()): boolean {
    return now - entry.timestamp > entry.ttl;
  }

  private calculateSize(value: any): number {
    // Rough estimate of object size in bytes
    const str = JSON.stringify(value);
    return new Blob([str]).size;
  }

  private async shouldEvict(requiredSize: number): Promise<boolean> {
    return this.currentSize + requiredSize > this.config.maxSize;
  }

  private async evict(requiredSize: number): Promise<void> {
    const targetSize = this.config.maxSize - requiredSize;

    switch (this.config.evictionPolicy) {
      case 'lru':
        await this.evictLRU(targetSize);
        break;
      case 'lfu':
        await this.evictLFU(targetSize);
        break;
      case 'fifo':
        await this.evictFIFO(targetSize);
        break;
    }
  }

  private async evictLRU(targetSize: number): Promise<void> {
    while (this.currentSize > targetSize && this.accessOrder.length > 0) {
      const key = this.accessOrder.shift()!;
      await this.delete(key);
    }
  }

  private async evictLFU(targetSize: number): Promise<void> {
    // Sort by hits (least frequently used first)
    const entries = Array.from(this.memoryCache.entries())
      .sort((a, b) => a[1].hits - b[1].hits);

    for (const [key] of entries) {
      if (this.currentSize <= targetSize) break;
      await this.delete(key);
    }
  }

  private async evictFIFO(targetSize: number): Promise<void> {
    // Sort by timestamp (oldest first)
    const entries = Array.from(this.memoryCache.entries())
      .sort((a, b) => a[1].timestamp - b[1].timestamp);

    for (const [key] of entries) {
      if (this.currentSize <= targetSize) break;
      await this.delete(key);
    }
  }

  private updateAccessOrder(key: string): void {
    // Remove from current position
    this.removeFromAccessOrder(key);
    // Add to end (most recently used)
    this.accessOrder.push(key);
  }

  private removeFromAccessOrder(key: string): void {
    const index = this.accessOrder.indexOf(key);
    if (index !== -1) {
      this.accessOrder.splice(index, 1);
    }
  }

  private async compress(data: any): Promise<any> {
    // Lazy initialize worker on first use
    if (!this.compressionWorker) {
      this.initializeCompressionWorker();
    }

    if (!this.compressionWorker) {
      throw new Error('Compression worker not available');
    }

    return new Promise((resolve, reject) => {
      const handler = (event: MessageEvent) => {
        this.compressionWorker!.removeEventListener('message', handler);
        if (event.data.success) {
          resolve(event.data.data);
        } else {
          reject(new Error(event.data.error));
        }
      };

      this.compressionWorker!.addEventListener('message', handler);
      this.compressionWorker!.postMessage({ action: 'compress', data });
    });
  }

  private async decompress(data: any): Promise<any> {
    // Lazy initialize worker on first use
    if (!this.compressionWorker) {
      this.initializeCompressionWorker();
    }

    if (!this.compressionWorker) {
      throw new Error('Compression worker not available');
    }

    return new Promise((resolve, reject) => {
      const handler = (event: MessageEvent) => {
        this.compressionWorker!.removeEventListener('message', handler);
        if (event.data.success) {
          resolve(event.data.data);
        } else {
          reject(new Error(event.data.error));
        }
      };

      this.compressionWorker!.addEventListener('message', handler);
      this.compressionWorker!.postMessage({ action: 'decompress', data });
    });
  }

  async destroy(): Promise<void> {
    if (this.compressionWorker) {
      this.compressionWorker.terminate();
      this.compressionWorker = null;
    }
    this.memoryCache.clear();
    this.accessOrder = [];
    this.currentSize = 0;

    // Close database connection
    await this.dbAdapter.close();
  }
}