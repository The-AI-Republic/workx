/**
 * Model clients for pi
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
export type { ToolDefinition } from '../../tools/BaseTool';

// Provider implementations
export { OpenAIResponsesClient, type OpenAIResponsesConfig } from './client/OpenAIResponsesClient';
export { OpenAIChatCompletionClient, type OpenAIChatCompletionConfig } from './client/OpenAIChatCompletionClient';
export { GoogleCompletionClient } from './client/GoogleCompletionClient';
export { GroqClient } from './client/GroqClient';

// Factory and utilities
export {
  ModelClientFactory,
  type ModelProvider,
  type ModelClientConfig,
} from './ModelClientFactory';

// Performance optimizations
export {
  SSEEventParser,
} from './SSEEventParser';

// ModelRegistry removed - model metadata now managed by AgentConfig