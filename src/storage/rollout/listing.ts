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
  // Validate page size
  if (pageSize < 1 || pageSize > 100) {
    throw new Error('Invalid page size: must be between 1 and 100');
  }

  // Validate cursor if provided
  if (cursor) {
    if (isNaN(cursor.timestamp) || !isValidUUID(cursor.id)) {
      throw new Error('Invalid cursor: timestamp or ID is malformed');
    }
  }

  const provider = await RolloutRecorder.getProvider();
  return await provider.listConversations(pageSize, cursor);
}
