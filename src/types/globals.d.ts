/**
 * Global type declarations for dual-mode architecture
 *
 * @module types/globals
 */

/**
 * Build mode constant set at compile time by Vite
 * - 'extension': Chrome extension build
 * - 'desktop': Tauri desktop application build
 * - 'server': Headless server build
 * - 'web': Web UI served by the server (browser SPA)
 * - 'mobile': Mobile application build (future)
 */
declare const __BUILD_MODE__: 'extension' | 'desktop' | 'server' | 'web' | 'mobile';

/**
 * Track 22 — compile-time feature flags, injected by Vite `define` from
 * vite.featureFlags.mjs. Bare constants so they constant-fold + tree-shake
 * exactly like __BUILD_MODE__. App code reads them via src/core/features/feature.ts,
 * not these globals directly.
 */
declare const __FEATURE_MCP__: boolean;
declare const __FEATURE_A2A__: boolean;
declare const __FEATURE_REMOTE_BRIDGE__: boolean;
declare const __FEATURE_X402__: boolean;
declare const __FEATURE_VOICE__: boolean;

/**
 * Augment the global scope
 */
declare global {
  const __BUILD_MODE__: 'extension' | 'desktop' | 'server' | 'web' | 'mobile';
  const __FEATURE_MCP__: boolean;
  const __FEATURE_A2A__: boolean;
  const __FEATURE_REMOTE_BRIDGE__: boolean;
  const __FEATURE_X402__: boolean;
  const __FEATURE_VOICE__: boolean;
}

export {};
