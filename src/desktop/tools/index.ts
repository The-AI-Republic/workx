/**
 * Desktop Tools Module
 *
 * Exports desktop-specific tool implementations that use
 * native APIs (CDP, terminal, file system) instead of Chrome extension APIs.
 *
 * @module desktop/tools
 */

export { CDPDOMTool } from './CDPDOMTool';
export { NativeBrowserController } from './browser/NativeBrowserController';
export { NativeCDPClient } from './browser/NativeCDPClient';
export { ChromeLauncher } from './browser/ChromeLauncher';
