/**
 * Approval Config Storage
 *
 * Cross-platform persistence for approval configuration and history.
 * Uses a storage getter function for platform abstraction
 * (chrome.storage.local on extension, Tauri config storage on desktop).
 */

import type { IApprovalConfig, ApprovalHistoryEntry } from './types';
import { DEFAULT_APPROVAL_CONFIG } from './types';
import { STORAGE_KEYS } from '../../config/defaults';

/** Maximum number of history entries to retain */
const MAX_HISTORY_ENTRIES = 100;

/** Minimum interval between history writes (ms) to avoid storage thrashing */
const HISTORY_WRITE_INTERVAL_MS = 2000;

/** Storage adapter interface */
type StorageGetter = () => {
  get(keys: string[]): Promise<Record<string, any>>;
  set(items: Record<string, any>): Promise<void>;
};

export class ApprovalConfigStorage {
  private getStorage: StorageGetter;
  private pendingHistoryEntries: ApprovalHistoryEntry[] = [];
  private historyWriteTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(storageGetter: StorageGetter) {
    this.getStorage = storageGetter;
  }

  /**
   * Load approval config from storage, merged with defaults.
   */
  async loadConfig(): Promise<IApprovalConfig> {
    try {
      const storage = this.getStorage();
      const result = await storage.get([STORAGE_KEYS.APPROVAL_CONFIG]);
      const stored = result[STORAGE_KEYS.APPROVAL_CONFIG];

      if (!stored) return { ...DEFAULT_APPROVAL_CONFIG };

      // Merge with defaults to handle new fields
      return {
        ...DEFAULT_APPROVAL_CONFIG,
        ...stored,
        timeouts: {
          ...DEFAULT_APPROVAL_CONFIG.timeouts,
          ...(stored.timeouts || {}),
        },
      };
    } catch (error) {
      console.error('[ApprovalConfigStorage] Failed to load config:', error);
      return { ...DEFAULT_APPROVAL_CONFIG };
    }
  }

  /**
   * Save approval config to storage.
   */
  async saveConfig(config: IApprovalConfig): Promise<void> {
    try {
      const storage = this.getStorage();
      await storage.set({ [STORAGE_KEYS.APPROVAL_CONFIG]: config });
    } catch (error) {
      console.error('[ApprovalConfigStorage] Failed to save config:', error);
      throw error;
    }
  }

  /**
   * Load approval history from storage.
   */
  async loadHistory(limit?: number): Promise<ApprovalHistoryEntry[]> {
    try {
      const storage = this.getStorage();
      const result = await storage.get([STORAGE_KEYS.APPROVAL_HISTORY]);
      const history: ApprovalHistoryEntry[] = result[STORAGE_KEYS.APPROVAL_HISTORY] || [];

      if (limit && limit > 0) {
        return history.slice(-limit);
      }
      return history;
    } catch (error) {
      console.error('[ApprovalConfigStorage] Failed to load history:', error);
      return [];
    }
  }

  /**
   * Append an entry to approval history (debounced to avoid storage thrashing).
   * Entries are batched and written at most once per HISTORY_WRITE_INTERVAL_MS.
   */
  async appendHistory(entry: ApprovalHistoryEntry): Promise<void> {
    this.pendingHistoryEntries.push(entry);

    // Debounce: schedule a write if not already pending
    if (!this.historyWriteTimer) {
      this.historyWriteTimer = setTimeout(() => {
        this.flushHistory();
      }, HISTORY_WRITE_INTERVAL_MS);
    }
  }

  /**
   * Flush pending history entries to storage.
   */
  private async flushHistory(): Promise<void> {
    this.historyWriteTimer = null;

    if (this.pendingHistoryEntries.length === 0) return;

    const entriesToWrite = this.pendingHistoryEntries.splice(0);

    try {
      const storage = this.getStorage();
      const result = await storage.get([STORAGE_KEYS.APPROVAL_HISTORY]);
      const history: ApprovalHistoryEntry[] = result[STORAGE_KEYS.APPROVAL_HISTORY] || [];

      history.push(...entriesToWrite);

      // Cap at max entries
      const trimmed = history.length > MAX_HISTORY_ENTRIES
        ? history.slice(-MAX_HISTORY_ENTRIES)
        : history;

      await storage.set({ [STORAGE_KEYS.APPROVAL_HISTORY]: trimmed });
    } catch (error) {
      console.error('[ApprovalConfigStorage] Failed to flush history:', error);
    }
  }
}
