/**
 * Storage Tool - LLM Runtime Data Cache
 *
 * Enables LLMs to cache intermediate results during complex multi-step operations.
 * Provides session-scoped caching with metadata-first responses to optimize context usage.
 *
 * Feature: 011-storage-cache
 * Refactored: Complete replacement of Chrome Storage API with IndexedDB-based cache
 */

import { BaseTool, type BaseToolRequest, type BaseToolOptions } from './BaseTool';
import { SessionCacheManager } from '../storage/SessionCacheManager';
import { IndexedDBAdapter } from '../storage/IndexedDBAdapter';
import {
  QuotaExceededError as SessionQuotaExceededError,
  DataTooLargeError as SessionDataTooLargeError,
  ItemNotFoundError as SessionItemNotFoundError,
  CorruptedDataError as SessionCorruptedDataError,
  CACHE_CONSTANTS
} from '../storage/SessionCacheManager';

// ============================================================================
// Cache Tool API Types (Tool Definition Data Structures)
// ============================================================================

/**
 * Base request for all StorageTool cache operations
 */
export interface CacheToolRequest {
  /** The cache operation to perform */
  action: 'write' | 'read' | 'list' | 'delete' | 'update';

  /** Session ID (auto-extracted from context if not provided) */
  sessionId?: string;

  /** Task ID (auto-generated if not provided) */
  taskId?: string;

  /** Turn ID (auto-generated if not provided) */
  turnId?: string;
}

/**
 * Write operation request - store new cached item
 */
export interface CacheWriteRequest extends CacheToolRequest {
  action: 'write';

  /** The data to cache (any JSON-serializable value) */
  data: any;

  /** Human-readable description for LLM reasoning (max 500 chars) */
  description: string;

  /** Optional custom metadata for LLM annotations */
  customMetadata?: Record<string, any>;
}

/**
 * Read operation request - retrieve cached item by key
 */
export interface CacheReadRequest extends CacheToolRequest {
  action: 'read';

  /** Storage key of item to retrieve */
  storageKey: string;
}

/**
 * List operation request - get all cached items metadata for session
 */
export interface CacheListRequest extends CacheToolRequest {
  action: 'list';

  /** Optional session ID filter (defaults to current session) */
  sessionId?: string;
}

/**
 * Delete operation request - remove cached item by key
 */
export interface CacheDeleteRequest extends CacheToolRequest {
  action: 'delete';

  /** Storage key of item to delete */
  storageKey: string;
}

/**
 * Update operation request - modify existing cached item
 */
export interface CacheUpdateRequest extends CacheToolRequest {
  action: 'update';

  /** Storage key of item to update */
  storageKey: string;

  /** New data (replaces existing data) */
  data: any;

  /** New description (replaces existing description) */
  description: string;

  /** Optional custom metadata (replaces existing metadata) */
  customMetadata?: Record<string, any>;
}

/**
 * Lightweight metadata returned to LLM (not full data)
 * Designed to stay under 700 bytes for context efficiency
 */
export interface CacheMetadata {
  /** Composite storage key */
  storageKey: string;

  /** Human-readable description */
  description: string;

  /** Timestamp when created/updated (Unix ms) */
  timestamp: number;

  /** Serialized size of data field (bytes) */
  dataSize: number;

  /** Session identifier */
  sessionId: string;

  /** Task identifier */
  taskId: string;

  /** Turn identifier */
  turnId: string;
}

/**
 * Full cached item (includes data payload)
 * Only returned on explicit read operations
 */
export interface CachedItem extends CacheMetadata {
  /** The actual cached data (JSON-serializable) */
  data: any;

  /** Optional custom metadata */
  customMetadata?: Record<string, any>;
}

/**
 * Response for write operations
 * Returns only metadata to keep LLM context efficient
 */
export interface CacheWriteResponse {
  success: true;
  metadata: CacheMetadata;
  message: string; // Human-readable confirmation
}

/**
 * Response for read operations
 * Returns full item with data payload
 */
export interface CacheReadResponse {
  success: true;
  item: CachedItem;
}

/**
 * Response for list operations
 * Returns array of metadata (not full data)
 */
export interface CacheListResponse {
  success: true;
  items: CacheMetadata[];
  totalCount: number;
  totalSize: number; // Total bytes across all items
  sessionQuotaUsed: number; // Bytes used out of 200MB quota
  sessionQuotaRemaining: number; // Bytes remaining
}

/**
 * Response for delete operations
 */
export interface CacheDeleteResponse {
  success: true;
  storageKey: string;
  message: string;
}

/**
 * Response for update operations
 * Returns updated metadata
 */
export interface CacheUpdateResponse {
  success: true;
  metadata: CacheMetadata;
  message: string;
}

/**
 * Specific error types for different failure scenarios
 */
export enum CacheErrorType {
  QUOTA_EXCEEDED = 'QUOTA_EXCEEDED',
  ITEM_NOT_FOUND = 'ITEM_NOT_FOUND',
  STORAGE_UNAVAILABLE = 'STORAGE_UNAVAILABLE',
  DATA_TOO_LARGE = 'DATA_TOO_LARGE',
  CORRUPTED_DATA = 'CORRUPTED_DATA',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  UNKNOWN_ERROR = 'UNKNOWN_ERROR'
}

/**
 * Base error for all cache operations
 */
export interface CacheError {
  success: false;
  error: string;
  errorType: CacheErrorType;
  message: string; // Actionable guidance for LLM
  details?: any;
}

/**
 * Quota exceeded error (session over 200MB limit)
 */
export interface QuotaExceededError extends CacheError {
  errorType: CacheErrorType.QUOTA_EXCEEDED;
  currentSize: number;
  attemptedSize: number;
  quotaLimit: number;
}

/**
 * Item not found error (invalid storage key)
 */
export interface ItemNotFoundError extends CacheError {
  errorType: CacheErrorType.ITEM_NOT_FOUND;
  storageKey: string;
}

/**
 * Storage unavailable error (IndexedDB disabled/blocked)
 */
export interface StorageUnavailableError extends CacheError {
  errorType: CacheErrorType.STORAGE_UNAVAILABLE;
  reason: string;
}

/**
 * Data too large error (single item exceeds 5MB)
 */
export interface DataTooLargeError extends CacheError {
  errorType: CacheErrorType.DATA_TOO_LARGE;
  dataSize: number;
  maxSize: number;
}

/**
 * Union type for all cache errors
 */
export type CacheErrorResponse =
  | QuotaExceededError
  | ItemNotFoundError
  | StorageUnavailableError
  | DataTooLargeError
  | CacheError;

/**
 * Tool definition for BaseTool integration
 * This is the schema passed to the LLM for tool discovery
 */
export const CACHE_TOOL_DEFINITION = {
  name: 'cache_storage_tool',
  description: `Cache intermediate results during complex multi-step operations to avoid context overflow.

## WHEN TO USE CACHE

Use the cache tool when:
1. **Processing 5+ similar items** (emails, documents, records, etc.)
2. **Single result size > 3KB** and used in later steps (not immediate reasoning)
3. **Multi-step workflows** requiring aggregation or pause/resume

## DESCRIPTION GUIDELINES (IMPORTANT)

**MUST keep descriptions under 500 characters.** Focus on:
- **What**: Type of data cached
- **Why**: Purpose/context (e.g., "customer support tickets re: pricing")
- **Size**: Approximate data size

**Good Examples**:
- ✅ "Email summaries batch 1-20: customer support tickets re pricing, 15KB total"
- ✅ "Processed order data for Q4 2024 analysis, contains 50 order objects with metadata, 120KB"
- ✅ "Gmail thread summaries (unread), filtered for action items, 8 threads, 22KB"

**Bad Examples**:
- ❌ "Email summaries" (too vague, no context)
- ❌ Verbose multi-sentence descriptions over 500 chars

## QUOTA MANAGEMENT
Session quota: 200MB. Auto-evicts oldest 50% when quota reached. You don't need to manually manage quota.

## USAGE
- For write/update: MUST provide both "data" and "description" fields
- For read/delete: MUST provide "storageKey"
- For list: only "action" needed`,
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'Cache operation to perform: "write" (store new data - requires data + description), "read" (retrieve data - requires storageKey), "list" (show all cached items), "delete" (remove item - requires storageKey), "update" (modify existing - requires storageKey + data + description)',
        enum: ['write', 'read', 'list', 'delete', 'update']
      },
      data: {
        type: 'object',
        description: '**REQUIRED for write/update operations** - The actual data to cache. Despite type="object", you can pass ANY JSON-serializable value: object {key: "value"}, array [1,2,3], string, number, or boolean. The tool accepts all types. Max 5MB. Example: {emailSummary: "Temu promo", sender: "Temu", importance: "low"}'
      },
      description: {
        type: 'string',
        description: '**REQUIRED for write/update operations** - Human-readable description (max 500 chars) explaining what this cached data contains. Focus on: what it is, why cached, approximate size. Example: "Email summary from Temu: promo for toy purchase, low importance, ~200 bytes"',
        maxLength: 500
      },
      storageKey: {
        type: 'string',
        description: '**REQUIRED for read/delete/update operations** - The unique storage key returned from a previous write operation. Format: sessionId_taskId_turnId. Use "list" action first to see available keys.'
      },
      customMetadata: {
        type: 'object',
        description: 'Optional custom metadata for additional annotations (advanced use only)'
      },
      sessionId: {
        type: 'string',
        description: 'Session ID (auto-detected, usually do not provide)'
      },
      taskId: {
        type: 'string',
        description: 'Task ID (auto-generated, usually do not provide)'
      },
      turnId: {
        type: 'string',
        description: 'Turn ID (auto-generated, usually do not provide)'
      }
    },
    required: ['action']
  }
} as const;

/**
 * Storage Tool Request Interface
 * Extends BaseToolRequest with cache-specific fields
 */
export interface StorageToolRequest extends BaseToolRequest, CacheToolRequest {}

/**
 * Storage Tool Response
 * Union of all possible cache responses
 */
export type StorageToolResponse =
  | CacheWriteResponse
  | CacheReadResponse
  | CacheListResponse
  | CacheDeleteResponse
  | CacheUpdateResponse
  | CacheErrorResponse;

/**
 * Storage Tool Implementation
 *
 * Provides LLM-optimized caching with:
 * - Session-scoped isolation (200MB quota per session)
 * - Metadata-first responses (<700 bytes)
 * - Auto-eviction (oldest 50% when quota reached)
 * - Global 5GB quota across all sessions
 */
export class StorageTool extends BaseTool {
  private cacheManager: SessionCacheManager;

  constructor(dbAdapter?: IndexedDBAdapter) {
    super();
    this.cacheManager = new SessionCacheManager(dbAdapter);
  }

  /**
   * Tool definition for LLM discovery
   * Uses the contract-defined CACHE_TOOL_DEFINITION
   */
  protected toolDefinition = {
    type: 'function' as const,
    function: {
      name: CACHE_TOOL_DEFINITION.name,
      description: CACHE_TOOL_DEFINITION.description,
      strict: false,
      parameters: CACHE_TOOL_DEFINITION.inputSchema as any
    }
  };

  /**
   * Override execute to inject action into metadata
   */
  async execute(request: BaseToolRequest, options?: BaseToolOptions): Promise<any> {
    const typedRequest = request as StorageToolRequest;

    // Inject action into metadata so it's available in the response
    const enrichedOptions = {
      ...options,
      metadata: {
        ...options?.metadata,
        action: typedRequest.action,
      },
    };

    return super.execute(request, enrichedOptions);
  }

  /**
   * Override parameter validation to allow any JSON-serializable data
   * BaseTool's default validation is too strict for the 'data' field
   */
  protected validateParameters(parameters: Record<string, any>): { valid: boolean; errors: any[] } {
    // Minimal validation - just check that action is present
    if (!parameters.action) {
      return {
        valid: false,
        errors: [{
          parameter: 'action',
          message: 'action parameter is required',
          code: 'REQUIRED_PARAMETER'
        }]
      };
    }

    return { valid: true, errors: [] };
  }

  /**
   * Initialize the cache manager
   * Should be called once on startup
   */
  async initialize(): Promise<void> {
    await this.cacheManager.initialize();
  }

  /**
   * Close the cache manager
   * Should be called on cleanup
   */
  async close(): Promise<void> {
    await this.cacheManager.close();
  }

  // ============================================================================
  // Cache Operation Execution
  // ============================================================================

  /**
   * Execute cache operation
   * Routes to appropriate handler based on action
   */
  protected async executeImpl(
    request: StorageToolRequest,
    options?: BaseToolOptions
  ): Promise<StorageToolResponse> {
    try {
      // Extract sessionId from request or options metadata
      const sessionId = request.sessionId || options?.metadata?.sessionId;
      if (!sessionId) {
        return this.createErrorResponse(
          CacheErrorType.VALIDATION_ERROR,
          'Session ID is required but was not provided in request or context',
          { providedRequest: request }
        );
      }

      // Inject sessionId into request if not present
      const requestWithSession = { ...request, sessionId };

      // Route to appropriate handler
      switch (request.action) {
        case 'write':
          return await this.handleWrite(requestWithSession as CacheWriteRequest);

        case 'read':
          return await this.handleRead(requestWithSession as CacheReadRequest);

        case 'list':
          return await this.handleList(requestWithSession as CacheListRequest);

        case 'delete':
          return await this.handleDelete(requestWithSession as CacheDeleteRequest);

        case 'update':
          return await this.handleUpdate(requestWithSession as CacheUpdateRequest);

        default:
          return this.createErrorResponse(
            CacheErrorType.VALIDATION_ERROR,
            `Unsupported cache action: ${(request as any).action}`,
            { action: (request as any).action }
          );
      }
    } catch (error: any) {
      // Convert unexpected errors to error responses
      return this.convertErrorToResponse(error);
    }
  }

  /**
   * Handle write operation
   * Stores data and returns metadata only
   */
  private async handleWrite(request: CacheWriteRequest): Promise<CacheWriteResponse | CacheErrorResponse> {
    try {
      // Validate required fields
      if (!request.data) {
        return this.createErrorResponse(
          CacheErrorType.VALIDATION_ERROR,
          'data field is required for write operation'
        );
      }

      if (!request.description) {
        return this.createErrorResponse(
          CacheErrorType.VALIDATION_ERROR,
          'description field is required for write operation (max 500 chars)'
        );
      }

      // Call SessionCacheManager.write()
      const metadata = await this.cacheManager.write(
        request.sessionId!,
        request.data,
        request.description,
        request.taskId,
        request.turnId,
        request.customMetadata
      );

      return {
        success: true,
        metadata,
        message: `Cached item stored successfully. Key: ${metadata.storageKey}. Use this key to retrieve later. Description: "${metadata.description.substring(0, 100)}${metadata.description.length > 100 ? '...' : ''}"`
      };
    } catch (error: any) {
      return this.convertErrorToResponse(error);
    }
  }

  /**
   * Handle read operation
   * Retrieves full item with data
   */
  private async handleRead(request: CacheReadRequest): Promise<CacheReadResponse | CacheErrorResponse> {
    try {
      // Validate required fields
      if (!request.storageKey) {
        return this.createErrorResponse(
          CacheErrorType.VALIDATION_ERROR,
          'storageKey field is required for read operation'
        );
      }

      // Call SessionCacheManager.read()
      const item = await this.cacheManager.read(request.storageKey);

      return {
        success: true,
        item
      };
    } catch (error: any) {
      return this.convertErrorToResponse(error);
    }
  }

  /**
   * Handle list operation
   * Returns metadata for all items in session
   */
  private async handleList(request: CacheListRequest): Promise<CacheListResponse | CacheErrorResponse> {
    try {
      // Call SessionCacheManager.list()
      const items = await this.cacheManager.list(request.sessionId!);

      // Get session stats for quota information
      const stats = await this.cacheManager.getStats(request.sessionId!);

      return {
        success: true,
        items,
        totalCount: items.length,
        totalSize: stats.totalSize,
        sessionQuotaUsed: stats.totalSize,
        sessionQuotaRemaining: CACHE_CONSTANTS.MAX_SESSION_QUOTA - stats.totalSize
      };
    } catch (error: any) {
      return this.convertErrorToResponse(error);
    }
  }

  /**
   * Handle delete operation
   * Removes item from cache
   */
  private async handleDelete(request: CacheDeleteRequest): Promise<CacheDeleteResponse | CacheErrorResponse> {
    try {
      // Validate required fields
      if (!request.storageKey) {
        return this.createErrorResponse(
          CacheErrorType.VALIDATION_ERROR,
          'storageKey field is required for delete operation'
        );
      }

      // Call SessionCacheManager.delete()
      const deleted = await this.cacheManager.delete(request.storageKey);

      if (!deleted) {
        return this.createErrorResponse(
          CacheErrorType.ITEM_NOT_FOUND,
          `Item with key "${request.storageKey}" not found`,
          { storageKey: request.storageKey }
        );
      }

      return {
        success: true,
        storageKey: request.storageKey,
        message: `Item "${request.storageKey}" deleted successfully`
      };
    } catch (error: any) {
      return this.convertErrorToResponse(error);
    }
  }

  /**
   * Handle update operation
   * Updates existing item with new data and description
   */
  private async handleUpdate(request: CacheUpdateRequest): Promise<CacheUpdateResponse | CacheErrorResponse> {
    try {
      // Validate required fields
      if (!request.storageKey) {
        return this.createErrorResponse(
          CacheErrorType.VALIDATION_ERROR,
          'storageKey field is required for update operation'
        );
      }

      if (!request.data) {
        return this.createErrorResponse(
          CacheErrorType.VALIDATION_ERROR,
          'data field is required for update operation'
        );
      }

      if (!request.description) {
        return this.createErrorResponse(
          CacheErrorType.VALIDATION_ERROR,
          'description field is required for update operation (max 500 chars)'
        );
      }

      // Call SessionCacheManager.update()
      const metadata = await this.cacheManager.update(
        request.storageKey,
        request.data,
        request.description,
        request.customMetadata
      );

      return {
        success: true,
        metadata,
        message: `Item "${request.storageKey}" updated successfully`
      };
    } catch (error: any) {
      return this.convertErrorToResponse(error);
    }
  }

  // ============================================================================
  // Error Handling
  // ============================================================================

  /**
   * Convert SessionCacheManager errors to CacheErrorResponse
   */
  private convertErrorToResponse(error: any): CacheErrorResponse {
    // Handle SessionCacheManager-specific errors
    if (error instanceof SessionQuotaExceededError) {
      const quotaError: QuotaExceededError = {
        success: false,
        error: error.message,
        errorType: CacheErrorType.QUOTA_EXCEEDED,
        message: `Session quota exceeded. Current: ${Math.round(error.currentSize / 1024 / 1024)}MB, Attempted: +${Math.round(error.attemptedSize / 1024 / 1024)}MB, Limit: ${Math.round(error.quotaLimit / 1024 / 1024)}MB. Auto-eviction triggered - oldest 50% of items removed. Please retry the operation.`,
        currentSize: error.currentSize,
        attemptedSize: error.attemptedSize,
        quotaLimit: error.quotaLimit
      };
      return quotaError;
    }

    if (error instanceof SessionDataTooLargeError) {
      const dataError: DataTooLargeError = {
        success: false,
        error: error.message,
        errorType: CacheErrorType.DATA_TOO_LARGE,
        message: `Data too large for caching. Size: ${Math.round(error.dataSize / 1024 / 1024)}MB, Max: ${Math.round(error.maxSize / 1024 / 1024)}MB. Consider splitting into smaller chunks or summarizing the data.`,
        dataSize: error.dataSize,
        maxSize: error.maxSize
      };
      return dataError;
    }

    if (error instanceof SessionItemNotFoundError) {
      const notFoundError: ItemNotFoundError = {
        success: false,
        error: error.message,
        errorType: CacheErrorType.ITEM_NOT_FOUND,
        message: `Item not found. Key: "${error.storageKey}". Use the list action to see available cached items.`,
        storageKey: error.storageKey
      };
      return notFoundError;
    }

    if (error instanceof SessionCorruptedDataError) {
      const corruptedError: CacheErrorResponse = {
        success: false,
        error: error.message,
        errorType: CacheErrorType.CORRUPTED_DATA,
        message: `Cache item corrupted and cannot be parsed. Key: "${error.storageKey}". Recovery: Delete this item using the delete action and recreate it with fresh data. Original error: ${error.originalError.message}`,
        details: { storageKey: error.storageKey, originalError: error.originalError.message }
      };
      return corruptedError;
    }

    // Handle generic errors
    return this.createErrorResponse(
      CacheErrorType.UNKNOWN_ERROR,
      error.message || 'An unexpected error occurred',
      { errorType: error.constructor.name, stack: error.stack }
    );
  }

  /**
   * Create a generic error response
   */
  private createErrorResponse(
    errorType: CacheErrorType,
    message: string,
    details?: any
  ): CacheErrorResponse {
    return {
      success: false,
      error: message,
      errorType,
      message,
      details
    };
  }

  // ============================================================================
  // Cache Management Methods
  // ============================================================================

  /**
   * Get cache statistics for debugging
   */
  async getStats(sessionId: string) {
    return await this.cacheManager.getStats(sessionId);
  }

  /**
   * Get global cache statistics
   */
  async getGlobalStats() {
    return await this.cacheManager.getGlobalStats();
  }

  /**
   * Cleanup operations
   */
  async cleanupOrphans(maxAgeMs: number = CACHE_CONSTANTS.ORPHAN_CLEANUP_THRESHOLD_MS) {
    return await this.cacheManager.cleanupOrphans(maxAgeMs);
  }

  async cleanupOutdated(maxAgeDays?: number) {
    return await this.cacheManager.cleanupOutdated(maxAgeDays);
  }
}
