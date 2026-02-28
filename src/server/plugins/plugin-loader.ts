/**
 * Plugin Loader
 *
 * Discovers plugins from extensions/ directory and node_modules.
 * Validates plugin definitions and loads them dynamically.
 *
 * @module server/plugins/plugin-loader
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import type { OpenClawPluginDefinition } from './types';

// ─────────────────────────────────────────────────────────────────────────
// Discovery
// ─────────────────────────────────────────────────────────────────────────

/**
 * Discover and load all available plugins.
 */
export async function discoverPlugins(
  extensionsDir?: string
): Promise<OpenClawPluginDefinition[]> {
  const plugins: OpenClawPluginDefinition[] = [];

  // 1. Scan extensions/ directory
  const extDir = extensionsDir ?? path.join(process.cwd(), 'extensions');
  if (fs.existsSync(extDir)) {
    const extPlugins = await scanDirectory(extDir);
    plugins.push(...extPlugins);
  }

  // 2. Scan node_modules for packages with "openclaw-plugin": true
  const nodeModulesPlugins = await scanNodeModules();
  plugins.push(...nodeModulesPlugins);

  console.log(`[PluginLoader] Discovered ${plugins.length} plugin(s)`);
  return plugins;
}

async function scanDirectory(dir: string): Promise<OpenClawPluginDefinition[]> {
  const plugins: OpenClawPluginDefinition[] = [];

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const pluginDir = path.join(dir, entry.name);
    const packageJsonPath = path.join(pluginDir, 'package.json');

    if (!fs.existsSync(packageJsonPath)) continue;

    try {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
      if (!pkg['openclaw-plugin']) continue;

      const entryPoint = path.join(pluginDir, pkg.main ?? 'index.js');
      const plugin = await loadPlugin(entryPoint);
      if (plugin) {
        plugins.push(plugin);
      }
    } catch (err) {
      console.warn(`[PluginLoader] Failed to load plugin from ${pluginDir}:`, err);
    }
  }

  return plugins;
}

async function scanNodeModules(): Promise<OpenClawPluginDefinition[]> {
  const plugins: OpenClawPluginDefinition[] = [];
  const nodeModulesDir = path.join(process.cwd(), 'node_modules');

  if (!fs.existsSync(nodeModulesDir)) return plugins;

  const entries = fs.readdirSync(nodeModulesDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    // Handle scoped packages (@org/pkg)
    if (entry.name.startsWith('@')) {
      const scopeDir = path.join(nodeModulesDir, entry.name);
      const scopedEntries = fs.readdirSync(scopeDir, { withFileTypes: true });
      for (const scopedEntry of scopedEntries) {
        if (!scopedEntry.isDirectory()) continue;
        const plugin = await tryLoadFromPackage(path.join(scopeDir, scopedEntry.name));
        if (plugin) plugins.push(plugin);
      }
    } else {
      const plugin = await tryLoadFromPackage(path.join(nodeModulesDir, entry.name));
      if (plugin) plugins.push(plugin);
    }
  }

  return plugins;
}

async function tryLoadFromPackage(pkgDir: string): Promise<OpenClawPluginDefinition | null> {
  const packageJsonPath = path.join(pkgDir, 'package.json');
  if (!fs.existsSync(packageJsonPath)) return null;

  try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    if (!pkg['openclaw-plugin']) return null;

    const entryPoint = path.join(pkgDir, pkg.main ?? 'index.js');
    return await loadPlugin(entryPoint);
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Loading & validation
// ─────────────────────────────────────────────────────────────────────────

async function loadPlugin(entryPoint: string): Promise<OpenClawPluginDefinition | null> {
  if (!fs.existsSync(entryPoint)) return null;

  try {
    const mod = await import(entryPoint);
    const definition = mod.default ?? mod;

    if (!validatePluginDefinition(definition)) {
      console.warn(`[PluginLoader] Invalid plugin definition at ${entryPoint}`);
      return null;
    }

    console.log(`[PluginLoader] Loaded plugin: ${definition.id} v${definition.version}`);
    return definition as OpenClawPluginDefinition;
  } catch (err) {
    console.warn(`[PluginLoader] Failed to import ${entryPoint}:`, err);
    return null;
  }
}

function validatePluginDefinition(def: unknown): boolean {
  if (!def || typeof def !== 'object') return false;

  const d = def as Record<string, unknown>;
  return (
    typeof d.id === 'string' &&
    typeof d.name === 'string' &&
    typeof d.version === 'string' &&
    typeof d.register === 'function'
  );
}
