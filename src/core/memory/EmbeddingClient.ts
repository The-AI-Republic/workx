/**
 * Embedding provider abstraction for the memory system.
 * Selects the appropriate embedding model based on the user's LLM provider.
 */

export interface EmbeddingProvider {
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
  getDimensions(): number;
}

export interface EmbeddingProviderConfig {
  provider: 'openai' | 'google';
  model: string;
  dimensions: number;
}

/**
 * Select embedding provider based on the user's LLM provider.
 */
export function selectEmbeddingProvider(
  llmProvider: string
): EmbeddingProviderConfig {
  switch (llmProvider) {
    case 'openai':
    case 'xai':
    case 'groq':
    case 'together':
    case 'fireworks':
      return {
        provider: 'openai',
        model: 'text-embedding-3-small',
        dimensions: 1536,
      };

    case 'google-ai-studio':
      return {
        provider: 'google',
        model: 'text-embedding-004',
        dimensions: 768,
      };

    case 'anthropic':
    default:
      // Anthropic doesn't offer embeddings — fall back to OpenAI
      return {
        provider: 'openai',
        model: 'text-embedding-3-small',
        dimensions: 1536,
      };
  }
}

/**
 * Create an EmbeddingProvider based on provider config and API key.
 */
export async function createEmbeddingProvider(
  config: EmbeddingProviderConfig,
  apiKey: string,
  baseUrl?: string
): Promise<EmbeddingProvider> {
  if (config.provider === 'google') {
    const { GoogleEmbeddingProvider } = await import(
      '@/core/models/client/GoogleEmbeddingProvider'
    );
    return new GoogleEmbeddingProvider(apiKey, config.model, config.dimensions);
  }

  const { OpenAIEmbeddingProvider } = await import(
    '@/core/models/client/OpenAIEmbeddingProvider'
  );
  return new OpenAIEmbeddingProvider(
    apiKey,
    config.model,
    config.dimensions,
    baseUrl
  );
}
