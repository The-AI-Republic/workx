/**
 * RemotePolicySource — the fleet remote-policy {@link PolicySource}.
 *
 * Highest-precedence server/desktop source. Wraps {@link fetchRemotePolicy}
 * with cache-via-ConfigStorageProvider + fail-open (stale cache on error,
 * never hard-deny) + a 1h background poll. Eligibility = "endpoint
 * configured" (BrowserX has no Anthropic-subscription analog). No remote
 * fetcher on the extension — Chrome managed storage is its channel.
 *
 * @module core/config/remotePolicy/RemotePolicySource
 */

import type { PolicySource, ResolvedPolicy } from '../policy/types';
import {
  fetchRemotePolicy,
  computePolicyChecksum,
  startPolicyPoll,
  stopPolicyPoll,
} from './RemotePolicyFetcher';

const CACHE_KEY = 'policy_cache';

interface CacheRecord {
  policy: ResolvedPolicy;
  checksum: string;
}

export interface RemotePolicySourceOptions {
  endpoint?: string;
  authHeaders?: Record<string, string>;
  timeoutMs?: number;
  pollIntervalMs?: number;
  fetchImpl?: typeof fetch;
}

export class RemotePolicySource implements PolicySource {
  readonly origin = 'remote' as const;
  private readonly opts: RemotePolicySourceOptions;

  constructor(opts: RemotePolicySourceOptions = {}) {
    this.opts = opts;
  }

  private get endpoint(): string | undefined {
    return this.opts.endpoint ?? process.env.APPLEPI_POLICY_ENDPOINT;
  }

  private async readCache(): Promise<CacheRecord | null> {
    try {
      const { isConfigStorageInitialized, getConfigStorage } = await import(
        '@/core/storage/ConfigStorageProvider'
      );
      if (!isConfigStorageInitialized()) return null;
      return (await getConfigStorage().get<CacheRecord>(CACHE_KEY)) ?? null;
    } catch {
      return null;
    }
  }

  private async writeCache(rec: CacheRecord | null): Promise<void> {
    try {
      const { isConfigStorageInitialized, getConfigStorage } = await import(
        '@/core/storage/ConfigStorageProvider'
      );
      if (!isConfigStorageInitialized()) return;
      const storage = getConfigStorage();
      if (rec) await storage.set(CACHE_KEY, rec);
      else await storage.remove(CACHE_KEY);
    } catch {
      /* fail open — cache is best-effort */
    }
  }

  async load(): Promise<ResolvedPolicy | null> {
    const endpoint = this.endpoint;
    if (!endpoint) return null; // not eligible — no endpoint configured

    const cached = await this.readCache();
    const result = await fetchRemotePolicy({
      endpoint,
      authHeaders: this.opts.authHeaders,
      cachedChecksum: cached?.checksum,
      timeoutMs: this.opts.timeoutMs,
      fetchImpl: this.opts.fetchImpl,
    });

    switch (result.status) {
      case 'updated': {
        const checksum = await computePolicyChecksum(result.policy);
        await this.writeCache({ policy: result.policy!, checksum });
        return result.policy!;
      }
      case 'unchanged':
        return cached?.policy ?? null;
      case 'cleared':
        await this.writeCache(null);
        return null;
      case 'error':
      default:
        // Fail-open: keep running on the last good policy, or none.
        return cached?.policy ?? null;
    }
  }

  subscribe(onChange: () => void): () => void {
    startPolicyPoll(onChange, this.opts.pollIntervalMs);
    return () => stopPolicyPoll();
  }
}
