/**
 * dependencyResolver — pure transitive dependency closure for plugin
 * install. Port of claudy `utils/plugins/dependencyResolver.ts:95-159`.
 *
 * Pure (no I/O): the `lookup` is injected so this stays trivially testable
 * without constructing marketplace infrastructure.
 *
 * Algorithm: DFS with an in-flight `stack` for cycle detection and a
 * `visited` set for dedupe. Output is **post-order** (topological) — a
 * plugin appears AFTER all its dependencies, so the installer's
 * materialize loop caches deps before dependents.
 *
 * Invariants (must match claudy — design § Dependency closure resolution):
 *  - Cross-marketplace block runs AFTER the `alreadyEnabled` check, so a
 *    manually-pre-installed cross-marketplace dep is not rejected.
 *  - Only the ROOT marketplace's allowlist applies (no transitive trust).
 *  - The root is NEVER skipped even if already enabled (re-install after a
 *    cleared cache must re-materialize it).
 *  - Bare dependency names inherit the declaring plugin's marketplace.
 */

import type { PluginId } from './types';

/** Minimal shape the resolver needs from a marketplace entry. */
export interface DependencyLookupResult {
  /** Fully- or bare-qualified dependency ids declared by this plugin. */
  dependencies?: string[];
}

export type DependencyLookup = (
  id: PluginId,
) => Promise<DependencyLookupResult | null>;

export type DependencyResolution =
  | { ok: true; closure: PluginId[] }
  | { ok: false; error: 'cycle'; chain: PluginId[] }
  | { ok: false; error: 'not-found'; id: PluginId }
  | { ok: false; error: 'cross-marketplace'; id: PluginId; marketplace: string };

function marketplaceOf(id: PluginId): string {
  const at = id.indexOf('@');
  return at >= 0 ? id.slice(at + 1) : 'local';
}

function nameOf(id: PluginId): string {
  const at = id.indexOf('@');
  return at >= 0 ? id.slice(0, at) : id;
}

/**
 * Qualify a raw dependency string. A bare name inherits the declaring
 * plugin's marketplace; an already-qualified `name@mkt` passes through.
 */
function qualifyDependency(raw: string, declaringId: PluginId): PluginId {
  if (raw.includes('@')) return raw;
  return `${raw}@${marketplaceOf(declaringId)}`;
}

export async function resolveDependencyClosure(
  rootId: PluginId,
  lookup: DependencyLookup,
  alreadyEnabled: ReadonlySet<PluginId>,
  allowedCrossMarketplaces: ReadonlySet<string>,
): Promise<DependencyResolution> {
  const rootMarketplace = marketplaceOf(rootId);
  const closure: PluginId[] = [];
  const visited = new Set<PluginId>();
  const stack: PluginId[] = [];

  async function walk(
    id: PluginId,
    isRoot: boolean,
  ): Promise<DependencyResolution | null> {
    // Skip already-enabled deps — but NEVER the root (re-install must
    // re-materialize even if settings already lists it).
    if (!isRoot && alreadyEnabled.has(id)) return null;

    // Cross-marketplace gate (after the alreadyEnabled check, per claudy).
    const mkt = marketplaceOf(id);
    if (mkt !== rootMarketplace && !allowedCrossMarketplaces.has(mkt)) {
      return { ok: false, error: 'cross-marketplace', id, marketplace: mkt };
    }

    if (stack.includes(id)) {
      return { ok: false, error: 'cycle', chain: [...stack, id] };
    }
    if (visited.has(id)) return null;
    visited.add(id);

    const entry = await lookup(id);
    if (!entry) return { ok: false, error: 'not-found', id };

    stack.push(id);
    for (const rawDep of entry.dependencies ?? []) {
      const dep = qualifyDependency(rawDep, id);
      const err = await walk(dep, false);
      if (err) return err;
    }
    stack.pop();

    closure.push(id); // post-order: deps before dependents
    return null;
  }

  const error = await walk(rootId, true);
  if (error) return error;
  return { ok: true, closure };
}

export { marketplaceOf, nameOf, qualifyDependency };
