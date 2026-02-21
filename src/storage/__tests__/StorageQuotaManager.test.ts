import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import '../../__test-utils__/chrome-storage-mock';
import { StorageQuotaManager } from '@/storage/StorageQuotaManager';
import type { CacheManager } from '@/storage/CacheManager';

// Mock the RolloutRecorder module
vi.mock('@/storage/rollout', () => ({
  RolloutRecorder: {
    getStorageStats: vi.fn().mockResolvedValue({
      rolloutCount: 5,
      itemCount: 100,
      rolloutBytes: 5000,
      itemBytes: 50000,
    }),
    cleanupExpired: vi.fn().mockResolvedValue(3),
  },
}));

// Helper to get the mocked RolloutRecorder (import is hoisted due to vi.mock)
async function getMockedRolloutRecorder() {
  const { RolloutRecorder } = await import('@/storage/rollout');
  return vi.mocked(RolloutRecorder);
}

/**
 * Reads a Blob as text. We temporarily restore real timers because
 * FileReader callbacks do not fire under vi.useFakeTimers().
 */
async function readBlobAsText(blob: Blob): Promise<string> {
  vi.useRealTimers();
  try {
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsText(blob);
    });
  } finally {
    vi.useFakeTimers();
  }
}

/**
 * Creates a mock CacheManager with configurable behavior.
 */
function createMockCacheManager(overrides?: Partial<CacheManager>): CacheManager {
  return {
    getStatistics: vi.fn().mockReturnValue({
      entries: 10,
      size: 2048,
      maxSize: 50 * 1024 * 1024,
      hitRate: 0.85,
      averageAge: 60000,
    }),
    cleanup: vi.fn().mockResolvedValue(5),
    clear: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as CacheManager;
}

/**
 * Sets up navigator.storage mock with configurable quota values.
 */
function mockNavigatorStorage(opts: {
  usage?: number;
  quota?: number;
  persisted?: boolean;
  persistResult?: boolean;
  estimateError?: boolean;
  persistedError?: boolean;
} = {}) {
  const {
    usage = 1000,
    quota = 10000,
    persisted = false,
    persistResult = true,
    estimateError = false,
    persistedError = false,
  } = opts;

  const storageMock = {
    estimate: estimateError
      ? vi.fn().mockRejectedValue(new Error('estimate failed'))
      : vi.fn().mockResolvedValue({ usage, quota }),
    persisted: persistedError
      ? vi.fn().mockRejectedValue(new Error('persisted check failed'))
      : vi.fn().mockResolvedValue(persisted),
    persist: vi.fn().mockResolvedValue(persistResult),
  };

  Object.defineProperty(navigator, 'storage', {
    value: storageMock,
    writable: true,
    configurable: true,
  });

  return storageMock;
}

/**
 * Removes navigator.storage to simulate browsers without the Storage API.
 * We must delete the property so that `'storage' in navigator` returns false.
 */
function removeNavigatorStorage() {
  // First make it configurable/deletable, then delete it
  Object.defineProperty(navigator, 'storage', {
    value: undefined,
    writable: true,
    configurable: true,
  });
  delete (navigator as any).storage;
}

describe('StorageQuotaManager', () => {
  let manager: StorageQuotaManager;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    // Reset mock implementations to defaults before each test
    const RolloutRecorder = await getMockedRolloutRecorder();
    vi.mocked(RolloutRecorder.getStorageStats).mockResolvedValue({
      rolloutCount: 5,
      itemCount: 100,
      rolloutBytes: 5000,
      itemBytes: 50000,
    });
    vi.mocked(RolloutRecorder.cleanupExpired).mockResolvedValue(3);
  });

  afterEach(() => {
    manager?.destroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // =========================================================================
  // 1. Constructor and Initialization
  // =========================================================================
  describe('constructor', () => {
    it('should create an instance without arguments', () => {
      manager = new StorageQuotaManager();
      expect(manager).toBeInstanceOf(StorageQuotaManager);
    });

    it('should create an instance with a CacheManager', () => {
      const mockCache = createMockCacheManager();
      manager = new StorageQuotaManager(mockCache);
      expect(manager).toBeInstanceOf(StorageQuotaManager);
    });
  });

  describe('initialize', () => {
    it('should initialize and start quota monitoring', async () => {
      mockNavigatorStorage({ persisted: true });
      manager = new StorageQuotaManager();
      const spy = vi.spyOn(manager, 'startQuotaMonitoring');
      await manager.initialize();
      expect(spy).toHaveBeenCalled();
    });

    it('should accept a cacheManager parameter during initialization', async () => {
      mockNavigatorStorage({ persisted: true });
      const mockCache = createMockCacheManager();
      manager = new StorageQuotaManager();
      await manager.initialize(mockCache);
      // After initialization with cache manager, getDetailedStats should use it
      const stats = await manager.getDetailedStats();
      expect(mockCache.getStatistics).toHaveBeenCalled();
      expect(stats.cache.entries).toBe(10);
    });
  });

  // =========================================================================
  // 2. fallbackEstimate() (tested via getQuota when navigator.storage missing)
  // =========================================================================
  describe('fallbackEstimate (via getQuota)', () => {
    it('should return default fallback when navigator.storage is unavailable', async () => {
      removeNavigatorStorage();
      manager = new StorageQuotaManager();
      const quota = await manager.getQuota();
      expect(quota).toEqual({
        usage: 0,
        quota: 5 * 1024 * 1024 * 1024,
        percentage: 0,
        persistent: false,
      });
    });

    it('should return fallback when navigator.storage.estimate throws', async () => {
      mockNavigatorStorage({ estimateError: true });
      manager = new StorageQuotaManager();
      const quota = await manager.getQuota();
      expect(quota.usage).toBe(0);
      expect(quota.quota).toBe(5 * 1024 * 1024 * 1024);
      expect(quota.percentage).toBe(0);
      expect(quota.persistent).toBe(false);
    });
  });

  // =========================================================================
  // 3. getQuota()
  // =========================================================================
  describe('getQuota', () => {
    it('should return correct quota info from navigator.storage', async () => {
      mockNavigatorStorage({ usage: 5000, quota: 10000, persisted: true });
      manager = new StorageQuotaManager();
      const quota = await manager.getQuota();
      expect(quota.usage).toBe(5000);
      expect(quota.quota).toBe(10000);
      expect(quota.percentage).toBe(50);
      expect(quota.persistent).toBe(true);
    });

    it('should handle zero quota without division by zero', async () => {
      mockNavigatorStorage({ usage: 0, quota: 0 });
      manager = new StorageQuotaManager();
      const quota = await manager.getQuota();
      expect(quota.percentage).toBe(0);
    });

    it('should handle missing usage/quota fields in estimate', async () => {
      const storageMock = {
        estimate: vi.fn().mockResolvedValue({}),
        persisted: vi.fn().mockResolvedValue(false),
      };
      Object.defineProperty(navigator, 'storage', {
        value: storageMock,
        writable: true,
        configurable: true,
      });
      manager = new StorageQuotaManager();
      const quota = await manager.getQuota();
      expect(quota.usage).toBe(0);
      expect(quota.quota).toBe(0);
      expect(quota.percentage).toBe(0);
    });
  });

  // =========================================================================
  // 4. setThresholds()
  // =========================================================================
  describe('setThresholds', () => {
    it('should accept valid thresholds', () => {
      manager = new StorageQuotaManager();
      expect(() => manager.setThresholds(50, 90)).not.toThrow();
    });

    it('should accept boundary thresholds (0 and 100)', () => {
      manager = new StorageQuotaManager();
      expect(() => manager.setThresholds(0, 100)).not.toThrow();
    });

    it('should throw if warning is negative', () => {
      manager = new StorageQuotaManager();
      expect(() => manager.setThresholds(-1, 90)).toThrow(
        'Thresholds must be between 0 and 100'
      );
    });

    it('should throw if critical is above 100', () => {
      manager = new StorageQuotaManager();
      expect(() => manager.setThresholds(50, 101)).toThrow(
        'Thresholds must be between 0 and 100'
      );
    });

    it('should throw if warning >= critical', () => {
      manager = new StorageQuotaManager();
      expect(() => manager.setThresholds(90, 90)).toThrow(
        'Warning threshold must be less than critical threshold'
      );
    });

    it('should throw if warning > critical', () => {
      manager = new StorageQuotaManager();
      expect(() => manager.setThresholds(95, 80)).toThrow(
        'Warning threshold must be less than critical threshold'
      );
    });

    it('should affect shouldCleanup behavior after being set', async () => {
      // Set usage to 60% -> with default thresholds (80) should NOT need cleanup
      mockNavigatorStorage({ usage: 6000, quota: 10000 });
      manager = new StorageQuotaManager();

      const beforeChange = await manager.shouldCleanup();
      expect(beforeChange).toBe(false);

      // Lower warning threshold to 50 -> now 60% is above it
      manager.setThresholds(50, 90);
      const afterChange = await manager.shouldCleanup();
      expect(afterChange).toBe(true);
    });
  });

  // =========================================================================
  // 5. formatBytes() (private, tested via checkQuotaImmediate log output)
  // =========================================================================
  describe('formatBytes (via startQuotaMonitoring log)', () => {
    // formatBytes is private, so we exercise it through startQuotaMonitoring
    // which calls checkQuotaImmediate which logs formatted bytes.

    it('should format 0 bytes as "0 Bytes"', async () => {
      mockNavigatorStorage({ usage: 0, quota: 10000 });
      manager = new StorageQuotaManager();
      manager.startQuotaMonitoring(10);
      await vi.advanceTimersByTimeAsync(0);
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('0 Bytes')
      );
    });

    it('should format bytes < 1024 as "X Bytes"', async () => {
      mockNavigatorStorage({ usage: 512, quota: 10000 });
      manager = new StorageQuotaManager();
      manager.startQuotaMonitoring(10);
      await vi.advanceTimersByTimeAsync(0);
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('512 Bytes')
      );
    });

    it('should format kilobytes correctly', async () => {
      mockNavigatorStorage({ usage: 2048, quota: 1048576 });
      manager = new StorageQuotaManager();
      manager.startQuotaMonitoring(10);
      await vi.advanceTimersByTimeAsync(0);
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('2 KB')
      );
    });

    it('should format megabytes correctly', async () => {
      mockNavigatorStorage({ usage: 5242880, quota: 1073741824 });
      manager = new StorageQuotaManager();
      manager.startQuotaMonitoring(10);
      await vi.advanceTimersByTimeAsync(0);
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('5 MB')
      );
    });

    it('should format gigabytes correctly', async () => {
      const oneGB = 1073741824;
      mockNavigatorStorage({ usage: 2 * oneGB, quota: 5 * oneGB });
      manager = new StorageQuotaManager();
      manager.startQuotaMonitoring(10);
      await vi.advanceTimersByTimeAsync(0);
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining('2 GB')
      );
    });
  });

  // =========================================================================
  // 6. cleanup()
  // =========================================================================
  describe('cleanup', () => {
    it('should return early if already below target percentage', async () => {
      mockNavigatorStorage({ usage: 3000, quota: 10000 }); // 30%
      manager = new StorageQuotaManager();
      const result = await manager.cleanup(50);
      expect(result.conversationsDeleted).toBe(0);
      expect(result.cacheEntriesRemoved).toBe(0);
      expect(result.rolloutsDeleted).toBe(0);
      expect(result.spaceFreed).toBe(0);
    });

    it('should clean expired rollouts when above target', async () => {
      const RolloutRecorder = await getMockedRolloutRecorder();
      // 80% usage, target 50%
      mockNavigatorStorage({ usage: 8000, quota: 10000 });
      manager = new StorageQuotaManager();
      const result = await manager.cleanup(50);
      expect(RolloutRecorder.cleanupExpired).toHaveBeenCalled();
      expect(result.rolloutsDeleted).toBe(3);
    });

    it('should clean cache entries if rollout cleanup is insufficient', async () => {
      // After rollout cleanup, still above target
      mockNavigatorStorage({ usage: 8000, quota: 10000 });
      const mockCache = createMockCacheManager();
      manager = new StorageQuotaManager(mockCache);
      const result = await manager.cleanup(50);
      expect(mockCache.cleanup).toHaveBeenCalled();
    });

    it('should do full cache clear if still above target after cache cleanup', async () => {
      // Stays at 80% through all cleanup steps
      mockNavigatorStorage({ usage: 8000, quota: 10000 });
      const mockCache = createMockCacheManager();
      manager = new StorageQuotaManager(mockCache);
      const result = await manager.cleanup(50);
      expect(mockCache.clear).toHaveBeenCalled();
      expect(result.cacheEntriesRemoved).toBe(-1);
    });

    it('should use default target percentage of 50', async () => {
      mockNavigatorStorage({ usage: 3000, quota: 10000 }); // 30% < 50%
      manager = new StorageQuotaManager();
      const result = await manager.cleanup();
      // Below default target of 50, should return early
      expect(result.spaceFreed).toBe(0);
    });

    it('should handle RolloutRecorder.cleanupExpired failure gracefully', async () => {
      const RolloutRecorder = await getMockedRolloutRecorder();
      vi.mocked(RolloutRecorder.cleanupExpired).mockRejectedValueOnce(
        new Error('DB error')
      );
      mockNavigatorStorage({ usage: 8000, quota: 10000 });
      manager = new StorageQuotaManager();
      // Should not throw
      const result = await manager.cleanup(50);
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Failed to cleanup expired rollouts'),
        expect.any(Error)
      );
    });

    it('should calculate spaceFreed correctly', async () => {
      let callCount = 0;
      const storageMock = {
        estimate: vi.fn().mockImplementation(async () => {
          callCount++;
          // First call: 80% usage; subsequent calls: 40% (simulating cleanup freed space)
          if (callCount <= 1) {
            return { usage: 8000, quota: 10000 };
          }
          return { usage: 4000, quota: 10000 };
        }),
        persisted: vi.fn().mockResolvedValue(false),
      };
      Object.defineProperty(navigator, 'storage', {
        value: storageMock,
        writable: true,
        configurable: true,
      });

      manager = new StorageQuotaManager();
      const result = await manager.cleanup(50);
      expect(result.spaceFreed).toBe(4000);
    });

    it('should not invoke cache cleanup when no cacheManager is set', async () => {
      mockNavigatorStorage({ usage: 8000, quota: 10000 });
      manager = new StorageQuotaManager(); // no cache manager
      const result = await manager.cleanup(50);
      // Should still complete without errors; cache entries removed stays 0
      // (cacheEntriesRemoved becomes -1 only if cacheManager.clear is called)
      expect(result.rolloutsDeleted).toBe(3);
    });
  });

  // =========================================================================
  // 7. shouldCleanup()
  // =========================================================================
  describe('shouldCleanup', () => {
    it('should return false when usage is below warning threshold', async () => {
      mockNavigatorStorage({ usage: 5000, quota: 10000 }); // 50%
      manager = new StorageQuotaManager();
      expect(await manager.shouldCleanup()).toBe(false);
    });

    it('should return true when usage equals warning threshold', async () => {
      mockNavigatorStorage({ usage: 8000, quota: 10000 }); // 80% = default warning
      manager = new StorageQuotaManager();
      expect(await manager.shouldCleanup()).toBe(true);
    });

    it('should return true when usage exceeds warning threshold', async () => {
      mockNavigatorStorage({ usage: 9500, quota: 10000 }); // 95%
      manager = new StorageQuotaManager();
      expect(await manager.shouldCleanup()).toBe(true);
    });

    it('should respect custom thresholds set via setThresholds', async () => {
      mockNavigatorStorage({ usage: 3500, quota: 10000 }); // 35%
      manager = new StorageQuotaManager();
      manager.setThresholds(30, 60);
      expect(await manager.shouldCleanup()).toBe(true);
    });

    it('should return false when usage is just below warning threshold', async () => {
      mockNavigatorStorage({ usage: 7999, quota: 10000 }); // 79.99%
      manager = new StorageQuotaManager();
      expect(await manager.shouldCleanup()).toBe(false);
    });
  });

  // =========================================================================
  // 8. getRecommendedActions()
  // =========================================================================
  describe('getRecommendedActions', () => {
    it('should return empty array when usage is low and stats are minimal', async () => {
      const RolloutRecorder = await getMockedRolloutRecorder();
      vi.mocked(RolloutRecorder.getStorageStats).mockResolvedValueOnce({
        rolloutCount: 2,
        itemCount: 10,
        rolloutBytes: 200,
        itemBytes: 1000,
      });
      mockNavigatorStorage({ usage: 100, quota: 10000, persisted: true });
      manager = new StorageQuotaManager();
      const actions = await manager.getRecommendedActions();
      expect(actions).toEqual([]);
    });

    it('should recommend cleanup when usage > 90%', async () => {
      const RolloutRecorder = await getMockedRolloutRecorder();
      vi.mocked(RolloutRecorder.getStorageStats).mockResolvedValueOnce({
        rolloutCount: 2,
        itemCount: 10,
        rolloutBytes: 200,
        itemBytes: 1000,
      });
      mockNavigatorStorage({ usage: 9500, quota: 10000, persisted: true });
      manager = new StorageQuotaManager();
      const actions = await manager.getRecommendedActions();
      expect(actions).toContain('Critical: Immediate cleanup required');
    });

    it('should recommend cleaning old conversations when usage > 70%', async () => {
      const RolloutRecorder = await getMockedRolloutRecorder();
      vi.mocked(RolloutRecorder.getStorageStats).mockResolvedValueOnce({
        rolloutCount: 2,
        itemCount: 10,
        rolloutBytes: 200,
        itemBytes: 1000,
      });
      mockNavigatorStorage({ usage: 7500, quota: 10000, persisted: true });
      manager = new StorageQuotaManager();
      const actions = await manager.getRecommendedActions();
      expect(actions).toContain('Consider cleaning up old conversations');
    });

    it('should recommend enabling persistent storage when not persisted', async () => {
      const RolloutRecorder = await getMockedRolloutRecorder();
      vi.mocked(RolloutRecorder.getStorageStats).mockResolvedValueOnce({
        rolloutCount: 2,
        itemCount: 10,
        rolloutBytes: 200,
        itemBytes: 1000,
      });
      mockNavigatorStorage({ usage: 100, quota: 10000, persisted: false });
      manager = new StorageQuotaManager();
      const actions = await manager.getRecommendedActions();
      expect(actions).toContain('Enable persistent storage to prevent data loss');
    });

    it('should recommend archiving when conversations > 100', async () => {
      const RolloutRecorder = await getMockedRolloutRecorder();
      vi.mocked(RolloutRecorder.getStorageStats).mockResolvedValueOnce({
        rolloutCount: 150,
        itemCount: 10,
        rolloutBytes: 200,
        itemBytes: 1000,
      });
      mockNavigatorStorage({ usage: 100, quota: 10000, persisted: true });
      manager = new StorageQuotaManager();
      const actions = await manager.getRecommendedActions();
      expect(actions).toContain('Archive or export old conversations');
    });

    it('should recommend clearing cache when cache > 10MB', async () => {
      const RolloutRecorder = await getMockedRolloutRecorder();
      vi.mocked(RolloutRecorder.getStorageStats).mockResolvedValueOnce({
        rolloutCount: 2,
        itemCount: 10,
        rolloutBytes: 200,
        itemBytes: 1000,
      });
      const mockCache = createMockCacheManager({
        getStatistics: vi.fn().mockReturnValue({
          entries: 500,
          size: 15 * 1024 * 1024, // 15MB
          maxSize: 50 * 1024 * 1024,
          hitRate: 0.5,
          averageAge: 120000,
        }),
      });
      mockNavigatorStorage({ usage: 100, quota: 10000, persisted: true });
      manager = new StorageQuotaManager(mockCache);
      const actions = await manager.getRecommendedActions();
      expect(actions).toContain('Clear cache to free up space');
    });

    it('should recommend archiving messages when count > 10000', async () => {
      const RolloutRecorder = await getMockedRolloutRecorder();
      vi.mocked(RolloutRecorder.getStorageStats).mockResolvedValueOnce({
        rolloutCount: 2,
        itemCount: 15000,
        rolloutBytes: 200,
        itemBytes: 1000,
      });
      mockNavigatorStorage({ usage: 100, quota: 10000, persisted: true });
      manager = new StorageQuotaManager();
      const actions = await manager.getRecommendedActions();
      expect(actions).toContain('Consider exporting and archiving old messages');
    });
  });

  // =========================================================================
  // 9. destroy()
  // =========================================================================
  describe('destroy', () => {
    it('should stop quota monitoring on destroy', () => {
      manager = new StorageQuotaManager();
      const stopSpy = vi.spyOn(manager, 'stopQuotaMonitoring');
      manager.destroy();
      expect(stopSpy).toHaveBeenCalled();
    });

    it('should nullify cacheManager reference', async () => {
      const mockCache = createMockCacheManager();
      mockNavigatorStorage({ usage: 100, quota: 10000 });
      manager = new StorageQuotaManager(mockCache);
      manager.destroy();
      // After destroy, getDetailedStats should not call cacheManager
      const stats = await manager.getDetailedStats();
      expect(stats.cache.entries).toBe(0);
      expect(stats.cache.sizeEstimate).toBe(0);
    });

    it('should clear the interval timer', () => {
      mockNavigatorStorage({ usage: 100, quota: 10000 });
      manager = new StorageQuotaManager();
      manager.startQuotaMonitoring(1);
      manager.destroy();
      // Calling destroy again should not throw
      expect(() => manager.destroy()).not.toThrow();
    });

    it('should be idempotent (safe to call multiple times)', () => {
      manager = new StorageQuotaManager();
      manager.destroy();
      manager.destroy();
      manager.destroy();
      // No error thrown
    });
  });

  // =========================================================================
  // 10. startQuotaMonitoring / stopQuotaMonitoring
  // =========================================================================
  describe('startQuotaMonitoring / stopQuotaMonitoring', () => {
    it('should log a warning when usage is above the warning threshold', async () => {
      mockNavigatorStorage({ usage: 8500, quota: 10000 }); // 85%
      manager = new StorageQuotaManager();
      manager.startQuotaMonitoring(10);
      await vi.advanceTimersByTimeAsync(0);
      expect(console.warn).toHaveBeenCalledWith(
        'Storage usage is above warning threshold'
      );
    });

    it('should clear previous interval when starting monitoring again', () => {
      mockNavigatorStorage({ usage: 100, quota: 10000 });
      manager = new StorageQuotaManager();
      manager.startQuotaMonitoring(10);
      // Starting again should not cause issues
      manager.startQuotaMonitoring(5);
      manager.stopQuotaMonitoring();
    });

    it('stopQuotaMonitoring should be safe to call when no interval is active', () => {
      manager = new StorageQuotaManager();
      expect(() => manager.stopQuotaMonitoring()).not.toThrow();
    });

    it('should trigger critical cleanup on interval when usage >= critical threshold', async () => {
      mockNavigatorStorage({ usage: 9600, quota: 10000 }); // 96% >= 95% critical
      manager = new StorageQuotaManager();
      manager.startQuotaMonitoring(1); // 1 minute interval
      // The immediate check runs first, then we advance to the interval callback
      await vi.advanceTimersByTimeAsync(0);
      // Advance past the interval
      await vi.advanceTimersByTimeAsync(60 * 1000);
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('Storage critical')
      );
    });
  });

  // =========================================================================
  // 11. requestPersistentStorage
  // =========================================================================
  describe('requestPersistentStorage', () => {
    it('should return true when already persisted', async () => {
      mockNavigatorStorage({ persisted: true });
      manager = new StorageQuotaManager();
      const result = await manager.requestPersistentStorage();
      expect(result).toBe(true);
    });

    it('should request persistence and return true when granted', async () => {
      mockNavigatorStorage({ persisted: false, persistResult: true });
      manager = new StorageQuotaManager();
      const result = await manager.requestPersistentStorage();
      expect(result).toBe(true);
    });

    it('should return false when persistence is denied', async () => {
      mockNavigatorStorage({ persisted: false, persistResult: false });
      manager = new StorageQuotaManager();
      const result = await manager.requestPersistentStorage();
      expect(result).toBe(false);
    });

    it('should return false when navigator.storage is unavailable', async () => {
      removeNavigatorStorage();
      manager = new StorageQuotaManager();
      const result = await manager.requestPersistentStorage();
      expect(result).toBe(false);
    });

    it('should return false and log error on exception', async () => {
      const storageMock = {
        persisted: vi.fn().mockRejectedValue(new Error('fail')),
        persist: vi.fn(),
        estimate: vi.fn().mockResolvedValue({ usage: 0, quota: 10000 }),
      };
      Object.defineProperty(navigator, 'storage', {
        value: storageMock,
        writable: true,
        configurable: true,
      });
      manager = new StorageQuotaManager();
      const result = await manager.requestPersistentStorage();
      expect(result).toBe(false);
      expect(console.error).toHaveBeenCalledWith(
        'Failed to request persistent storage:',
        expect.any(Error)
      );
    });
  });

  // =========================================================================
  // 12. getDetailedStats
  // =========================================================================
  describe('getDetailedStats', () => {
    it('should return stats including rollout and cache data', async () => {
      mockNavigatorStorage({ usage: 5000, quota: 10000 });
      const mockCache = createMockCacheManager();
      manager = new StorageQuotaManager(mockCache);
      const stats = await manager.getDetailedStats();
      expect(stats.totalUsage).toBe(5000);
      expect(stats.quota).toBe(10000);
      expect(stats.percentageUsed).toBe(50);
      expect(stats.conversations.count).toBe(5);
      expect(stats.messages.count).toBe(100);
      expect(stats.cache.entries).toBe(10);
      expect(stats.cache.sizeEstimate).toBe(2048);
    });

    it('should handle RolloutRecorder.getStorageStats failure gracefully', async () => {
      const RolloutRecorder = await getMockedRolloutRecorder();
      vi.mocked(RolloutRecorder.getStorageStats).mockRejectedValueOnce(
        new Error('DB error')
      );
      mockNavigatorStorage({ usage: 1000, quota: 10000 });
      manager = new StorageQuotaManager();
      const stats = await manager.getDetailedStats();
      expect(stats.conversations.count).toBe(0);
      expect(stats.messages.count).toBe(0);
    });

    it('should return zero cache stats when no cacheManager is set', async () => {
      mockNavigatorStorage({ usage: 1000, quota: 10000 });
      manager = new StorageQuotaManager();
      const stats = await manager.getDetailedStats();
      expect(stats.cache.entries).toBe(0);
      expect(stats.cache.sizeEstimate).toBe(0);
    });

    it('should populate sizeEstimate from rollout byte counts', async () => {
      const RolloutRecorder = await getMockedRolloutRecorder();
      vi.mocked(RolloutRecorder.getStorageStats).mockResolvedValueOnce({
        rolloutCount: 3,
        itemCount: 50,
        rolloutBytes: 12000,
        itemBytes: 80000,
      });
      mockNavigatorStorage({ usage: 2000, quota: 10000 });
      manager = new StorageQuotaManager();
      const stats = await manager.getDetailedStats();
      expect(stats.conversations.sizeEstimate).toBe(12000);
      expect(stats.messages.sizeEstimate).toBe(80000);
    });
  });

  // =========================================================================
  // 13. exportData
  // =========================================================================
  describe('exportData', () => {
    it('should return a JSON Blob with storage stats', async () => {
      mockNavigatorStorage({ usage: 1000, quota: 10000 });
      manager = new StorageQuotaManager();
      const blob = await manager.exportData();
      expect(blob).toBeInstanceOf(Blob);
      expect(blob.type).toBe('application/json');
    });

    it('should include rollout info when includeConversations is true', async () => {
      mockNavigatorStorage({ usage: 1000, quota: 10000 });
      manager = new StorageQuotaManager();
      const blob = await manager.exportData({ includeConversations: true });
      const text = await readBlobAsText(blob);
      const data = JSON.parse(text);
      expect(data.rollouts).toBeDefined();
      expect(data.rollouts.count).toBe(5);
    });

    it('should include cache stats when includeCache is true and cacheManager exists', async () => {
      mockNavigatorStorage({ usage: 1000, quota: 10000 });
      const mockCache = createMockCacheManager();
      manager = new StorageQuotaManager(mockCache);
      const blob = await manager.exportData({ includeCache: true });
      const text = await readBlobAsText(blob);
      const data = JSON.parse(text);
      expect(data.cacheStats).toBeDefined();
      expect(data.cacheStats.entries).toBe(10);
    });

    it('should include version and timestamp in exported data', async () => {
      mockNavigatorStorage({ usage: 1000, quota: 10000 });
      manager = new StorageQuotaManager();
      const blob = await manager.exportData();
      const text = await readBlobAsText(blob);
      const data = JSON.parse(text);
      expect(data.version).toBe('1.0.0');
      expect(typeof data.timestamp).toBe('number');
      expect(data.storage).toBeDefined();
    });
  });

  // =========================================================================
  // 14. optimizeStorage
  // =========================================================================
  describe('optimizeStorage', () => {
    it('should return optimized true and list of actions on success', async () => {
      mockNavigatorStorage({ usage: 1000, quota: 10000, persisted: false, persistResult: true });
      const mockCache = createMockCacheManager();
      manager = new StorageQuotaManager(mockCache);
      const result = await manager.optimizeStorage();
      expect(result.optimized).toBe(true);
      expect(result.actionsToken.length).toBeGreaterThan(0);
    });

    it('should return optimized false when an error occurs', async () => {
      const RolloutRecorder = await getMockedRolloutRecorder();
      vi.mocked(RolloutRecorder.cleanupExpired).mockRejectedValueOnce(
        new Error('cleanup failed')
      );
      mockNavigatorStorage({ usage: 1000, quota: 10000, persisted: true });
      manager = new StorageQuotaManager();
      const result = await manager.optimizeStorage();
      expect(result.optimized).toBe(false);
      expect(result.actionsToken[0]).toContain('Optimization failed');
    });

    it('should include current usage percentage in actions', async () => {
      mockNavigatorStorage({ usage: 1000, quota: 10000, persisted: true });
      manager = new StorageQuotaManager();
      const result = await manager.optimizeStorage();
      expect(result.optimized).toBe(true);
      const usageAction = result.actionsToken.find(a => a.includes('Current usage'));
      expect(usageAction).toBeDefined();
      expect(usageAction).toContain('10.00%');
    });
  });
});
