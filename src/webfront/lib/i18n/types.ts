/**
 * TypeScript interfaces for Chrome i18n API
 */

/**
 * Structure of a single message entry in messages.json
 */
export interface ChromeMessage {
  message: string;
  description?: string;
  placeholders?: Record<string, {
    content: string;
    example?: string;
  }>;
}

/**
 * Structure of the messages.json file
 */
export interface MessagesFile {
  [key: string]: ChromeMessage;
}

/**
 * Options for the t() translation function
 */
export interface TranslationOptions {
  /** Substitution values for placeholders */
  substitutions?: string | string[];
  /** Fallback text if translation is not found (defaults to original text) */
  fallback?: string;
}
