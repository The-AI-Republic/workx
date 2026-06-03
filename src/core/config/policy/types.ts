/**
 * Managed / Policy Settings — shared types (Track 20).
 *
 * A single admin-controlled configuration tier that sits ABOVE every existing
 * config layer in BOTH of BrowserX's independent config systems (the agent
 * config and the server config). Platform-native {@link PolicySource}s feed a
 * shared resolver; the resolved policy is overlaid post-merge and a declared
 * subset of keys is frozen against every write surface.
 *
 * Namespacing: BrowserX has two config systems, so a single policy document
 * uses fully-qualified dot-paths prefixed by namespace — `agent.*` for the
 * agent config (extension/desktop/server) and `server.*` for the headless
 * server config. {@link applyPolicy} filters to its namespace before applying.
 *
 * @module core/config/policy/types
 */

export type PolicyOrigin = 'chrome-managed' | 'file' | 'remote' | 'env' | null;

export type PolicyNamespace = 'agent' | 'server';

/**
 * A resolved policy document. `values` and `lockedKeys` use namespaced
 * dot-paths (e.g. `agent.approval.mode`, `server.exec.approvalPolicy`).
 *
 * - `values`: admin-provided values. Overlaid post-merge as the highest
 *   priority — they win over user/stored/default values.
 * - `lockedKeys`: the subset additionally *frozen* — rejected at every write
 *   surface and rendered non-editable in the UI. Locking an ancestor path
 *   (e.g. `agent.providers.openai`) freezes the whole subtree.
 */
export interface ResolvedPolicy {
  values: Record<string, unknown>;
  lockedKeys: string[];
  origin: Exclude<PolicyOrigin, null>;
}

/**
 * A platform-native policy source. Sources are consulted in registration
 * order; the first whose `load()` returns a non-empty policy wins entirely
 * ("first source wins" — sources are NOT merged with each other).
 */
export interface PolicySource {
  readonly origin: Exclude<PolicyOrigin, null>;
  /** Return the policy this source carries, or `null` if it carries none. */
  load(): Promise<ResolvedPolicy | null>;
  /**
   * Optional platform-native change hook (e.g. `chrome.storage.onChanged`,
   * an fs watch, the server config reload seam, or the remote poll). The
   * returned function unsubscribes.
   */
  subscribe?(onChange: () => void): () => void;
}

/** Thrown when a write targets a policy-locked path. */
export class PolicyLockedError extends Error {
  readonly lockedPath: string;
  constructor(lockedPath: string) {
    super(
      `Configuration "${lockedPath}" is managed by your organization and cannot be changed.`
    );
    this.name = 'PolicyLockedError';
    this.lockedPath = lockedPath;
  }
}

/** Compact, redaction-safe summary for diagnostics. Never includes values. */
export interface PolicySummary {
  origin: PolicyOrigin;
  lockedKeys: string[];
  /** Number of admin-provided values (count only — never the values). */
  valueCount: number;
}
