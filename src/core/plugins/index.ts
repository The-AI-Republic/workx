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

export {
  resolveDependencyClosure,
  marketplaceOf,
  nameOf,
  qualifyDependency,
} from './dependencyResolver';
export type {
  DependencyLookup,
  DependencyResolution,
  DependencyLookupResult,
} from './dependencyResolver';
export {
  InstalledPluginsStore,
  InstalledPluginEntrySchema,
  InstalledPluginsFileV2Schema,
  emptyInstalledPluginsFile,
} from './installedPlugins';
export type {
  InstalledPluginEntry,
  InstalledPluginsFileV2,
  InstalledPluginScope,
  InstalledPluginsStoreDeps,
} from './installedPlugins';
export { MarketplaceSchema, MarketplaceEntrySchema, PluginSourceSchema } from './MarketplaceSchema';
export type { Marketplace, MarketplaceEntry } from './MarketplaceSchema';
export { MarketplaceRegistry } from './MarketplaceRegistry';
export type { MarketplaceRegistryDeps } from './MarketplaceRegistry';
export { PluginCache, BROWSERX_PLUGIN_ORPHAN_TTL_MS } from './PluginCache';
export type { PluginCacheFsDeps } from './PluginCache';
export {
  gitClone,
  buildCloneArgs,
  buildPullArgs,
  gitErrorHint,
  redactUrlCredentials,
  gitTimeoutMs,
  GIT_NO_PROMPT_ENV,
  GitArgError,
} from './git';
export type { GitRunner, GitRunResult, GitCloneOptions } from './git';
export { createGitFetchPlugin } from './pluginFetch';
export type { GitFetchDeps } from './pluginFetch';
export {
  PolicyLoader,
  PluginPolicy,
  PolicySettingsSchema,
  emptyPolicy,
  isSourceAllowedByPolicy,
  isSourceInBlocklist,
  sourceMatches,
  isBlockedOfficialName,
  validateOfficialNameSource,
  ALLOWED_OFFICIAL_MARKETPLACE_NAMES,
  BLOCKED_OFFICIAL_NAME_PATTERN,
} from './policy';
export type {
  PolicySettings,
  PolicyLoaderDeps,
  MarketplaceSourceMatcher,
} from './policy';
export { PluginAutoupdate } from './PluginAutoupdate';
export type { AutoupdateDeps, AutoupdateResult } from './PluginAutoupdate';
export { PluginOptions } from './PluginOptions';
export type { PluginOptionsDeps } from './PluginOptions';
export { PluginInstaller, PluginUninstaller } from './PluginInstaller';
export type {
  PluginInstallerDeps,
  PluginUninstallerDeps,
  FetchedPlugin,
  InstallResult,
  UninstallResult,
} from './PluginInstaller';

export { SkillSlotLoader } from './loaders/SkillSlotLoader';
export type { SkillSlotLoaderDeps, FileReader, DirLister } from './loaders/SkillSlotLoader';
export { HookSlotLoader } from './loaders/HookSlotLoader';
export { McpSlotLoader } from './loaders/McpSlotLoader';
export { SubAgentSlotLoader } from './loaders/SubAgentSlotLoader';
export type { SubAgentSlotLoaderDeps } from './loaders/SubAgentSlotLoader';
export { CommandSlotLoader } from './loaders/CommandSlotLoader';
export type { CommandSlotLoaderDeps } from './loaders/CommandSlotLoader';
