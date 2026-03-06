/**
 * LLM-based fact extraction from conversations.
 * Extracts atomic personal facts about the user from conversation messages.
 */

import extractionPrompt from './prompts/extraction.md?raw';
import type { LLMCaller, MemoryConfig } from './types';

export interface ConversationMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
}

export class FactExtractor {
  private llm: LLMCaller;
  private config: MemoryConfig;

  constructor(llm: LLMCaller, config: MemoryConfig) {
    this.llm = llm;
    this.config = config;
  }

  /**
   * Check whether extraction is worthwhile for these messages.
   */
  shouldExtract(messages: ConversationMessage[]): boolean {
    const userMessages = messages.filter((m) => m.role === 'user');
    if (userMessages.length === 0) return false;

    const totalUserChars = userMessages.reduce(
      (sum, m) => sum + (m.content?.length ?? 0),
      0
    );
    return totalUserChars >= 20;
  }

  /**
   * Pre-process messages to avoid wasting tokens on data dumps.
   */
  preprocessForExtraction(
    messages: ConversationMessage[]
  ): ConversationMessage[] {
    return messages.map((m) => {
      if (m.role !== 'user') return m;

      let text = m.content ?? '';

      // Strip large code blocks (unlikely to contain personal facts)
      text = text.replace(/```[\s\S]{500,}?```/g, '[code block removed]');

      // Truncate excessively long messages
      if (text.length > 2000) {
        text =
          text.slice(0, 2000) +
          '\n[...truncated for memory extraction]';
      }

      return { ...m, content: text };
    });
  }

  /**
   * Extract facts from conversation messages.
   * Returns an array of atomic fact strings.
   */
  async extract(messages: ConversationMessage[]): Promise<string[]> {
    if (!this.shouldExtract(messages)) {
      return [];
    }

    const processed = this.preprocessForExtraction(messages);
    const prompt = this.config.customExtractionPrompt ?? extractionPrompt;
    const systemPrompt = prompt.replace(
      '{{currentDate}}',
      new Date().toISOString().split('T')[0]
    );

    // Format conversation for the LLM
    const conversationText = processed
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
      .join('\n\n');

    try {
      const response = await this.llm.complete(
        systemPrompt,
        conversationText
      );
      return this.parseFacts(response);
    } catch (err) {
      console.warn('[Memory] Fact extraction failed:', err);
      return [];
    }
  }

  private parseFacts(response: string): string[] {
    try {
      // Try to extract the last JSON object containing "facts" (avoids
      // capturing preamble text with braces via greedy matching)
      const jsonMatch = response.match(/\{[^{}]*"facts"\s*:\s*\[[\s\S]*?\]\s*\}/);
      if (!jsonMatch) return [];

      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed.facts)) {
        return parsed.facts.filter(
          (f: unknown) => typeof f === 'string' && f.length > 0
        );
      }
      return [];
    } catch {
      console.warn('[Memory] Failed to parse extraction response');
      return [];
    }
  }
}
