/**
 * Platform-Agnostic Messaging
 *
 * Central export for the messaging module. Provides a unified API
 * for UI components to communicate with the backend regardless of
 * whether they're running in a Chrome extension or Tauri desktop app.
 *
 * Usage:
 *
 * 1. Entry point initializes the service:
 *    ```typescript
 *    // In extension entry:
 *    import { initializeMessaging, ChromeMessageService } from '@/core/messaging';
 *    await initializeMessaging(new ChromeMessageService());
 *
 *    // In desktop entry:
 *    import { initializeMessaging, TauriMessageService } from '@/core/messaging';
 *    await initializeMessaging(new TauriMessageService());
 *    ```
 *
 * 2. Components use the service:
 *    ```typescript
 *    import { messageService } from '@/core/messaging';
 *    import { get } from 'svelte/store';
 *
 *    const service = get(messageService);
 *    const response = await service.send(MessageType.PING);
 *    ```
 *
 * @module core/messaging
 */

import { writable, type Readable } from 'svelte/store';
import type { IMessageService, ConnectionState } from './types';

// Re-export types and implementations
export type { IMessageService, MessageHandler, Unsubscribe, ConnectionState, MessageServiceConfig } from './types';
export { ChromeMessageService } from './ChromeMessageService';
export { TauriMessageService } from './TauriMessageService';

/**
 * Global message service store
 *
 * Holds the platform-specific message service instance.
 * Components subscribe to this store to access messaging functionality.
 */
const messageServiceStore = writable<IMessageService | null>(null);

/**
 * Connection state store
 *
 * Reactive store for the current connection state.
 * Components can use this to show connection status UI.
 */
const connectionStateStore = writable<ConnectionState>('disconnected');

/**
 * Read-only message service store for components
 */
export const messageService: Readable<IMessageService | null> = {
  subscribe: messageServiceStore.subscribe,
};

/**
 * Read-only connection state store for components
 */
export const connectionState: Readable<ConnectionState> = {
  subscribe: connectionStateStore.subscribe,
};

/**
 * Get the current message service instance synchronously
 *
 * @throws Error if service not initialized
 */
export function getMessageService(): IMessageService {
  let service: IMessageService | null = null;
  messageServiceStore.subscribe((s) => {
    service = s;
  })();

  if (!service) {
    throw new Error('Message service not initialized. Call initializeMessaging() first.');
  }

  return service;
}

/**
 * Try to get the message service, returns null if not initialized
 */
export function tryGetMessageService(): IMessageService | null {
  let service: IMessageService | null = null;
  messageServiceStore.subscribe((s) => {
    service = s;
  })();
  return service;
}

/**
 * Initialize the messaging system with a platform-specific service
 *
 * This should be called by the entry point (extension or desktop)
 * before mounting the app.
 *
 * @param service - Platform-specific message service instance
 */
export async function initializeMessaging(service: IMessageService): Promise<void> {
  console.log('[Messaging] Initializing messaging service...');

  // Update connection state during initialization
  connectionStateStore.set('connecting');

  try {
    // Initialize the service
    await service.initialize();

    // Store the service
    messageServiceStore.set(service);

    // Update connection state
    connectionStateStore.set(service.getConnectionState());

    console.log('[Messaging] Messaging service initialized');
  } catch (error) {
    console.error('[Messaging] Failed to initialize messaging service:', error);
    connectionStateStore.set('error');
    throw error;
  }
}

/**
 * Destroy the messaging system
 *
 * Cleans up resources when the app is unmounted.
 */
export async function destroyMessaging(): Promise<void> {
  const service = tryGetMessageService();

  if (service) {
    await service.destroy();
    messageServiceStore.set(null);
    connectionStateStore.set('disconnected');
  }
}

/**
 * Check if messaging is initialized
 */
export function isMessagingInitialized(): boolean {
  let initialized = false;
  messageServiceStore.subscribe((s) => {
    initialized = s !== null;
  })();
  return initialized;
}
