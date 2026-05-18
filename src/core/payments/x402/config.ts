/**
 * x402 Config (extension/desktop) — Track 22 stand-in.
 *
 * The Track 22 feature-flag system does not exist in src/, so this in-track
 * config IS the gate: x402 is OFF unless explicitly enabled here. Persisted
 * via the same ConfigStorage dot-path mechanism SettingTool uses, so it works
 * on extension (chrome.storage) and desktop (Tauri) without touching the typed
 * IAgentConfig schema. The SERVER does not use this module — it reads
 * `server.x402` from the server Zod config (see server-config.ts).
 *
 * Every read fails SAFE: any error ⇒ disabled.
 *
 * @module core/payments/x402/config
 */

import { getConfigStorage } from '@/core/storage/ConfigStorageProvider';
import { STORAGE_KEYS } from '@/config/defaults';
import { X402_DEFAULTS, isPaymentNetwork, type X402Config } from './types';

/** Dot-path under the CONFIG storage object where x402 settings live. */
const X402_CONFIG_PATH = 'x402';

type RawConfig = Record<string, unknown>;

function coerce(raw: unknown): X402Config {
  const r = (raw ?? {}) as Partial<X402Config>;
  return {
    enabled: r.enabled === true,
    network: isPaymentNetwork(r.network) ? r.network : X402_DEFAULTS.network,
    address: typeof r.address === 'string' ? r.address : undefined,
    maxPaymentPerRequestUSD:
      typeof r.maxPaymentPerRequestUSD === 'number' && r.maxPaymentPerRequestUSD > 0
        ? r.maxPaymentPerRequestUSD
        : X402_DEFAULTS.maxPaymentPerRequestUSD,
    maxSessionSpendUSD:
      typeof r.maxSessionSpendUSD === 'number' && r.maxSessionSpendUSD > 0
        ? r.maxSessionSpendUSD
        : X402_DEFAULTS.maxSessionSpendUSD,
  };
}

/** Read the x402 config (extension/desktop). Fails safe to disabled defaults. */
export async function getX402Config(): Promise<X402Config> {
  try {
    const config = await getConfigStorage().get<RawConfig>(STORAGE_KEYS.CONFIG);
    return coerce(config?.[X402_CONFIG_PATH]);
  } catch {
    return { ...X402_DEFAULTS };
  }
}

/** Persist a partial update to the x402 config (extension/desktop). */
export async function saveX402Config(updates: Partial<X402Config>): Promise<X402Config> {
  const storage = getConfigStorage();
  const config = (await storage.get<RawConfig>(STORAGE_KEYS.CONFIG)) ?? {};
  const current = coerce(config[X402_CONFIG_PATH]);
  const merged: X402Config = { ...current, ...updates };
  config[X402_CONFIG_PATH] = merged;
  await storage.set(STORAGE_KEYS.CONFIG, config);
  return merged;
}

/**
 * The gate (extension/desktop). True only when explicitly enabled. The server
 * has its own enablement check (server.x402.enabled) — this is never consulted
 * there.
 */
export async function isX402Enabled(): Promise<boolean> {
  return (await getX402Config()).enabled === true;
}
