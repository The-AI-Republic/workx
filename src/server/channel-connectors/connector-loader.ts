/**
 * Connector Loader
 *
 * Discovers connectors from extensions/ directory and node_modules.
 * Validates connector definitions and loads them dynamically.
 *
 * @module server/channel-connectors/connector-loader
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import type { OpenClawConnectorDefinition } from './types';

// ─────────────────────────────────────────────────────────────────────────
// Discovery
// ─────────────────────────────────────────────────────────────────────────

/**
 * Discover and load all available connectors.
 */
export async function discoverConnectors(
  extensionsDir?: string
): Promise<OpenClawConnectorDefinition[]> {
  const connectors: OpenClawConnectorDefinition[] = [];

  // 1. Scan extensions/ directory
  const extDir = extensionsDir ?? path.join(process.cwd(), 'extensions');
  if (fs.existsSync(extDir)) {
    const extConnectors = await scanDirectory(extDir);
    connectors.push(...extConnectors);
  }

  // 2. Scan node_modules for packages with "openclaw-connector": true
  const nodeModulesConnectors = await scanNodeModules();
  connectors.push(...nodeModulesConnectors);

  console.log(`[ConnectorLoader] Discovered ${connectors.length} connector(s)`);
  return connectors;
}

async function scanDirectory(dir: string): Promise<OpenClawConnectorDefinition[]> {
  const connectors: OpenClawConnectorDefinition[] = [];

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const connectorDir = path.join(dir, entry.name);
    const packageJsonPath = path.join(connectorDir, 'package.json');

    if (!fs.existsSync(packageJsonPath)) continue;

    try {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
      if (!pkg['openclaw-plugin']) continue;

      const entryPoint = path.join(connectorDir, pkg.main ?? 'index.js');
      const connector = await loadConnector(entryPoint);
      if (connector) {
        connectors.push(connector);
      }
    } catch (err) {
      console.warn(`[ConnectorLoader] Failed to load connector from ${connectorDir}:`, err);
    }
  }

  return connectors;
}

async function scanNodeModules(): Promise<OpenClawConnectorDefinition[]> {
  const connectors: OpenClawConnectorDefinition[] = [];
  const nodeModulesDir = path.join(process.cwd(), 'node_modules');

  if (!fs.existsSync(nodeModulesDir)) return connectors;

  const entries = fs.readdirSync(nodeModulesDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    // Handle scoped packages (@org/pkg)
    if (entry.name.startsWith('@')) {
      const scopeDir = path.join(nodeModulesDir, entry.name);
      const scopedEntries = fs.readdirSync(scopeDir, { withFileTypes: true });
      for (const scopedEntry of scopedEntries) {
        if (!scopedEntry.isDirectory()) continue;
        const connector = await tryLoadFromPackage(path.join(scopeDir, scopedEntry.name));
        if (connector) connectors.push(connector);
      }
    } else {
      const connector = await tryLoadFromPackage(path.join(nodeModulesDir, entry.name));
      if (connector) connectors.push(connector);
    }
  }

  return connectors;
}

async function tryLoadFromPackage(pkgDir: string): Promise<OpenClawConnectorDefinition | null> {
  const packageJsonPath = path.join(pkgDir, 'package.json');
  if (!fs.existsSync(packageJsonPath)) return null;

  try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    if (!pkg['openclaw-plugin']) return null;

    const entryPoint = path.join(pkgDir, pkg.main ?? 'index.js');
    return await loadConnector(entryPoint);
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Loading & validation
// ─────────────────────────────────────────────────────────────────────────

async function loadConnector(entryPoint: string): Promise<OpenClawConnectorDefinition | null> {
  if (!fs.existsSync(entryPoint)) return null;

  try {
    const mod = await import(entryPoint);
    const definition = mod.default ?? mod;

    if (!validateConnectorDefinition(definition)) {
      console.warn(`[ConnectorLoader] Invalid connector definition at ${entryPoint}`);
      return null;
    }

    console.log(`[ConnectorLoader] Loaded connector: ${definition.id} v${definition.version}`);
    return definition as OpenClawConnectorDefinition;
  } catch (err) {
    console.warn(`[ConnectorLoader] Failed to import ${entryPoint}:`, err);
    return null;
  }
}

function validateConnectorDefinition(def: unknown): boolean {
  if (!def || typeof def !== 'object') return false;

  const d = def as Record<string, unknown>;
  return (
    typeof d.id === 'string' &&
    typeof d.name === 'string' &&
    typeof d.version === 'string' &&
    typeof d.register === 'function'
  );
}
