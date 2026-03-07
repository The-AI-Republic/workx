/**
 * Background entry point for Chrome extension
 * Re-exports service worker functionality
 */

export * from './service-worker';
export { RepublicAgent } from '../../core/RepublicAgent';
export { MessageType } from '../../core/message-types';
export { ModelClientFactory } from '../../core/models/ModelClientFactory';
export { ToolRegistry } from '../../tools/ToolRegistry';

// For convenience, also export the main service worker initialization
export { initialize as initializeBackground } from './service-worker';