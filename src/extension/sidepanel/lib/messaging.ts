/**
 * Platform-Agnostic Messaging Utilities
 *
 * Provides helper functions for UI components to send messages
 * without directly using chrome.runtime.sendMessage.
 *
 * Uses IMessageService when available, with fallback to chrome.runtime
 * for backward compatibility during migration.
 *
 * @module sidepanel/lib/messaging
 */

import { tryGetMessageService } from '@/core/messaging';
import { MessageType } from '@/core/MessageRouter';

/**
 * Send a message to the backend (service worker or Tauri agent)
 *
 * @param type - Message type from MessageType enum
 * @param payload - Optional message payload
 * @returns Promise resolving to response data
 *
 * @example
 * ```typescript
 * import { sendMessage } from './lib/messaging';
 * import { MessageType } from '@/core/MessageRouter';
 *
 * // Send config update notification
 * await sendMessage(MessageType.CONFIG_UPDATE);
 *
 * // Send with payload
 * const servers = await sendMessage(MessageType.MCP_GET_SERVERS);
 * ```
 */
export async function sendMessage<T = unknown>(
  type: MessageType,
  payload?: unknown
): Promise<T> {
  // Try to use IMessageService first (preferred)
  const service = tryGetMessageService();

  if (service) {
    return await service.send<T>(type, payload);
  }

  // Fallback to chrome.runtime.sendMessage for extension mode
  // or polyfill in desktop mode
  if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { type, payload },
        (response: unknown) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(response as T);
          }
        }
      );
    });
  }

  throw new Error('No messaging service available');
}

/**
 * Send a config update notification
 *
 * Notifies the backend that configuration has changed and
 * it should reload/refresh as needed.
 */
export async function notifyConfigUpdate(): Promise<void> {
  try {
    await sendMessage(MessageType.CONFIG_UPDATE);
  } catch (error) {
    // Fire and forget - log but don't throw
    console.warn('[messaging] Failed to send CONFIG_UPDATE:', error);
  }
}

/**
 * Send a message without waiting for response (fire and forget)
 *
 * @param type - Message type
 * @param payload - Optional payload
 */
export function sendMessageAsync(type: MessageType, payload?: unknown): void {
  sendMessage(type, payload).catch((error) => {
    console.warn(`[messaging] Failed to send ${type}:`, error);
  });
}

// Re-export MessageType for convenience
export { MessageType };
