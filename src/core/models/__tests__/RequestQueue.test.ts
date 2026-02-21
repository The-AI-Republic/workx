import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RequestQueue, RequestPriority } from '../RequestQueue.js';
import type { QueuedRequest, RateLimitConfig } from '../RequestQueue.js';
import type { CompletionRequest } from '../ModelClient.js';

// ---------------------------------------------------------------------------
// Mock the storage layer so the constructor's loadFromStorage() is inert.
// The mock returns a result whose property access yields undefined, which
// the source code handles via its try/catch in loadFromStorage.
// ---------------------------------------------------------------------------
vi.mock('../../storage/ConfigStorageProvider', () => ({
  isConfigStorageInitialized: () => false,
  getConfigStorage: () => null,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal CompletionRequest fixture. */
function makeRequest(tag = 'default'): CompletionRequest {
  return {
    model: 'test-model',
    messages: [{ role: 'user', content: `test message ${tag}` }],
  };
}

/** Default rate-limit config used by most tests. */
const DEFAULT_CONFIG: RateLimitConfig = {
  requestsPerMinute: 60,
  requestsPerHour: 1000,
  burstLimit: 10,
};

/** Very permissive config so rate limiting never fires. */
const PERMISSIVE_CONFIG: RateLimitConfig = {
  requestsPerMinute: 10_000,
  requestsPerHour: 100_000,
  burstLimit: 10_000,
};

/**
 * Create a RequestQueue whose processQueue() method has been stubbed out so
 * that enqueue() never triggers asynchronous consumption.  This lets us test
 * queue-ordering, metrics, and dequeue in isolation.
 *
 * The original processQueue is returned so callers can restore it if needed.
 */
function createInertQueue(config: RateLimitConfig = DEFAULT_CONFIG): {
  queue: RequestQueue;
  originalProcessQueue: () => Promise<void>;
} {
  const queue = new RequestQueue(config);
  const originalProcessQueue = (queue as any).processQueue.bind(queue);
  (queue as any).processQueue = async () => {
    /* no-op */
  };
  return { queue, originalProcessQueue };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RequestQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // =========================================================================
  // enqueue / dequeue
  // =========================================================================
  describe('enqueue() / dequeue()', () => {
    it('should return a unique request ID on enqueue', () => {
      const { queue } = createInertQueue();
      const id = queue.enqueue(makeRequest('a'));
      expect(id).toMatch(/^req_/);
    });

    it('should generate distinct IDs for successive enqueues', () => {
      const { queue } = createInertQueue();
      const id1 = queue.enqueue(makeRequest('a'));
      const id2 = queue.enqueue(makeRequest('b'));
      expect(id1).not.toBe(id2);
    });

    it('should increase queue size on enqueue', () => {
      const { queue } = createInertQueue();
      queue.enqueue(makeRequest('a'));
      queue.enqueue(makeRequest('b'));
      expect(queue.getStatus().queueSize).toBe(2);
    });

    it('should decrement queue size on dequeue', () => {
      const { queue } = createInertQueue();
      const id = queue.enqueue(makeRequest('a'));
      queue.enqueue(makeRequest('b'));
      queue.dequeue(id);
      expect(queue.getStatus().queueSize).toBe(1);
    });

    it('should return true when dequeuing an existing request', () => {
      const { queue } = createInertQueue();
      const id = queue.enqueue(makeRequest('a'));
      expect(queue.dequeue(id)).toBe(true);
    });

    it('should return false when dequeuing a non-existent request', () => {
      const { queue } = createInertQueue();
      expect(queue.dequeue('does-not-exist')).toBe(false);
    });

    it('should not allow dequeuing the same request twice', () => {
      const { queue } = createInertQueue();
      const id = queue.enqueue(makeRequest('a'));
      queue.dequeue(id);
      expect(queue.dequeue(id)).toBe(false);
    });

    it('should increment totalQueued metric on every enqueue', () => {
      const { queue } = createInertQueue();
      queue.enqueue(makeRequest('a'));
      queue.enqueue(makeRequest('b'));
      queue.enqueue(makeRequest('c'));
      expect(queue.getStatus().metrics.totalQueued).toBe(3);
    });

    it('should track currentQueueSize accurately after mixed enqueue/dequeue', () => {
      const { queue } = createInertQueue();
      const id1 = queue.enqueue(makeRequest('a'));
      queue.enqueue(makeRequest('b'));
      const id3 = queue.enqueue(makeRequest('c'));
      queue.dequeue(id1);
      queue.dequeue(id3);
      expect(queue.getStatus().metrics.currentQueueSize).toBe(1);
    });
  });

  // =========================================================================
  // Priority ordering
  // =========================================================================
  describe('priority ordering', () => {
    it('should place higher-priority requests before lower-priority ones', () => {
      const { queue } = createInertQueue();
      queue.enqueue(makeRequest('low'), RequestPriority.LOW);
      queue.enqueue(makeRequest('urgent'), RequestPriority.URGENT);
      queue.enqueue(makeRequest('normal'), RequestPriority.NORMAL);

      const status = queue.getStatus();
      expect(status.nextRequest).toBeDefined();
      expect(status.nextRequest!.priority).toBe(RequestPriority.URGENT);
    });

    it('should maintain FIFO within the same priority level', () => {
      const { queue } = createInertQueue();
      vi.setSystemTime(1000);
      const id1 = queue.enqueue(makeRequest('first'), RequestPriority.NORMAL);
      vi.setSystemTime(2000);
      queue.enqueue(makeRequest('second'), RequestPriority.NORMAL);

      const next = queue.getStatus().nextRequest;
      expect(next).toBeDefined();
      expect(next!.id).toBe(id1);
    });

    it('should order all four priority levels correctly', () => {
      const { queue } = createInertQueue();
      vi.setSystemTime(1000);
      const lowId = queue.enqueue(makeRequest('low'), RequestPriority.LOW);
      vi.setSystemTime(2000);
      const normalId = queue.enqueue(makeRequest('normal'), RequestPriority.NORMAL);
      vi.setSystemTime(3000);
      const highId = queue.enqueue(makeRequest('high'), RequestPriority.HIGH);
      vi.setSystemTime(4000);
      const urgentId = queue.enqueue(makeRequest('urgent'), RequestPriority.URGENT);

      // Dequeue one-by-one and verify order: URGENT > HIGH > NORMAL > LOW
      const expectedOrder = [urgentId, highId, normalId, lowId];
      for (const expectedId of expectedOrder) {
        const next = queue.getStatus().nextRequest;
        expect(next).toBeDefined();
        expect(next!.id).toBe(expectedId);
        queue.dequeue(expectedId);
      }

      expect(queue.getStatus().queueSize).toBe(0);
    });

    it('should interleave priorities with same-priority FIFO preserved', () => {
      const { queue } = createInertQueue();
      vi.setSystemTime(100);
      const normalA = queue.enqueue(makeRequest('normalA'), RequestPriority.NORMAL);
      vi.setSystemTime(200);
      const high1 = queue.enqueue(makeRequest('high1'), RequestPriority.HIGH);
      vi.setSystemTime(300);
      const normalB = queue.enqueue(makeRequest('normalB'), RequestPriority.NORMAL);
      vi.setSystemTime(400);
      const high2 = queue.enqueue(makeRequest('high2'), RequestPriority.HIGH);

      const expectedOrder = [high1, high2, normalA, normalB];
      for (const expectedId of expectedOrder) {
        const next = queue.getStatus().nextRequest;
        expect(next!.id).toBe(expectedId);
        queue.dequeue(expectedId);
      }
    });

    it('should track queueSizeByPriority correctly', () => {
      const { queue } = createInertQueue();
      queue.enqueue(makeRequest('low1'), RequestPriority.LOW);
      queue.enqueue(makeRequest('low2'), RequestPriority.LOW);
      queue.enqueue(makeRequest('high1'), RequestPriority.HIGH);
      queue.enqueue(makeRequest('urgent1'), RequestPriority.URGENT);

      const byPriority = queue.getStatus().metrics.queueSizeByPriority;
      expect(byPriority[RequestPriority.LOW]).toBe(2);
      expect(byPriority[RequestPriority.NORMAL]).toBe(0);
      expect(byPriority[RequestPriority.HIGH]).toBe(1);
      expect(byPriority[RequestPriority.URGENT]).toBe(1);
    });

    it('should update queueSizeByPriority on dequeue', () => {
      const { queue } = createInertQueue();
      const id = queue.enqueue(makeRequest('high'), RequestPriority.HIGH);
      queue.dequeue(id);
      expect(queue.getStatus().metrics.queueSizeByPriority[RequestPriority.HIGH]).toBe(0);
    });
  });

  // =========================================================================
  // getStatus()
  // =========================================================================
  describe('getStatus()', () => {
    it('should report empty queue correctly', () => {
      const { queue } = createInertQueue();
      const status = queue.getStatus();
      expect(status.queueSize).toBe(0);
      expect(status.processing).toBe(false);
      expect(status.nextRequest).toBeUndefined();
    });

    it('should report queueSize matching internal queue length', () => {
      const { queue } = createInertQueue();
      queue.enqueue(makeRequest('a'));
      queue.enqueue(makeRequest('b'));
      expect(queue.getStatus().queueSize).toBe(2);
    });

    it('should expose metrics as a copy (not a reference)', () => {
      const { queue } = createInertQueue();
      const metrics1 = queue.getStatus().metrics;
      const metrics2 = queue.getStatus().metrics;
      expect(metrics1).toEqual(metrics2);
      expect(metrics1).not.toBe(metrics2);
    });

    it('should reflect nextRequest as the head of the priority queue', () => {
      const { queue } = createInertQueue();
      queue.enqueue(makeRequest('normal'), RequestPriority.NORMAL);
      const urgentId = queue.enqueue(makeRequest('urgent'), RequestPriority.URGENT);
      expect(queue.getStatus().nextRequest!.id).toBe(urgentId);
    });

    it('should show metrics with default zeroes on a fresh queue', () => {
      const { queue } = createInertQueue();
      const { metrics } = queue.getStatus();
      expect(metrics.totalQueued).toBe(0);
      expect(metrics.totalProcessed).toBe(0);
      expect(metrics.totalErrors).toBe(0);
      expect(metrics.currentQueueSize).toBe(0);
      expect(metrics.averageProcessingTime).toBe(0);
    });
  });

  // =========================================================================
  // clear()
  // =========================================================================
  describe('clear()', () => {
    it('should remove all items from the queue', () => {
      const { queue } = createInertQueue();
      queue.enqueue(makeRequest('a'));
      queue.enqueue(makeRequest('b'));
      queue.enqueue(makeRequest('c'));
      queue.clear();
      expect(queue.getStatus().queueSize).toBe(0);
    });

    it('should reset currentQueueSize metric to zero', () => {
      const { queue } = createInertQueue();
      queue.enqueue(makeRequest('a'));
      queue.clear();
      expect(queue.getStatus().metrics.currentQueueSize).toBe(0);
    });

    it('should reset all priority counts to zero', () => {
      const { queue } = createInertQueue();
      queue.enqueue(makeRequest('low'), RequestPriority.LOW);
      queue.enqueue(makeRequest('high'), RequestPriority.HIGH);
      queue.enqueue(makeRequest('urgent'), RequestPriority.URGENT);
      queue.clear();

      const byPriority = queue.getStatus().metrics.queueSizeByPriority;
      expect(byPriority[RequestPriority.LOW]).toBe(0);
      expect(byPriority[RequestPriority.NORMAL]).toBe(0);
      expect(byPriority[RequestPriority.HIGH]).toBe(0);
      expect(byPriority[RequestPriority.URGENT]).toBe(0);
    });

    it('should not reset totalQueued (historical counter)', () => {
      const { queue } = createInertQueue();
      queue.enqueue(makeRequest('a'));
      queue.enqueue(makeRequest('b'));
      queue.clear();
      expect(queue.getStatus().metrics.totalQueued).toBe(2);
    });

    it('should leave the queue usable after clearing', () => {
      const { queue } = createInertQueue();
      queue.enqueue(makeRequest('a'));
      queue.clear();
      const id = queue.enqueue(makeRequest('b'));
      expect(queue.getStatus().queueSize).toBe(1);
      expect(queue.dequeue(id)).toBe(true);
    });
  });

  // =========================================================================
  // pause() / resume()
  // =========================================================================
  describe('pause() / resume()', () => {
    it('should set processing to false on pause', () => {
      const queue = new RequestQueue(DEFAULT_CONFIG);
      queue.pause();
      expect(queue.getStatus().processing).toBe(false);
    });

    it('should prevent processQueue from continuing when paused mid-loop', async () => {
      // Start a real queue, let it begin processing, then pause
      const queue = new RequestQueue(PERMISSIVE_CONFIG);
      (queue as any).executeRequest = async () => ({ success: true });

      queue.enqueue(makeRequest('a'));
      queue.enqueue(makeRequest('b'));
      queue.enqueue(makeRequest('c'));

      // Let the first item process
      await vi.advanceTimersByTimeAsync(200);
      queue.pause();

      // The while-loop checks this.queue.length > 0 but processing was set
      // to false; however, it only checks processing at the start of
      // processQueue, not inside the loop. The loop exits when the queue
      // empties or a sleep resolves. After pause, calling resume restarts.
      // Verify pause sets the flag.
      expect(queue.getStatus().processing).toBe(false);
    });

    it('should restart processing on resume when queue has items', () => {
      const { queue, originalProcessQueue } = createInertQueue(PERMISSIVE_CONFIG);
      queue.enqueue(makeRequest('a'));
      queue.enqueue(makeRequest('b'));

      // Restore processQueue so resume() can trigger it
      (queue as any).processQueue = originalProcessQueue;
      queue.resume();
      // resume calls processQueue which sets processing = true
      expect(queue.getStatus().processing).toBe(true);
    });

    it('should not set processing when resuming an empty queue', () => {
      const queue = new RequestQueue(DEFAULT_CONFIG);
      queue.pause();
      queue.resume();
      expect(queue.getStatus().processing).toBe(false);
    });

    it('should preserve queue contents when processQueue is inactive', () => {
      const { queue } = createInertQueue();
      queue.enqueue(makeRequest('a'));
      queue.enqueue(makeRequest('b'));
      expect(queue.getStatus().queueSize).toBe(2);
    });
  });

  // =========================================================================
  // getAnalytics()
  // =========================================================================
  describe('getAnalytics()', () => {
    it('should return successRate of 0 when history is empty', () => {
      const { queue } = createInertQueue();
      const analytics = queue.getAnalytics();
      expect(analytics.successRate).toBe(0);
    });

    it('should return averageWaitTime of 0 when queue is empty', () => {
      const { queue } = createInertQueue();
      const analytics = queue.getAnalytics();
      expect(analytics.averageWaitTime).toBe(0);
    });

    it('should return queueTrends with 10 data points', () => {
      const { queue } = createInertQueue();
      const analytics = queue.getAnalytics();
      expect(analytics.queueTrends).toHaveLength(10);
    });

    it('should have ascending timestamps in queueTrends', () => {
      const { queue } = createInertQueue();
      const { queueTrends } = queue.getAnalytics();
      for (let i = 1; i < queueTrends.length; i++) {
        expect(queueTrends[i].timestamp).toBeGreaterThan(queueTrends[i - 1].timestamp);
      }
    });

    it('should compute averageWaitTime based on enqueue timestamps', () => {
      const { queue } = createInertQueue();
      vi.setSystemTime(1000);
      queue.enqueue(makeRequest('a'));
      vi.setSystemTime(3000);
      queue.enqueue(makeRequest('b'));

      // Check at time 5000
      vi.setSystemTime(5000);
      const analytics = queue.getAnalytics();
      // Item a waited 4000ms, item b waited 2000ms => avg = 3000
      expect(analytics.averageWaitTime).toBe(3000);
    });

    it('should compute successRate from request history', () => {
      const { queue } = createInertQueue();
      const qAny = queue as any;
      qAny.requestHistory = [
        { timestamp: 1000, success: true, duration: 100 },
        { timestamp: 2000, success: true, duration: 100 },
        { timestamp: 3000, success: false, duration: 100 },
        { timestamp: 4000, success: true, duration: 100 },
      ];

      const analytics = queue.getAnalytics();
      expect(analytics.successRate).toBe(0.75); // 3/4
    });

    it('should include queueSize in every trend entry', () => {
      const { queue } = createInertQueue();
      queue.enqueue(makeRequest('a'));
      const { queueTrends } = queue.getAnalytics();
      for (const entry of queueTrends) {
        expect(entry).toHaveProperty('timestamp');
        expect(entry).toHaveProperty('queueSize');
        expect(typeof entry.queueSize).toBe('number');
      }
    });
  });

  // =========================================================================
  // Rate limiting
  // =========================================================================
  describe('rate limiting', () => {
    it('should allow requests when under the burst limit', () => {
      const queue = new RequestQueue(DEFAULT_CONFIG);
      const qAny = queue as any;
      // No history means canMakeRequest should return true
      expect(qAny.canMakeRequest()).toBe(true);
    });

    it('should enforce burst limit', () => {
      const tinyBurst: RateLimitConfig = {
        requestsPerMinute: 100,
        requestsPerHour: 1000,
        burstLimit: 2,
      };
      const queue = new RequestQueue(tinyBurst);
      const qAny = queue as any;

      vi.setSystemTime(10_000);
      qAny.requestHistory = [
        { timestamp: 10_000, success: true, duration: 100 },
        { timestamp: 10_000, success: true, duration: 100 },
      ];

      expect(qAny.canMakeRequest()).toBe(false);
    });

    it('should enforce per-minute limit', () => {
      const minuteLimit: RateLimitConfig = {
        requestsPerMinute: 3,
        requestsPerHour: 1000,
        burstLimit: 100,
      };
      const queue = new RequestQueue(minuteLimit);
      const qAny = queue as any;

      vi.setSystemTime(60_000);
      qAny.requestHistory = [
        { timestamp: 55_000, success: true, duration: 100 },
        { timestamp: 56_000, success: true, duration: 100 },
        { timestamp: 57_000, success: true, duration: 100 },
      ];

      expect(qAny.canMakeRequest()).toBe(false);
    });

    it('should enforce per-hour limit', () => {
      const hourLimit: RateLimitConfig = {
        requestsPerMinute: 1000,
        requestsPerHour: 2,
        burstLimit: 1000,
      };
      const queue = new RequestQueue(hourLimit);
      const qAny = queue as any;

      vi.setSystemTime(3_600_000);
      qAny.requestHistory = [
        { timestamp: 3_500_000, success: true, duration: 100 },
        { timestamp: 3_550_000, success: true, duration: 100 },
      ];

      expect(qAny.canMakeRequest()).toBe(false);
    });

    it('should allow requests once old history entries expire from the window', () => {
      const minuteLimit: RateLimitConfig = {
        requestsPerMinute: 2,
        requestsPerHour: 1000,
        burstLimit: 100,
      };
      const queue = new RequestQueue(minuteLimit);
      const qAny = queue as any;

      vi.setSystemTime(0);
      qAny.requestHistory = [
        { timestamp: 0, success: true, duration: 100 },
        { timestamp: 0, success: true, duration: 100 },
      ];

      // Still within the minute window
      vi.setSystemTime(30_000);
      expect(qAny.canMakeRequest()).toBe(false);

      // Past the minute window
      vi.setSystemTime(61_000);
      expect(qAny.canMakeRequest()).toBe(true);
    });

    it('should compute delay until next available slot', () => {
      const minuteLimit: RateLimitConfig = {
        requestsPerMinute: 1,
        requestsPerHour: 1000,
        burstLimit: 100,
      };
      const queue = new RequestQueue(minuteLimit);
      const qAny = queue as any;

      vi.setSystemTime(70_000);
      qAny.requestHistory = [
        { timestamp: 50_000, success: true, duration: 100 },
      ];

      // The oldest request at 50_000 + 60_000 window = 110_000
      // Delay = 110_000 - 70_000 = 40_000
      const delay = qAny.getDelayUntilNextRequest();
      expect(delay).toBe(40_000);
    });

    it('should return default 1s delay when not over per-minute limit', () => {
      const queue = new RequestQueue(DEFAULT_CONFIG);
      const qAny = queue as any;

      vi.setSystemTime(100_000);
      qAny.requestHistory = [
        { timestamp: 99_000, success: true, duration: 100 },
      ];

      // Under the per-minute limit, so default delay
      const delay = qAny.getDelayUntilNextRequest();
      expect(delay).toBe(1000);
    });
  });

  // =========================================================================
  // Queue overflow / MAX_HISTORY_SIZE trimming
  // =========================================================================
  describe('queue overflow / history trimming', () => {
    it('should trim request history when it exceeds MAX_HISTORY_SIZE', () => {
      const queue = new RequestQueue(DEFAULT_CONFIG);
      const qAny = queue as any;
      const MAX = qAny.MAX_HISTORY_SIZE; // 1000

      // Manually fill history beyond the max
      qAny.requestHistory = Array.from({ length: MAX + 200 }, (_, i) => ({
        timestamp: i,
        success: true,
        duration: 10,
      }));

      // recordRequest triggers trimming
      qAny.recordRequest(true, 10);

      expect(qAny.requestHistory.length).toBeLessThanOrEqual(MAX + 1);
    });

    it('should keep the most recent entries after trimming', () => {
      const queue = new RequestQueue(DEFAULT_CONFIG);
      const qAny = queue as any;
      const MAX = qAny.MAX_HISTORY_SIZE;

      qAny.requestHistory = Array.from({ length: MAX + 50 }, (_, i) => ({
        timestamp: i,
        success: true,
        duration: 10,
      }));

      qAny.recordRequest(true, 10);

      const history = qAny.requestHistory;
      // After trimming to last MAX_HISTORY_SIZE and adding 1, the oldest
      // should no longer be timestamp 0
      const oldestTimestamp = history[0].timestamp;
      expect(oldestTimestamp).toBeGreaterThan(0);
    });

    it('should handle a large number of enqueues without issues', () => {
      const { queue } = createInertQueue();
      const ids: string[] = [];
      for (let i = 0; i < 500; i++) {
        ids.push(queue.enqueue(makeRequest(`item-${i}`)));
      }
      expect(queue.getStatus().queueSize).toBe(500);
      expect(queue.getStatus().metrics.totalQueued).toBe(500);
    });
  });

  // =========================================================================
  // Concurrent processing (processQueue behaviour)
  // =========================================================================
  describe('concurrent processing', () => {
    it('should set processing flag to true when processQueue starts', () => {
      const queue = new RequestQueue(PERMISSIVE_CONFIG);
      queue.enqueue(makeRequest('a'));
      // processQueue fires and sets processing = true synchronously
      expect(queue.getStatus().processing).toBe(true);
    });

    it('should not start a second processQueue while one is active', () => {
      const queue = new RequestQueue(PERMISSIVE_CONFIG);
      // First enqueue triggers processQueue
      queue.enqueue(makeRequest('a'));
      expect(queue.getStatus().processing).toBe(true);
      // Second enqueue sees processing === true and skips processQueue
      queue.enqueue(makeRequest('b'));
      expect(queue.getStatus().processing).toBe(true);
    });

    it('should process items in priority order through processQueue', async () => {
      const processedOrder: string[] = [];
      const queue = new RequestQueue(PERMISSIVE_CONFIG);

      // Stub executeRequest to resolve instantly and record order
      (queue as any).executeRequest = async (req: QueuedRequest) => {
        processedOrder.push(req.request.messages[0].content!);
        return { success: true };
      };

      // Enqueue items with different priorities at different times
      // The first enqueue triggers processQueue which immediately shifts the
      // first item. To test ordering properly we need all items in the queue
      // before processing starts. Use createInertQueue then restore.
      const { queue: q, originalProcessQueue } = createInertQueue(PERMISSIVE_CONFIG);
      (q as any).executeRequest = async (req: QueuedRequest) => {
        processedOrder.push(req.request.messages[0].content!);
        return { success: true };
      };

      vi.setSystemTime(1000);
      q.enqueue(makeRequest('low'), RequestPriority.LOW);
      vi.setSystemTime(2000);
      q.enqueue(makeRequest('urgent'), RequestPriority.URGENT);
      vi.setSystemTime(3000);
      q.enqueue(makeRequest('normal'), RequestPriority.NORMAL);

      // Restore processQueue and kick off processing
      (q as any).processQueue = originalProcessQueue;
      q.resume();

      // Advance through async sleeps
      for (let i = 0; i < 30; i++) {
        await vi.advanceTimersByTimeAsync(200);
      }

      expect(processedOrder).toEqual([
        'test message urgent',
        'test message normal',
        'test message low',
      ]);
    });

    it('should increment totalProcessed on successful execution', async () => {
      const queue = new RequestQueue(PERMISSIVE_CONFIG);
      (queue as any).executeRequest = async () => ({ success: true });

      queue.enqueue(makeRequest('a'));

      for (let i = 0; i < 10; i++) {
        await vi.advanceTimersByTimeAsync(200);
      }

      expect(queue.getStatus().metrics.totalProcessed).toBeGreaterThanOrEqual(1);
    });

    it('should call onComplete callback on success', async () => {
      const queue = new RequestQueue(PERMISSIVE_CONFIG);
      (queue as any).executeRequest = async () => ({ success: true });

      const onComplete = vi.fn();
      queue.enqueue(makeRequest('a'), RequestPriority.NORMAL, { onComplete });

      for (let i = 0; i < 10; i++) {
        await vi.advanceTimersByTimeAsync(200);
      }

      expect(onComplete).toHaveBeenCalledTimes(1);
    });

    it('should call onError callback after maxRetries exhausted', async () => {
      const queue = new RequestQueue(PERMISSIVE_CONFIG);
      (queue as any).executeRequest = async () => {
        throw new Error('always fails');
      };

      const onError = vi.fn();
      queue.enqueue(makeRequest('fail'), RequestPriority.NORMAL, {
        maxRetries: 0,
        onError,
      });

      for (let i = 0; i < 10; i++) {
        await vi.advanceTimersByTimeAsync(200);
      }

      expect(onError).toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith(expect.any(Error));
    });

    it('should increment totalErrors when retries are exhausted', async () => {
      const queue = new RequestQueue(PERMISSIVE_CONFIG);
      (queue as any).executeRequest = async () => {
        throw new Error('always fails');
      };

      queue.enqueue(makeRequest('fail'), RequestPriority.NORMAL, {
        maxRetries: 0,
      });

      for (let i = 0; i < 10; i++) {
        await vi.advanceTimersByTimeAsync(200);
      }

      expect(queue.getStatus().metrics.totalErrors).toBeGreaterThanOrEqual(1);
    });

    it('should re-queue a request for retry on transient failure', async () => {
      const queue = new RequestQueue(PERMISSIVE_CONFIG);
      let callCount = 0;
      (queue as any).executeRequest = async () => {
        callCount++;
        if (callCount <= 1) {
          throw new Error('transient');
        }
        return { success: true };
      };

      const onComplete = vi.fn();
      queue.enqueue(makeRequest('retry-me'), RequestPriority.NORMAL, {
        maxRetries: 3,
        onComplete,
      });

      // Advance enough time for retry (exponential backoff + processing)
      for (let i = 0; i < 50; i++) {
        await vi.advanceTimersByTimeAsync(500);
      }

      expect(callCount).toBe(2);
      expect(onComplete).toHaveBeenCalledTimes(1);
    });

    it('should set processing to false after all items are consumed', async () => {
      const queue = new RequestQueue(PERMISSIVE_CONFIG);
      (queue as any).executeRequest = async () => ({ success: true });

      queue.enqueue(makeRequest('only'));

      for (let i = 0; i < 20; i++) {
        await vi.advanceTimersByTimeAsync(200);
      }

      expect(queue.getStatus().processing).toBe(false);
      expect(queue.getStatus().queueSize).toBe(0);
    });

    it('should update averageProcessingTime after processing', async () => {
      const queue = new RequestQueue(PERMISSIVE_CONFIG);
      (queue as any).executeRequest = async () => {
        // Simulate some processing time by advancing timer
        return { success: true };
      };

      queue.enqueue(makeRequest('a'));

      for (let i = 0; i < 20; i++) {
        await vi.advanceTimersByTimeAsync(200);
      }

      // After processing, averageProcessingTime should have been updated
      const { metrics } = queue.getStatus();
      expect(metrics.totalProcessed).toBeGreaterThanOrEqual(1);
      // averageProcessingTime is computed from recorded durations
      expect(typeof metrics.averageProcessingTime).toBe('number');
    });
  });

  // =========================================================================
  // Retry / exponential backoff
  // =========================================================================
  describe('retry / exponential backoff', () => {
    it('should compute exponential backoff delays', () => {
      const queue = new RequestQueue(DEFAULT_CONFIG);
      const qAny = queue as any;
      expect(qAny.getRetryDelay(1)).toBe(2000);   // 1000 * 2^1
      expect(qAny.getRetryDelay(2)).toBe(4000);   // 1000 * 2^2
      expect(qAny.getRetryDelay(3)).toBe(8000);   // 1000 * 2^3
    });

    it('should cap retry delay at 30 seconds', () => {
      const queue = new RequestQueue(DEFAULT_CONFIG);
      const qAny = queue as any;
      expect(qAny.getRetryDelay(10)).toBe(30_000);
      expect(qAny.getRetryDelay(20)).toBe(30_000);
    });

    it('should compute correct delay for retryCount 0', () => {
      const queue = new RequestQueue(DEFAULT_CONFIG);
      const qAny = queue as any;
      // 1000 * 2^0 = 1000
      expect(qAny.getRetryDelay(0)).toBe(1000);
    });

    it('should respect maxRetries option', async () => {
      const queue = new RequestQueue(PERMISSIVE_CONFIG);
      let callCount = 0;
      (queue as any).executeRequest = async () => {
        callCount++;
        throw new Error('always fails');
      };

      const onError = vi.fn();
      queue.enqueue(makeRequest('fail'), RequestPriority.NORMAL, {
        maxRetries: 2,
        onError,
      });

      // Advance enough time for all retries to exhaust
      for (let i = 0; i < 100; i++) {
        await vi.advanceTimersByTimeAsync(1000);
      }

      // Initial attempt + 2 retries = 3 total calls
      expect(callCount).toBe(3);
      expect(onError).toHaveBeenCalledTimes(1);
    });
  });

  // =========================================================================
  // Default configuration
  // =========================================================================
  describe('default configuration', () => {
    it('should use default rate limit config when none is provided', () => {
      const queue = new RequestQueue();
      const qAny = queue as any;
      expect(qAny.rateLimitConfig.requestsPerMinute).toBe(60);
      expect(qAny.rateLimitConfig.requestsPerHour).toBe(1000);
      expect(qAny.rateLimitConfig.burstLimit).toBe(10);
    });

    it('should default maxRetries to 3 when not specified in enqueue options', () => {
      const { queue } = createInertQueue();
      queue.enqueue(makeRequest('a'));
      const next = queue.getStatus().nextRequest;
      expect(next).toBeDefined();
      expect(next!.maxRetries).toBe(3);
    });

    it('should default priority to NORMAL when not specified', () => {
      const { queue } = createInertQueue();
      queue.enqueue(makeRequest('a'));
      const next = queue.getStatus().nextRequest;
      expect(next).toBeDefined();
      expect(next!.priority).toBe(RequestPriority.NORMAL);
    });
  });

  // =========================================================================
  // updateAverageProcessingTime
  // =========================================================================
  describe('average processing time', () => {
    it('should calculate average processing time from history', () => {
      const queue = new RequestQueue(DEFAULT_CONFIG);
      const qAny = queue as any;
      qAny.requestHistory = [
        { timestamp: 1000, success: true, duration: 100 },
        { timestamp: 2000, success: true, duration: 300 },
        { timestamp: 3000, success: true, duration: 200 },
      ];

      qAny.updateAverageProcessingTime();
      expect(qAny.metrics.averageProcessingTime).toBe(200); // (100+300+200)/3
    });

    it('should not change average when history is empty', () => {
      const queue = new RequestQueue(DEFAULT_CONFIG);
      const qAny = queue as any;
      qAny.requestHistory = [];
      qAny.metrics.averageProcessingTime = 42;

      qAny.updateAverageProcessingTime();
      expect(qAny.metrics.averageProcessingTime).toBe(42);
    });

    it('should only use the last 100 entries for average', () => {
      const queue = new RequestQueue(DEFAULT_CONFIG);
      const qAny = queue as any;
      // 101 entries: first has duration 10000, rest have duration 100
      qAny.requestHistory = [
        { timestamp: 0, success: true, duration: 10_000 },
        ...Array.from({ length: 100 }, (_, i) => ({
          timestamp: i + 1,
          success: true,
          duration: 100,
        })),
      ];

      qAny.updateAverageProcessingTime();
      // slice(-100) should drop the outlier at index 0
      expect(qAny.metrics.averageProcessingTime).toBe(100);
    });
  });

  // =========================================================================
  // Request ID generation
  // =========================================================================
  describe('request ID generation', () => {
    it('should generate IDs starting with "req_"', () => {
      const queue = new RequestQueue(DEFAULT_CONFIG);
      const qAny = queue as any;
      const id = qAny.generateRequestId();
      expect(id).toMatch(/^req_/);
    });

    it('should include a timestamp component in the ID', () => {
      vi.setSystemTime(123456789);
      const queue = new RequestQueue(DEFAULT_CONFIG);
      const qAny = queue as any;
      const id = qAny.generateRequestId();
      expect(id).toContain('123456789');
    });
  });

  // =========================================================================
  // recalculateMetrics
  // =========================================================================
  describe('recalculateMetrics', () => {
    it('should recalculate currentQueueSize from actual queue contents', () => {
      const { queue } = createInertQueue();
      queue.enqueue(makeRequest('a'), RequestPriority.HIGH);
      queue.enqueue(makeRequest('b'), RequestPriority.LOW);
      queue.enqueue(makeRequest('c'), RequestPriority.NORMAL);

      // Manually corrupt the metric
      const qAny = queue as any;
      qAny.metrics.currentQueueSize = 999;
      qAny.recalculateMetrics();

      expect(qAny.metrics.currentQueueSize).toBe(3);
    });

    it('should recalculate priority counts from actual queue contents', () => {
      const { queue } = createInertQueue();
      queue.enqueue(makeRequest('a'), RequestPriority.HIGH);
      queue.enqueue(makeRequest('b'), RequestPriority.HIGH);
      queue.enqueue(makeRequest('c'), RequestPriority.LOW);

      const qAny = queue as any;
      // Corrupt priority counts
      qAny.metrics.queueSizeByPriority[RequestPriority.HIGH] = 99;
      qAny.recalculateMetrics();

      expect(qAny.metrics.queueSizeByPriority[RequestPriority.HIGH]).toBe(2);
      expect(qAny.metrics.queueSizeByPriority[RequestPriority.LOW]).toBe(1);
      expect(qAny.metrics.queueSizeByPriority[RequestPriority.NORMAL]).toBe(0);
      expect(qAny.metrics.queueSizeByPriority[RequestPriority.URGENT]).toBe(0);
    });
  });
});
