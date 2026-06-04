/**
 * Vite Environment Variables Type Definitions
 *
 * This file provides TypeScript type definitions for Vite's environment variables.
 * Without it, TypeScript doesn't know what properties exist on `import.meta.env`.
 *
 * Example usage in code:
 *   const domain = import.meta.env.VITE_AUTH_COOKIE_DOMAIN; // TypeScript knows this is a string
 *
 * To add new environment variables:
 *   1. Add the variable to .env and .env.example (prefixed with VITE_)
 *   2. Add the type definition to ImportMetaEnv interface below
 */

/// <reference types="vite/client" />

/**
 * Declares custom environment variables available via import.meta.env
 * All VITE_* prefixed variables from .env files should be declared here
 */
interface ImportMetaEnv {
  /** Hosted auth base URL (e.g., 'https://auth.example.com') */
  readonly VITE_AUTH_BASE_URL: string;
  /** Cookie domain for reading auth cookies (e.g., '.example.com') */
  readonly VITE_AUTH_COOKIE_DOMAIN: string;
  /** Legacy hosted auth base URL alias */
  readonly VITE_HOME_PAGE_BASE_URL: string;
  /** Legacy auth cookie domain alias */
  readonly VITE_COOKIE_DOMAIN: string;
  readonly VITE_AUTH_ACCESS_COOKIE_NAME: string;
  readonly VITE_AUTH_REFRESH_COOKIE_NAME: string;
  readonly VITE_AUTH_CSRF_COOKIE_NAME: string;
  readonly VITE_AUTH_STATUS_COOKIE_NAME: string;
  readonly VITE_AUTH_USER_NAME_COOKIE_NAME: string;
  readonly VITE_AUTH_USER_EMAIL_COOKIE_NAME: string;
  readonly VITE_AUTH_LOGIN_PATH: string;
  readonly VITE_AUTH_DESKTOP_SESSION_PATH: string;
  readonly VITE_AUTH_DESKTOP_REFRESH_PATH: string;
  readonly VITE_AUTH_PROFILE_PATH: string;
  readonly VITE_AUTH_USER_CENTER_PATH: string;
  readonly VITE_AUTH_PRICING_PATH: string;
  /** API base URL for fetching user profile */
  readonly VITE_API_BASE_URL: string;
  /** Vault secret for wrapping the encryption key (32+ characters, from .env) */
  readonly VITE_VAULT_SECRET: string;
}

/**
 * Extends the global ImportMeta interface to include typed env
 */
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
