/**
 * Main i18n translation utility with user-selectable language support
 *
 * Usage:
 *   import { _t, setLocale } from './lib/i18n';
 *   {$_t("Hello World")} -> reactive translation in Svelte templates
 *   t("Hello World") -> non-reactive translation for scripts
 *
 * The original English text is converted to a Chrome-compatible key using
 * the pre-generated key_map.json, then looked up in the locale messages.
 */

import { writable, derived, get } from 'svelte/store';
import type { TranslationOptions, MessagesFile } from './types';

// Import key_map.json at build time (text -> key mapping)
import keyMap from '../../../../../_locales/key_map.json';

// Import all locale messages at build time using Vite's glob import
const localeModules = import.meta.glob('../../../../../_locales/*/messages.json', { eager: true });

/**
 * Map of locale codes to their messages
 * Builds from glob import paths like '../../../../../_locales/zh_CN/messages.json'
 */
const localeMessages: Record<string, MessagesFile> = {};

// Parse glob imports and build locale map
for (const [path, module] of Object.entries(localeModules)) {
  // Extract locale code from path: '../../../../../_locales/zh_CN/messages.json' -> 'zh_CN'
  const match = path.match(/_locales\/([^/]+)\/messages\.json$/);
  if (match) {
    const localeDir = match[1]; // e.g., 'zh_CN', 'en', 'de_DE'
    const messages = (module as { default?: MessagesFile }).default || module as MessagesFile;

    // Add with underscore format (directory name)
    localeMessages[localeDir] = messages;

    // Also add with hyphen format for BCP 47 compatibility
    const hyphenated = localeDir.replace('_', '-');
    if (hyphenated !== localeDir) {
      localeMessages[hyphenated] = messages;
    }

    // Special handling for 'en' -> 'en-US'
    if (localeDir === 'en') {
      localeMessages['en-US'] = messages;
    }
  }
}

/**
 * Convert original text to Chrome-compatible i18n key
 * Uses the pre-generated key_map.json for lookup
 *
 * @param text - Original English text
 * @returns Chrome-compatible key, or null if not found
 */
export function textToKey(text: string): string | null {
  if (!text) return null;
  return (keyMap as Record<string, string>)[text] || null;
}

/**
 * Current locale store - reactive for Svelte components
 */
export const currentLocale = writable<string>('en-US');

/**
 * Reactive translation function store
 * Usage in components: {$_t("Hello World")}
 *
 * This is a derived store that returns a translation function.
 * When currentLocale changes, the store updates and triggers re-renders.
 */
export const _t = derived(currentLocale, ($locale) => {
  return (text: string, options?: TranslationOptions): string => {
    if (!text) return '';

    const fallback = options?.fallback ?? text;

    try {
      // Convert text to Chrome-compatible key
      const key = textToKey(text);
      if (!key) {
        console.warn(`[i18n] No key mapping found for: "${text.substring(0, 50)}..."`);
        return fallback;
      }

      const messages = getMessages($locale);
      const messageEntry = messages[key];

      if (!messageEntry || !messageEntry.message || messageEntry.message === '') {
        return fallback;
      }

      let message = messageEntry.message;

      // Handle substitutions
      if (options?.substitutions) {
        const subs = Array.isArray(options.substitutions)
          ? options.substitutions
          : [options.substitutions];

        subs.forEach((sub, index) => {
          message = message.replace(new RegExp(`\\$${index + 1}\\$`, 'g'), String(sub));

          if (messageEntry.placeholders) {
            Object.entries(messageEntry.placeholders).forEach(([name, placeholder]) => {
              if (placeholder.content === `$${index + 1}`) {
                message = message.replace(new RegExp(`\\$${name.toUpperCase()}\\$`, 'g'), String(sub));
              }
            });
          }
        });
      }

      return message;
    } catch (error) {
      console.warn(`[i18n] Error translating "${text}":`, error);
      return fallback;
    }
  };
});

/**
 * Set the current locale
 * @param locale - Locale code (e.g., 'en-US', 'zh-CN')
 */
export function setLocale(locale: string): void {
  const normalizedLocale = normalizeLocale(locale);
  currentLocale.set(normalizedLocale);
}

/**
 * Get the current locale value (non-reactive)
 */
export function getLocale(): string {
  return get(currentLocale);
}

/**
 * Normalize locale code to match our supported locales
 */
function normalizeLocale(locale: string): string {
  if (!locale) return 'en-US';

  // Direct match
  if (localeMessages[locale]) {
    return locale;
  }

  // Try with hyphen instead of underscore
  const hyphenated = locale.replace('_', '-');
  if (localeMessages[hyphenated]) {
    return hyphenated;
  }

  // Try with underscore instead of hyphen
  const underscored = locale.replace('-', '_');
  if (localeMessages[underscored]) {
    return underscored;
  }

  // Try base language code (e.g., 'zh' -> 'zh-CN')
  const baseCode = locale.split(/[-_]/)[0];
  if (baseCode === 'zh') return 'zh-CN';
  if (baseCode === 'en') return 'en-US';

  // Default to English
  return 'en-US';
}

/**
 * Get messages for a specific locale
 */
function getMessages(locale: string): MessagesFile {
  const normalized = normalizeLocale(locale);
  return localeMessages[normalized] || localeMessages['en-US'] || localeMessages['en'] || {};
}

/**
 * Translate a text string using the current locale
 *
 * The original English text is converted to a Chrome-compatible key,
 * then looked up in the locale messages.
 *
 * @param text - Original English text
 * @param options - Translation options (substitutions, fallback)
 * @returns Translated text or fallback to original
 *
 * @example
 * t("Settings") // converts to key, looks up translation
 * t("Hello $NAME$", { substitutions: ["World"] })
 */
export function t(text: string, options?: TranslationOptions): string {
  if (!text) {
    return '';
  }

  const fallback = options?.fallback ?? text;

  try {
    // Convert text to Chrome-compatible key
    const key = textToKey(text);
    if (!key) {
      console.warn(`[i18n] No key mapping found for: "${text.substring(0, 50)}..."`);
      return fallback;
    }

    // Get messages for current locale
    const locale = get(currentLocale);
    const messages = getMessages(locale);

    // Look up the message using generated key
    const messageEntry = messages[key];

    // Fall back to English (original text) if:
    // - Entry doesn't exist
    // - Message is undefined/null
    // - Message is empty string (not yet translated)
    if (!messageEntry || !messageEntry.message || messageEntry.message === '') {
      return fallback;
    }

    let message = messageEntry.message;

    // Handle substitutions (Chrome i18n style: $1$, $2$, etc. or $NAME$)
    if (options?.substitutions) {
      const subs = Array.isArray(options.substitutions)
        ? options.substitutions
        : [options.substitutions];

      subs.forEach((sub, index) => {
        // Replace $1$, $2$, etc.
        message = message.replace(new RegExp(`\\$${index + 1}\\$`, 'g'), String(sub));

        // Also handle named placeholders if defined
        if (messageEntry.placeholders) {
          Object.entries(messageEntry.placeholders).forEach(([name, placeholder]) => {
            if (placeholder.content === `$${index + 1}`) {
              message = message.replace(new RegExp(`\\$${name.toUpperCase()}\\$`, 'g'), String(sub));
            }
          });
        }
      });
    }

    return message;
  } catch (error) {
    console.warn(`[i18n] Error translating "${text}":`, error);
    return fallback;
  }
}

/**
 * Get the browser's UI language (for initialization)
 */
export function getBrowserLocale(): string {
  // Try Chrome i18n API first
  if (typeof chrome !== 'undefined' && chrome.i18n?.getUILanguage) {
    try {
      return chrome.i18n.getUILanguage();
    } catch {
      // Fall through to navigator
    }
  }

  // Fall back to navigator.language
  if (typeof navigator !== 'undefined' && navigator.language) {
    return navigator.language;
  }

  return 'en-US';
}

/**
 * Get the current locale (for backward compatibility)
 * @deprecated Use getLocale() instead
 */
export function getCurrentLocale(): string {
  return getLocale();
}

/**
 * Initialize locale from user preferences or browser default
 * @param savedLocale - Locale saved in user preferences (if any)
 */
export function initLocale(savedLocale?: string): void {
  if (savedLocale) {
    setLocale(savedLocale);
  } else {
    setLocale(getBrowserLocale());
  }
}

// Re-export types
export type { ChromeMessage, MessagesFile, TranslationOptions } from './types';
