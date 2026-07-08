/**
 * Error message sanitization for surfaces that DISPLAY or PERSIST errors.
 *
 * A thrown error's `message` can carry secrets — a Bearer token in a failed
 * request, an API key echoed back by a provider, a `password=…` in a
 * connection string. Those messages flow to three places we do not control:
 * the `TaskFailed` event shown in the UI, tool-call `output` fed back to the
 * LLM, and the rollout recording persisted to disk. This module strips secrets
 * before an error string reaches any of them.
 *
 * It is intentionally conservative: it removes only high-confidence secrets
 * (reusing the diagnostics redaction rules) and preserves the rest of the
 * message — URLs, file paths, and the failure reason — so both the user and
 * the agent keep enough context to understand what went wrong.
 *
 * @module core/errors/sanitizeError
 */

import { redactSecretsInText } from '@/core/diagnostics/redact';

/** Extract a plain message from an unknown thrown value (no redaction). */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Secret-redacted message for an unknown thrown value. Use at every point an
 * error string is written into a tool output, an event shown to the user, or a
 * persisted record.
 */
export function safeErrorMessage(error: unknown): string {
  return redactSecretsInText(errorMessage(error));
}
