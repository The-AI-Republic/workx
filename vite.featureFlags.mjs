// vite.featureFlags.mjs
//
// Track 22 — single dependency-free feature-flag default matrix.
//
// This file is the ONLY source of compile-time feature defaults. It is plain
// data + one helper, with ZERO `@/`/TypeScript/app imports, so it can be
// imported by the plain `.mjs` Vite configs at Node config-eval time (which
// cannot load a `.ts` or `@/`-aliased module). `src/core/features/feature.ts`
// re-states the same flag set as typed constants for app code.
//
// Two layers — do not conflate (see design.md "Two layers"):
//   - COMPILE-TIME (this file -> Vite `define` -> __FEATURE_*__): code is
//     physically present/absent in the artifact. Flipping requires a REBUILD.
//   - RUNTIME (FeatureFlagRecorder + Track 20): code is present but inert;
//     flips without a rebuild. NOT this file.
//
// `WORKX_FEATURE_<NAME>` env vars override a default at BUILD time only
// (they change what gets baked) — they are a CI/per-build knob, never a
// production runtime override. The extension service worker has no
// `process.env` at all, so an extension flag is a pure baked constant.

/** Canonical flag registry. Keep in sync with feature.ts `FlagName`. */
export const FLAG_NAMES = ['MCP', 'A2A', 'REMOTE_BRIDGE', 'X402', 'VOICE'];

/**
 * Per-platform compile-time defaults.
 *
 * Behavior-preserving rule: a subsystem that ships TODAY defaults ON on every
 * platform it currently ships on, so this track introduces the *ability* to
 * gate it without changing what users get. Only genuinely not-yet-shipping
 * experimental subsystems default OFF.
 *
 *   - MCP / A2A  : shipping in the extension SW today -> ON (gateable; the
 *                  OFF path is exercised by forced-OFF analyzer builds, not by
 *                  default, so this PR is a no-op for users).
 *   - REMOTE_BRIDGE (Track 21) : not built yet -> OFF everywhere; desktop ON
 *                  once it lands (host worker is a desktop concern).
 *   - X402 (Track 23) : not built yet -> OFF everywhere until vetted.
 *   - VOICE      : not built yet -> OFF on extension (size); desktop ON later.
 */
export const FLAG_DEFAULTS = {
  extension: { MCP: true,  A2A: true,  REMOTE_BRIDGE: false, X402: false, VOICE: false },
  desktop:   { MCP: true,  A2A: true,  REMOTE_BRIDGE: true,  X402: false, VOICE: true  },
  server:    { MCP: true,  A2A: false, REMOTE_BRIDGE: false, X402: false, VOICE: false },
};

/**
 * Build the Vite `define` fragment for a platform.
 *
 * @param {keyof typeof FLAG_DEFAULTS} platform
 * @param {Record<string, string | undefined>} [env]  typically process.env
 * @returns {Record<string, string>}  e.g. { __FEATURE_MCP__: "true", ... }
 *          (values are JSON.stringify'd booleans, exactly like __BUILD_MODE__)
 */
export function featureDefine(platform, env = {}) {
  const defaults = FLAG_DEFAULTS[platform];
  if (!defaults) {
    throw new Error(
      `featureDefine: unknown platform "${platform}" (expected one of ${Object.keys(FLAG_DEFAULTS).join(', ')})`
    );
  }
  /** @type {Record<string, string>} */
  const out = {};
  for (const name of FLAG_NAMES) {
    const override = env[`WORKX_FEATURE_${name}`];
    const value =
      override === undefined ? defaults[name] : override === '1' || override === 'true';
    out[`__FEATURE_${name}__`] = JSON.stringify(value);
  }
  return out;
}
