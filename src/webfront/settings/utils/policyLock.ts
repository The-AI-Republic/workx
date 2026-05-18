/**
 * UI managed-lock helper (Track 20).
 *
 * Generalises claudy's ad-hoc per-feature "is this configured by policy?"
 * checks into one reusable predicate, bound to the runtime
 * `IAgentConfig.policy.lockedKeys` the resolver stamps. Settings components
 * use it to disable inputs and show a "Managed by your organization" badge.
 *
 * Enforcement does NOT depend on this — the write guards already reject locked
 * writes. This is the visibility affordance.
 *
 * @module webfront/settings/utils/policyLock
 */

import type { IAgentConfig } from '@/config/types';
import { isPathLockedBy } from '@/core/config/policy';

/**
 * True when `path` (agent namespace-relative dot-path, e.g. `approval.mode`,
 * `providers.openai.apiKey`, `tools`) is policy-locked — exact match or under
 * a locked ancestor.
 */
export function isPolicyLocked(
  config: Pick<IAgentConfig, 'policy'> | null | undefined,
  path: string
): boolean {
  const locked = config?.policy?.lockedKeys;
  if (!locked || locked.length === 0) return false;
  return isPathLockedBy(locked, path);
}

/** The origin label for tooltips, or null when unmanaged. */
export function policyOrigin(
  config: Pick<IAgentConfig, 'policy'> | null | undefined
): string | null {
  return config?.policy?.origin ?? null;
}

/** Human tooltip for a locked control. */
export function managedTooltip(
  config: Pick<IAgentConfig, 'policy'> | null | undefined
): string {
  const origin = policyOrigin(config);
  return origin
    ? `Managed by your organization (source: ${origin}) — contact your administrator to change this.`
    : 'Managed by your organization — contact your administrator to change this.';
}
