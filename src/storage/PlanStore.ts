/**
 * PlanStore - Persistent storage for agent plans
 *
 * Feature: 029-planning-tool-v2
 *
 * Stores plans in IndexedDB keyed by sessionId (one plan per session).
 * Falls back to in-memory Map if IndexedDB is unavailable.
 */

import type { StoredPlan } from '../types/storage';
import { IndexedDBAdapter, STORE_NAMES, IndexedDBError } from './IndexedDBAdapter';

export class PlanStore {
  private adapter: IndexedDBAdapter | null = null;
  private fallbackMap: Map<string, StoredPlan> | null = null;
  private initialized = false;

  /**
   * Initialize the plan store.
   * Attempts to use IndexedDB; falls back to in-memory storage on failure.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      this.adapter = new IndexedDBAdapter();
      await this.adapter.initialize();
      this.initialized = true;
    } catch (error) {
      console.warn('[PlanStore] IndexedDB unavailable, using in-memory fallback:', error);
      this.adapter = null;
      this.fallbackMap = new Map();
      this.initialized = true;
    }
  }

  /**
   * Get the stored plan for a session.
   * Returns null if no plan exists.
   */
  async get(sessionId: string): Promise<StoredPlan | null> {
    if (!this.initialized) await this.initialize();

    if (this.fallbackMap) {
      return this.fallbackMap.get(sessionId) ?? null;
    }

    try {
      return await this.adapter!.get<StoredPlan>(STORE_NAMES.PLANS, sessionId);
    } catch (error) {
      console.warn('[PlanStore] Failed to get plan:', error);
      return null;
    }
  }

  /**
   * Save a plan. Overwrites any existing plan for the session.
   */
  async save(plan: StoredPlan): Promise<void> {
    if (!this.initialized) await this.initialize();

    if (this.fallbackMap) {
      this.fallbackMap.set(plan.sessionId, plan);
      return;
    }

    try {
      await this.adapter!.put(STORE_NAMES.PLANS, plan);
    } catch (error) {
      console.warn('[PlanStore] Failed to save plan, using fallback:', error);
      // Promote to in-memory fallback on write failure
      if (!this.fallbackMap) this.fallbackMap = new Map();
      this.fallbackMap.set(plan.sessionId, plan);
    }
  }

  /**
   * Delete the plan for a session.
   */
  async delete(sessionId: string): Promise<void> {
    if (!this.initialized) await this.initialize();

    if (this.fallbackMap) {
      this.fallbackMap.delete(sessionId);
      return;
    }

    try {
      await this.adapter!.delete(STORE_NAMES.PLANS, sessionId);
    } catch (error) {
      console.warn('[PlanStore] Failed to delete plan:', error);
    }
  }

  /** Check if the store is using in-memory fallback */
  get isUsingFallback(): boolean {
    return this.fallbackMap !== null;
  }
}

// ── Singleton Access ────────────────────────────────────────────────────

let planStoreInstance: PlanStore | null = null;

/**
 * Get or create the shared PlanStore singleton.
 * Initializes lazily on first call.
 */
export async function getPlanStore(): Promise<PlanStore> {
  if (!planStoreInstance) {
    planStoreInstance = new PlanStore();
    await planStoreInstance.initialize();
  }
  return planStoreInstance;
}

/**
 * Set the PlanStore singleton (for testing/DI).
 */
export function setPlanStore(store: PlanStore): void {
  planStoreInstance = store;
}
