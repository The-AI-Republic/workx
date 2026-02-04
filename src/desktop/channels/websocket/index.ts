/**
 * WebSocket Module
 *
 * Exports WebSocket server and types for the remote control API.
 *
 * @module desktop/channels/websocket
 */

export * from './types';
export { WebSocketServer, type WebSocketServerConfig, type ConnectedClient } from './WebSocketServer';
