/**
 * Vite Environment Variables Type Definitions
 *
 * This file provides TypeScript type definitions for Vite's environment variables.
 * Without it, TypeScript doesn't know what properties exist on `import.meta.env`.
 *
 * Example usage in code:
 *   const domain = import.meta.env.VITE_COOKIE_DOMAIN; // TypeScript knows this is a string
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
  /** Cookie domain for reading auth cookies (e.g., '.airepublic.com') */
  readonly VITE_COOKIE_DOMAIN: string;
  /** Login page URL to redirect unauthenticated users */
  readonly VITE_LOGIN_PAGE: string;
  /** API base URL for fetching user profile */
  readonly VITE_API_BASE_URL: string;
}

/**
 * Extends the global ImportMeta interface to include typed env
 */
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
