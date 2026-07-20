/**
 * Browser Bridge Handle
 *
 * Dependency-free seam between the desktop-runtime browser bridge (extension
 * acting as the live-browser executor) and generic tool registration code.
 * `registerDesktopTools` consults it to skip the chrome-devtools-mcp fallback
 * when a live-browser executor is connected, and the agent factory applies
 * bridge tools to newly created sessions through it.
 *
 * The handle is only set in the desktop runtime (Node sidecar). In extension
 * and Tauri-UI builds it stays null and everything behaves as before.
 *
 * @module tools/browserBridgeHandle
 */

import type { ToolRegistry } from './ToolRegistry';
import type { SessionBrowserContext } from '../core/platform/IPlatformAdapter';

export interface BrowserBridgeHandle {
  /** True when a paired browser extension is connected and has advertised tools. */
  hasActiveNode(): boolean;
  /** Register the current bridge tool set on a (new) session's registry. */
  applyToRegistry(sessionId: string, registry: ToolRegistry): Promise<void>;
  getSessionBrowserContext(sessionId: string): Promise<SessionBrowserContext | null>;
  releaseSession(sessionId: string): Promise<void>;
}

let handle: BrowserBridgeHandle | null = null;

export function setBrowserBridgeHandle(h: BrowserBridgeHandle | null): void {
  handle = h;
}

export function getBrowserBridgeHandle(): BrowserBridgeHandle | null {
  return handle;
}
