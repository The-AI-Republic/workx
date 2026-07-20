/**
 * Token Usage Store
 *
 * Service for persisting and querying per-task token usage records.
 * Uses the platform-agnostic StorageAdapter.
 */

import type { StorageAdapter } from './StorageAdapter';
import type { TokenUsageRecord, SessionUsageSummary, DailyUsageSummary } from './types';

const STORE_NAME = 'token_usage_records';

export class TokenUsageStore {
  private static instance: TokenUsageStore | null = null;
  private adapter: StorageAdapter | null;

  constructor(adapter?: StorageAdapter) {
    this.adapter = adapter || null;
  }

  /**
   * Inject a StorageAdapter for the singleton instance.
   * Each platform bootstrap should call this early with the appropriate adapter.
   */
  static setAdapter(adapter: StorageAdapter): void {
    const store = TokenUsageStore.getInstance();
    store.adapter = adapter;
  }

  static getInstance(): TokenUsageStore {
    if (!TokenUsageStore.instance) {
      TokenUsageStore.instance = new TokenUsageStore();
    }
    return TokenUsageStore.instance;
  }

  private db(): StorageAdapter | null {
    if (!this.adapter) {
      console.warn('[TokenUsageStore] Adapter not set. Call TokenUsageStore.setAdapter() first.');
      return null;
    }
    return this.adapter;
  }

  async save(record: TokenUsageRecord): Promise<void> {
    const adapter = this.db();
    if (!adapter) return;
    try {
      await adapter.put(STORE_NAME, record);
    } catch (err) {
      console.warn('[TokenUsageStore] Save failed:', err);
    }
  }

  async getAll(): Promise<TokenUsageRecord[]> {
    const adapter = this.db();
    if (!adapter) return [];
    return adapter.getAll<TokenUsageRecord>(STORE_NAME);
  }

  async getBySession(sessionId: string): Promise<TokenUsageRecord[]> {
    const adapter = this.db();
    if (!adapter) return [];
    return adapter.queryByIndex<TokenUsageRecord>(STORE_NAME, 'by_session', sessionId);
  }

  /** Delete every usage record owned by one durable session. */
  async deleteSession(sessionId: string): Promise<void> {
    const adapter = this.db();
    if (!adapter) return;
    const records = await adapter.queryByIndex<TokenUsageRecord>(
      STORE_NAME,
      'by_session',
      sessionId,
    );
    if (records.length > 0) {
      await adapter.batchDelete(STORE_NAME, records.map((record) => record.id));
    }
  }

  async getByDateRange(start: string, end: string): Promise<TokenUsageRecord[]> {
    const adapter = this.db();
    if (!adapter) return [];
    return adapter.queryByIndex<TokenUsageRecord>(
      STORE_NAME, 'by_timestamp', IDBKeyRange.bound(start, end)
    );
  }

  async getByModel(model: string): Promise<TokenUsageRecord[]> {
    const adapter = this.db();
    if (!adapter) return [];
    return adapter.queryByIndex<TokenUsageRecord>(STORE_NAME, 'by_model', model);
  }

  static aggregateBySession(records: TokenUsageRecord[]): SessionUsageSummary[] {
    const map = new Map<string, {
      records: TokenUsageRecord[];
      models: Set<string>;
    }>();

    for (const r of records) {
      let entry = map.get(r.sessionId);
      if (!entry) {
        entry = { records: [], models: new Set() };
        map.set(r.sessionId, entry);
      }
      entry.records.push(r);
      entry.models.add(r.model);
    }

    const summaries: SessionUsageSummary[] = [];
    for (const [sessionId, entry] of map) {
      const sorted = entry.records.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
      summaries.push({
        sessionId,
        firstTimestamp: sorted[0].timestamp,
        lastTimestamp: sorted[sorted.length - 1].timestamp,
        models: Array.from(entry.models),
        taskCount: entry.records.length,
        input_tokens: entry.records.reduce((s, r) => s + r.input_tokens, 0),
        cached_input_tokens: entry.records.reduce((s, r) => s + r.cached_input_tokens, 0),
        output_tokens: entry.records.reduce((s, r) => s + r.output_tokens, 0),
        reasoning_output_tokens: entry.records.reduce((s, r) => s + r.reasoning_output_tokens, 0),
        total_tokens: entry.records.reduce((s, r) => s + r.total_tokens, 0),
        costUSD: entry.records.reduce((s, r) => s + (r.costUSD ?? 0), 0),
        costEstimated: entry.records.some((r) => r.costEstimated === true),
        turn_count: entry.records.reduce((s, r) => s + r.turn_count, 0),
      });
    }

    return summaries.sort((a, b) => b.lastTimestamp.localeCompare(a.lastTimestamp));
  }

  static aggregateByDate(records: TokenUsageRecord[]): DailyUsageSummary[] {
    const map = new Map<string, DailyUsageSummary>();

    for (const r of records) {
      const date = r.timestamp.slice(0, 10); // YYYY-MM-DD
      let entry = map.get(date);
      if (!entry) {
        entry = { date, total_tokens: 0, input_tokens: 0, output_tokens: 0, costUSD: 0, byModel: {} };
        map.set(date, entry);
      }
      entry.total_tokens += r.total_tokens;
      entry.input_tokens += r.input_tokens;
      entry.output_tokens += r.output_tokens;
      entry.costUSD += r.costUSD ?? 0;
      entry.byModel[r.model] = (entry.byModel[r.model] || 0) + r.total_tokens;
    }

    return Array.from(map.values()).sort((a, b) => a.date.localeCompare(b.date));
  }

  static aggregateByModel(records: TokenUsageRecord[]): Record<string, { total_tokens: number; taskCount: number; costUSD: number; costEstimated: boolean }> {
    const result: Record<string, { total_tokens: number; taskCount: number; costUSD: number; costEstimated: boolean }> = {};
    for (const r of records) {
      // Track 18: key per provider-qualified model when available so cost
      // is attributed to the right provider (same model id can be priced
      // differently across providers); fall back to the raw id.
      const key = r.provider_model ?? r.model;
      if (!result[key]) {
        result[key] = { total_tokens: 0, taskCount: 0, costUSD: 0, costEstimated: false };
      }
      result[key].total_tokens += r.total_tokens;
      result[key].taskCount += 1;
      result[key].costUSD += r.costUSD ?? 0;
      if (r.costEstimated) {
        result[key].costEstimated = true;
      }
    }
    return result;
  }
}
