// vite.version.mjs
//
// Single, dependency-free source of truth for the app version at BUILD time.
//
// The version is defined in exactly ONE place — package.json — and every build
// artifact reads it from here so the number can never drift again (previously
// package.json said 1.0.0, tauri.conf.json said 0.1.1, and RolloutRecorder
// hard-coded '1.0.0'). tauri.conf.json reads the same package.json directly via
// its `"version": "../package.json"` reference.
//
// Mirrors the vite.featureFlags.mjs pattern: plain data + one helper, ZERO
// `@/`/TypeScript/app imports, so the plain `.mjs`/`.mts` Vite configs can
// import it at Node config-eval time. App code reads the injected value through
// src/config/version.ts (typed `APP_VERSION`), not the bare global directly.

import { readFileSync } from 'node:fs';

/** Canonical app version, read from package.json (the one source of truth). */
export const APP_VERSION = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
).version;

/**
 * Build the Vite `define` fragment injecting the version as a bare
 * `__APP_VERSION__` constant (JSON.stringify'd, exactly like __BUILD_MODE__).
 *
 * @returns {Record<string, string>}  e.g. { __APP_VERSION__: "\"3.0.0\"" }
 */
export function versionDefine() {
  return { __APP_VERSION__: JSON.stringify(APP_VERSION) };
}
