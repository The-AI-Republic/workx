/**
 * Embedding provider for the memory system.
 * Hardcoded to OpenAI text-embedding-3-small (1536 dims).
 *
 * The embedding model is independent of the user's LLM provider choice.
 * This ensures stored memory vectors remain valid across provider switches.
 *
 * Supports two routing modes:
 * - Direct: calls OpenAI API with user's own API key
 * - Backend: proxies through AI Republic backend (for paid-tier logged-in users)
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
 * Create an embedding provider that calls OpenAI directly with the user's own API key.
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

/**
 * Create an embedding provider that routes through the AI Republic backend.
 * Used for paid-tier logged-in users who prefer backend routing for memory.
 */
export function createBackendEmbeddingProvider(
  backendBaseUrl: string,
  getAccessToken: () => Promise<string | null>,
): EmbeddingProvider {
  return new BackendEmbeddingProvider(
    backendBaseUrl,
    getAccessToken,
    EMBEDDING_CONFIG.model,
    EMBEDDING_CONFIG.dimensions,
  );
}

/**
 * Embedding provider that routes embedding requests through the AI Republic backend.
 * Uses fetch (not the OpenAI SDK) to call the backend's /openai/embeddings endpoint.
 * The backend proxies to OpenAI using its own API key and deducts credits.
 */
class BackendEmbeddingProvider implements EmbeddingProvider {
  constructor(
    private backendBaseUrl: string,
    private getAccessToken: () => Promise<string | null>,
    private model: string,
    private dimensions: number,
  ) {}

  async embed(text: string): Promise<Float32Array> {
    const data = await this.callBackend(text);
    if (!data.data?.[0]?.embedding) {
      throw new Error('Backend embedding API returned empty result');
    }
    return new Float32Array(data.data[0].embedding);
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];

    const data = await this.callBackend(texts);
    if (!Array.isArray(data.data) || data.data.length !== texts.length) {
      throw new Error(
        `Backend embedding API returned ${data.data?.length ?? 0} results for ${texts.length} inputs`,
      );
    }
    const sorted = [...data.data].sort(
      (a: { index: number }, b: { index: number }) => a.index - b.index,
    );
    return sorted.map(
      (d: { embedding: number[] }) => new Float32Array(d.embedding),
    );
  }

  getDimensions(): number {
    return this.dimensions;
  }

  private async callBackend(
    input: string | string[],
  ): Promise<{ data: Array<{ index: number; embedding: number[] }> }> {
    const token = await this.getAccessToken();
    if (!token) {
      throw new Error(
        'No access token available for backend memory embeddings. Please log in.',
      );
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    };

    const response = await fetch(`${this.backendBaseUrl}/openai/embeddings`, {
      method: 'POST',
      headers,
      credentials: 'include', // For cookie-based auth (extension)
      body: JSON.stringify({
        model: this.model,
        input,
        dimensions: this.dimensions,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'Unknown error');
      throw new Error(
        `Backend embedding request failed (${response.status}): ${errorText}`,
      );
    }

    return response.json();
  }
}
