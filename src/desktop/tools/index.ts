/**
 * Desktop Tools Module
 *
 * Exports desktop-specific tool implementations that use
 * native APIs (CDP, terminal, file system) instead of Chrome extension APIs.
 *
 * Browser automation tools (DOM, navigation, etc.) are now registered
 * dynamically via MCPManager's builtin 'browser' server. See
 * registerDesktopTools.ts for the registration flow.
 *
 * @module desktop/tools
 */

export { NativeBrowserController } from './browser/NativeBrowserController';
export { NativeCDPClient } from './browser/NativeCDPClient';
export { CDPDebuggerClient } from './browser/CDPDebuggerClient';
export { DesktopTabManager } from './browser/DesktopTabManager';
export { ChromeLauncher } from './browser/ChromeLauncher';
export { TerminalTool, SecurityFilter } from './terminal';
