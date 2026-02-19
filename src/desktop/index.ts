/**
 * Desktop Module
 *
 * Exports for the Tauri desktop application.
 *
 * @module desktop
 */

export { initializeDesktop, cleanup } from './main';
export { initializeTray, minimizeToTray, restoreFromTray, toggleWindow } from './tray';
export {
  initializeHotkeys,
  registerHotkey,
  unregisterHotkey,
  unregisterAllHotkeys,
} from './hotkeys';
export { TauriChannel } from './channels/TauriChannel';
export {
  getPlatformPaths,
  getConfigPath,
  getDataPath,
  getCachePath,
  getLogPath,
  getDatabasePath,
} from './platform/paths';
