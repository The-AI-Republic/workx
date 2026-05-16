import type { RateLimitSnapshotEvent } from '../../protocol/events';

/**
 * Rate limit information from API headers
 *
 * Structure with optional primary/secondary windows
 */
export interface RateLimitSnapshot {
  primary?: RateLimitWindow;
  secondary?: RateLimitWindow;
}

/**
 * Individual rate limit window details
 *
 * All fields use snake_case
 */
export interface RateLimitWindow {
  used_percent: number;
  window_minutes?: number;
  resets_in_seconds?: number;
}

/**
 * Creates an empty RateLimitSnapshot
 */
export function createEmptyRateLimitSnapshot(): RateLimitSnapshot {
  return {};
}

/**
 * Creates a RateLimitWindow with specified values
 */
export function createRateLimitWindow(
  usedPercent: number,
  windowMinutes?: number,
  resetsInSeconds?: number
): RateLimitWindow {
  return {
    used_percent: usedPercent,
    window_minutes: windowMinutes,
    resets_in_seconds: resetsInSeconds,
  };
}

/**
 * Creates a RateLimitSnapshot with primary and optional secondary windows
 */
export function createRateLimitSnapshot(
  primary?: RateLimitWindow,
  secondary?: RateLimitWindow
): RateLimitSnapshot {
  return {
    primary,
    secondary,
  };
}

/**
 * Type guard to check if object is a valid RateLimitWindow
 */
export function isRateLimitWindow(obj: any): obj is RateLimitWindow {
  return obj &&
    typeof obj.used_percent === 'number' &&
    (obj.window_minutes === undefined || typeof obj.window_minutes === 'number') &&
    (obj.resets_in_seconds === undefined || typeof obj.resets_in_seconds === 'number');
}

/**
 * Type guard to check if object is a valid RateLimitSnapshot
 */
export function isRateLimitSnapshot(obj: any): obj is RateLimitSnapshot {
  return obj && (
    obj.primary === undefined || isRateLimitWindow(obj.primary)
  ) && (
    obj.secondary === undefined || isRateLimitWindow(obj.secondary)
  ) && (
    obj.primary || obj.secondary
  );
}

/**
 * Validates that a RateLimitSnapshot has at least one window
 */
export function hasValidRateLimitData(snapshot: RateLimitSnapshot): boolean {
  return !!(snapshot.primary || snapshot.secondary);
}

/**
 * Gets the most restrictive rate limit (highest used_percent)
 */
export function getMostRestrictiveWindow(snapshot: RateLimitSnapshot): RateLimitWindow | null {
  if (!snapshot.primary && !snapshot.secondary) {
    return null;
  }

  if (!snapshot.primary) {
    return snapshot.secondary!;
  }

  if (!snapshot.secondary) {
    return snapshot.primary;
  }

  return snapshot.primary.used_percent >= snapshot.secondary.used_percent
    ? snapshot.primary
    : snapshot.secondary;
}

/**
 * Checks if any rate limit is approaching the threshold (default 80%)
 */
export function isApproachingRateLimit(
  snapshot: RateLimitSnapshot,
  threshold: number = 80
): boolean {
  const mostRestrictive = getMostRestrictiveWindow(snapshot);
  return mostRestrictive ? mostRestrictive.used_percent >= threshold : false;
}

/**
 * Track 12: adapt the stored snapshot (optional primary/secondary windows)
 * to the flat, all-required `RateLimitSnapshotEvent` wire shape. The two
 * types are structurally incompatible and there was no converter — a getter
 * alone would not type-check at the TokenCountEvent emit site.
 *
 * Absent-window policy: a missing window zero-fills its fields. The
 * primary/secondary ratio is primary_window / secondary_window * 100 when
 * both window durations are known, else 0.
 */
export function toRateLimitSnapshotEvent(
  snapshot: RateLimitSnapshot
): RateLimitSnapshotEvent {
  const p = snapshot.primary;
  const s = snapshot.secondary;
  const primaryWindow = p?.window_minutes ?? 0;
  const secondaryWindow = s?.window_minutes ?? 0;
  const ratio =
    primaryWindow > 0 && secondaryWindow > 0
      ? Math.round((primaryWindow / secondaryWindow) * 100)
      : 0;
  return {
    primary_used_percent: p?.used_percent ?? 0,
    secondary_used_percent: s?.used_percent ?? 0,
    primary_to_secondary_ratio_percent: ratio,
    primary_window_minutes: primaryWindow,
    secondary_window_minutes: secondaryWindow,
  };
}

/**
 * Track 12: time-relative early-warning thresholds. A warning fires when
 * usage is high *early* in the window — i.e. quota is being burned faster
 * than the window can sustain — so the user is told before rejection.
 * Mirrors claudy's two-tier model (the static `isApproachingRateLimit`
 * covers the server-threshold case; this covers the client-side fallback).
 */
export interface EarlyWarningThreshold {
  /** Fire when used fraction (0-1) >= this... */
  utilization: number;
  /** ...and elapsed fraction of the window (0-1) <= this. */
  timePct: number;
}

export const EARLY_WARNING_THRESHOLDS: EarlyWarningThreshold[] = [
  { utilization: 0.9, timePct: 0.72 },
  { utilization: 0.75, timePct: 0.6 },
  { utilization: 0.5, timePct: 0.35 },
];

/**
 * Suppress warnings below this usage fraction — prevents false alarms from
 * stale post-reset data (claudy uses the same 0.7 floor).
 */
export const EARLY_WARNING_FLOOR = 0.7;

export interface EarlyWarning {
  window: 'primary' | 'secondary';
  used_percent: number;
  time_progress?: number;
  resets_in_seconds?: number;
}

function timeProgress(win: RateLimitWindow): number | undefined {
  if (
    win.window_minutes === undefined ||
    win.window_minutes <= 0 ||
    win.resets_in_seconds === undefined
  ) {
    return undefined;
  }
  const windowSeconds = win.window_minutes * 60;
  const elapsed = windowSeconds - win.resets_in_seconds;
  return Math.max(0, Math.min(1, elapsed / windowSeconds));
}

function evaluateWindow(
  win: RateLimitWindow | undefined,
  label: 'primary' | 'secondary'
): EarlyWarning | null {
  if (!win) return null;
  const util = win.used_percent / 100;
  // Floor: never warn below 70% used, even if a low threshold matches.
  if (util < EARLY_WARNING_FLOOR) return null;
  const tp = timeProgress(win);
  if (tp === undefined) return null;
  const hit = EARLY_WARNING_THRESHOLDS.some(
    (t) => util >= t.utilization && tp <= t.timePct
  );
  if (!hit) return null;
  return {
    window: label,
    used_percent: win.used_percent,
    time_progress: tp,
    resets_in_seconds: win.resets_in_seconds,
  };
}

/**
 * Returns an early warning if either window is burning quota faster than its
 * time window sustains, else null. Primary is checked first.
 */
export function evaluateEarlyWarning(
  snapshot: RateLimitSnapshot
): EarlyWarning | null {
  return (
    evaluateWindow(snapshot.primary, 'primary') ??
    evaluateWindow(snapshot.secondary, 'secondary')
  );
}

/**
 * Formats rate limit information for display
 */
export function formatRateLimitInfo(rateLimitWindow: RateLimitWindow): string {
  const percent = rateLimitWindow.used_percent.toFixed(1);
  const resetInfo = rateLimitWindow.resets_in_seconds
    ? `, resets in ${Math.ceil(rateLimitWindow.resets_in_seconds)}s`
    : '';
  const windowInfo = rateLimitWindow.window_minutes
    ? ` (${rateLimitWindow.window_minutes}min window)`
    : '';

  return `${percent}% used${windowInfo}${resetInfo}`;
}