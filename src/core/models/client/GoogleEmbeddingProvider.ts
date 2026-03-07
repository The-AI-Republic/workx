import { GoogleGenAI } from '@google/genai';
import type { EmbeddingProvider } from '@/core/memory/EmbeddingClient';

/**
 * Google AI embedding provider using text-embedding-004 (768 dimensions).
 */
export class GoogleEmbeddingProvider implements EmbeddingProvider {
  private client: GoogleGenAI;
  private model: string;
  private dimensions: number;

  constructor(
    apiKey: string,
    model: string = 'text-embedding-004',
    dimensions: number = 768
  ) {
    this.client = new GoogleGenAI({ apiKey });
    this.model = model;
    this.dimensions = dimensions;
  }

  async embed(text: string): Promise<Float32Array> {
    // Normalization (newline→space, trim) is handled by CachedEmbeddingProvider
    const result = await this.client.models.embedContent({
      model: this.model,
      contents: text,
      config: { outputDimensionality: this.dimensions },
    });
    // H4: Guard against empty/malformed API response
    if (!result.embeddings?.[0]?.values) {
      throw new Error('Google embedding API returned empty result');
    }
    return new Float32Array(result.embeddings[0].values);
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];

    // Process in batches of 5 to avoid API rate limits
    const CONCURRENCY = 5;
    const results: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += CONCURRENCY) {
      const batch = texts.slice(i, i + CONCURRENCY);
      const batchResults = await Promise.all(batch.map((text) => this.embed(text)));
      results.push(...batchResults);
    }
    return results;
  }

  getDimensions(): number {
    return this.dimensions;
  }
}
