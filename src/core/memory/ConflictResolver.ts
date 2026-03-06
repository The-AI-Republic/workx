/**
 * LLM-based conflict resolution for topical memories.
 * Compares new facts against existing memories and decides:
 * ADD, UPDATE, DELETE, or NONE for each fact.
 */

import conflictPrompt from './prompts/conflict.md?raw';
import type { LLMCaller, MemoryConfig, MemoryDecision, MemoryFact } from './types';

export class ConflictResolver {
  private llm: LLMCaller;
  private config: MemoryConfig;

  constructor(llm: LLMCaller, config: MemoryConfig) {
    this.llm = llm;
    this.config = config;
  }

  /**
   * Resolve conflicts between new facts and existing memories.
   * If no existing memories, all facts default to ADD.
   */
  async resolve(
    newFacts: string[],
    existingMemories: MemoryFact[]
  ): Promise<MemoryDecision[]> {
    if (newFacts.length === 0) return [];

    // No existing memories → ADD all
    if (existingMemories.length === 0) {
      return newFacts.map((fact) => ({
        fact,
        action: 'ADD' as const,
      }));
    }

    // Map real UUIDs to sequential integers to prevent hallucination
    const idToIndex = new Map<string, string>();
    const indexToId = new Map<string, string>();
    existingMemories.forEach((m, i) => {
      const idx = String(i);
      idToIndex.set(m.id, idx);
      indexToId.set(idx, m.id);
    });

    // Format existing memories with integer IDs
    const existingText = existingMemories
      .map((m, i) => `[${i}] (${m.category}) ${m.factText}`)
      .join('\n');

    const newFactsText = newFacts.map((f, i) => `${i + 1}. ${f}`).join('\n');

    const prompt = this.config.customConflictPrompt ?? conflictPrompt;
    const systemPrompt = prompt
      .replace('{{existingMemories}}', existingText)
      .replace('{{newFacts}}', newFactsText);

    try {
      const response = await this.llm.complete(systemPrompt, '');
      const decisions = this.parseDecisions(response);

      // H3: If parsing returned empty (garbled JSON), default to ADD rather than losing facts
      if (decisions.length === 0) {
        console.warn('[Memory] Conflict resolution returned no decisions, defaulting to ADD');
        return newFacts.map((fact) => ({
          fact,
          action: 'ADD' as const,
        }));
      }

      // Map integer IDs back to real UUIDs
      return decisions.map((d) => {
        if (d.memoryId) {
          d.memoryId = indexToId.get(d.memoryId) ?? d.memoryId;
        }
        return d;
      });
    } catch (err) {
      console.warn('[Memory] Conflict resolution failed, defaulting to ADD:', err);
      return newFacts.map((fact) => ({
        fact,
        action: 'ADD' as const,
      }));
    }
  }

  private parseDecisions(response: string): MemoryDecision[] {
    try {
      // Match JSON object containing "decisions" array, avoiding greedy capture
      const jsonMatch = response.match(/\{[^{}]*"decisions"\s*:\s*\[[\s\S]*?\]\s*\}/);
      if (!jsonMatch) {
        // H3: Fall back to returning null to signal parse failure (caller defaults to ADD)
        return [];
      }

      const parsed = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(parsed.decisions)) return [];

      return parsed.decisions
        .filter(
          (d: Record<string, unknown>) =>
            typeof d.fact === 'string' &&
            ['ADD', 'UPDATE', 'DELETE', 'NONE'].includes(d.action as string)
        )
        .map((d: Record<string, unknown>) => ({
          fact: d.fact as string,
          action: d.action as MemoryDecision['action'],
          memoryId: d.memoryId != null ? String(d.memoryId) : undefined,
          reasoning: d.reasoning as string | undefined,
        }));
    } catch {
      console.warn('[Memory] Failed to parse conflict resolution response');
      return [];
    }
  }
}
