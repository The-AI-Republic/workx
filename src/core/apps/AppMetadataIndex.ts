import type { AppSearchResult, AppConnectionStatus } from './types';
import { AppLocalStore } from './AppLocalStore';

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter(token => token.length >= 2);
}

function statusToAction(status: AppConnectionStatus, hasMetadata: boolean): AppSearchResult['suggestedAction'] {
  if (!hasMetadata) {
    return 'install_metadata';
  }
  if (status === 'needs_auth' || status === 'auth_error') {
    return 'connect_auth';
  }
  if (status === 'connected') {
    return 'none';
  }
  return 'activate';
}

export class AppMetadataIndex {
  constructor(private readonly store: AppLocalStore = new AppLocalStore()) {}

  async search(query: string, limit = 8): Promise<AppSearchResult[]> {
    const queryTokens = tokenize(query);
    const entries = await this.store.listMetadataEntries();
    const results: AppSearchResult[] = [];

    for (const entry of entries) {
      const haystackParts = [
        entry.manifest.name,
        entry.manifest.description,
        ...(entry.manifest.capabilities ?? []),
        ...(entry.manifest.tags ?? []),
        ...(entry.manifest.categories ?? []),
        entry.metadataMarkdown,
      ];
      const haystack = haystackParts.join('\n').toLowerCase();
      const matchedText: string[] = [];
      let score = 0;

      for (const token of queryTokens) {
        if (haystack.includes(token)) {
          score += 1;
          matchedText.push(token);
        }
        if (entry.manifest.name.toLowerCase().includes(token) || entry.manifest.slug.toLowerCase().includes(token)) {
          score += 3;
        }
        if ((entry.manifest.capabilities ?? []).some(capability => capability.toLowerCase().includes(token))) {
          score += 2;
        }
      }

      if (queryTokens.length === 0) {
        score = entry.install.priority === 1 ? 2 : 1;
      }

      if (score <= 0) {
        continue;
      }

      const summary = entry.manifest.capabilities?.slice(0, 4).join(', ') || entry.manifest.description;
      results.push({
        appId: entry.appId,
        slug: entry.manifest.slug,
        name: entry.manifest.name,
        version: entry.manifest.version,
        score: score + (entry.install.priority === 1 ? 1 : 0),
        status: entry.install.connectionStatus,
        enabled: entry.install.enabled,
        priority: entry.install.priority,
        summary,
        matchedText: Array.from(new Set(matchedText)).slice(0, 8),
        suggestedAction: statusToAction(entry.install.connectionStatus, true),
      });
    }

    return results
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .slice(0, limit);
  }
}
