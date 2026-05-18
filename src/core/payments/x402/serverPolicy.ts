/**
 * Server x402 allowlist policy (Track 20 stand-in) — pure + unit-tested.
 *
 * This is the single most safety-critical piece of the server path, so it
 * lives here as a pure function rather than inline in ServerAgentBootstrap.
 * DEFAULT-DENY: empty allowlist, unparseable/unknown payee host, over the
 * per-entry cap, or over the per-day cap ⇒ denied with an explicit reason.
 *
 * @module core/payments/x402/serverPolicy
 */

export interface X402AllowlistEntry {
  domain: string;
  maxPerRequestUSD: number;
}

export interface X402ServerPolicyConfig {
  allowlist: X402AllowlistEntry[];
  /** 0 ⇒ no per-day ceiling check. */
  maxPerDayUSD: number;
}

export type ServerPolicyDecision = { allowed: boolean; reason?: string };

/**
 * Evaluate whether a server-side x402 payment is permitted.
 *
 * @param resourceUrl the payee URL — the 402's `resource`, or the fetched URL
 *   when the 402 omitted `resource` (resolved by the caller).
 * @param daySpentUSD spend already accounted toward the per-day ceiling
 *   (currently session-scoped — a conservative approximation pending Phase 4).
 */
export function evaluateServerPolicy(
  cfg: X402ServerPolicyConfig,
  amountUSD: number,
  resourceUrl: string,
  daySpentUSD: number,
): ServerPolicyDecision {
  let host: string;
  try {
    host = new URL(resourceUrl).hostname.toLowerCase();
  } catch {
    return { allowed: false, reason: `unparseable payee URL '${resourceUrl}'` };
  }
  if (!host) {
    return { allowed: false, reason: 'no payee host to match against the allowlist' };
  }

  const entry = cfg.allowlist.find((e) => {
    const d = e.domain.toLowerCase();
    return host === d || host.endsWith(`.${d}`);
  });
  if (!entry) {
    return { allowed: false, reason: `payee domain '${host}' is not allowlisted` };
  }

  if (amountUSD > entry.maxPerRequestUSD) {
    return {
      allowed: false,
      reason: `$${amountUSD.toFixed(4)} exceeds allowlist cap $${entry.maxPerRequestUSD.toFixed(2)} for ${host}`,
    };
  }

  if (cfg.maxPerDayUSD > 0 && daySpentUSD + amountUSD > cfg.maxPerDayUSD) {
    return {
      allowed: false,
      reason: `would exceed per-day cap $${cfg.maxPerDayUSD.toFixed(2)} (already $${daySpentUSD.toFixed(4)})`,
    };
  }

  return { allowed: true };
}
