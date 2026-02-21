/**
 * Channel Module
 *
 * Exports channel-related types and the ChannelManager.
 *
 * @module core/channels
 */

export type { ChannelAdapter } from './ChannelAdapter';
export { ChannelManager, getChannelManager } from './ChannelManager';
export type { AgentHandler } from './ChannelManager';
export * from './types';
