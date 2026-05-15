/**
 * Public API — Track 10 user-facing plugin system.
 *
 * NOT to be confused with `src/server/channel-connectors/` (OpenClaw channel
 * connectors, the old `PluginRegistry` renamed in PR #217).
 */

export type {
  PluginId,
  PluginScope,
  PluginPlatform,
  PluginSlot,
  PluginAuthor,
  CommandMetadata,
  PluginUserConfigOption,
  PluginSource,
  PluginManifest,
  PluginState,
  LoadedPlugin,
  PluginError,
  PluginLoadResult,
  BundledPluginDefinition,
} from './types';

export { isStablePluginStatus, isPluginEnabled } from './types';

export {
  PluginManifestSchema,
  PluginManifestStrictSchema,
} from './PluginManifest';

export { getPluginErrorMessage, toPluginError } from './PluginErrors';

export type { IPluginProvider } from './PluginProvider';

export { PluginLoader } from './PluginLoader';
export type { PluginLoaderDeps } from './PluginLoader';
export { PluginRegistry } from './PluginRegistry';
export type { PluginRegistryDeps, SessionBinderHandle } from './PluginRegistry';
export { PluginSessionBinder } from './PluginSessionBinder';
export type { PluginSessionBinderDeps } from './PluginSessionBinder';

export {
  registerBundledPlugin,
  getBundledPlugins,
  getBundledPluginById,
  bundledIdFor,
  toLoadedPlugin,
  BUNDLED_MARKETPLACE_NAME,
} from './BundledPluginRegistry';

export {
  substitutePluginVariables,
  substituteUserConfigVariables,
  substituteUserConfigInContent,
  substituteContent,
  substituteRuntime,
  buildPluginOptionEnvVars,
  sensitiveContentPlaceholder,
} from './userConfigSubstitution';

export { SkillSlotLoader } from './loaders/SkillSlotLoader';
export type { SkillSlotLoaderDeps, FileReader, DirLister } from './loaders/SkillSlotLoader';
export { HookSlotLoader } from './loaders/HookSlotLoader';
export { McpSlotLoader } from './loaders/McpSlotLoader';
export { SubAgentSlotLoader } from './loaders/SubAgentSlotLoader';
export type { SubAgentSlotLoaderDeps } from './loaders/SubAgentSlotLoader';
export { CommandSlotLoader } from './loaders/CommandSlotLoader';
export type { CommandSlotLoaderDeps } from './loaders/CommandSlotLoader';
