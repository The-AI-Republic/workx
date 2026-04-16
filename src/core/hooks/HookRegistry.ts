/**
 * HookRegistry — Central hook registration, discovery, and lifecycle management.
 */

import { v4 as uuidv4 } from 'uuid';
import type {
  HookEvent,
  HookCommand,
  HookSource,
  RegisteredHook,
  HooksConfig,
} from './types';
import { HookMatcher } from './HookMatcher';

export class HookRegistry {
  private hooks: Map<HookEvent, RegisteredHook[]> = new Map();

  /**
   * Register a single hook for an event.
   * Returns the hook ID for later removal.
   */
  register(
    event: HookEvent,
    command: HookCommand,
    source: HookSource,
    matcher?: string,
  ): string {
    const id = `hook_${uuidv4()}`;
    const entry: RegisteredHook = {
      id,
      event,
      matcher,
      command,
      source,
      registeredAt: Date.now(),
    };

    const existing = this.hooks.get(event) ?? [];
    this.hooks.set(event, [...existing, entry]);
    return id;
  }

  /**
   * Bulk register hooks from a HooksConfig object (settings.json format).
   */
  registerFromConfig(config: HooksConfig, source: HookSource): string[] {
    const ids: string[] = [];
    for (const [eventName, matcherEntries] of Object.entries(config)) {
      const event = eventName as HookEvent;
      for (const entry of matcherEntries) {
        for (const hookCmd of entry.hooks) {
          ids.push(this.register(event, hookCmd, source, entry.matcher));
        }
      }
    }
    return ids;
  }

  /**
   * Unregister a hook by ID.
   */
  unregister(hookId: string): boolean {
    for (const [event, hooks] of this.hooks.entries()) {
      const idx = hooks.findIndex((h) => h.id === hookId);
      if (idx !== -1) {
        const updated = [...hooks];
        updated.splice(idx, 1);
        this.hooks.set(event, updated);
        return true;
      }
    }
    return false;
  }

  /**
   * Unregister all hooks from a specific source.
   */
  unregisterBySource(source: HookSource): number {
    let count = 0;
    for (const [event, hooks] of this.hooks.entries()) {
      const before = hooks.length;
      const filtered = hooks.filter((h) => h.source !== source);
      this.hooks.set(event, filtered);
      count += before - filtered.length;
    }
    return count;
  }

  /**
   * Get all hooks matching an event + tool context.
   * Applies matcher pattern filtering and `if` condition checking.
   */
  getMatchingHooks(
    event: HookEvent,
    toolName?: string,
    parameters?: Record<string, unknown>,
  ): RegisteredHook[] {
    const candidates = this.hooks.get(event) ?? [];
    return candidates.filter((hook) => {
      if (!HookMatcher.matches(hook.matcher, toolName ?? '', parameters)) {
        return false;
      }
      if (
        !HookMatcher.matchesCondition(
          hook.command.if,
          toolName ?? '',
          parameters,
        )
      ) {
        return false;
      }
      return true;
    });
  }

  /**
   * Get all registered hooks (for diagnostics/UI).
   */
  getAllHooks(): Map<HookEvent, RegisteredHook[]> {
    return new Map(this.hooks);
  }

  /**
   * Check whether any hooks are registered for a given event.
   * Fast-path check to avoid building HookInput when no hooks exist.
   */
  hasHooksFor(event: HookEvent): boolean {
    const hooks = this.hooks.get(event);
    return hooks !== undefined && hooks.length > 0;
  }

  /**
   * Clear all hooks.
   */
  clear(): void {
    this.hooks.clear();
  }
}
