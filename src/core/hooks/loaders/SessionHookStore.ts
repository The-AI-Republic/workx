/**
 * SessionHookStore — Runtime-registered session-scoped hooks.
 *
 * Provides convenience methods for adding/removing hooks that live only
 * for the current session. Backed by HookRegistry with source='session'.
 */

import type { HookRegistry } from '../HookRegistry';
import type { HookEvent, HookCommand } from '../types';

export class SessionHookStore {
  private readonly registry: HookRegistry;
  private readonly hookIds: Set<string> = new Set();

  constructor(registry: HookRegistry) {
    this.registry = registry;
  }

  /**
   * Add a session-scoped hook.
   * Returns the hook ID for later removal.
   */
  add(event: HookEvent, command: HookCommand, matcher?: string): string {
    const id = this.registry.register(event, command, 'session', matcher);
    this.hookIds.add(id);
    return id;
  }

  /**
   * Remove a session-scoped hook by ID.
   */
  remove(hookId: string): boolean {
    const removed = this.registry.unregister(hookId);
    if (removed) {
      this.hookIds.delete(hookId);
    }
    return removed;
  }

  /**
   * Clear all session-scoped hooks registered through this store.
   */
  clear(): number {
    let count = 0;
    for (const id of this.hookIds) {
      if (this.registry.unregister(id)) {
        count++;
      }
    }
    this.hookIds.clear();
    return count;
  }

  /**
   * Number of session hooks currently registered.
   */
  get size(): number {
    return this.hookIds.size;
  }
}
