/**
 * Desktop Tools Module
 *
 * Exports desktop-specific tool implementations that use
 * native APIs (CDP, terminal, file system) instead of Chrome extension APIs.
 *
 * @module desktop/tools
 */

export { DesktopDOMTool } from './DesktopDOMTool';
export { CDPNavigationTool } from './CDPNavigationTool';
export { NativeBrowserController } from './browser/NativeBrowserController';
export { NativeCDPClient } from './browser/NativeCDPClient';
export { CDPDebuggerClient } from './browser/CDPDebuggerClient';
export { DesktopTabManager } from './browser/DesktopTabManager';
export { ChromeLauncher } from './browser/ChromeLauncher';
