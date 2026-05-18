import type { ToolExposureDecision } from './ToolExposureTypes';

export interface ToolSearchMatch {
  name: string;
  displayName: string;
  description: string;
  source: string;
  serverName?: string;
  selected: boolean;
  score: number;
}

export interface ToolSearchResult {
  matches: ToolSearchMatch[];
  exactSelect: string[];
}

export class ToolSearchIndex {
  constructor(private readonly tools: readonly ToolExposureDecision[]) {}

  search(query: string, options: { maxResults?: number; select?: readonly string[] } = {}): ToolSearchResult {
    const parsed = parseQuery(query);
    const exactSelect = unique([
      ...(options.select ?? []),
      ...parsed.exactSelect,
    ]);
    const maxResults = Math.max(1, Math.min(options.maxResults ?? 10, 50));

    const scored = this.tools
      .map((tool) => ({ tool, score: this.score(tool, parsed) }))
      .filter((item) => item.score > 0 || exactSelect.includes(item.tool.name))
      .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
      .slice(0, maxResults);

    return {
      exactSelect,
      matches: scored.map(({ tool, score }) => ({
        name: tool.name,
        displayName: tool.profile.displayName ?? tool.name,
        description: tool.description,
        source: tool.profile.source ?? 'builtin',
        serverName: tool.profile.serverName,
        selected: tool.selected || exactSelect.includes(tool.name),
        score,
      })),
    };
  }

  private score(tool: ToolExposureDecision, parsed: ParsedQuery): number {
    if (parsed.source && parsed.source !== tool.profile.source && parsed.source !== tool.profile.serverName) {
      return 0;
    }

    const haystack = [
      tool.name,
      tool.profile.displayName,
      tool.description,
      tool.profile.searchHint,
      tool.profile.source,
      tool.profile.serverName,
    ].filter(Boolean).join(' ').toLowerCase();

    if (parsed.requiredTerms.some((term) => !haystack.includes(term))) {
      return 0;
    }

    if (parsed.terms.length === 0 && parsed.source) {
      return 10;
    }

    let score = 0;
    for (const term of parsed.terms) {
      if (tool.name.toLowerCase() === term) score += 100;
      else if (tool.name.toLowerCase().includes(term)) score += 40;
      else if ((tool.profile.displayName ?? '').toLowerCase().includes(term)) score += 25;
      else if ((tool.profile.searchHint ?? '').toLowerCase().includes(term)) score += 15;
      else if (tool.description.toLowerCase().includes(term)) score += 10;
    }
    return score;
  }
}

interface ParsedQuery {
  terms: string[];
  requiredTerms: string[];
  source?: string;
  exactSelect: string[];
}

function parseQuery(query: string): ParsedQuery {
  const terms: string[] = [];
  const requiredTerms: string[] = [];
  const exactSelect: string[] = [];
  let source: string | undefined;

  for (const rawToken of query.trim().split(/\s+/).filter(Boolean)) {
    const token = rawToken.toLowerCase();
    if (token.startsWith('select:')) {
      exactSelect.push(...rawToken.substring('select:'.length).split(',').map((s) => s.trim()).filter(Boolean));
      continue;
    }
    if (token.includes(':')) {
      const [prefix, value] = token.split(':', 2);
      if (['source', 'mcp', 'a2a', 'plugin', 'server'].includes(prefix) && value) {
        source = prefix === 'source' || prefix === 'server' ? value : prefix;
        if (prefix === 'server') terms.push(value);
        continue;
      }
    }
    if (token.startsWith('+') && token.length > 1) {
      const required = token.substring(1);
      requiredTerms.push(required);
      terms.push(required);
      continue;
    }
    terms.push(token);
  }

  return { terms, requiredTerms, source, exactSelect };
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
