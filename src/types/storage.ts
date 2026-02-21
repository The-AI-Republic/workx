export interface CacheEntry {
  key: string;
  value: any;
  timestamp: number;
  ttl: number;
  hits: number;
  size: number;
  compressed?: boolean;
  tags?: string[];
}

export interface CacheConfig {
  maxSize: number;
  defaultTTL: number;
  evictionPolicy: 'lru' | 'lfu' | 'fifo';
  compressionThreshold: number;
  persistToStorage: boolean;
}

export interface StorageQuota {
  usage: number;
  quota: number;
  percentage: number;
  persistent?: boolean;
}

export interface StorageStats {
  conversations: {
    count: number;
    sizeEstimate: number;
  };
  messages: {
    count: number;
    sizeEstimate: number;
  };
  cache: {
    entries: number;
    sizeEstimate: number;
  };
  totalUsage: number;
  quota: number;
  percentageUsed: number;
}

// ============================================================================
// Internal Storage Types (Feature 011-storage-cache)
// Note: Tool definition types (requests, responses, errors) are in StorageTool.ts
// ============================================================================

/**
 * Session cache entry stored in IndexedDB cache_items object store
 * Used for LLM runtime data caching
 */
export interface SessionCacheEntry {
  /** Composite storage key: {sessionId}_{taskId}_{turnId} */
  storageKey: string;

  /** The actual cached data (JSON-serializable) */
  data: any;

  /** Human-readable description (max 500 chars) */
  description: string;

  /** Timestamp when created/updated (Unix ms) */
  timestamp: number;

  /** Serialized size of data field (bytes) */
  dataSize: number;

  /** Session identifier */
  sessionId: string;

  /** Task identifier (8-char alphanumeric) */
  taskId: string;

  /** Turn identifier (8-char alphanumeric) */
  turnId: string;

  /** Optional custom metadata for LLM annotations */
  customMetadata?: Record<string, any>;
}

/**
 * Session cache metadata stored in IndexedDB sessions object store
 * Tracks quota usage per session
 */
export interface SessionCacheMetadata {
  /** Session identifier */
  sessionId: string;

  /** Total bytes used by this session's cache entries */
  totalSize: number;

  /** Number of cached items in this session */
  itemCount: number;

  /** Percentage of 200MB quota used (0-100) */
  quotaUsed: number;

  /** Timestamp when first item was created (Unix ms) */
  createdAt: number;

  /** Timestamp when last accessed (Unix ms) */
  lastAccessedAt: number;
}

/**
 * LLM cache configuration stored in IndexedDB config object store
 * Separate from rollout CacheConfig
 */
export interface LLMCacheConfig {
  /** Outdated cache cleanup in days (-1 = disabled, default 30) */
  outdatedCleanupDays: number;

  /** Session quota eviction percentage (0-1, default 0.5 = 50%) */
  sessionEvictionPercentage: number;
}

// ============================================================================
// Plan Storage Types (Feature 029-planning-tool-v2)
// ============================================================================

import type { PlanStatus, StepStatus } from '../core/protocol/events';

/**
 * A plan step as stored in IndexedDB
 */
export interface StoredPlanStep {
  /** Stable UUID identifier */
  id: string;
  /** Human-readable step description */
  step: string;
  /** Current execution state */
  status: StepStatus;
  /** Critical file paths relevant to this step */
  files?: string[];
  /** Existing code/functions to leverage */
  reuse?: string[];
  /** How to verify this step succeeded */
  verification?: string;
  /** Present-tense description shown during InProgress */
  activeDescription?: string;
  /** IDs of steps that must complete before this step can start */
  dependsOn?: string[];
}

/**
 * A persisted plan stored in IndexedDB, keyed by sessionId
 */
export interface StoredPlan {
  /** Unique plan identifier (UUID) */
  id: string;
  /** Session this plan belongs to (primary key in IndexedDB) */
  sessionId: string;
  /** Plan-level status */
  status: PlanStatus;
  /** Agent's explanation for creating/updating this plan */
  explanation?: string;
  /** Ordered list of plan steps */
  steps: StoredPlanStep[];
  /** Monotonically increasing counter, incremented on every update */
  version: number;
  /** Unix timestamp (ms) of plan creation */
  createdAt: number;
  /** Unix timestamp (ms) of last modification */
  updatedAt: number;
}