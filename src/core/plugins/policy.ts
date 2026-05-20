/**
 * Plugin policy — admin-owned governance, separate from user settings.
 *
 * Policy lives in a platform-specific location (NOT agentConfig — it's
 * admin-deployed, e.g. /etc/browserx/policy.json or chrome.storage.managed).
 * The reader is injected so this module stays platform-agnostic + testable.
 *
 * Reference: design.md § Hardening (policySettings, PluginPolicy,
 * marketplaceHelpers, MarketplaceGuards).
 */

import { z } from 'zod';
import type { PluginId } from './types';

// ── Schema ─────────────────────────────────────────────────────────

export const MarketplaceSourceMatcherSchema = z.union([
  z.object({ type: z.literal('github'), repo: z.string() }),
  z.object({ type: z.literal('host'), hostPattern: z.string() }),
  z.object({ type: z.literal('path'), pathPattern: z.string() }),
]);
export type MarketplaceSourceMatcher = z.infer<typeof MarketplaceSourceMatcherSchema>;

export const PolicySettingsSchema = z.object({
  /** id → false blocks; id → true force-enables (and locks). */
  enabledPlugins: z.record(z.string(), z.boolean()).optional(),
  /** null = no allowlist active; [] = deny-all; [...] = allow only these. */
  strictKnownMarketplaces: z.array(MarketplaceSourceMatcherSchema).nullable().optional(),
  /** Non-empty = active blocklist. */
  blockedMarketplaces: z.array(MarketplaceSourceMatcherSchema).optional(),
  /** Appended to the trust-warning banner. */
  pluginTrustMessage: z.string().optional(),
});
export type PolicySettings = z.infer<typeof PolicySettingsSchema>;

export function emptyPolicy(): PolicySettings {
  return {};
}

// ── Loader ─────────────────────────────────────────────────────────

export interface PolicyLoaderDeps {
  /** Read raw policy JSON (platform-specific path / managed storage). */
  readPolicyText: () => Promise<string | null>;
}

export class PolicyLoader {
  private cached: PolicySettings | null = null;

  constructor(private readonly deps: PolicyLoaderDeps) {}

  /** Load + cache. Falls back to empty policy on missing/corrupt. */
  async load(): Promise<PolicySettings> {
    if (this.cached) return this.cached;
    const raw = await this.deps.readPolicyText();
    if (raw == null) {
      this.cached = emptyPolicy();
      return this.cached;
    }
    try {
      const parsed = PolicySettingsSchema.safeParse(JSON.parse(raw));
      this.cached = parsed.success ? parsed.data : emptyPolicy();
      if (!parsed.success) {
        console.warn('[PolicyLoader] invalid policy.json; ignoring:', parsed.error.message);
      }
    } catch (e) {
      console.warn('[PolicyLoader] unparseable policy.json; ignoring:', e);
      this.cached = emptyPolicy();
    }
    return this.cached;
  }

  /** Force a re-read on next load() (e.g. chrome.storage.onChanged). */
  invalidate(): void {
    this.cached = null;
  }
}

// ── PluginPolicy (enforcement predicates) ──────────────────────────

export class PluginPolicy {
  constructor(private readonly loader: PolicyLoader) {}

  async isBlocked(id: PluginId): Promise<boolean> {
    const p = await this.loader.load();
    return p.enabledPlugins?.[id] === false;
  }

  async isForceEnabled(id: PluginId): Promise<boolean> {
    const p = await this.loader.load();
    return p.enabledPlugins?.[id] === true;
  }

  async getTrustMessage(): Promise<string | undefined> {
    return (await this.loader.load()).pluginTrustMessage;
  }
}

// ── Marketplace source allow/blocklist ─────────────────────────────

function hostOf(ref: string): string {
  try {
    // hostname (not host) so an embedded port can't dodge a host pattern.
    return new URL(ref).hostname;
  } catch {
    const m = ref.match(/@([^:/]+)[:/]/) || ref.match(/\/\/([^/]+)/);
    return m ? m[1] : ref;
  }
}

/**
 * Parse the canonical `owner/repo` from a GitHub ref, requiring the HOST
 * to be exactly github.com. Returns null otherwise. Substring/querystring
 * embedding (`https://evil.com/?x=github.com/o/r`) and adjacent-name
 * collisions (`o/r-evil` vs an allowlist of `o/r`) must NOT resolve — a
 * weak `ref.includes(...)` here is an allowlist bypass.
 */
function parseGithubRepo(ref: string): string | null {
  let host: string;
  let pathPart: string;
  try {
    const u = new URL(ref);
    host = u.hostname.toLowerCase();
    pathPart = u.pathname;
  } catch {
    const m = ref.match(/^[\w.-]+@([^:]+):(.+)$/); // scp: git@host:owner/repo
    if (!m) return null;
    host = m[1].toLowerCase();
    pathPart = `/${m[2]}`;
  }
  if (host !== 'github.com') return null;
  const cleaned = pathPart
    .replace(/^\/+/, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
  const parts = cleaned.split('/');
  if (parts.length < 2 || !parts[0] || !parts[1]) return null;
  return `${parts[0]}/${parts[1]}`;
}

function globToRe(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${esc}$`);
}

export function sourceMatches(
  ref: string,
  matcher: MarketplaceSourceMatcher,
): boolean {
  switch (matcher.type) {
    case 'github': {
      if (ref === matcher.repo) return true; // bare `owner/repo`
      return parseGithubRepo(ref) === matcher.repo;
    }
    case 'host':
      return globToRe(matcher.hostPattern).test(hostOf(ref));
    case 'path':
      return globToRe(matcher.pathPattern).test(ref);
  }
}

export function isSourceAllowedByPolicy(
  ref: string,
  policy: PolicySettings,
): boolean {
  const allow = policy.strictKnownMarketplaces;
  // Array (even empty) = allowlist active. null/undefined = no allowlist.
  if (Array.isArray(allow)) {
    if (!allow.some((m) => sourceMatches(ref, m))) return false;
  }
  const block = policy.blockedMarketplaces ?? [];
  if (block.length > 0 && block.some((m) => sourceMatches(ref, m))) {
    return false;
  }
  return true;
}

export function isSourceInBlocklist(ref: string, policy: PolicySettings): boolean {
  const block = policy.blockedMarketplaces ?? [];
  return block.length > 0 && block.some((m) => sourceMatches(ref, m));
}

// ── Impersonation guards ───────────────────────────────────────────

/** Empty for v1 — BrowserX has no official marketplaces yet. */
export const ALLOWED_OFFICIAL_MARKETPLACE_NAMES: readonly string[] = [];

export const BLOCKED_OFFICIAL_NAME_PATTERN =
  /(official.*\b(browserx|airepublic)\b|\b(browserx|airepublic)\b.*official|^(browserx|airepublic)[-_](marketplace|plugins|official))/i;

const OFFICIAL_GITHUB_ORG = 'browserx';

function containsNonAscii(value: string): boolean {
  return Array.from(value).some((char) => char.charCodeAt(0) > 0x7f);
}

/** Names that look "official" (or use homographs) are reserved. */
export function isBlockedOfficialName(name: string): boolean {
  if (containsNonAscii(name)) return true; // homograph guard
  if (BLOCKED_OFFICIAL_NAME_PATTERN.test(name)) {
    return !ALLOWED_OFFICIAL_MARKETPLACE_NAMES.includes(name);
  }
  return false;
}

/** A reserved (allowed-official) name must come from the BrowserX org. */
export function validateOfficialNameSource(
  name: string,
  ref: string,
): { ok: true } | { ok: false; reason: 'reserved-name-non-authoritative' } {
  if (!ALLOWED_OFFICIAL_MARKETPLACE_NAMES.includes(name)) return { ok: true };
  if (ref.includes(`github.com/${OFFICIAL_GITHUB_ORG}/`)) return { ok: true };
  return { ok: false, reason: 'reserved-name-non-authoritative' };
}
