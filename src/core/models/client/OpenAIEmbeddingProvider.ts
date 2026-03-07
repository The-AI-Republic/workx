import OpenAI from 'openai';
import type { EmbeddingProvider } from '@/core/memory/EmbeddingClient';

/**
 * OpenAI embedding provider using text-embedding-3-small (default).
 * Also works with OpenAI-compatible providers (xAI, Groq, Together, Fireworks).
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  private client: OpenAI;
  private model: string;
  private dimensions: number;

  constructor(
    apiKey: string,
    model: string = 'text-embedding-3-small',
    dimensions: number = 1536,
    baseUrl?: string
  ) {
    this.client = new OpenAI({
      apiKey,
      baseURL: baseUrl,
      dangerouslyAllowBrowser: true,
    });
    this.model = model;
    this.dimensions = dimensions;
  }

  async embed(text: string): Promise<Float32Array> {
    // Normalization (newline→space, trim) is handled by CachedEmbeddingProvider
    const response = await this.client.embeddings.create({
      model: this.model,
      input: text,
      dimensions: this.dimensions,
    });
    if (!response.data?.[0]?.embedding) {
      throw new Error('OpenAI embedding API returned empty result');
    }
    return new Float32Array(response.data[0].embedding);
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];

    const response = await this.client.embeddings.create({
      model: this.model,
      input: texts,
      dimensions: this.dimensions,
    });

    // Sort by index to maintain order
    const sorted = response.data.sort((a, b) => a.index - b.index);
    return sorted.map((d) => new Float32Array(d.embedding));
  }

  getDimensions(): number {
    return this.dimensions;
  }
}
