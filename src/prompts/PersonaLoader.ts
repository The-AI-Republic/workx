/// <reference types="vite/client" />
/**
 * Persona / output-style loader (Track 24.2).
 *
 * A persona is a `.md` file: optional YAML-ish frontmatter carrying scalar
 * `name` / `description` / `keepCodingInstructions`, and the markdown BODY
 * (everything after the closing `---`) is the persona prompt. Because the body
 * is the prompt, no multi-line/quoted YAML ever needs parsing — a tiny
 * hand-rolled reader is enough and avoids a YAML dependency (decision D1).
 *
 * Built-in personas are bundled from `./styles/*.md` via Vite `import.meta.glob`
 * (safe on every target incl. the Vite-SSR server build — decision D3).
 *
 * Filesystem-backed personas (project/user `.browserx/styles` dirs) are
 * provided by Node-only callers via `registerExternalPersonas` so this module
 * stays pure and never imports `node:fs` (which would break the extension
 * bundle and the sync compose path). Resolution precedence:
 *   external (project > user)  >  built-in
 *
 * Selection (which persona name is active) is per-platform and lives in
 * config, not here: ext/desktop via `IUserPreferences.personaName`, server via
 * `config.json` `server.persona`.
 *
 * @module prompts/PersonaLoader
 */

export interface Persona {
  name: string;
  description: string;
  keepCodingInstructions: boolean;
  prompt: string;
}

export interface ResolvedPersona {
  prompt: string;
  keepCodingInstructions: boolean;
}

const FRONT_KEYS = new Set(['name', 'description', 'keepcodinginstructions']);

function stripQuotes(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.endsWith('"')) || (t[0] === "'" && t.endsWith("'")))) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Parse a persona `.md`. Fail-soft: anything malformed degrades to "no
 * frontmatter, whole file is the body" — never throws.
 *
 * `keepCodingInstructions` defaults to `true` when absent, so a persona is a
 * purely additive prompt section unless it explicitly opts out.
 */
export function parsePersona(raw: string, fallbackName = ''): Persona {
  const defaults: Persona = {
    name: fallbackName,
    description: '',
    keepCodingInstructions: true,
    prompt: '',
  };
  if (typeof raw !== 'string') return defaults;

  const startsWithFence = /^---\r?\n/.test(raw);
  if (!startsWithFence) {
    return { ...defaults, prompt: raw.replace(/^\r?\n/, '') };
  }

  // Find the closing fence: a line that is exactly `---`.
  const lines = raw.split(/\r?\n/);
  let closeIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---') {
      closeIdx = i;
      break;
    }
  }
  if (closeIdx === -1) {
    // Unterminated frontmatter — treat the whole thing as body (fail-soft).
    return { ...defaults, prompt: raw };
  }

  const front = lines.slice(1, closeIdx);
  const body = lines.slice(closeIdx + 1).join('\n').replace(/^\r?\n/, '');

  const result: Persona = { ...defaults, prompt: body };
  for (const line of front) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const m = /^([A-Za-z_]+)\s*:\s*(.*)$/.exec(trimmed);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (!FRONT_KEYS.has(key)) continue;
    const value = stripQuotes(m[2]);
    if (key === 'name') result.name = value;
    else if (key === 'description') result.description = value;
    else if (key === 'keepcodinginstructions') {
      result.keepCodingInstructions = value.trim().toLowerCase() === 'true';
    }
  }
  if (!result.name) result.name = fallbackName;
  return result;
}

// ── Built-in personas (bundled) ──────────────────────────────────────────
const builtinRaw = import.meta.glob('./styles/*.md', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>;

function normalizeName(name: string): string {
  return name.toLowerCase().trim();
}

const builtins = new Map<string, Persona>();
for (const [path, raw] of Object.entries(builtinRaw)) {
  const fileName = path.split('/').pop()?.replace(/\.md$/, '') ?? '';
  const p = parsePersona(raw, fileName);
  if (p.name) builtins.set(normalizeName(p.name), p);
}

// ── External (filesystem) personas — registered by Node-only callers ─────
const external = new Map<string, Persona>();

/**
 * Register filesystem-backed personas. Caller supplies them in precedence
 * order with the LOWEST precedence first (user dir), then higher (project
 * dir) — later entries overwrite earlier, and all of them overlay built-ins.
 * Idempotent per name. No-op on the extension (it never calls this).
 */
export function registerExternalPersonas(personas: Persona[]): void {
  for (const p of personas) {
    if (p.name) external.set(normalizeName(p.name), p);
  }
}

/** Test/util: clear registered external personas. */
export function clearExternalPersonas(): void {
  external.clear();
}

/**
 * Resolve the active persona by name. Unknown / empty → `null`, so the prompt
 * is composed unchanged (safe no-op).
 */
export function resolvePersona(name?: string | null): ResolvedPersona | null {
  if (!name || typeof name !== 'string') return null;
  const key = normalizeName(name);
  const found = external.get(key) ?? builtins.get(key);
  if (!found) return null;
  return { prompt: found.prompt, keepCodingInstructions: found.keepCodingInstructions };
}

/** List available persona names (external overlaid on built-in). */
export function listPersonaNames(): string[] {
  return Array.from(new Set([...builtins.keys(), ...external.keys()])).sort();
}
