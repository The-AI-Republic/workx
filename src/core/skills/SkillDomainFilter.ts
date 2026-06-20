/**
 * SkillDomainFilter — bidirectional conditional activation by website domain.
 *
 * WorkX equivalent of Claudy's `paths`-based conditional skills. Skills
 * with a `domains` field are dormant until the active tab matches; they
 * deactivate when the tab moves away (unlike Claudy's monotonic file-path
 * activation, since tab context does not accumulate).
 *
 * Match syntax (v1):
 *  - exact host:           "mail.google.com"
 *  - single-segment glob:  "*.google.com" matches "mail.google.com" but NOT "google.com"
 *  - any:                  "*"  → no filter (always-available; treated like no `domains`)
 */

import type { SkillMeta } from './types';

export interface ActivationDelta {
  readonly activated: readonly string[];
  readonly deactivated: readonly string[];
}

export class SkillDomainFilter {
  /** Skills with `domains` that don't currently match the active tab. */
  private conditional = new Map<string, SkillMeta>();
  /** Skills currently visible to the model — unconditional + matching conditional. */
  private active = new Map<string, SkillMeta>();

  /**
   * Seed the filter with all known skills. Splits into conditional vs.
   * unconditional based on presence of a non-trivial `domains` field.
   */
  init(metas: readonly SkillMeta[]): void {
    this.conditional.clear();
    this.active.clear();
    for (const meta of metas) {
      const patterns = filterRealPatterns(meta.domains);
      if (patterns && patterns.length > 0) {
        this.conditional.set(meta.name, meta);
      } else {
        this.active.set(meta.name, meta);
      }
    }
  }

  /**
   * Re-evaluate visibility for the given hostname. Promotes matching
   * conditional skills to active; demotes active conditional skills no
   * longer matching back to conditional. Unconditional skills are unaffected.
   *
   * Returns the names that flipped state.
   */
  onActiveTabChange(hostname: string | null | undefined): ActivationDelta {
    const activated: string[] = [];
    const deactivated: string[] = [];

    // Promote: conditional → active
    if (hostname) {
      for (const [name, skill] of this.conditional) {
        const patterns = filterRealPatterns(skill.domains);
        if (patterns && patterns.some((p) => matchesDomain(hostname, p))) {
          this.active.set(name, skill);
          this.conditional.delete(name);
          activated.push(name);
        }
      }
    }

    // Demote: active → conditional (only those with domains)
    for (const [name, skill] of this.active) {
      const patterns = filterRealPatterns(skill.domains);
      if (!patterns || patterns.length === 0) continue; // unconditional — leave alone
      if (!hostname || !patterns.some((p) => matchesDomain(hostname, p))) {
        this.conditional.set(name, skill);
        this.active.delete(name);
        deactivated.push(name);
      }
    }

    return { activated, deactivated };
  }

  /** Snapshot of skills visible to the model right now. */
  getAvailableSkills(): SkillMeta[] {
    return Array.from(this.active.values());
  }

  /** True if `name` is currently visible. */
  isAvailable(name: string): boolean {
    return this.active.has(name);
  }

  /** Test-only inspection. */
  getConditionalNames(): string[] {
    return Array.from(this.conditional.keys());
  }
  getActiveNames(): string[] {
    return Array.from(this.active.keys());
  }
}

/** Drop the `*` "match-all" sentinel — treats as no filter (matches Claudy's `**` behavior). */
function filterRealPatterns(domains: readonly string[] | undefined): string[] | undefined {
  if (!domains || domains.length === 0) return undefined;
  const real = domains.filter((d) => d !== '*' && d !== '**');
  return real.length === 0 ? undefined : real;
}

/**
 * Hostname matcher. Lowercases both sides. Supports `*.host.tld` single-segment
 * wildcard (does NOT match the bare apex). Exact match otherwise.
 */
export function matchesDomain(hostname: string, pattern: string): boolean {
  const h = hostname.toLowerCase();
  const p = pattern.toLowerCase();
  if (p === h) return true;
  if (p.startsWith('*.')) {
    const suffix = p.slice(2);
    // Must have at least one label before the suffix, e.g. "x.suffix" not just "suffix"
    if (h.length <= suffix.length) return false;
    if (!h.endsWith('.' + suffix)) return false;
    // Single-segment: the prefix before the suffix must not contain a dot
    const prefix = h.slice(0, h.length - suffix.length - 1);
    return prefix.length > 0 && !prefix.includes('.');
  }
  return false;
}
