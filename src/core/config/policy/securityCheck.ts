/**
 * securityCheck — dangerous managed-change assessment (Track 20).
 *
 * Pure, platform-agnostic. Detects when a *newly applied* policy WEAKENS
 * security vs the previously applied one (WorkX-domain: approvals relaxed,
 * risky tools enabled, allowlist widened, sandbox opened). Interactive
 * runtimes warn the user; the headless server auto-applies + emits a redacted
 * audit (the emit lives in the server bootstrap — core must not import the
 * server log sink). An improvement over claudy's silent-headless behavior.
 *
 * @module core/config/policy/securityCheck
 */

import type { ResolvedPolicy } from './types';

export interface PolicyChangeAssessment {
  weakened: boolean;
  changedKeys: string[];
  reasons: string[];
}

const RISKY_TOOL_KEYS = [
  'agent.tools.execCommand',
  'agent.tools.fileOperations',
  'agent.tools.network_intercept_tool',
  'agent.tools.web_scraping_tool',
  'agent.tools.enable_all_tools',
];

function val(p: ResolvedPolicy | null, key: string): unknown {
  return p?.values?.[key];
}

/** Assess whether `next` weakens security relative to `prev`. */
export function assessPolicyChange(
  prev: ResolvedPolicy | null,
  next: ResolvedPolicy | null
): PolicyChangeAssessment {
  const reasons: string[] = [];
  const changedKeys: string[] = [];

  const keys = new Set<string>([
    ...Object.keys(prev?.values ?? {}),
    ...Object.keys(next?.values ?? {}),
  ]);
  for (const k of keys) {
    if (JSON.stringify(val(prev, k)) !== JSON.stringify(val(next, k))) {
      changedKeys.push(k);
    }
  }

  // Approvals relaxed.
  const nextMode = val(next, 'agent.approval.mode');
  if (nextMode === 'yolo' && val(prev, 'agent.approval.mode') !== 'yolo') {
    reasons.push('approval mode set to "yolo" (auto-approves all tool calls)');
  }

  // Trusted-domain allowlist widened.
  const prevTrusted = (val(prev, 'agent.approval.trustedDomains') as unknown[]) ?? [];
  const nextTrusted = (val(next, 'agent.approval.trustedDomains') as unknown[]) ?? [];
  if (Array.isArray(nextTrusted) && nextTrusted.length > prevTrusted.length) {
    reasons.push('trusted-domain allowlist widened');
  }

  // Risky tools enabled.
  for (const tk of RISKY_TOOL_KEYS) {
    if (val(next, tk) === true && val(prev, tk) !== true) {
      reasons.push(`risky tool enabled: ${tk}`);
    }
  }

  // Sandbox network opened.
  if (
    val(next, 'agent.tools.sandboxPolicy.network_access') === true &&
    val(prev, 'agent.tools.sandboxPolicy.network_access') !== true
  ) {
    reasons.push('sandbox network access enabled');
  }

  return { weakened: reasons.length > 0, changedKeys, reasons };
}

// Stateful tracker for change listeners (which only receive the new policy).
let _lastSeen: ResolvedPolicy | null = null;

/** Assess `next` vs the last recorded policy, then record `next`. */
export function assessAndRecord(
  next: ResolvedPolicy | null
): PolicyChangeAssessment {
  const a = assessPolicyChange(_lastSeen, next);
  _lastSeen = next;
  return a;
}

/** Test-only reset. */
export function __resetSecurityCheckForTests(): void {
  _lastSeen = null;
}

const SECRET_RE =
  /(sk-[A-Za-z0-9_-]{12,}|Bearer\s+\S+|eyJ[\w-]+\.[\w-]+\.[\w-]+|(api[-_]?key|token|secret|password)["':=\s]+\S+|:\/\/[^/\s]+:[^@\s]+@)/gi;

/** Deny-by-shape redaction of secret-bearing values for audit logging. */
export function redactSecrets<T>(value: T): T {
  if (typeof value === 'string') {
    return value.replace(SECRET_RE, '***') as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactSecrets(v)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactSecrets(v);
    }
    return out as unknown as T;
  }
  return value;
}
