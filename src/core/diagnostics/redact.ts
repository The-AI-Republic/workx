/**
 * Diagnostic-output redactor (Track 17).
 *
 * Track 16 (telemetry/redaction) does not exist in code at write time — only
 * a 2-field, server-only `redactConfig()`. Diagnostic output can carry config
 * URLs, tokens, and account info and is emitted over network-exposed WS/HTTP
 * surfaces, so this module ships an in-track, deny-by-shape redactor. It is a
 * single pure function so a future Track 16 can re-export / replace its
 * internals without changing callers.
 *
 * MANDATORY before any cross-process emission of a `DoctorReport`.
 *
 * @module core/diagnostics/redact
 */

import type { DoctorReport } from './types';

const REPLACEMENT = '***';

/** Ordered list of (pattern, replacement). Conservative — over-redact rather
 *  than leak. The existing `'[SECURED]'` config marker matches none of these
 *  and is intentionally preserved. */
const RULES: Array<[RegExp, string]> = [
  // Provider API keys: sk-…, sk-proj-…, xai-…, AIza… (Google)
  [/\bsk-[A-Za-z0-9_-]{10,}\b/g, REPLACEMENT],
  [/\bxai-[A-Za-z0-9_-]{10,}\b/g, REPLACEMENT],
  [/\bAIza[A-Za-z0-9_-]{10,}\b/g, REPLACEMENT],
  // Bearer tokens
  [/\bBearer\s+[A-Za-z0-9._-]+/gi, `Bearer ${REPLACEMENT}`],
  // JWT-shaped triples
  [/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, REPLACEMENT],
  // key=value / key: "value" for secret-ish keys
  [
    /\b(api[_-]?key|token|secret|password|passwd|authorization)\b(["']?\s*[:=]\s*["']?)([^\s"',}]+)/gi,
    `$1$2${REPLACEMENT}`,
  ],
  // URL userinfo  scheme://user:pass@host  →  scheme://user:***@host
  [
    /\b([a-z][a-z0-9+.-]*:\/\/[^/\s:@]+):([^/\s@]+)@/gi,
    `$1:${REPLACEMENT}@`,
  ],
];

/** A `data` field whose key name is itself sensitive — scrub the value
 *  wholesale regardless of its shape. */
const SENSITIVE_KEY =
  /(^|_)(api[_-]?key|apikey|token|secret|password|passwd|authorization)$/i;

function redactString(input: string): string {
  let out = input;
  for (const [pattern, replacement] of RULES) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

function redactValue(value: unknown, keyIsSensitive = false): unknown {
  if (typeof value === 'string') {
    return keyIsSensitive ? REPLACEMENT : redactString(value);
  }
  if (keyIsSensitive && (typeof value === 'number' || typeof value === 'boolean')) {
    return REPLACEMENT;
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactValue(v, keyIsSensitive));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(v, SENSITIVE_KEY.test(k));
    }
    return out;
  }
  return value;
}

/** Return a redacted deep clone. Never mutates the input. */
export function redactDoctorReport(report: DoctorReport): DoctorReport {
  return {
    ...report,
    checks: report.checks.map((c) => ({
      ...c,
      detail: redactString(c.detail),
      data:
        c.data === undefined
          ? undefined
          : (redactValue(c.data) as Record<string, unknown>),
    })),
  };
}
