import { writable } from 'svelte/store';
import { TokenUsageStore } from '@/storage/TokenUsageStore';
import type { TokenUsageRecord, SessionUsageSummary, DailyUsageSummary } from '@/storage/types';

interface UsageState {
  records: TokenUsageRecord[];
  sessionSummaries: SessionUsageSummary[];
  dailySummaries: DailyUsageSummary[];
  modelSummaries: Record<string, { total_tokens: number; taskCount: number }>;
  groupByModel: boolean;
  loading: boolean;
  error: string | null;
}

const initialState: UsageState = {
  records: [],
  sessionSummaries: [],
  dailySummaries: [],
  modelSummaries: {},
  groupByModel: false,
  loading: false,
  error: null,
};

function createUsageStore() {
  const { subscribe, set, update } = writable<UsageState>(initialState);

  async function loadAll() {
    update((s) => ({ ...s, loading: true, error: null }));
    try {
      const store = TokenUsageStore.getInstance();
      const records = await store.getAll();
      const sessionSummaries = TokenUsageStore.aggregateBySession(records);

      // Daily summaries filtered to last 30 days
      const allDaily = TokenUsageStore.aggregateByDate(records);
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - 30);
      const cutoffStr = cutoff.toISOString().slice(0, 10);
      const dailySummaries = allDaily.filter((d) => d.date >= cutoffStr);

      const modelSummaries = TokenUsageStore.aggregateByModel(records);

      set({
        records,
        sessionSummaries,
        dailySummaries,
        modelSummaries,
        groupByModel: false,
        loading: false,
        error: null,
      });
    } catch (err) {
      update((s) => ({
        ...s,
        loading: false,
        error: err instanceof Error ? err.message : 'Failed to load usage data',
      }));
    }
  }

  function setDateRange(days: number) {
    update((s) => {
      const allDaily = TokenUsageStore.aggregateByDate(s.records);
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - days);
      const cutoffStr = cutoff.toISOString().slice(0, 10);
      return {
        ...s,
        dailySummaries: allDaily.filter((d) => d.date >= cutoffStr),
      };
    });
  }

  function toggleGroupByModel() {
    update((s) => ({ ...s, groupByModel: !s.groupByModel }));
  }

  return {
    subscribe,
    loadAll,
    refresh: loadAll,
    setDateRange,
    toggleGroupByModel,
  };
}

export const usageStore = createUsageStore();
