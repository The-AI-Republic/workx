/**
 * Track 22 — compile-time feature flags.
 *
 * The ONLY module app code imports for compile-time feature gating.
 *
 * Mechanism (diverges from claudy on purpose):
 *   claudy's `feature('X')` folds only because Bun macro-inlines the call.
 *   Vite `define` is textual identifier substitution and cannot fold an
 *   object-indexed function return, so we mirror workx's proven house
 *   pattern instead: ONE bare typed injected constant per flag (exactly how
 *   the 80 `__BUILD_MODE__` sites work, e.g. src/config/AgentConfig.ts:76).
 *
 *   Each `export const` collapses to a literal after Vite `define` replaces
 *   `__FEATURE_<NAME>__`, so `if (FLAG) { ... }` is dead-code-eliminated and
 *   the gated module is tree-shaken. The `typeof ... !== 'undefined'` guard
 *   only matters under vitest/ts-node where `define` is absent — it is NOT a
 *   production runtime override (the constant is baked at build time).
 *
 *   Do NOT reintroduce a string-keyed `feature(name)` indexed function: it
 *   defeats both DCE (the headline failure mode) and type-safety. See the
 *   regression test in feature.deadcode.test.ts.
 *
 * Three distinct layers — never conflate (design.md "Two layers"):
 *   1. COMPILE-TIME — this file. Code physically absent when OFF. Flip = rebuild.
 *   2. RUNTIME — SessionServices.FeatureFlagRecorder + Track 20 managed policy.
 *      Code present but inert; flips WITHOUT a rebuild. The fleet/rollout lever.
 *   3. PLATFORM — __BUILD_MODE__ ('extension' | 'desktop' | 'server'). Which
 *      product, not which feature.
 *
 * ── Flag registry (single source of truth; keep in sync with
 *    vite.featureFlags.mjs FLAG_NAMES). Every experimental flag MUST carry an
 *    owning track + remove-by condition: ───────────────────────────────────
 *   MCP           — existing subsystem; gate is permanent (product tiering).
 *   A2A           — existing subsystem; gate is permanent (product tiering).
 *   REMOTE_BRIDGE — Track 21; remove the gate once relay GAs on all targets.
 *   X402          — Track 23; remove the gate once agentic payments GA.
 *   VOICE         — voice mode; remove the gate once voice GAs.
 */

declare const __FEATURE_MCP__: boolean;
declare const __FEATURE_A2A__: boolean;
declare const __FEATURE_REMOTE_BRIDGE__: boolean;
declare const __FEATURE_X402__: boolean;
declare const __FEATURE_VOICE__: boolean;

/** MCP (Model Context Protocol) bridge subsystem. */
export const MCP = typeof __FEATURE_MCP__ !== 'undefined' && __FEATURE_MCP__;

/** A2A (agent-to-agent) bridge subsystem. */
export const A2A = typeof __FEATURE_A2A__ !== 'undefined' && __FEATURE_A2A__;

/** Track 21 — remote bridge / relay host. */
export const REMOTE_BRIDGE =
  typeof __FEATURE_REMOTE_BRIDGE__ !== 'undefined' && __FEATURE_REMOTE_BRIDGE__;

/** Track 23 — agentic payments (x402). */
export const X402 = typeof __FEATURE_X402__ !== 'undefined' && __FEATURE_X402__;

/** Voice mode. */
export const VOICE = typeof __FEATURE_VOICE__ !== 'undefined' && __FEATURE_VOICE__;

/** Canonical flag name union — the single registry at the type level. */
export type FlagName = 'MCP' | 'A2A' | 'REMOTE_BRIDGE' | 'X402' | 'VOICE';

/**
 * Snapshot of every flag's compile-time value. Use ONLY for runtime
 * attribution (reporting into FeatureFlagRecorder) — never gate on
 * `FLAG_SNAPSHOT[name]`, that is an indexed lookup that does not DCE. Gate on
 * the bare `MCP` / `A2A` / ... consts above.
 */
export const FLAG_SNAPSHOT: Readonly<Record<FlagName, boolean>> = {
  MCP,
  A2A,
  REMOTE_BRIDGE,
  X402,
  VOICE,
};

/**
 * Runtime-attribution bridge (layer 2). Reports every compile-time flag's
 * baked value into a FeatureFlagRecorder when one is present. Structural
 * param type (not an import of SessionServices) to avoid an import cycle.
 * No-op when no recorder is supplied (prod default — SessionServices.ts:142).
 *
 * This is attribution only: it records what the build baked. It does NOT
 * gate anything and is NOT the rebuild-free rollout lever (that is the
 * recorder/Track 20 managed policy deciding a flag's runtime treatment).
 */
export function reportFeatureFlags(
  recorder?: { record(feature: string, enabled: boolean): void }
): void {
  if (!recorder) return;
  for (const name of Object.keys(FLAG_SNAPSHOT) as FlagName[]) {
    recorder.record(name, FLAG_SNAPSHOT[name]);
  }
}
