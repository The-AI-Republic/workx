/**
 * Conversation listing with cursor-based pagination.
 * Delegates to the storage provider via RolloutRecorder singleton.
 */

import type { ConversationsPage, Cursor } from './types';
import { isValidUUID } from './helpers';
import { RolloutRecorder } from './RolloutRecorder';

/**
 * List conversations with cursor-based pagination.
 * @param pageSize - Number of items to return (1-100)
 * @param cursor - Optional cursor for pagination
 * @returns Promise resolving to ConversationsPage
 */
export async function listConversations(
  pageSize: number,
  cursor?: Cursor
): Promise<ConversationsPage> {
  // Validate page size (throws before try-catch so tests can catch it)
  if (pageSize < 1 || pageSize > 100) {
    throw new Error('Invalid page size: must be between 1 and 100');
  }

  // Validate cursor if provided
  if (cursor) {
    if (isNaN(cursor.timestamp) || !isValidUUID(cursor.id)) {
      throw new Error('Invalid cursor: timestamp or ID is malformed');
    }
  }

  try {
    const provider = await RolloutRecorder.getProvider();
    return await provider.listConversations(pageSize, cursor);
  } catch (err) {
    console.error('[listConversations] Error:', err);
    return { items: [], nextCursor: undefined, numScanned: 0, reachedCap: false };
  }
}
