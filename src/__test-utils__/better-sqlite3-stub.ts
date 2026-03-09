/**
 * Stub for better-sqlite3 in the Vitest test environment.
 *
 * better-sqlite3 is a native Node.js addon used only in server mode.
 * It's not installed as an npm dependency (server deploys install it separately).
 * This stub allows Vite's import analysis to resolve the module during tests,
 * while vi.mock('better-sqlite3', ...) in test files overrides the actual behavior.
 */

function Database() {
  throw new Error('better-sqlite3 stub — use vi.mock() in your test file');
}

export default Database;
