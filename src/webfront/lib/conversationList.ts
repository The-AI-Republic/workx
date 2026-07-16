/**
 * Platform-aware conversation listing for the chat-history UI.
 *
 * The extension side panel shares IndexedDB with the service worker, so it
 * can read rollout storage directly via RolloutRecorder. Every other webview
 * (desktop, web) has no local rollout storage — on desktop it is owned by
 * the runtime sidecar — so listing goes through the `session.listConversations`
 * service over the UI channel instead. Calling RolloutRecorder directly on
 * those platforms throws ("Desktop WebView rollout storage is owned by the
 * runtime sidecar"), which is exactly what the chat-history components must
 * not do.
 *
 * @module webfront/lib/conversationList
 */

import { RolloutRecorder, type ConversationsPage, type Cursor } from '@/storage/rollout';
import { getInitializedUIClient } from '@/core/messaging';
import { platform } from '../stores/platformStore';

/**
 * List persisted conversations with cursor-based pagination, using the
 * platform-appropriate data path.
 */
export async function listConversations(
  pageSize: number,
  cursor?: Cursor
): Promise<ConversationsPage> {
  if (platform.platformName === 'extension') {
    return RolloutRecorder.listConversations(pageSize, cursor);
  }
  const client = await getInitializedUIClient();
  return await client.serviceRequest<ConversationsPage>('session.listConversations', {
    pageSize,
    ...(cursor ? { cursor } : {}),
  });
}
