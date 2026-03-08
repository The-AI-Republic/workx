/**
 * Platform capabilities store
 *
 * Centralizes all platform-specific UI differences in one place.
 * Components check capabilities (e.g., "hasTabSelection") rather than
 * platform names (e.g., "is extension?") for better semantics.
 *
 * @module stores/platformStore
 */

export interface PlatformCapabilities {
  /** Can select browser tabs (extension only) */
  hasTabSelection: boolean;

  /** Has system tray integration (desktop only) */
  hasSystemTray: boolean;

  /** Can register global hotkeys (desktop only) */
  hasGlobalHotkeys: boolean;

  /** Can auto-start on OS login (desktop only) */
  hasAutoStart: boolean;

  /** Supports agent long-term memory (desktop/server only) */
  hasMemory: boolean;

  /** Has touch-optimized input (mobile only) */
  hasTouchInput: boolean;

  /** Platform identifier for analytics/debugging */
  platformName: 'extension' | 'desktop' | 'server' | 'mobile';
}

/**
 * Platform capabilities based on build mode
 */
export const platform: PlatformCapabilities = {
  // Extension-only features
  hasTabSelection: __BUILD_MODE__ === 'extension',

  // Desktop-only features
  hasSystemTray: __BUILD_MODE__ === 'desktop',
  hasGlobalHotkeys: __BUILD_MODE__ === 'desktop',
  hasAutoStart: __BUILD_MODE__ === 'desktop',

  // Memory support (desktop/server only)
  hasMemory: __BUILD_MODE__ !== 'extension',

  // Mobile-only features (for future use)
  hasTouchInput: false, // Will be: __BUILD_MODE__ === 'mobile'

  // Platform identifier
  platformName: __BUILD_MODE__ as 'extension' | 'desktop' | 'server' | 'mobile',
};
