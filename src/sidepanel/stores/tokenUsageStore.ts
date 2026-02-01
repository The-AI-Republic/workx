/**
 * Token Usage Display Store for Side Panel UI
 *
 * Manages whether token usage information is shown in task events.
 * Persists preference to AgentConfig.
 */

import { writable, type Writable } from 'svelte/store';

// Default to hidden (false) - token info can be "scary" to users
const DEFAULT_SHOW_TOKEN_USAGE = false;

// Create the token usage visibility store
function createTokenUsageStore() {
  const { subscribe, set }: Writable<boolean> = writable(DEFAULT_SHOW_TOKEN_USAGE);

  return {
    subscribe,

    /**
     * Set whether to show token usage
     */
    setShowTokenUsage: (show: boolean) => {
      set(show);
    },

    /**
     * Initialize from config
     */
    initialize: (show: boolean | undefined) => {
      set(show ?? DEFAULT_SHOW_TOKEN_USAGE);
    },
  };
}

export const showTokenUsage = createTokenUsageStore();
