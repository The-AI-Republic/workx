/**
 * Chrome extension config messaging protocol types
 */

import type { IAgentConfig, IModelConfig, IConfigChangeEvent } from '../config/types';

/**
 * Base message structure for all config messages
 */
export interface ConfigMessageBase {
  messageId: string;
  timestamp: number;
  source: 'background' | 'content' | 'sidepanel' | 'popup';
}

/**
 * Config request message
 */
export interface ConfigRequestMessage extends ConfigMessageBase {
  type: 'CONFIG_REQUEST';
  sections?: Array<'model' | 'providers' | 'profiles' | 'tools' | 'security' | 'ui' | 'system'>;
}

/**
 * Config response message
 */
export interface ConfigResponseMessage extends ConfigMessageBase {
  type: 'CONFIG_RESPONSE';
  config: Partial<IAgentConfig>;
  requestId: string;
}

/**
 * Config update message
 */
export interface ConfigUpdateMessage extends ConfigMessageBase {
  type: 'CONFIG_UPDATE';
  changes: Partial<IAgentConfig>;
  broadcast: boolean;
}

/**
 * Update acknowledgment message
 */
export interface UpdateAckMessage extends ConfigMessageBase {
  type: 'UPDATE_ACK';
  success: boolean;
  error?: string;
  updateId: string;
}

/**
 * Config change notification
 */
export interface ConfigChangeNotification extends ConfigMessageBase {
  type: 'CONFIG_CHANGE';
  section: 'model' | 'provider' | 'profile' | 'tools' | 'security' | 'ui' | 'system';
  changeType: 'created' | 'updated' | 'deleted';
  oldValue?: any;
  newValue?: any;
}

/**
 * Config sync message
 */
export interface ConfigSyncMessage extends ConfigMessageBase {
  type: 'CONFIG_SYNC';
  action: 'push' | 'pull' | 'merge';
  config?: IAgentConfig;
  force?: boolean;
}

/**
 * Sync result message
 */
export interface SyncResultMessage extends ConfigMessageBase {
  type: 'SYNC_RESULT';
  success: boolean;
  finalConfig: IAgentConfig;
  conflicts?: Array<{
    section: string;
    localValue: any;
    remoteValue: any;
    resolution: 'local' | 'remote' | 'merged';
  }>;
}

/**
 * Union type for all config messages
 */
export type ConfigMessage =
  | ConfigRequestMessage
  | ConfigResponseMessage
  | ConfigUpdateMessage
  | UpdateAckMessage
  | ConfigChangeNotification
  | ConfigSyncMessage
  | SyncResultMessage;

/**
 * Chrome runtime message wrapper
 */
export interface ChromeConfigMessage {
  action: 'CONFIG_REQUEST' | 'CONFIG_RESPONSE' | 'CONFIG_UPDATE' | 'CONFIG_CHANGE' | 'CONFIG_SYNC';
  data: ConfigMessage;
}

/**
 * Helper to create a unique message ID
 */
export function generateMessageId(): string {
  return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Helper to create a config request message
 */
export function createConfigRequest(
  source: ConfigMessageBase['source'],
  sections?: ConfigRequestMessage['sections']
): ConfigRequestMessage {
  return {
    type: 'CONFIG_REQUEST',
    messageId: generateMessageId(),
    timestamp: Date.now(),
    source,
    sections
  };
}

/**
 * Helper to create a config response message
 */
export function createConfigResponse(
  source: ConfigMessageBase['source'],
  config: Partial<IAgentConfig>,
  requestId: string
): ConfigResponseMessage {
  return {
    type: 'CONFIG_RESPONSE',
    messageId: generateMessageId(),
    timestamp: Date.now(),
    source,
    config,
    requestId
  };
}

/**
 * Helper to create a config update message
 */
export function createConfigUpdate(
  source: ConfigMessageBase['source'],
  changes: Partial<IAgentConfig>,
  broadcast: boolean = true
): ConfigUpdateMessage {
  return {
    type: 'CONFIG_UPDATE',
    messageId: generateMessageId(),
    timestamp: Date.now(),
    source,
    changes,
    broadcast
  };
}

/**
 * Helper to create a config change notification
 */
export function createConfigChangeNotification(
  source: ConfigMessageBase['source'],
  event: IConfigChangeEvent
): ConfigChangeNotification {
  return {
    type: 'CONFIG_CHANGE',
    messageId: generateMessageId(),
    timestamp: Date.now(),
    source,
    section: event.section as any,
    changeType: 'updated',
    oldValue: event.oldValue,
    newValue: event.newValue
  };
}