/**
 * Pure hostname matching for per-session skill projections.
 * Match syntax:
 *  - exact host:           "mail.google.com"
 *  - single-segment glob:  "*.google.com" matches "mail.google.com" but NOT "google.com"
 *  - any:                  "*"  → no filter (always-available; treated like no `domains`)
 */

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
