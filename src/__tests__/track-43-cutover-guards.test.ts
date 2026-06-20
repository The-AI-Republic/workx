/**
 * Track 43 cutover guards — static checks that the WebView layer never
 * reaches back into the deleted in-WebView agent path.
 *
 * Anything matched here is forbidden post-cutover; the regex hits fail the
 * suite so a future refactor can't quietly reintroduce a leak. Keep the
 * forbidden list narrowly-scoped: only paths a contributor _could_
 * accidentally re-add (the deleted files themselves cannot be imported).
 */

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Walk `root` recursively, returning absolute paths of files matching `predicate`. */
function walk(root: string, predicate: (path: string) => boolean): string[] {
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full);
        continue;
      }
      if (predicate(full)) out.push(full);
    }
  };
  if (statSync(root).isDirectory()) visit(root);
  return out;
}

function repoRoot(): string {
  // This file lives at src/__tests__/; the repo root is two up.
  return join(__dirname, '..', '..');
}

function sourceFiles(under: string, ext: RegExp = /\.(ts|svelte|mts|js|mjs)$/): string[] {
  return walk(join(repoRoot(), under), (p) => ext.test(p));
}

interface ForbiddenRule {
  name: string;
  /** Regex applied to the file's text. */
  pattern: RegExp;
  /**
   * Paths under repo root that must not match. Using a broad `src/` here
   * (instead of a per-subtree allowlist) means a new directory like
   * `src/desktop/v2/` or `src/cli/` is covered automatically — the
   * directories that legitimately need the forbidden identifiers are
   * surfaced via the `allow` field below.
   */
  scopes: string[];
  /** Optional allowlist of relative paths (e.g. doc-only references). */
  allow?: string[];
}

/**
 * Default broad scope. Allowlist-the-runtime-itself for rules that target
 * "everywhere except the runtime sidecar's own implementation files".
 */
const ALL_SRC = ['src'];

/** Runtime-internal files that are allowed to mention what they implement. */
const RUNTIME_INTERNAL = [
  'src/desktop-runtime/',
  'src/server/',
  'src/__tests__/track-43-cutover-guards.test.ts',
];

const RULES: ForbiddenRule[] = [
  {
    name: 'Nothing in src/ may import the deleted DesktopAgentBootstrap',
    pattern: /['"]@\/desktop\/agent\/DesktopAgentBootstrap['"]|from\s+['"]\.\.?\/agent\/DesktopAgentBootstrap['"]/,
    scopes: ALL_SRC,
  },
  {
    name: 'Nothing in src/ may import @/desktop/auth/* (deleted — runtime owns auth)',
    pattern: /['"]@\/desktop\/auth(\/|['"])/,
    scopes: ALL_SRC,
  },
  {
    name: 'KeytarCredentialStore must not be referenced from anywhere',
    pattern: /KeytarCredentialStore/,
    scopes: ALL_SRC,
    allow: [
      // Doc comments describing what was deleted — not a live reference.
      // Naming the deleted class in prose is helpful for future readers.
      'src/core/storage/CredentialStore.ts',
    ],
  },
  {
    name: 'The deleted TauriChannel/TauriTransport must not be referenced',
    // RuntimeRelayTauriTransport is the *replacement* transport. The forbidden
    // identifier is `TauriTransport` standalone (anchored with a word boundary
    // before it that is NOT `Relay`). `(?<!Relay)` is a negative lookbehind
    // that lets RuntimeRelayTauriTransport through while still flagging a
    // bare `TauriTransport` regression.
    pattern: /['"]@\/desktop\/channels\/TauriChannel['"]|(?<!Relay)TauriTransport\b/,
    scopes: ALL_SRC,
    allow: [
      'src/core/messaging/transports/RuntimeRelayTauriTransport.ts',
      'src/core/messaging/transports/index.ts',
      'src/core/messaging/index.ts',
    ],
  },
  {
    // Static `from '@/desktop-runtime/storage/...'` imports — only meant
    // for dynamic-import call sites in core/storage and storage/rollout,
    // which use `await import(...)` and therefore don't match this regex.
    name: 'Desktop runtime SQLite providers must not be statically imported by `@/desktop-runtime/storage` path',
    pattern: /from\s+['"]@\/desktop-runtime\/storage\/DesktopRuntime(Storage|SQLite|Rollout)Provider['"]/,
    scopes: ALL_SRC,
  },
  {
    name: 'RustMCPBridge must not be referenced anywhere (deleted; NodeMCPBridge replaces it)',
    pattern: /RustMCPBridge/,
    scopes: ALL_SRC,
    allow: [
      // Doc comments referencing the deleted class — kept for context.
      'src/core/mcp/MCPManager.ts',
      'src/server/mcp/NodeMCPBridge.ts',
    ],
  },
  {
    name: 'No call site may invoke the deleted Rust commands',
    pattern: /invoke\s*<[^>]*>?\s*\(\s*['"](?:fs_stat|fs_read_file|fs_apply_edit|fs_write_if_unchanged|skills_ensure_dir|skills_list_dirs|skills_read_file|skills_write_file|skills_remove_dir|plugins_ensure_dir|plugins_list_entries|plugins_read_file|plugins_write_file|plugins_remove_dir|plugins_rename|plugins_path_exists|mcp_connect|mcp_list_tools|mcp_call_tool|mcp_list_resources|mcp_read_resource|mcp_disconnect|get_browser_mcp_sidecar_path|start_oauth_callback_server|find_running_browsers|launch_chrome|get_chrome_ws_endpoint|kill_process|file_exists|get_home_dir|is_port_available|storage_init|storage_get|storage_set|rollout_db_init)['"]/,
    scopes: ALL_SRC,
  },
];

describe('Track 43 cutover guards (static)', () => {
  for (const rule of RULES) {
    it(rule.name, () => {
      const offenders: string[] = [];
      for (const scope of rule.scopes) {
        for (const file of sourceFiles(scope)) {
          const rel = relative(repoRoot(), file);
          if (rule.allow?.includes(rel)) continue;
          // Skip test files themselves so their forbidden patterns in
          // string literals (this file!) do not trip the guard.
          if (/__tests__|\.test\.|\.spec\./.test(rel)) continue;
          const text = readFileSync(file, 'utf-8');
          if (rule.pattern.test(text)) offenders.push(rel);
        }
      }
      expect(offenders, `Forbidden pattern leaked into:\n  ${offenders.join('\n  ')}`).toEqual([]);
    });
  }
});
