/**
 * stdout protocol guard.
 *
 * fd 1 (stdout) carries the length-prefixed runtime frame protocol and MUST
 * contain nothing else. The shared agent/bootstrap code logs heavily via
 * `console.log/info/debug`, which Node routes to stdout by default and which
 * would corrupt the frame stream. Redirect those to stderr (where `console.warn`
 * / `console.error` already go) so diagnostics never touch fd 1.
 *
 * This module is intentionally side-effecting and MUST be the first import in
 * the desktop-runtime entrypoint so the patch is applied before any other
 * module's top-level code can log.
 */

const toStderr = console.error.bind(console);

console.log = toStderr;
console.info = toStderr;
console.debug = toStderr;

export {};
