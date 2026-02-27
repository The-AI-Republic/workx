/**
 * Theme Store for Side Panel UI
 *
 * Manages UI theme state using Svelte stores.
 * Supports 4 theme preferences:
 *   - terminal: Fixed green-on-black terminal look
 *   - modern-auto: Modern Chat, follows OS light/dark preference
 *   - modern-light: Modern Chat, always light
 *   - modern-dark: Modern Chat, always dark
 *
 * Controls the `.dark` class on <html> for Tailwind dark: variant.
 */

import { writable, derived } from 'svelte/store';

export type ThemePreference = 'terminal' | 'modern-auto' | 'modern-light' | 'modern-dark';
export type UITheme = 'terminal' | 'modern';

const DEFAULT_PREFERENCE: ThemePreference = 'modern-auto';

// Internal writable store for the user's 4-way selection
const _preference = writable<ThemePreference>(DEFAULT_PREFERENCE);

// Derived store: collapses all modern-* variants into 'modern'
export const uiTheme = derived(_preference, ($pref) =>
  ($pref === 'terminal' ? 'terminal' : 'modern') as UITheme
);

// Media query for system dark preference
let mediaQuery: MediaQueryList | null = null;
let mediaListener: ((e: MediaQueryListEvent) => void) | null = null;

/**
 * Apply the `.dark` class on <html> based on the current preference.
 */
function applyDarkClass(pref: ThemePreference) {
  if (typeof document === 'undefined') return;

  const html = document.documentElement;

  switch (pref) {
    case 'terminal':
    case 'modern-light':
      html.classList.remove('dark');
      break;
    case 'modern-dark':
      html.classList.add('dark');
      break;
    case 'modern-auto':
      if (mediaQuery?.matches) {
        html.classList.add('dark');
      } else {
        html.classList.remove('dark');
      }
      break;
  }
}

/**
 * Set up or tear down the matchMedia listener for modern-auto mode.
 */
function updateMediaListener(pref: ThemePreference) {
  if (typeof window === 'undefined') return;

  // Clean up existing listener
  if (mediaListener && mediaQuery) {
    mediaQuery.removeEventListener('change', mediaListener);
    mediaListener = null;
  }

  if (pref === 'modern-auto' && typeof window.matchMedia === 'function') {
    mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    mediaListener = () => applyDarkClass(pref);
    mediaQuery.addEventListener('change', mediaListener);
  }
}

// Subscribe to preference changes to apply side effects
_preference.subscribe((pref) => {
  updateMediaListener(pref);
  applyDarkClass(pref);
});

/**
 * Normalize legacy stored values.
 * 'chatgpt' and 'modern' (without suffix) both map to 'modern-auto'.
 */
function normalizePreference(value: string | undefined): ThemePreference {
  if (!value) return DEFAULT_PREFERENCE;
  if (value === 'chatgpt' || value === 'modern') return 'modern-auto';
  if (value === 'terminal' || value === 'modern-auto' || value === 'modern-light' || value === 'modern-dark') {
    return value as ThemePreference;
  }
  return DEFAULT_PREFERENCE;
}

/**
 * Public API — mirrors the previous store interface for compatibility.
 */
export const themePreference = {
  subscribe: _preference.subscribe,

  /**
   * Set the theme preference (accepts the new 4-way value).
   */
  setTheme: (pref: ThemePreference) => {
    _preference.set(pref);
  },

  /**
   * Initialize from stored config value (handles legacy 'chatgpt' values).
   */
  initialize: (stored: string | undefined) => {
    _preference.set(normalizePreference(stored));
  },
};
