/**
 * SessionState - pure data container for session state
 */

import type { ResponseItem, ConversationHistory } from '../../../protocol/types';
import type { TokenUsageInfo, RateLimitSnapshot } from './types';
import { isDOMSnapshotOutput, compressSnapshot } from './SnapshotCompressor';

/**
 * Export format for SessionState
 */
export interface SessionStateExport {
  history: ConversationHistory;
  approvedCommands: string[];
  tokenInfo?: TokenUsageInfo;
  latestRateLimits?: RateLimitSnapshot;
  tabId?: number; // T019: Add tabId to export format
}

/**
 * Pure data container for session state
 * Separates state management from business logic
 */
export class SessionState {
  /** Set of commands approved by user */
  private approvedCommands: Set<string>;

  /** Conversation history */
  private history: ResponseItem[];

  /** Token usage information */
  private tokenInfo?: TokenUsageInfo;

  /** Latest rate limit information */
  private latestRateLimits?: RateLimitSnapshot;

  /** T019: Bound tab ID (-1 = no tab attached, >0 = bound) */
  private tabId: number;

  constructor() {
    this.approvedCommands = new Set();
    this.history = [];
    this.tokenInfo = undefined;
    this.latestRateLimits = undefined;
    this.tabId = -1; // T020: Initialize with tabId = -1
  }

  // ===== History Management =====

  /**
   * Record items to conversation history
   * @param items Items to append to history
   */
  recordItems(items: ResponseItem[]): void {
    this.history.push(...items);
  }

  /**
   * Get a snapshot of conversation history (deep copy for immutability)
   * @returns Deep copy of history items
   */
  historySnapshot(): ResponseItem[] {
    return JSON.parse(JSON.stringify(this.history));
  }

  /**
   * Get conversation history as ConversationHistory object
   * @returns ConversationHistory with items
   */
  getConversationHistory(): ConversationHistory {
    return {
      items: this.historySnapshot(),
    };
  }

  /**
   * Replace entire conversation history
   * Used for compaction - replaces all history with new items
   * @param items New history items to replace existing history
   */
  replaceHistory(items: ResponseItem[]): void {
    this.history = [...items];
  }

  /**
   * Compress the most recent DOM snapshot in history
   *
   * This method finds the latest DOM snapshot output in history and compresses it
   * by replacing its body with a placeholder message while preserving metadata.
   *
   * Called when a new DOM snapshot arrives to compress the previous one, keeping
   * only the latest snapshot fresh for LLM reasoning.
   */
  compressPreviousDomSnapshot(): void {
    // Iterate backwards to find the most recent DOM snapshot
    for (let i = this.history.length - 1; i >= 0; i--) {
      const item = this.history[i];

      if (isDOMSnapshotOutput(item)) {
        // Found the snapshot - compress it in place
        this.history[i] = compressSnapshot(item);
      }
    }
    // No snapshot found - nothing to compress
  }

  // ===== Token Tracking =====

  /**
   * Add token usage (simple accumulation)
   * @param tokens Number of tokens to add to total
   */
  addTokenUsage(tokens: number): void {
    if (!this.tokenInfo) {
      this.tokenInfo = {
        total_tokens: tokens,
      };
    } else {
      this.tokenInfo.total_tokens = (this.tokenInfo.total_tokens ?? 0) + tokens;
    }
  }

  /**
   * Update token usage info with detailed information
   * @param info Token usage information to merge
   */
  updateTokenInfo(info: TokenUsageInfo): void {
    if (!this.tokenInfo) {
      this.tokenInfo = { ...info };
    } else {
      this.tokenInfo = {
        ...this.tokenInfo,
        ...info,
      };
    }
  }

  // ===== Rate Limit Tracking =====

  /**
   * Update rate limit information
   * @param limits Rate limit snapshot
   */
  updateRateLimits(limits: RateLimitSnapshot): void {
    this.latestRateLimits = { ...limits };
  }

  // ===== Approved Commands =====

  /**
   * Add an approved command
   * @param command Command to approve
   */
  addApprovedCommand(command: string): void {
    this.approvedCommands.add(command);
  }

  /**
   * Check if a command is approved
   * @param command Command to check
   * @returns True if command is approved
   */
  isCommandApproved(command: string): boolean {
    return this.approvedCommands.has(command);
  }

  // ===== Tab Binding (T021-T023) =====

  /**
   * T021: Get bound tab ID
   * @returns tabId (-1 if no tab attached, positive integer if bound)
   */
  getTabId(): number {
    return this.tabId;
  }

  /**
   * T022: Set bound tab ID
   * @param tabId Tab ID to set (-1 or positive integer)
   */
  setTabId(tabId: number): void {
    this.tabId = tabId;
  }

  /**
   * T023: Check if tab is currently bound
   * @returns true if tabId !== -1
   */
  hasTabAttached(): boolean {
    return this.tabId !== -1;
  }

  // ===== Export/Import =====

  /**
   * Export state for persistence
   * @returns Serializable state object
   */
  export(): SessionStateExport {
    return {
      history: {
        items: this.historySnapshot(),
      },
      approvedCommands: Array.from(this.approvedCommands),
      tokenInfo: this.tokenInfo ? { ...this.tokenInfo } : undefined,
      latestRateLimits: this.latestRateLimits
        ? { ...this.latestRateLimits }
        : undefined,
      tabId: this.tabId, // Include tabId in export
    };
  }

  /**
   * Import state from exported data
   * @param data Exported state data
   * @returns New SessionState instance
   */
  static import(data: SessionStateExport): SessionState {
    const state = new SessionState();

    // Restore history
    if (data.history?.items) {
      state.history = JSON.parse(JSON.stringify(data.history.items));
    }

    // Restore approved commands
    if (data.approvedCommands) {
      state.approvedCommands = new Set(data.approvedCommands);
    }

    // Restore token info
    if (data.tokenInfo) {
      state.tokenInfo = { ...data.tokenInfo };
    }

    // Restore rate limits
    if (data.latestRateLimits) {
      state.latestRateLimits = { ...data.latestRateLimits };
    }

    // Restore tabId (default to -1 if not present for backward compatibility)
    if (data.tabId !== undefined) {
      state.tabId = data.tabId;
    }

    return state;
  }

  /**
   * Create a deep copy of this state
   * @returns Independent copy of state
   */
  deepCopy(): SessionState {
    return SessionState.import(this.export());
  }
}
