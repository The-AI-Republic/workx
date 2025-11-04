/**
 * Model clients for browserx-chrome extension
 * Exports all model client components
 */

// Base classes and interfaces
export {
  ModelClient,
  ModelClientError,
  type CompletionRequest,
  type CompletionResponse,
  type StreamChunk,
  type Message,
  type Choice,
  type Usage,
  type ToolCall,
  type RetryConfig,
} from './ModelClient';

// Re-export ToolDefinition from tools/BaseTool.ts
export type { ToolDefinition } from '../tools/BaseTool';

// Provider implementations
export { OpenAIResponsesClient, type OpenAIResponsesConfig } from './OpenAIResponsesClient';

// Factory and utilities
export {
  ModelClientFactory,
  type ModelProvider,
  type ModelClientConfig,
} from './ModelClientFactory';

// Authentication management
export {
  ChromeAuthManager,
} from './ChromeAuthManager';

// Performance optimizations
export {
  SSEEventParser,
} from './SSEEventParser';

// Browser-specific request queue for rate limiting
export {
  RequestQueue,
  RequestPriority,
  type QueuedRequest,
  type RateLimitConfig as RequestQueueRateLimitConfig,
  type QueueMetrics,
} from './RequestQueue';

// ModelRegistry removed - model metadata now managed by AgentConfig