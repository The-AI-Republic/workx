/**
 * Session Storage
 *
 * IndexedDB persistence layer for AgentSession metadata.
 * Feature: 015-multi-agent-instances (T035, T036, T037)
 */

import type { StorageAdapter } from '../../storage/StorageAdapter';
import { STORE_NAMES } from '../../storage/IndexedDBAdapter';
import type { SessionMetadata, SessionType, SessionState } from './types';

/**
 * Persisted session record - subset of SessionMetadata suitable for storage
 */
export interface PersistedSession {
  sessionId: string;
  sessionLetter: string;
  conversationId: string;
  type: SessionType;
  state: SessionState;
  createdAt: number;
  lastActivityAt: number;
  tabId: number | null;
  tabGroupId: number | null;
  tabGroupName: string;
  /** Timestamp when session was persisted */
  persistedAt: number;
}

/**
 * Storage implementation for agent sessions
 */
export class SessionStorage {
  constructor(private db: StorageAdapter) {}

  /**
   * T035: Persist session metadata to IndexedDB
   */
  async persistSession(metadata: SessionMetadata): Promise<void> {
    const record: PersistedSession = {
      sessionId: metadata.sessionId,
      sessionLetter: metadata.sessionLetter,
      conversationId: metadata.conversationId,
      type: metadata.type,
      state: metadata.state,
      createdAt: metadata.createdAt,
      lastActivityAt: metadata.lastActivityAt,
      tabId: metadata.tabId,
      tabGroupId: metadata.tabGroupId,
      tabGroupName: metadata.tabGroupName,
      persistedAt: Date.now(),
    };

    await this.db.put(STORE_NAMES.AGENT_SESSIONS, record);
    console.log(`[SessionStorage] Persisted session: ${metadata.sessionId}`);
  }

  /**
   * Get a persisted session by ID
   */
  async getSession(sessionId: string): Promise<PersistedSession | null> {
    return this.db.get<PersistedSession>(STORE_NAMES.AGENT_SESSIONS, sessionId);
  }

  /**
   * T036: Load all persisted sessions
   */
  async loadAllSessions(): Promise<PersistedSession[]> {
    return this.db.getAll<PersistedSession>(STORE_NAMES.AGENT_SESSIONS);
  }

  /**
   * Load sessions that are not terminated
   */
  async loadActiveSessions(): Promise<PersistedSession[]> {
    const allSessions = await this.loadAllSessions();
    return allSessions.filter(s => s.state !== 'terminated');
  }

  /**
   * Load sessions by type
   */
  async loadSessionsByType(type: SessionType): Promise<PersistedSession[]> {
    return this.db.queryByIndex<PersistedSession>(
      STORE_NAMES.AGENT_SESSIONS,
      'by_type',
      type
    );
  }

  /**
   * Delete a persisted session
   */
  async deleteSession(sessionId: string): Promise<void> {
    await this.db.delete(STORE_NAMES.AGENT_SESSIONS, sessionId);
    console.log(`[SessionStorage] Deleted session: ${sessionId}`);
  }

  /**
   * T040: Clean up orphaned sessions
   * Sessions that haven't been active for longer than maxAge
   */
  async cleanupOrphanedSessions(maxAgeMs: number = 24 * 60 * 60 * 1000): Promise<number> {
    const allSessions = await this.loadAllSessions();
    const now = Date.now();
    let cleanedCount = 0;

    for (const session of allSessions) {
      // Clean up if:
      // 1. Session is terminated, or
      // 2. Session hasn't been active for maxAgeMs
      const isOrphaned =
        session.state === 'terminated' ||
        (now - session.lastActivityAt > maxAgeMs);

      if (isOrphaned) {
        await this.deleteSession(session.sessionId);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      console.log(`[SessionStorage] Cleaned up ${cleanedCount} orphaned sessions`);
    }

    return cleanedCount;
  }

  /**
   * Clear all persisted sessions
   */
  async clearAll(): Promise<void> {
    const allSessions = await this.loadAllSessions();
    for (const session of allSessions) {
      await this.deleteSession(session.sessionId);
    }
    console.log(`[SessionStorage] Cleared all persisted sessions`);
  }
}
