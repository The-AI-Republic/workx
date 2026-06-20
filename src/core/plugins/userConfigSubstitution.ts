/**
 * User Config Substitution — three functions with three different semantics.
 *
 * Mirrors claudy's `pluginOptionsStorage.ts:326-400`. Adapted to WorkX
 * with the same regex patterns and the same literal placeholder string
 * (verbatim — plugins authored for claudy expect that fingerprint).
 *
 * Reference: design.md § User Config Substitution.
 *
 * Per-slot firing pattern:
 *   - Skill / agent / command BODY → substitutePluginVariables, then
 *     substituteUserConfigInContent (sensitive → placeholder)
 *   - MCP env / command / args, hook command string → substitutePluginVariables,
 *     then substituteUserConfigVariables (strict — throws on missing key)
 *   - Hook execution env vars → CLAUDE_PLUGIN_OPTION_<KEY> injection (see
 *     `buildPluginOptionEnvVars` below)
 *
 * All substitution is SINGLE-PASS, non-recursive. A substituted value
 * containing `${...}` is not re-scanned. This is intentional — schema-
 * driven sensitivity differentiation would be fragile under recursion.
 */

import type { LoadedPlugin, PluginUserConfigOption } from './types';

// ── Regexes (identical to claudy) ──────────────────────────────────

const ROOT_RE = /\$\{CLAUDE_PLUGIN_ROOT\}/g;
const DATA_RE = /\$\{CLAUDE_PLUGIN_DATA\}/g;
const USER_CONFIG_RE = /\$\{user_config\.([^}]+)\}/g;

// ── (1) Plugin vars (root + data) ──────────────────────────────────

/**
 * Substitute `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_DATA}` in a
 * string. Always available; no sensitivity concerns.
 *
 * Windows-normalizes backslashes to forward slashes in the substituted
 * paths (avoids escape-sequence issues in JSON-embedded strings).
 *
 * Uses the function-form `.replace((match, key) => value)` so paths
 * containing `$$`, `$'`, `$\``, `$&` don't get reinterpreted as
 * replacement patterns.
 */
export function substitutePluginVariables(
  value: string,
  plugin: { path: string; dataPath?: string },
): string {
  let result = value.replace(ROOT_RE, () => normalizePath(plugin.path));
  if (plugin.dataPath !== undefined) {
    result = result.replace(DATA_RE, () => normalizePath(plugin.dataPath!));
  }
  return result;
}

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/');
}

// ── (2) User config — strict (throws on missing key) ───────────────

/**
 * Substitute `${user_config.KEY}` references with the actual configured
 * value. Throws on missing keys — used for targets where a missing value
 * is a plugin authoring bug, not a runtime fallback.
 *
 * Sensitive values DO substitute here — these targets flow to stdio/stdin
 * (MCP env, hook commands), which is the same trust boundary as reading
 * the credential store directly.
 *
 * Use sites: MCP server `env`/`command`/`args`, hook `command` strings.
 */
export function substituteUserConfigVariables(
  value: string,
  userConfig: Record<string, unknown>,
): string {
  return value.replace(USER_CONFIG_RE, (_match, key: string) => {
    if (!(key in userConfig)) {
      throw new Error(
        `Missing user_config value for "${key}". Plugin author should declare this key in manifest.userConfig.`,
      );
    }
    const v = userConfig[key];
    return v == null ? '' : String(v);
  });
}

// ── (3) User config — content-safe (placeholder for sensitive) ─────

/**
 * The literal placeholder string emitted in skill/agent/command body
 * content when a sensitive value would otherwise have been substituted.
 *
 * **Verbatim from claudy** — plugins authored for claudy and ported to
 * WorkX will display the same fingerprint. Do not localize or rewrite.
 */
export function sensitiveContentPlaceholder(key: string): string {
  return `[sensitive option '${key}' not available in skill content]`;
}

/**
 * Substitute `${user_config.KEY}` in content (skill body / agent body /
 * command body). Soft semantics:
 *   - Sensitive keys (per schema) → literal placeholder string.
 *   - Unknown keys (not in `userConfig` AND not in `schema`) → leave the
 *     `${user_config.KEY}` literal intact (matches env-var semantics for
 *     unset vars).
 *   - Known non-sensitive keys with values → substituted.
 */
export function substituteUserConfigInContent(
  content: string,
  userConfig: Record<string, unknown>,
  schema: Record<string, PluginUserConfigOption> | undefined,
): string {
  return content.replace(USER_CONFIG_RE, (match, key: string) => {
    const decl = schema?.[key];
    if (decl?.sensitive) {
      return sensitiveContentPlaceholder(key);
    }
    if (!(key in userConfig)) {
      // Unknown key — leave the literal intact
      return match;
    }
    const v = userConfig[key];
    return v == null ? '' : String(v);
  });
}

// ── CLAUDE_PLUGIN_OPTION_<KEY> env injection (hooks only) ──────────

/**
 * Generate the `CLAUDE_PLUGIN_OPTION_<KEY>` env var map for invoking a
 * hook command. Sensitive values **are included** — hooks run user-
 * controlled scripts, same trust boundary as reading the credential
 * store directly (claudy `utils/hooks.ts:895-906`).
 *
 * Key sanitization: non-identifier characters → `_`, uppercased.
 * The schema-side regex `/^[A-Za-z_]\w*$/` on userConfig keys makes
 * the sanitization belt-and-suspenders for well-formed manifests.
 */
export function buildPluginOptionEnvVars(
  userConfig: Record<string, unknown>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(userConfig)) {
    const envKey = key.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase();
    out[`CLAUDE_PLUGIN_OPTION_${envKey}`] = value == null ? '' : String(value);
  }
  return out;
}

// ── Convenience: combined per-slot helpers ─────────────────────────

/**
 * Body content (skill / agent / command). Runs plugin-vars first, then
 * content-safe user-config substitution.
 */
export function substituteContent(
  content: string,
  plugin: LoadedPlugin & { dataPath?: string },
  userConfig: Record<string, unknown>,
): string {
  const afterPluginVars = substitutePluginVariables(content, plugin);
  return substituteUserConfigInContent(
    afterPluginVars,
    userConfig,
    plugin.manifest.userConfig,
  );
}

/**
 * MCP env / command / args. Runs plugin-vars first, then strict
 * user-config substitution (throws on missing keys).
 */
export function substituteRuntime(
  value: string,
  plugin: LoadedPlugin & { dataPath?: string },
  userConfig: Record<string, unknown>,
): string {
  const afterPluginVars = substitutePluginVariables(value, plugin);
  return substituteUserConfigVariables(afterPluginVars, userConfig);
}
