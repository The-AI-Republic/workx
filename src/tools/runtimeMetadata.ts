/**
 * Tool Runtime Metadata
 *
 * Defines runtime execution metadata for tools: concurrency safety,
 * UI classification, result size management, and progress reporting.
 *
 * This metadata lives on ToolRegistryEntry (not on ToolDefinition.metadata)
 * because it is a runtime execution concern, not a model-facing schema concern.
 *
 * Defaults are fail-closed: unknown tools are assumed non-concurrent, non-read-only.
 */

// =============================================================================
// Concurrency Profile
// =============================================================================

/**
 * Per-input concurrency classification for a tool.
 * All methods are synchronous — concurrency decisions must be fast.
 */
export interface ToolConcurrencyProfile {
  /** Whether this tool call is safe to run in parallel with other safe calls. */
  isConcurrencySafe(input: Record<string, unknown>): boolean;
  /** Whether this tool call only reads state (no mutations). */
  isReadOnly(input: Record<string, unknown>): boolean;
  /** Whether this tool call is irreversible (delete, overwrite, send). */
  isDestructive(input: Record<string, unknown>): boolean;
}

/**
 * Fail-closed defaults. Applied when a tool does not declare its own profile.
 */
export const DEFAULT_TOOL_CONCURRENCY_PROFILE: ToolConcurrencyProfile = {
  isConcurrencySafe: () => false,
  isReadOnly: () => false,
  isDestructive: () => false,
};

// =============================================================================
// UI Profile
// =============================================================================

/**
 * UI-oriented metadata for tools: activity descriptions and search/read classification.
 */
export interface ToolUIProfile {
  /** Human-readable description for spinner/status display. */
  getActivityDescription?(input: Record<string, unknown>): string | null;
  /** Classification for UI display (collapsible sections, search results). */
  isSearchOrReadCommand?(input: Record<string, unknown>): {
    isSearch: boolean;
    isRead: boolean;
    isList?: boolean;
  };
}

// =============================================================================
// Result Profile
// =============================================================================

/**
 * Result size management for tools with potentially large outputs.
 */
export interface ToolResultProfile {
  /** Max chars before result is truncated. */
  maxResultSizeChars?: number;
  /** Check if two inputs would produce equivalent results (for deduplication). */
  inputsEquivalent?(a: Record<string, unknown>, b: Record<string, unknown>): boolean;
}

// =============================================================================
// Combined Runtime Metadata
// =============================================================================

/**
 * Complete runtime metadata for a registered tool.
 */
export interface ToolRuntimeMetadata {
  concurrency: ToolConcurrencyProfile;
  ui?: ToolUIProfile;
  result?: ToolResultProfile;
}

// =============================================================================
// Progress Reporting
// =============================================================================

/**
 * Base type for tool-specific progress data.
 * Each tool defines its own progress shape with a discriminant `type` field.
 */
export interface ToolProgressData {
  type: string;
  message?: string;
  status?: string;
  [key: string]: unknown;
}

/**
 * Progress event wrapper with correlation ID.
 */
export interface ToolProgress<P extends ToolProgressData = ToolProgressData> {
  toolUseID: string;
  data: P;
}

/**
 * Progress callback type. Optional — only invoked when provided.
 */
export type ToolProgressCallback<P extends ToolProgressData = ToolProgressData> = (
  progress: ToolProgress<P>
) => void;

// =============================================================================
// Tool-Specific Progress Types
// =============================================================================

export interface DOMToolProgress extends ToolProgressData {
  type: 'dom_progress';
  action: 'snapshot' | 'click' | 'type' | 'keypress' | 'scroll';
  selector?: string;
  status: 'started' | 'serializing' | 'executing' | 'completed' | 'failed';
  nodeCount?: number;
}

export interface NavigationProgress extends ToolProgressData {
  type: 'navigation_progress';
  url: string;
  status: 'loading' | 'loaded' | 'failed';
}

export interface WebScrapingProgress extends ToolProgressData {
  type: 'scraping_progress';
  contentType: string;
  bytesExtracted: number;
  status: 'started' | 'extracting' | 'completed' | 'failed';
}

export interface DataExtractionProgress extends ToolProgressData {
  type: 'extraction_progress';
  mode: string;
  rowsExtracted: number;
  status: 'started' | 'extracting' | 'completed' | 'failed';
}

export interface PageVisionProgress extends ToolProgressData {
  type: 'vision_progress';
  status: 'capturing' | 'captured' | 'failed';
  screenshotSizeBytes?: number;
}

export interface DataQueryProgress extends ToolProgressData {
  type: 'data_query';
  status: 'started' | 'completed' | 'failed';
  sourceName: string;
  connectorId: string;
  transport: 'native' | 'mcp';
  purpose: string;
  sql?: string;
  parameterTypes: string[];
  parameterCount: number;
  durationMs?: number;
  rowCount?: number;
  truncated?: boolean;
  errorCode?: string;
}

export interface DataContextLearnedProgress extends ToolProgressData {
  type: 'data_context_learned';
  status: 'completed';
  sourceId: string;
  sourceName: string;
  summaries: string[];
  priorRevision: number;
  currentRevision: number;
}

export interface NetworkInterceptProgress extends ToolProgressData {
  type: 'intercept_progress';
  action: string;
  status: 'started' | 'rule_applied' | 'monitoring' | 'completed' | 'failed';
  requestsIntercepted?: number;
}
