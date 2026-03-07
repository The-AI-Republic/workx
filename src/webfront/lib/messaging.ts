/**
 * Platform-Agnostic Messaging Utilities
 *
 * Provides helper functions for UI components to send messages
 * without directly using chrome.runtime.sendMessage.
 *
 * Uses UIChannelClient when available, with fallback to chrome.runtime
 * for backward compatibility.
 *
 * @module sidepanel/lib/messaging
 */

import { getInitializedUIClient } from '@/core/messaging';
import { MessageType } from '@/core/message-types';

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
 * import { MessageType } from '@/core/message-types';
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
  // Route through UIChannelClient for types with a service path mapping
  const servicePath = MESSAGE_TYPE_TO_SERVICE_PATH[type];
  if (servicePath) {
    try {
      const client = await getInitializedUIClient();
      const params: Record<string, unknown> =
        payload && typeof payload === 'object' && !Array.isArray(payload)
          ? (payload as Record<string, unknown>)
          : payload !== undefined
            ? { payload }
            : {};
      return await client.serviceRequest<T>(servicePath, params);
    } catch {
      // Fall through to legacy path if UIChannelClient is unavailable
    }
  }

  // Fallback to chrome.runtime.sendMessage for extension mode
  if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(
        { type, payload },
        (response: unknown) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            // Unwrap ResponseEnvelope (matching ChromeMessageService behavior)
            const envelope = response as Record<string, unknown> | null | undefined;
            if (envelope && typeof envelope === 'object' && 'success' in envelope) {
              if (envelope.success === false) {
                reject(new Error((envelope.error as string) || 'Request failed'));
              } else {
                resolve(envelope.data as T);
              }
            } else {
              resolve(response as T);
            }
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

// ---------------------------------------------------------------------------
// Compatibility shim (message_routing_v2)
// Maps old MessageType enum values to new service paths.
// Temporary — will be removed when UI components migrate to serviceRequest().
// ---------------------------------------------------------------------------

const MESSAGE_TYPE_TO_SERVICE_PATH: Partial<Record<MessageType, string>> = {
  [MessageType.PING]: 'agent.ping',
  [MessageType.INTERRUPT]: 'agent.interrupt',
  [MessageType.GET_STATE]: 'session.getState',
  [MessageType.HEALTH_CHECK]: 'agent.healthCheck',
  [MessageType.SESSION_RESET]: 'session.reset',
  [MessageType.RESUME_SESSION]: 'session.resume',
  [MessageType.CONFIG_UPDATE]: 'agent.configUpdate',
  [MessageType.INIT_AUTH]: 'agent.initAuth',
  [MessageType.STORAGE_GET]: 'storage.get',
  [MessageType.STORAGE_SET]: 'storage.set',
  [MessageType.MCP_GET_SERVERS]: 'mcp.getServers',
  [MessageType.MCP_ADD_SERVER]: 'mcp.addServer',
  [MessageType.MCP_UPDATE_SERVER]: 'mcp.updateServer',
  [MessageType.MCP_REMOVE_SERVER]: 'mcp.removeServer',
  [MessageType.MCP_CONNECT]: 'mcp.connect',
  [MessageType.MCP_DISCONNECT]: 'mcp.disconnect',
  [MessageType.MCP_GET_CONNECTION]: 'mcp.getConnection',
  [MessageType.MCP_GET_CONNECTIONS]: 'mcp.getConnections',
  [MessageType.MCP_GET_ALL_TOOLS]: 'mcp.getAllTools',
  [MessageType.MCP_EXECUTE_TOOL]: 'mcp.executeTool',
  [MessageType.MCP_GET_ALL_RESOURCES]: 'mcp.getAllResources',
  [MessageType.MCP_READ_RESOURCE]: 'mcp.readResource',
  [MessageType.SCHEDULER_CREATE_DRAFT_TASK]: 'scheduler.createDraft',
  [MessageType.SCHEDULER_SCHEDULE_TASK]: 'scheduler.schedule',
  [MessageType.SCHEDULER_TRIGGER_TASK]: 'scheduler.trigger',
  [MessageType.SCHEDULER_CANCEL_TASK]: 'scheduler.cancel',
  [MessageType.SCHEDULER_COMPLETE_TASK]: 'scheduler.complete',
  [MessageType.SCHEDULER_FAIL_TASK]: 'scheduler.fail',
  [MessageType.SCHEDULER_PAUSE_QUEUE]: 'scheduler.pauseQueue',
  [MessageType.SCHEDULER_RESUME_QUEUE]: 'scheduler.resumeQueue',
  [MessageType.SCHEDULER_GET_DRAFT_TASKS]: 'scheduler.getDraftTasks',
  [MessageType.SCHEDULER_GET_SCHEDULED_TASKS]: 'scheduler.getScheduledTasks',
  [MessageType.SCHEDULER_GET_MISSED_TASKS]: 'scheduler.getMissedTasks',
  [MessageType.SCHEDULER_GET_QUEUE]: 'scheduler.getQueue',
  [MessageType.SCHEDULER_GET_ARCHIVED_TASKS]: 'scheduler.getArchivedTasks',
  [MessageType.SCHEDULER_GET_STATE]: 'scheduler.getState',
  [MessageType.SCHEDULER_GET_TASK_DETAILS]: 'scheduler.getTaskDetails',
  [MessageType.VAULT_STATUS]: 'vault.status',
  [MessageType.VAULT_UNLOCK]: 'vault.unlock',
  [MessageType.VAULT_LOCK]: 'vault.lock',
  [MessageType.PIN_SET]: 'vault.pin.set',
  [MessageType.PIN_CHANGE]: 'vault.pin.change',
  [MessageType.PIN_REMOVE]: 'vault.pin.remove',
  [MessageType.PIN_FORGOT]: 'vault.pin.forgot',
  [MessageType.SKILLS_LIST]: 'skills.list',
  [MessageType.SKILLS_LOAD]: 'skills.load',
  [MessageType.SKILLS_SAVE]: 'skills.save',
  [MessageType.SKILLS_DELETE]: 'skills.delete',
  [MessageType.SKILLS_UPDATE_MODE]: 'skills.updateMode',
  [MessageType.SKILLS_IMPORT]: 'skills.import',
  [MessageType.SKILLS_EXPORT]: 'skills.export',
  [MessageType.SKILLS_TRUST]: 'skills.trust',
  [MessageType.SESSION_LIST]: 'session.list',
  [MessageType.SESSION_GET_ACTIVE_COUNT]: 'session.getActiveCount',
  [MessageType.SET_MAX_CONCURRENT_SESSIONS]: 'session.setMaxConcurrent',
  [MessageType.A2A_GET_AGENTS]: 'a2a.getAgents',
  [MessageType.A2A_ADD_AGENT]: 'a2a.addAgent',
  [MessageType.A2A_UPDATE_AGENT]: 'a2a.updateAgent',
  [MessageType.A2A_REMOVE_AGENT]: 'a2a.removeAgent',
  [MessageType.A2A_CONNECT]: 'a2a.connect',
  [MessageType.A2A_DISCONNECT]: 'a2a.disconnect',
  [MessageType.A2A_GET_CONNECTION]: 'a2a.getConnection',
  [MessageType.A2A_GET_CONNECTIONS]: 'a2a.getConnections',
  [MessageType.A2A_GET_ALL_SKILLS]: 'a2a.getAllSkills',
  [MessageType.A2A_EXECUTE_SKILL]: 'a2a.executeSkill',
  [MessageType.A2A_CANCEL_TASK]: 'a2a.cancelTask',
};

/**
 * Map a MessageType to its service path.
 * Returns null if the type doesn't have a service path mapping.
 */
export function messageTypeToServicePath(type: MessageType): string | null {
  return MESSAGE_TYPE_TO_SERVICE_PATH[type] ?? null;
}
