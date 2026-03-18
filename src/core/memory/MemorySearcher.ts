/**
 * MemorySearcher -- two-stage search: keyword generation -> grep -> LLM filtering.
 */
import type { LLMCaller } from './types';
import type { DailyMemoryStore, MemoryEntry } from './DailyMemoryStore';

export interface SearchResult {
  fact: string;
  category: string;
  sourceDate: string;
  relevance: number;
}

const MAX_SEARCH_RESULTS = 50;
const FALLBACK_RECENT_DAYS = 7;

export class MemorySearcher {
  private llm: LLMCaller;
  private store: DailyMemoryStore;

  constructor(llm: LLMCaller, store: DailyMemoryStore) {
    this.llm = llm;
    this.store = store;
  }

  async search(query: string, limit: number = 10): Promise<SearchResult[]> {
    // Stage 1: Generate keywords from the query
    const keywords = await this.generateKeywords(query);

    // Stage 2: Search daily files for keyword matches
    let candidates: MemoryEntry[] = [];
    if (keywords.length > 0) {
      candidates = await this.store.searchKeywords(keywords);
    }

    // Fallback: if no keyword matches, read recent days
    if (candidates.length === 0) {
      const recentDays = await this.store.readRecentDays(FALLBACK_RECENT_DAYS);
      for (const day of recentDays) {
        candidates.push(...day.entries);
      }
    }

    if (candidates.length === 0) {
      return [];
    }

    // Cap candidates before sending to LLM
    const capped = candidates.slice(0, MAX_SEARCH_RESULTS);

    // Stage 3: LLM filters and ranks for relevance
    return this.filterAndRank(query, capped, limit);
  }

  private async generateKeywords(query: string): Promise<string[]> {
    try {
      const response = await this.llm.complete(
        `You are a keyword extraction system. Given a user's search query, generate a list of search keywords and synonyms that would help find relevant facts in a memory store.

Rules:
- Return 3-8 keywords, one per line
- Include synonyms and related terms
- Include both specific and general terms
- Do NOT include common words like "the", "a", "is", "what", "my"
- Return ONLY the keywords, one per line, nothing else`,
        `Query: "${query}"`
      );

      return response
        .split('\n')
        .map(l => l.trim().replace(/^[-*]\s*/, ''))
        .filter(l => l.length > 0 && l.length < 50);
    } catch (err) {
      console.warn('[MemorySearcher] Keyword generation failed:', err);
      // Fallback: split query into words
      return query.split(/\s+/).filter(w => w.length > 2);
    }
  }

  private async filterAndRank(
    query: string,
    candidates: MemoryEntry[],
    limit: number
  ): Promise<SearchResult[]> {
    // Format candidates for the LLM
    const candidateList = candidates
      .map((c, i) => `[${i}] (${c.sourceDate} ${c.time} | ${c.category}) ${c.text}`)
      .join('\n');

    try {
      const response = await this.llm.complete(
        `You are a memory relevance filter. Given a search query and a list of memory entries, select the most relevant entries and assign relevance scores.

Rules:
- Select up to ${limit} most relevant entries
- Assign a relevance score from 0.0 to 1.0 for each selected entry
- Return ONLY a JSON array of objects: [{"index": <number>, "relevance": <number>}]
- Order by relevance (highest first)
- If no entries are relevant, return an empty array: []`,
        `Query: "${query}"\n\nMemory entries:\n${candidateList}`
      );

      // Parse JSON response
      const cleaned = response.replace(/```json?\s*/g, '').replace(/```\s*/g, '').trim();
      const parsed = JSON.parse(cleaned) as Array<{ index: number; relevance: number }>;

      return parsed
        .filter(p => p.index >= 0 && p.index < candidates.length && p.relevance > 0)
        .map(p => ({
          fact: candidates[p.index].text,
          category: candidates[p.index].category,
          sourceDate: candidates[p.index].sourceDate,
          relevance: Math.min(1, Math.max(0, p.relevance)),
        }));
    } catch (err) {
      console.warn('[MemorySearcher] Relevance filtering failed, returning all candidates:', err);
      // Fallback: return all candidates with neutral relevance
      return candidates.slice(0, limit).map(c => ({
        fact: c.text,
        category: c.category,
        sourceDate: c.sourceDate,
        relevance: 0.5,
      }));
    }
  }
}
