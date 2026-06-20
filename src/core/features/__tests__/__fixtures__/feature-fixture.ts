// Track 22 regression fixture — mirrors src/core/features/feature.ts exactly:
// a bare typed injected constant (NOT an indexed feature('X') function).
// If anyone changes the real feature.ts to a form that does not constant-fold,
// the matching change here would make the dead-code test fail.
declare const __FEATURE_TESTGATE__: boolean;
export const TESTGATE =
  typeof __FEATURE_TESTGATE__ !== 'undefined' && __FEATURE_TESTGATE__;
