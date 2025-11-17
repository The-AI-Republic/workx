/**
 * ActiveConversationTracker
 *
 * Manages the "active" conversation ID in chrome.storage.local
 * This allows the service worker to resume the last active session
 * when it wakes up from sleep.
 */

const STORAGE_KEY = 'browserx_active_conversation_id';

export class ActiveConversationTracker {
  /**
   * Set the active conversation ID
   */
  static async setActiveConversation(conversationId: string): Promise<void> {
    try {
      await chrome.storage.local.set({ [STORAGE_KEY]: conversationId });
      console.log('[ActiveConversationTracker] Set active conversation:', conversationId);
    } catch (error) {
      console.error('[ActiveConversationTracker] Failed to set active conversation:', error);
      throw error;
    }
  }

  /**
   * Get the active conversation ID
   * Returns null if no active conversation
   */
  static async getActiveConversation(): Promise<string | null> {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEY);
      const conversationId = result[STORAGE_KEY] || null;
      console.log('[ActiveConversationTracker] Got active conversation:', conversationId);
      return conversationId;
    } catch (error) {
      console.error('[ActiveConversationTracker] Failed to get active conversation:', error);
      return null;
    }
  }

  /**
   * Clear the active conversation ID
   * Called when session is explicitly reset or closed
   */
  static async clearActiveConversation(): Promise<void> {
    try {
      await chrome.storage.local.remove(STORAGE_KEY);
      console.log('[ActiveConversationTracker] Cleared active conversation');
    } catch (error) {
      console.error('[ActiveConversationTracker] Failed to clear active conversation:', error);
    }
  }

  /**
   * Check if there's an active conversation
   */
  static async hasActiveConversation(): Promise<boolean> {
    const conversationId = await this.getActiveConversation();
    return conversationId !== null;
  }
}
