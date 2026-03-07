/**
 * Embedding provider for the memory system.
 * Hardcoded to OpenAI text-embedding-3-small (1536 dims).
 *
 * The embedding model is independent of the user's LLM provider choice.
 * This ensures stored memory vectors remain valid across provider switches.
 */

export interface EmbeddingProvider {
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
  getDimensions(): number;
}

/** Fixed embedding configuration — never changes with LLM provider. */
export const EMBEDDING_CONFIG = {
  model: 'text-embedding-3-small',
  dimensions: 1536,
} as const;

/**
 * Create the embedding provider. Always uses OpenAI's text-embedding-3-small.
 * Requires an OpenAI API key regardless of which LLM provider the user selects.
 */
export async function createEmbeddingProvider(
  apiKey: string,
): Promise<EmbeddingProvider> {
  const { OpenAIEmbeddingProvider } = await import(
    '@/core/models/client/OpenAIEmbeddingProvider'
  );
  return new OpenAIEmbeddingProvider(
    apiKey,
    EMBEDDING_CONFIG.model,
    EMBEDDING_CONFIG.dimensions,
  );
}
