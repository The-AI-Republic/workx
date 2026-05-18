/**
 * Fail-closed secret scanner (Track 24.5).
 *
 * Memory and conversation text can leave the device through server egress
 * surfaces — connector replies (Slack/Telegram), the WebSocket transcript
 * stream, and the on-disk transcript. A credential landing in an automated
 * connector reply from an unattended job is a live exfiltration path.
 *
 * This module is a single pure function. It is deliberately FAIL-CLOSED on the
 * egress path — the inverse of the initiative-wide fail-open default. A missed
 * secret is worse than a blocked share, so callers on the high-stakes
 * connector path MUST treat `block === true` as "do not send the original;
 * substitute the safe string". The WS/transcript callers instead use
 * `redacted` (non-blocking, keeps the surface usable).
 *
 * Do NOT "fix" the fail-closed behavior to fail-open — it is intentional and
 * load-bearing. See .ai_design/agent_improvements/24_minor_ux_hardening_followups.
 *
 * @module core/security/secretScanner
 */

const REPLACEMENT = '***';

/** Fixed string a fail-closed egress gate substitutes for a blocked message. */
export const BLOCKED_OUTBOUND_MESSAGE =
  '[blocked: outbound message withheld — possible secret detected]';

/**
 * Above this size the regex pass is not treated as deterministic enough to
 * clear a message for high-stakes egress, so the scan reports `block` as a
 * fail-closed signal. `redacted` is still computed best-effort.
 */
export const MAX_SCAN_BYTES = 256 * 1024;

export interface SecretSpan {
  start: number;
  end: number;
  ruleId: string;
}

export interface ScanResult {
  /** Offsets of detected secrets in the input (best-effort). */
  spans: SecretSpan[];
  /** Hard fail-closed decision for the connector / high-stakes path. */
  block: boolean;
  /** Input with detected secrets replaced by `***` (for WS/transcript). */
  redacted: string;
}

interface Rule {
  id: string;
  pattern: RegExp;
  /** Replacement for `String.replace` (may use `$1` etc.). */
  replacement: string;
  /**
   * High-confidence rules force `block`. Low-confidence rules (generic
   * high-entropy blobs) only redact — they are too false-positive-prone to
   * hard-block a connector reply on.
   */
  highConfidence: boolean;
}

/**
 * Ordered rules. Conservative — over-redact rather than leak. Mirrors the
 * Track 17 `core/diagnostics/redact.ts` rule shapes (kept in sync by intent)
 * and extends them with AWS / GitHub / Slack / private-key / generic
 * high-entropy patterns.
 *
 * Every pattern is linear (no nested quantifiers) — safe against catastrophic
 * backtracking even on large inputs.
 */
const RULES: Rule[] = [
  // ── Provider API keys ────────────────────────────────────────────────
  { id: 'openai-sk', pattern: /\bsk-[A-Za-z0-9_-]{10,}\b/g, replacement: REPLACEMENT, highConfidence: true },
  { id: 'xai', pattern: /\bxai-[A-Za-z0-9_-]{10,}\b/g, replacement: REPLACEMENT, highConfidence: true },
  { id: 'google-aiza', pattern: /\bAIza[A-Za-z0-9_-]{10,}\b/g, replacement: REPLACEMENT, highConfidence: true },
  // ── Cloud / VCS / chat platform tokens ───────────────────────────────
  { id: 'aws-akia', pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: REPLACEMENT, highConfidence: true },
  { id: 'github-pat', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, replacement: REPLACEMENT, highConfidence: true },
  { id: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replacement: REPLACEMENT, highConfidence: true },
  // ── Bearer tokens ────────────────────────────────────────────────────
  { id: 'bearer', pattern: /\bBearer\s+[A-Za-z0-9._-]+/gi, replacement: `Bearer ${REPLACEMENT}`, highConfidence: true },
  // ── JWT-shaped triples ───────────────────────────────────────────────
  {
    id: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
    replacement: REPLACEMENT,
    highConfidence: true,
  },
  // ── PEM private key blocks ───────────────────────────────────────────
  {
    id: 'private-key',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g,
    replacement: REPLACEMENT,
    highConfidence: true,
  },
  // ── key=value / key: "value" for secret-ish keys ─────────────────────
  {
    id: 'kv-secret',
    pattern:
      /\b(api[_-]?key|token|secret|password|passwd|authorization|credentials?|auth)\b(["']?\s*[:=]\s*["']?)([^\s"',}]+)/gi,
    replacement: `$1$2${REPLACEMENT}`,
    highConfidence: true,
  },
  // ── URL userinfo  scheme://user:pass@host ────────────────────────────
  {
    id: 'url-userinfo',
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^/\s:@]+):([^/\s@]+)@/gi,
    replacement: `$1:${REPLACEMENT}@`,
    highConfidence: true,
  },
  // ── Generic high-entropy blob (redact only — too noisy to hard-block) ─
  {
    id: 'generic-highentropy',
    pattern: /\b[A-Za-z0-9+/_-]{40,}={0,2}\b/g,
    replacement: REPLACEMENT,
    highConfidence: false,
  },
];

/**
 * Scan `text` for secrets.
 *
 * - `block` is true iff any high-confidence rule matched, OR the input is
 *   uncertain (> MAX_SCAN_BYTES, or the scan threw). Fail-closed.
 * - `redacted` always carries a best-effort scrub (every matched rule applied)
 *   so non-blocking callers (WS/transcript) stay usable.
 */
export function scanForSecrets(text: string): ScanResult {
  if (typeof text !== 'string' || text.length === 0) {
    return { spans: [], block: false, redacted: text ?? '' };
  }

  try {
    const oversized = text.length > MAX_SCAN_BYTES;
    const spans: SecretSpan[] = [];
    let highConfidenceHit = false;
    let redacted = text;

    for (const rule of RULES) {
      // Collect spans on the original text (offsets stay meaningful).
      const collector = new RegExp(rule.pattern.source, rule.pattern.flags);
      let m: RegExpExecArray | null;
      while ((m = collector.exec(text)) !== null) {
        spans.push({ start: m.index, end: m.index + m[0].length, ruleId: rule.id });
        if (rule.highConfidence) highConfidenceHit = true;
        if (m[0].length === 0) collector.lastIndex++; // guard against zero-width loops
      }
      redacted = redacted.replace(
        new RegExp(rule.pattern.source, rule.pattern.flags),
        rule.replacement,
      );
    }

    return { spans, block: highConfidenceHit || oversized, redacted };
  } catch {
    // Pathological input — fail closed and hand callers the safe string.
    return { spans: [], block: true, redacted: BLOCKED_OUTBOUND_MESSAGE };
  }
}
