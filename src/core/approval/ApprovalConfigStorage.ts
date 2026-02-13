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

/** Storage adapter interface */
type StorageGetter = () => {
  get(keys: string[]): Promise<Record<string, any>>;
  set(items: Record<string, any>): Promise<void>;
};

export class ApprovalConfigStorage {
  private getStorage: StorageGetter;

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
   * Append an entry to approval history (capped at MAX_HISTORY_ENTRIES).
   */
  async appendHistory(entry: ApprovalHistoryEntry): Promise<void> {
    try {
      const storage = this.getStorage();
      const result = await storage.get([STORAGE_KEYS.APPROVAL_HISTORY]);
      const history: ApprovalHistoryEntry[] = result[STORAGE_KEYS.APPROVAL_HISTORY] || [];

      history.push(entry);

      // Cap at max entries
      const trimmed = history.length > MAX_HISTORY_ENTRIES
        ? history.slice(-MAX_HISTORY_ENTRIES)
        : history;

      await storage.set({ [STORAGE_KEYS.APPROVAL_HISTORY]: trimmed });
    } catch (error) {
      console.error('[ApprovalConfigStorage] Failed to append history:', error);
    }
  }
}
