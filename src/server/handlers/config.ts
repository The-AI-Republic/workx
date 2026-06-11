/**
 * Config Method Handlers
 *
 * Handles config.get, config.set, config.patch with hot-reload support.
 *
 * @module server/handlers/config
 */

import { registerMethodHandler, type MethodContext } from '@workx/ws-server';
import { invalidRequest } from '@workx/ws-server';
import { getServerConfig, redactConfig, loadServerConfig } from '../config/server-config';

export function registerConfigHandlers(): void {
  registerMethodHandler('config.get', handleConfigGet);
  registerMethodHandler('config.set', handleConfigSet);
  registerMethodHandler('config.patch', handleConfigPatch);
}

// ─────────────────────────────────────────────────────────────────────────
// config.get
// ─────────────────────────────────────────────────────────────────────────

async function handleConfigGet(
  params: Record<string, unknown> | undefined,
  _ctx: MethodContext
): Promise<unknown> {
  const config = getServerConfig();
  const key = params?.key as string | undefined;

  // Redact secrets
  const safe = redactConfig(config);

  if (key) {
    // Return specific key (dot-notation path)
    return { key, value: getNestedValue(safe, key) };
  }

  return safe;
}

// ─────────────────────────────────────────────────────────────────────────
// config.set
// ─────────────────────────────────────────────────────────────────────────

async function handleConfigSet(
  params: Record<string, unknown> | undefined,
  _ctx: MethodContext
): Promise<unknown> {
  const key = params?.key as string;
  const value = params?.value;

  if (!key) throw invalidRequest('"key" is required');
  if (value === undefined) throw invalidRequest('"value" is required');

  // Write to config file
  await updateConfigKey(key, value);

  return { status: 'set', key };
}

// ─────────────────────────────────────────────────────────────────────────
// config.patch
// ─────────────────────────────────────────────────────────────────────────

async function handleConfigPatch(
  params: Record<string, unknown> | undefined,
  _ctx: MethodContext
): Promise<unknown> {
  const patch = params?.patch as Record<string, unknown>;
  if (!patch) throw invalidRequest('"patch" is required');

  // Apply each key in the patch
  for (const [key, value] of Object.entries(patch)) {
    await updateConfigKey(key, value);
  }

  return { status: 'patched', keys: Object.keys(patch) };
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function getNestedValue(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

async function updateConfigKey(key: string, value: unknown): Promise<void> {
  const fs = await import('node:fs');
  const path = await import('node:path');

  const configPath = process.env.WORKX_CONFIG_PATH ?? path.join(
    process.env.HOME ?? process.env.USERPROFILE ?? '/tmp',
    '.workx-server',
    'config.json'
  );

  let config: Record<string, unknown> = {};
  if (fs.existsSync(configPath)) {
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch {
      // Start fresh
    }
  }

  // Set nested key
  setNestedValue(config, key, value);

  // Ensure directory exists
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  // Trigger reload
  loadServerConfig();
}

function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!(parts[i] in current) || typeof current[parts[i]] !== 'object') {
      current[parts[i]] = {};
    }
    current = current[parts[i]] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}
