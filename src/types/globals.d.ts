/**
 * Global type declarations for dual-mode architecture
 *
 * @module types/globals
 */

/**
 * Build mode constant set at compile time by Vite
 * - 'extension': Chrome extension build
 * - 'desktop': Tauri desktop application build
 * - 'mobile': Mobile application build (future)
 */
declare const __BUILD_MODE__: 'extension' | 'desktop' | 'mobile';

/**
 * Augment the global scope
 */
declare global {
  const __BUILD_MODE__: 'extension' | 'desktop' | 'mobile';
}

export {};
