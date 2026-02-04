/**
 * Global type declarations for dual-mode architecture
 *
 * @module types/globals
 */

/**
 * Build mode constant set at compile time by Vite
 * - 'extension': Chrome extension build
 * - 'desktop': Tauri desktop application build
 */
declare const __BUILD_MODE__: 'extension' | 'desktop';

/**
 * Augment the global scope
 */
declare global {
  const __BUILD_MODE__: 'extension' | 'desktop';
}

export {};
