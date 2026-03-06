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
    const input = text.replace(/\n/g, ' ').trim();
    const result = await this.client.models.embedContent({
      model: this.model,
      contents: input,
    });
    // H4: Guard against empty/malformed API response
    if (!result.embeddings?.[0]?.values) {
      throw new Error('Google embedding API returned empty result');
    }
    return new Float32Array(result.embeddings[0].values);
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];

    // H5: Use parallel calls instead of sequential for better throughput
    const promises = texts.map((text) => this.embed(text));
    return Promise.all(promises);
  }

  getDimensions(): number {
    return this.dimensions;
  }
}
