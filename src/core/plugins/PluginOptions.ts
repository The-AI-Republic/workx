/**
 * PluginOptions — per-plugin userConfig storage (Phase 10c).
 *
 * Non-sensitive values → settings (`pluginConfigs[id].options`).
 * Sensitive values → credential store. Reads merge with credential-store
 * winning. Values are validated against the plugin's `userConfig` schema
 * before persisting.
 *
 * Storage is injected so this is platform-agnostic + testable.
 * Reference: design.md § Per-plugin options.
 */

import type { PluginId, PluginUserConfigOption } from './types';

export interface PluginOptionsDeps {
  getConfigOptions: (id: PluginId) => Record<string, unknown>;
  setConfigOptions: (id: PluginId, options: Record<string, unknown>) => Promise<void>;
  getSecrets: (id: PluginId) => Promise<Record<string, unknown>>;
  setSecret: (id: PluginId, key: string, value: unknown) => Promise<void>;
  deleteSecrets: (id: PluginId) => Promise<void>;
}

export class PluginOptions {
  constructor(private readonly deps: PluginOptionsDeps) {}

  /** Merged view (credential store wins on key collision). */
  async get(id: PluginId): Promise<Record<string, unknown>> {
    const nonSensitive = this.deps.getConfigOptions(id) ?? {};
    const sensitive = (await this.deps.getSecrets(id)) ?? {};
    return { ...nonSensitive, ...sensitive };
  }

  /** Validate + persist a single option to the right store. */
  async set(
    id: PluginId,
    key: string,
    value: unknown,
    schema: PluginUserConfigOption,
  ): Promise<void> {
    this.validate(key, value, schema);
    if (schema.sensitive) {
      await this.deps.setSecret(id, key, value);
    } else {
      const cur = this.deps.getConfigOptions(id) ?? {};
      await this.deps.setConfigOptions(id, { ...cur, [key]: value });
    }
  }

  /** Wipe both stores for a plugin (called from uninstall last-scope). */
  async delete(id: PluginId): Promise<void> {
    await this.deps.setConfigOptions(id, {});
    await this.deps.deleteSecrets(id);
  }

  private validate(
    key: string,
    value: unknown,
    schema: PluginUserConfigOption,
  ): void {
    if (schema.required && (value == null || value === '')) {
      throw new Error(`option "${key}" is required`);
    }
    if (value == null) return;
    switch (schema.type) {
      case 'number': {
        if (typeof value !== 'number' || Number.isNaN(value)) {
          throw new Error(`option "${key}" must be a number`);
        }
        if (schema.min != null && value < schema.min) {
          throw new Error(`option "${key}" must be >= ${schema.min}`);
        }
        if (schema.max != null && value > schema.max) {
          throw new Error(`option "${key}" must be <= ${schema.max}`);
        }
        break;
      }
      case 'boolean':
        if (typeof value !== 'boolean') {
          throw new Error(`option "${key}" must be a boolean`);
        }
        break;
      case 'string':
      case 'directory':
      case 'file':
        if (typeof value !== 'string') {
          throw new Error(`option "${key}" must be a string`);
        }
        break;
    }
  }
}
