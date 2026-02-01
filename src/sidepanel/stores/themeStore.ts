/**
 * Theme Store for Side Panel UI
 *
 * Manages UI theme state (terminal vs chatgpt) using Svelte store.
 * Persists theme preference to AgentConfig.
 */

import { writable, type Writable } from 'svelte/store';

export type UITheme = 'terminal' | 'chatgpt';

// Default to chatgpt theme (Modern Chat style)
const DEFAULT_THEME: UITheme = 'chatgpt';

// Create the theme store
function createThemeStore() {
  const { subscribe, set, update }: Writable<UITheme> = writable(DEFAULT_THEME);

  return {
    subscribe,

    /**
     * Set the UI theme
     */
    setTheme: (theme: UITheme) => {
      set(theme);
    },

    /**
     * Initialize theme from config
     */
    initialize: (theme: UITheme | undefined) => {
      set(theme || DEFAULT_THEME);
    },

    /**
     * Toggle between terminal and chatgpt themes
     */
    toggle: () => {
      update((current) => (current === 'terminal' ? 'chatgpt' : 'terminal'));
    },
  };
}

export const uiTheme = createThemeStore();
