/**
 * Track 12: Rate-Limit Resilience — single retry orchestrator.
 *
 * One caller-side retry engine that wraps the whole turn at the
 * `TurnManager.runTurn` loop. It replaces the shallow per-attempt loops with:
 *  - error classification off `ModelClientError`/`RateLimitError` + statusCode
 *    (NOT `StreamAttemptError`, which is dead code),
 *  - wait-until-reset delay for rate limits,
 *  - persistent (unattended) mode that does not give up on 429/529,
 *  - consecutive-overload counting → model fallback,
 *  - background-source fast-bail.
 *
 * It is a plain async function (no generator/yield): workx emits status on
 * the event bus via callbacks, so there is no need for claudy's yielded
 * heartbeat message.
 *
 * Design: .ai_design/agent_improvements/12_rate_limit_resilience/design.md
 */

import { ModelClientError } from '../ModelClient';
import { RateLimitError } from '../ModelClientError';

export const DEFAULT_MAX_RETRIES = 10;
export const MAX_529_RETRIES = 3;
export const BASE_DELAY_MS = 500;
export const PERSISTENT_MAX_BACKOFF_MS = 5 * 60 * 1000;
/** Absolute ceiling on any single reset-wait (6 h). */
export const RESET_CAP_MS = 6 * 60 * 60 * 1000;
/** Long sleeps are chunked into slices this size so the abort signal is polled. */
export const HEARTBEAT_CHUNK_MS = 30_000;
/**
 * Extension (MV3) reset-wait clamp: the service worker is evicted long before
 * a 6 h reset, so a persistent wait is clamped short and the chrome-alarms
 * re-trigger is what actually resumes the job.
 */
export const EXTENSION_UNATTENDED_RESET_CAP_MS = 5 * 60 * 1000;

export type RetrySource = 'foreground' | 'background';

export type ModelErrorKind =
  | 'rate_limit' // HTTP 429
  | 'overloaded' // HTTP 529 / "overloaded_error"
  | 'server' // HTTP >= 500
  | 'context_overflow' // HTTP 413 / provider "prompt too long" errors
  | 'transport' // network / stream-closed / unknown-no-status (retryable)
  | 'fatal'; // 4xx (incl. 401/403/400) — not retryable

export interface ModelErrorClassification {
  kind: ModelErrorKind;
  statusCode?: number;
  /** Server-directed retry delay in ms, if the error carried one. */
  retryAfterMs?: number;
}

function getStatusCode(error: unknown): number | undefined {
  if (error instanceof ModelClientError && typeof error.statusCode === 'number') {
    return error.statusCode;
  }
  const anyErr = error as { status?: number; statusCode?: number } | null;
  if (anyErr && typeof anyErr.status === 'number') return anyErr.status;
  if (anyErr && typeof anyErr.statusCode === 'number') return anyErr.statusCode;
  return undefined;
}

function getMessage(error: unknown): string {
  if (error instanceof Error) return error.message ?? '';
  if (typeof error === 'string') return error;
  return '';
}

/** retry-after in ms from a `RateLimitError`/`ModelClientError` (already ms). */
function getRetryAfterMs(error: unknown): number | undefined {
  if (error instanceof ModelClientError && typeof error.retryAfter === 'number') {
    // ModelClientError.retryAfter is stored in ms (ErrorFactory multiplies by 1000).
    return error.retryAfter;
  }
  return undefined;
}

function isTransportError(error: unknown): boolean {
  const msg = getMessage(error).toLowerCase();
  return (
    msg.includes('econnreset') ||
    msg.includes('epipe') ||
    msg.includes('etimedout') ||
    msg.includes('socket hang up') ||
    msg.includes('network') ||
    msg.includes('fetch failed') ||
    // transient stream terminations the legacy loop also retried
    msg.includes('stream closed') ||
    msg.includes('stream error') ||
    msg.includes('timeout')
  );
}

/**
 * Classify a model-call error. A 529 may arrive as status 529 OR only in the
 * message body (the SDK sometimes drops the status during streaming — claudy
 * documents the same). Unknown/no-status errors are treated as retryable
 * `transport` to preserve the legacy "retry transient stream failures"
 * behavior; only explicit 4xx is `fatal`.
 */
export function classifyModelError(error: unknown): ModelErrorClassification {
  const status = getStatusCode(error);
  const msg = getMessage(error).toLowerCase();
  const retryAfterMs = getRetryAfterMs(error);

  if (isContextOverflowError(error)) {
    return { kind: 'context_overflow', statusCode: status };
  }
  // 529 may arrive as a status OR (when the SDK drops it mid-stream) only as
  // the `"type":"overloaded_error"` JSON fragment in the message. Match that
  // specific fragment, not a bare "overloaded" substring (too broad — could
  // hit echoed user content).
  if (status === 529 || msg.includes('overloaded_error')) {
    return { kind: 'overloaded', statusCode: status ?? 529, retryAfterMs };
  }
  if (status === 429 || error instanceof RateLimitError) {
    return { kind: 'rate_limit', statusCode: status ?? 429, retryAfterMs };
  }
  if (status !== undefined && status >= 500) {
    return { kind: 'server', statusCode: status, retryAfterMs };
  }
  if (status !== undefined && status >= 400) {
    return { kind: 'fatal', statusCode: status };
  }
  if (isTransportError(error)) {
    return { kind: 'transport' };
  }
  // No status, not obviously transport: keep retryable (legacy parity — the
  // old TurnManager loop retried anything not on its non-retryable list).
  return { kind: 'transport' };
}

/**
 * Wait-until-reset delay (ms) derivable from the error itself. Precedence:
 *   1. RateLimitError.retryAfter (ms, server directive)
 *   2. rateLimitMetadata.reset (unix seconds) - now
 * Returns null when nothing usable; caller falls back to backoff.
 * Capped at RESET_CAP_MS.
 */
export function getResetDelayMs(error: unknown): number | null {
  const retryAfterMs = getRetryAfterMs(error);
  if (typeof retryAfterMs === 'number' && retryAfterMs > 0) {
    return Math.min(retryAfterMs, RESET_CAP_MS);
  }
  if (error instanceof RateLimitError) {
    const resetUnixSec = error.rateLimitMetadata?.reset;
    if (typeof resetUnixSec === 'number' && Number.isFinite(resetUnixSec)) {
      const deltaMs = resetUnixSec * 1000 - Date.now();
      if (deltaMs > 0) return Math.min(deltaMs, RESET_CAP_MS);
    }
  }
  return null;
}

/**
 * Track 12 (pairs with Track 25): parse the API's max-tokens context-overflow
 * 400 — `input length and max_tokens exceed context limit: A + B > C` — so a
 * caller can lower max_tokens and retry instead of hard-failing. Returns
 * undefined when the error is not this specific 400.
 */
export function parseMaxTokensContextOverflowError(
  error: unknown,
): { inputTokens: number; maxTokens: number; contextLimit: number } | undefined {
  if (getStatusCode(error) !== 400) return undefined;
  const msg = getMessage(error);
  if (!msg.includes('input length and') || !msg.includes('exceed context limit')) {
    return undefined;
  }
  const m = msg.match(
    /input length and `?max_tokens`? exceed context limit: (\d+) \+ (\d+) > (\d+)/,
  );
  if (!m || m.length !== 4) return undefined;
  const inputTokens = parseInt(m[1], 10);
  const maxTokens = parseInt(m[2], 10);
  const contextLimit = parseInt(m[3], 10);
  if (
    Number.isNaN(inputTokens) ||
    Number.isNaN(maxTokens) ||
    Number.isNaN(contextLimit)
  ) {
    return undefined;
  }
  return { inputTokens, maxTokens, contextLimit };
}

export function isContextOverflowError(error: unknown): boolean {
  const status = getStatusCode(error);
  if (status === 413) return true;

  const msg = getMessage(error).toLowerCase();
  if (!msg) return false;

  return (
    msg.includes('context_length_exceeded') ||
    msg.includes('maximum context length') ||
    msg.includes('context limit') ||
    msg.includes('context window') ||
    msg.includes('prompt too long') ||
    msg.includes('prompt is too long') ||
    msg.includes('input too long') ||
    msg.includes('request too large') ||
    msg.includes('too many tokens') ||
    msg.includes('token limit exceeded')
  );
}

/** Internal exponential backoff with jitter (used for persistent mode). */
export function internalBackoffMs(attempt: number, capMs: number): number {
  const base = Math.min(BASE_DELAY_MS * Math.pow(2, Math.max(0, attempt - 1)), capMs);
  const jitter = Math.random() * 0.25 * base;
  return base + jitter;
}

export interface ModelRetryFallback {
  /** Resolve the next fallback model id, or undefined if none configured. */
  resolveFallbackModel: () => string | undefined;
  /** Swap the model onto the live TurnContext so the next attempt uses it. */
  applyFallbackModel: (model: string) => void | Promise<void>;
  /** Surface a visible ModelDowngraded event (never silent). */
  onDowngrade?: (from: string | undefined, to: string) => void | Promise<void>;
}

export interface WaitInfo {
  delayMs: number;
  attempt: number;
  statusCode?: number;
  kind: ModelErrorKind;
}

export interface ModelRetryOptions {
  /** Attended cap. Ignored while a transient error is retried in persistent mode. */
  maxRetries: number;
  /** When true, 429/529 are retried until reset and the loop never gives up. */
  unattended: boolean;
  /** 'background' callers fast-bail on overload (no cascade amplification). */
  source?: RetrySource;
  /** Ceiling on a single reset-wait; lowered on extension (MV3 SW lifetime). */
  resetCapMs?: number;
  isCancelled?: () => boolean;
  isAborted?: () => boolean;
  /** Caller-specific hard non-retryable test (e.g. TurnManager.isNonRetryableError). */
  isNonRetryable?: (error: unknown) => boolean;
  /** Attended backoff (reuse the caller's existing curve for behavior parity). */
  computeBackoffMs?: (attempt: number, error: unknown) => number;
  /** Notify on every retry (e.g. emit a StreamError event). */
  onRetryNotice?: (
    error: unknown,
    attempt: number,
    delayMs: number,
    maxRetries: number,
  ) => void | Promise<void>;
  /** Notify before a long unattended wait (emit RateLimitWaiting). */
  onWait?: (info: WaitInfo) => void | Promise<void>;
  fallback?: ModelRetryFallback;
  /**
   * Track 25 join: handle a max-tokens context-overflow 400 by lowering
   * max_tokens for the next attempt. Return true if handled (the loop then
   * retries without counting it as an attempt); false/absent ⇒ the 400 is
   * fatal, unchanged. Wiring the prompt rebuild is deferred to Track 25
   * (same TurnManager boundary) per the design.
   */
  onContextOverflow?: (info: {
    inputTokens?: number;
    maxTokens?: number;
    contextLimit?: number;
    statusCode?: number;
    message?: string;
  }) => boolean | Promise<boolean>;
  currentModel?: () => string | undefined;
  /** Injectable sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
}

type TestErrorInjector = () => unknown | undefined;
let __testErrorInjector: TestErrorInjector | null = null;

/**
 * Test-only seam (replaces the deleted RequestQueue.test.ts coverage). When
 * set, the injector is consulted before each attempt; a returned value is
 * thrown as the model-call error. Inert unless explicitly set by a test.
 */
export function __setModelRetryTestInjector(fn: TestErrorInjector | null): void {
  __testErrorInjector = fn;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function chunkedSleep(
  totalMs: number,
  sleepFn: (ms: number) => Promise<void>,
  shouldAbort: () => boolean,
): Promise<void> {
  let remaining = totalMs;
  while (remaining > 0) {
    if (shouldAbort()) return;
    const chunk = Math.min(remaining, HEARTBEAT_CHUNK_MS);
    await sleepFn(chunk);
    remaining -= chunk;
  }
}

/**
 * Run `operation` with the unified retry/fallback policy. `operation` is the
 * whole turn (e.g. `() => this.tryRunTurn(prompt)`); restarting it replays
 * clean prior history (workx records history only on turn success — no
 * orphan-tool_use hazard, design Divergence 5).
 */
export async function withModelRetry<T>(
  operation: () => Promise<T>,
  opts: ModelRetryOptions,
): Promise<T> {
  const maxRetries = opts.maxRetries;
  const resetCapMs = opts.resetCapMs ?? RESET_CAP_MS;
  const sleepFn = opts.sleep ?? defaultSleep;
  const source: RetrySource = opts.source ?? 'foreground';
  const isCancelled = opts.isCancelled ?? (() => false);
  const isAborted = opts.isAborted ?? (() => false);
  const shouldAbort = () => isCancelled() || isAborted();

  let consecutive529 = 0;
  let persistentAttempt = 0;
  let lastError: unknown;

  for (let attempt = 1; ; attempt++) {
    if (shouldAbort()) {
      throw lastError ?? new Error('Operation cancelled');
    }

    try {
      if (__testErrorInjector) {
        const injected = __testErrorInjector();
        if (injected) throw injected;
      }
      return await operation();
    } catch (error) {
      lastError = error;

      if (isCancelled()) throw error;
      if (opts.isNonRetryable?.(error)) throw error;

      // Max-tokens context-overflow self-heal (before the fatal-4xx check,
      // since this is a 400). If the caller lowers max_tokens, retry without
      // counting it as an attempt.
      if (opts.onContextOverflow) {
        const overflow = parseMaxTokensContextOverflowError(error);
        if (overflow || isContextOverflowError(error)) {
          const handled = await opts.onContextOverflow({
            ...overflow,
            statusCode: getStatusCode(error),
            message: getMessage(error),
          });
          if (handled) continue;
          throw error;
        }
      }

      const cls = classifyModelError(error);
      if (cls.kind === 'context_overflow') throw error;
      if (cls.kind === 'fatal') throw error;

      const transient = cls.kind === 'rate_limit' || cls.kind === 'overloaded';

      // Background fast-bail: a non-user-blocking call must not amplify a
      // capacity cascade. Only when attended (unattended jobs still wait).
      if (source === 'background' && cls.kind === 'overloaded' && !opts.unattended) {
        throw error;
      }

      // Consecutive-overload → model fallback (separate from the retry count).
      if (cls.kind === 'overloaded') {
        consecutive529++;
        if (consecutive529 >= MAX_529_RETRIES && opts.fallback) {
          const to = opts.fallback.resolveFallbackModel();
          if (to) {
            const from = opts.currentModel?.();
            await opts.fallback.applyFallbackModel(to);
            await opts.fallback.onDowngrade?.(from, to);
            consecutive529 = 0;
            persistentAttempt = 0;
            // Do not count the swap as a retry attempt.
            continue;
          }
        }
      } else {
        consecutive529 = 0;
      }

      const persistent = opts.unattended && transient;

      let delayMs: number;
      if (persistent) {
        persistentAttempt++;
        const reset = getResetDelayMs(error);
        delayMs = Math.min(
          reset ?? internalBackoffMs(persistentAttempt, PERSISTENT_MAX_BACKOFF_MS),
          resetCapMs,
        );
      } else {
        if (attempt > maxRetries) throw error;
        delayMs =
          cls.retryAfterMs ??
          (opts.computeBackoffMs
            ? opts.computeBackoffMs(attempt, error)
            : internalBackoffMs(attempt, PERSISTENT_MAX_BACKOFF_MS));
      }

      const reportedAttempt = persistent ? persistentAttempt : attempt;
      await opts.onRetryNotice?.(error, reportedAttempt, delayMs, maxRetries);
      if (persistent) {
        await opts.onWait?.({
          delayMs,
          attempt: reportedAttempt,
          statusCode: cls.statusCode,
          kind: cls.kind,
        });
      }

      await chunkedSleep(delayMs, sleepFn, shouldAbort);
      if (shouldAbort()) throw error;

      // Persistent mode never terminates on the attended cap: clamp so the
      // loop continues while persistentAttempt drives backoff growth.
      if (persistent && attempt >= maxRetries) {
        attempt = maxRetries;
      }
    }
  }
}
