/**
 * ConfigHookLoader — Load hooks from AgentConfig and register them.
 *
 * Called during RepublicAgent.initialize() and on config-changed events.
 */

import type { HookRegistry } from '../HookRegistry';
import type { HooksConfig } from '../types';

/**
 * Minimal config interface so this module doesn't depend on the full AgentConfig class.
 */
export interface HookConfigSource {
  getConfig(): { hooks?: HooksConfig };
  on(
    event: 'config-changed',
    handler: (e: { section: string }) => void,
  ): void;
  off(
    event: 'config-changed',
    handler: (e: { section: string }) => void,
  ): void;
}

export class ConfigHookLoader {
  /**
   * Load hooks from config and register them.
   * Clears any previously registered config-source hooks first.
   */
  static load(config: HookConfigSource, registry: HookRegistry): void {
    registry.unregisterBySource('config');
    const cfg = config.getConfig();
    if (cfg.hooks) {
      registry.registerFromConfig(cfg.hooks, 'config');
    }
  }

  /**
   * Subscribe to config changes and reload hooks when the 'hooks' section changes.
   * Returns an unsubscribe function.
   */
  static watch(
    config: HookConfigSource,
    registry: HookRegistry,
  ): () => void {
    const handler = (event: { section: string }) => {
      if (event.section === 'hooks') {
        ConfigHookLoader.load(config, registry);
      }
    };
    config.on('config-changed', handler);
    return () => config.off('config-changed', handler);
  }
}
