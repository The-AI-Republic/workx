/**
 * Runtime access to the app version.
 *
 * The canonical version lives in package.json; Vite injects it at build time as
 * the bare `__APP_VERSION__` constant (see vite.version.mjs). The fallback keeps
 * non-bundled contexts — ts-node dev server, vitest runs without the define —
 * from crashing on an undefined global.
 *
 * @module config/version
 */
export const APP_VERSION: string =
  typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.0.0-dev';
