/**
 * Desktop Bridge Settings
 *
 * Persistence for the extension→desktop browser bridge: whether the bridge
 * is enabled, the desktop app-server URL, and the pairing (capability) token
 * copied from the desktop app.
 *
 * Stored in `chrome.storage.local` — the token grants only the node scopes
 * (`node.invoke`/`node.event`) on a loopback listener, and the desktop can
 * rotate it at any time from its UI.
 *
 * @module extension/bridge/bridgeSettings
 */

export interface BridgeSettings {
  enabled: boolean;
  /** Desktop app-server WebSocket URL. */
  url: string;
  /** Capability token issued by the desktop app (pairing). */
  token: string;
}

export const BRIDGE_SETTINGS_KEY = 'workx:bridge_settings';

/**
 * Keepalive alarm name. Lives here (not in BridgeClient) so the service
 * worker can register its top-level alarm listener without statically
 * importing the full client/executor module graph.
 */
export const BRIDGE_KEEPALIVE_ALARM = 'workx-bridge-keepalive';

/** chrome.storage.session key the BridgeClient publishes live status under. */
export const BRIDGE_STATUS_KEY = 'workx:bridge_status';

export interface BridgeStatusSnapshot {
  status: 'disabled' | 'connecting' | 'connected' | 'error';
  lastError: string | null;
  updatedAt: number;
}

export const DEFAULT_BRIDGE_SETTINGS: BridgeSettings = {
  enabled: false,
  url: 'ws://127.0.0.1:18101',
  token: '',
};

export async function getBridgeSettings(): Promise<BridgeSettings> {
  const raw = await chrome.storage.local.get(BRIDGE_SETTINGS_KEY);
  const stored = raw?.[BRIDGE_SETTINGS_KEY] as Partial<BridgeSettings> | undefined;
  return { ...DEFAULT_BRIDGE_SETTINGS, ...(stored ?? {}) };
}

export async function setBridgeSettings(patch: Partial<BridgeSettings>): Promise<BridgeSettings> {
  const current = await getBridgeSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [BRIDGE_SETTINGS_KEY]: next });
  return next;
}

/** Subscribe to settings changes. Returns an unsubscribe function. */
export function onBridgeSettingsChanged(listener: (settings: BridgeSettings) => void): () => void {
  const handler = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ) => {
    if (areaName !== 'local' || !changes[BRIDGE_SETTINGS_KEY]) return;
    const next = {
      ...DEFAULT_BRIDGE_SETTINGS,
      ...((changes[BRIDGE_SETTINGS_KEY].newValue as Partial<BridgeSettings>) ?? {}),
    };
    listener(next);
  };
  chrome.storage.onChanged.addListener(handler);
  return () => chrome.storage.onChanged.removeListener(handler);
}
