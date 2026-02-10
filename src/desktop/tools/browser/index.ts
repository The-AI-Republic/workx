/**
 * Desktop Browser Tools
 *
 * Exports browser automation tools for the desktop application.
 *
 * @module desktop/tools/browser
 */

export { BrowserDetector, type BrowserInfo, type RunningBrowser } from './BrowserDetector';
export { ProfileManager, type ProfileInfo, type ProfileStatus, type CopyOptions } from './ProfileManager';
export { ChromeLauncher, type LaunchOptions, type LaunchResult } from './ChromeLauncher';
export { NativeCDPClient } from './NativeCDPClient';
export { NativeBrowserController, type ConnectionMode } from './NativeBrowserController';
export {
  ConnectionManager,
  type ConnectionState,
  type ConnectionEventType,
  type ConnectionEventCallback,
  type ConnectionOptions,
} from './ConnectionManager';
