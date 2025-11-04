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
 * Formats rate limit information for display
 */
export function formatRateLimitInfo(window: RateLimitWindow): string {
  const percent = window.used_percent.toFixed(1);
  const resetInfo = window.resets_in_seconds
    ? `, resets in ${Math.ceil(window.resets_in_seconds)}s`
    : '';
  const windowInfo = window.window_minutes
    ? ` (${window.window_minutes}min window)`
    : '';

  return `${percent}% used${windowInfo}${resetInfo}`;
}