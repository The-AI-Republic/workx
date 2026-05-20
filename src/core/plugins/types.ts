/**
 * Track 10: Plugin System — Type Model
 *
 * Public type surface for the user-facing plugin system. NOT to be confused
 * with `src/server/channel-connectors/` (OpenClaw channel connectors, the
 * old `PluginRegistry` renamed in PR #217).
 *
 * Reference: `.ai_design/agent_improvements/10_plugin_system/design.md`
 * § Type Model + § PluginRegistry Algorithm.
 */

import type { HooksConfig } from '@/core/hooks/types';
import type { IMCPServerConfig } from '@/core/mcp/types';
import type { ToolExposureMode } from '@/tools/exposure';

// ── Identifiers and scope ──────────────────────────────────────────

/** Plugin identifier, format `<name>@<marketplace>`. */
export type PluginId = string;

/**
 * Installation scope (mirrors claudy). `managed` is admin-deployed; user
 * cannot uninstall. Other scopes are user-controllable.
 */
export type PluginScope = 'managed' | 'user' | 'project' | 'local';

/** Runtime platforms. Used in `manifest.browserx.platforms` for opt-in restriction. */
export type PluginPlatform = 'desktop' | 'extension' | 'server';

/** Capability slots a plugin can contribute to (v1). */
export type PluginSlot =
  | 'skills'
  | 'hooks'
  | 'mcpServers'
  | 'agents'
  | 'commands';

// ── Manifest sub-types ─────────────────────────────────────────────

export interface PluginAuthor {
  name?: string;
  email?: string;
  url?: string;
}

/**
 * `manifest.commands` map entry. Mirrors claudy's CommandMetadata — exactly
 * one of `source` (relative path) or `content` (inline body) is required.
 */
export interface CommandMetadata {
  source?: string;
  content?: string;
  description?: string;
  argumentHint?: string;
  whenToUse?: string;
}

/**
 * `manifest.userConfig.<KEY>` option declaration. Sensitive values are stored
 * via credential store and surface as a placeholder string in skill/agent
 * content (see `substituteUserConfigInContent`).
 */
export interface PluginUserConfigOption {
  type: 'string' | 'number' | 'boolean' | 'directory' | 'file';
  title: string;
  description: string;
  required?: boolean;
  default?: unknown;
  multiple?: boolean;
  sensitive?: boolean;
  min?: number;
  max?: number;
}

/**
 * Source descriptor for marketplace catalogue entries. Used in Phase 10b
 * but type-defined in Phase 10a-2 so `LoadedPlugin.source` is type-safe.
 *
 * `bundled` is the sentinel for `BundledPluginRegistry` entries; `path` is
 * the on-disk root for filesystem-loaded plugins (the v1 happy path).
 */
export type PluginSource =
  | { type: 'github'; repo: string; ref?: string; sha?: string }
  | { type: 'git'; url: string; ref?: string; sha?: string }
  | { type: 'url'; url: string; ref?: string; sha?: string }
  | { type: 'npm'; package: string; version?: string; registry?: string }
  | { type: 'path'; path: string }
  | { type: 'bundled' };

// ── Manifest ────────────────────────────────────────────────────────

/**
 * `plugin.json` shape. Mirrors claudy's `PluginManifestSchema`. Unknown
 * top-level fields are stripped at load (forward-compat); `/plugin validate`
 * uses strict mode for plugin-author feedback.
 *
 * Required: `name`, `version`. All capability slots optional. Each slot
 * accepts a single path, an array of paths, or inline config — the loader
 * normalizes during ingestion.
 */
export interface PluginManifest {
  name: string;
  version: string;
  description?: string;
  author?: PluginAuthor;
  homepage?: string;
  repository?: string;
  license?: string;
  keywords?: string[];

  // Capability slots
  skills?: string | string[];
  hooks?: string | HooksConfig | Array<string | HooksConfig>;
  mcpServers?:
    | string
    | Record<string, Partial<IMCPServerConfig>>
    | Array<string | Record<string, Partial<IMCPServerConfig>>>;
  agents?: string | string[];
  commands?: string | string[] | Record<string, CommandMetadata>;

  settings?: Record<string, unknown>;
  userConfig?: Record<string, PluginUserConfigOption>;

  /** BrowserX-specific extensions; never required for claudy compat. */
  browserx?: {
    domains?: string[];
    platforms?: PluginPlatform[];
    toolExposure?: Record<string, {
      mode?: ToolExposureMode;
      searchHint?: string;
      displayName?: string;
    }>;
  };
}

// ── Loaded plugin (runtime record) ──────────────────────────────────

/**
 * Lifecycle state for a loaded plugin. Discriminated union mirroring
 * Track 04's `TaskStateBase` pattern (`src/core/tasks/types.ts:53-73`).
 * Surface via `/plugin info <id>`.
 */
export type PluginState =
  | { status: 'disabled' }
  | { status: 'enabling'; startedAt: number }
  | { status: 'enabled'; enabledAt: number; activeSlots: PluginSlot[] }
  | { status: 'disabling'; startedAt: number }
  | { status: 'error'; lastError: PluginError; failedAt: number };

export function isStablePluginStatus(s: PluginState['status']): boolean {
  return s === 'disabled' || s === 'enabled' || s === 'error';
}

/**
 * Loaded plugin record. Constructed by `PluginLoader.loadFromDir`, owned by
 * `PluginRegistry.plugins`. The `state` field is mutated through the
 * registry's enable/disable lifecycle.
 */
export interface LoadedPlugin {
  id: PluginId;
  manifest: PluginManifest;

  /** On-disk root, or `'bundled'` sentinel for `BundledPluginRegistry` entries. */
  path: string;
  source: PluginSource;
  scope: PluginScope;
  isBuiltin?: boolean;
  sha?: string;

  /** Current lifecycle state — read via `isPluginEnabled` for the boolean view. */
  state: PluginState;

  // Resolved-path artifacts populated post-discovery by loader normalization.
  resolvedSkillPaths?: string[];
  resolvedAgentPaths?: string[];
  resolvedCommandPaths?: string[];
  resolvedMcpServers?: Record<string, Partial<IMCPServerConfig>>;
  resolvedHooks?: HooksConfig;

  /** Diagnostic surface for `/plugin info <id>`. Append-only across enable attempts. */
  loadErrors?: PluginError[];
}

/** Convenience: derived boolean view of `state.status === 'enabled'`. */
export function isPluginEnabled(p: LoadedPlugin): boolean {
  return p.state.status === 'enabled';
}

// ── Errors ──────────────────────────────────────────────────────────

/**
 * Discriminated union of plugin load/enable/install failure modes. Starts
 * with 6 variants (mirrors claudy's "widely emitted" subset); grow
 * incrementally rather than adding aspirational variants.
 *
 * Defined here to avoid a circular import — `LoadedPlugin.loadErrors`
 * references this and the errors module would reference `PluginId`.
 */
export type PluginError =
  | { type: 'generic-error'; message: string; pluginId?: PluginId }
  | { type: 'plugin-not-found'; pluginId: PluginId }
  | { type: 'path-not-found'; pluginId: PluginId; path: string }
  | {
      type: 'manifest-parse-error';
      pluginId?: PluginId;
      path: string;
      cause: string;
    }
  | {
      type: 'manifest-validation-error';
      pluginId?: PluginId;
      path: string;
      issues: string[];
    }
  | {
      type: 'component-load-failed';
      pluginId: PluginId;
      slot: PluginSlot;
      cause: string;
    }
  // Phase 10b/10c errors — defined here so `LoadedPlugin.loadErrors` stays
  // typed; their producers ship later.
  | {
      type: 'marketplace-blocked-by-policy';
      pluginId: PluginId;
      blockedByBlocklist: boolean;
    }
  | { type: 'mcp-server-suppressed-duplicate'; pluginId: PluginId; key: string };

// ── Result envelopes ───────────────────────────────────────────────

/** Returned by `PluginRegistry.bootstrapEnabledPlugins()` and `.reload()`. */
export interface PluginLoadResult {
  enabled: LoadedPlugin[];
  disabled: LoadedPlugin[];
  errors: PluginError[];
}

// ── Bundled-plugin shape ───────────────────────────────────────────

/**
 * In-process plugin definition for `BundledPluginRegistry`. Bundled plugins
 * don't read from disk — they declare their slots inline. The sentinel
 * marketplace name is `'bundled'`; resulting `PluginId` is `<name>@bundled`.
 */
export interface BundledPluginDefinition {
  name: string;
  version?: string;
  description?: string;
  manifest: PluginManifest;
  defaultEnabled?: boolean;
  /** Per-platform self-disable. Returning `false` hides the plugin entirely. */
  isAvailable?: () => boolean;
}
