# Track 22: Feature Flags & Lazy Loading

**Priority: P2** · **Effort: M** · **Status: READY TO IMPLEMENT**

> Source: second-pass claudy↔browserx research (2026-05-14), implementation-readiness + multi-platform pass (2026-05-15). Grounded in a full read of claudy's `feature()` shim and browserx's build define + flag recorder across all three deploy targets — see "Validation Notes". This is plan.md "Priority 8", confirmed never tracked.

## Problem

BrowserX has **no compile-time feature gating / dead-code elimination**. The two things that look like it are not:

- `__BUILD_MODE__` (`vite.config.mjs:116` `'extension'`, `vite.config.server.mts:13` `'server'`, `vite.config.desktop.mts:28` `'desktop'`, `vite.config.content.mjs:12` `'extension'`) — **platform branch selection**, not feature isolation.
- `FeatureFlagRecorder` (`core/session/state/SessionServices.ts:23` interface, `:115` `InMemoryFeatureFlagRecorder`, `:142` prod default `undefined`) — a **recorder for test/observability attribution**. It *observes* flags; it does not gate or eliminate anything.

Experimental subsystems (Track 21 relay, Track 23 x402, voice, heavy MCP bridges) cannot ship dark without bloating the size-critical extension bundle.

## What Claudy Does

`shims/bun-bundle.ts` (41 lines):

```ts
const FEATURE_FLAGS: Record<string, boolean> = {
  BRIDGE_MODE: envBool('CLAUDE_CODE_BRIDGE_MODE', false),
  DAEMON: envBool('CLAUDE_CODE_DAEMON', false),
  VOICE_MODE: envBool('CLAUDE_CODE_VOICE_MODE', false),
  /* …~28 flags… */
}
export function feature(name: string): boolean { return FEATURE_FLAGS[name] ?? false }
```

In production Bun builds `feature('X')` is a **compile-time constant** so `if (feature('X')) { … }` branches are stripped; the dev shim reads env (`envBool`) with `false` defaults. `shims/preload.ts` installs it before app code. Usage (`entrypoints/cli.tsx:100-212`): `if (feature('DAEMON') && args[0]==='--daemon-worker')`, `if (feature('BRIDGE_MODE') && args[0]==='remote-control')` — **the gate guards entrypoint dispatch / a dynamic import**, so a disabled subsystem is both dead-code-eliminated *and* never loaded. Compile-time isolation is cleanly separate from runtime remote gates (GrowthBook), often layered.

## BrowserX Mapping

### The real seam

| Concern | BrowserX location | State |
|---|---|---|
| Constant injection | `vite.config.mjs:115-116`, `vite.config.content.mjs:12`, `vite.config.desktop.mts:28`, `vite.config.server.mts:12-13` `define: { __BUILD_MODE__ }` | **The exact substrate** — Vite `define` constant-folds + tree-shakes; platform-only today |
| Flag observation | `SessionServices.ts:23-147` `FeatureFlagRecorder`, prod `undefined` | Attribution only — **not** gating |
| Env availability | `process.env` on desktop/server; **none in the extension SW** (`logger.ts:12` guards `typeof process`) | Determines where a runtime override is even possible |
| Heavy optional subsystems | Track 21 relay, Track 23 x402, voice, heavy MCP | Bundled unconditionally today |

### Per-Platform Behavior

Four Vite configs, **two of them extension** (`vite.config.mjs` main + `vite.config.content.mjs` content script). The track's *value* and the *override model* differ sharply per target.

- **BrowserX (extension, Chrome MV3).** The reason this track exists. Bundle size is **size-critical**: Chrome Web Store review, and MV3 service-worker cold-start latency scale with bundle size. Heavy optional subsystems (relay/x402/voice/heavy MCP) must default **OFF** and be tree-shaken out of `vite.config.mjs` *and* `vite.config.content.mjs`. **Hard constraint:** the extension SW has no `process.env`, so claudy's `envBool` runtime fallback is impossible here — on the extension a flag is a *pure compile-time constant* baked at build, with **no runtime override**. The bundle-size delta (measure it) is the success metric and it is an extension-only metric.
- **Apple Pi (desktop, Tauri).** `vite.config.desktop.mts`. Bundle size is not Web-Store-policed; lazy loading still trims cold start. `process.env` exists → the `envBool` dev/runtime fallback works. Per-target *defaults differ*: subsystems gated OFF on the extension (e.g. relay host worker, shell-heavy MCP) default **ON** here. So a flag is `(platform default) overridable by env`.
- **Apple Pi Server (headless, Docker/K8s).** `vite.config.server.mts`. Bundle size barely matters (Docker image). Flags matter for **(a)** keeping a production server image from shipping unvetted experimental paths (relay/x402 default OFF until vetted, flipped per-deployment), and **(b)** the **most valuable per-platform lever**: `APPLEPI_FEATURE_*` env vars let an operator flip a flag per K8s deployment **without a rebuild** — exactly claudy's `CLAUDE_CODE_*` env model, viable here precisely because `process.env` exists. This is the natural fleet/staged-rollout knob for the headless server and composes with Track 20 (a flag default can be a managed-policy key).

### Key design decisions (and divergences from claudy)

1. **Vite `define` is browserx's `bun:bundle`, with per-target default maps.** Add `define: { __FEATURE_<X>__: JSON.stringify(bool) }` to **all four** `vite.config.*` from a single `featureDefaults[platform]` map (a flag may default differently per platform — relay OFF on extension, ON on desktop/server). `core/features/feature.ts` `feature('X')` returns the injected `__FEATURE_X__`; a fallback reads `process.env`/`APPLEPI_FEATURE_*` **only where `process.env` exists** (desktop/server) — guard `typeof process` exactly like `logger.ts:12`. Vite already constant-folds + tree-shakes `define` (proven by `__BUILD_MODE__`). **Divergence:** mechanism is Vite `define`, not `bun:bundle`; and the runtime env fallback is desktop/server-only, not universal (claudy assumes env everywhere).
2. **Gate guards a dynamic import** (port claudy's `cli.tsx` pattern): `if (feature('REMOTE_BRIDGE')) { const m = await import('./remote/relay') }`. Disabled subsystems are *neither bundled nor loaded* — the extension bundle-size win.
3. **Two explicit layers; keep `FeatureFlagRecorder`.** Compile-time `feature()` (elimination/isolation) vs runtime flag (rollout/attribution). The existing `FeatureFlagRecorder` stays as the runtime attribution layer — pair with it, don't replace it.
4. **First feature-gated subsystems:** Track 21 (relay), Track 23 (x402), voice, heavy MCP bridges. Prove the extension bundle-size delta with a bundle analyzer (don't assume tree-shaking worked).
5. **P2, honest scoping.** Bundle hygiene + experimental isolation, not a correctness gap. Land before Track 21/23 ship so they ship dark; does not block correctness.

## Implementation Plan (file-level, ordered)

**Phase 1 — `feature()` + per-target defines.**
- `core/features/featureDefaults.ts`: `Record<BuildMode, Record<FlagName, boolean>>` (the per-platform default matrix).
- `core/features/feature.ts`: `feature(name)` → injected `__FEATURE_<name>__`; env fallback `APPLEPI_FEATURE_<name>` guarded by `typeof process !== 'undefined'` (no-op in extension SW).
- Add the `__FEATURE_*__` define block (sourced from `featureDefaults[platform]`, env-overridable on node) to `vite.config.mjs`, `vite.config.content.mjs`, `vite.config.desktop.mts`, `vite.config.server.mts` — mirror the existing `__BUILD_MODE__` define exactly.

**Phase 2 — convert subsystems + verify.**
- Convert 2–3 heavy optional subsystems (Track 21 relay worker, Track 23 x402, one heavy MCP bridge) to `feature()`-gated dynamic imports.
- Run a bundle analyzer on the `extension` build with the flags off; record the byte delta as the acceptance criterion.

**Phase 3 — discipline + attribution.**
- Single flag registry with a mandatory expiry/removal note per experimental flag.
- Wire `feature()` evaluations into `FeatureFlagRecorder` for runtime attribution; document the compile-time-vs-runtime-vs-`__BUILD_MODE__` three-way split so a future reader does not conflate them.

## Dependencies

- Build config (`vite.config.mjs`, `vite.config.content.mjs`, `vite.config.desktop.mts`, `vite.config.server.mts`) + existing `__BUILD_MODE__` define infra.
- **Track 21** (Relay) & **Track 23** (x402): natural first feature-gated subsystems — coordinate so they ship dark.
- **Track 20** (Managed Settings): a flag default can be a managed-policy key (server staged rollout).
- `SessionServices.FeatureFlagRecorder` (existing) for runtime attribution.

## Risks

- Vite constant-folding must actually eliminate the gated `import()` — verify with a bundle analyzer per target (the value is the extension size delta).
- Flag sprawl — single registry; mandatory expiry/removal note (claudy carries ~28 and it is already a lot).
- Don't conflate with `__BUILD_MODE__` (platform) or `FeatureFlagRecorder` (attribution) — three distinct concerns.
- Extension has **no runtime override** (no `process.env`): a wrong extension build default cannot be hot-flipped — extension flag defaults must be conservative (off for anything heavy).
- P2 priority is deliberate — sequence just before Tracks 21/23, don't preempt P0/P1.

## Validation Notes (verified vs claudy + browserx source, 2026-05-14 / multi-platform pass 2026-05-15)

- claudy: `shims/bun-bundle.ts:1-41`; `shims/preload.ts`/`macro.ts`; `entrypoints/cli.tsx:100,112,165,185,212`.
- browserx: `vite.config.mjs:115-116`, `vite.config.content.mjs:12`, `vite.config.desktop.mts:28`, `vite.config.server.mts:12-13` (`define:{__BUILD_MODE__}` — the four-config Vite-define substrate); `core/session/state/SessionServices.ts:23,115,142` (recorder, not gate); `utils/logger.ts:12` (`typeof process` guard — the pattern for the env-fallback guard; proves extension SW has no `process.env`).

Corrections vs the first-pass draft:
1. Pinned the substrate: browserx already uses Vite `define` for `__BUILD_MODE__` across **four** configs — `feature()` is the same mechanism extended with `__FEATURE_*__`, not a new build system.
2. `FeatureFlagRecorder` is prod-`undefined` recorder-only (`SessionServices.ts:142`) — source-pinned.
3. Sequenced before Tracks 21/23 (their dark-ship enabler) while keeping P2.
4. **Multi-platform (2026-05-15):** the bundle-size payoff is overwhelmingly an *extension* concern (Web Store + MV3 SW cold start); near-irrelevant on the server Docker image. Flags need a **per-target default matrix** (a flag may default differently per platform) across all four Vite configs. claudy's `envBool` runtime fallback is **desktop/server-only** (the extension SW has no `process.env`) — on the extension a flag is a pure compile-time constant with no runtime override; on the server `APPLEPI_FEATURE_*` env is the rebuild-free fleet rollout lever (composes with Track 20).
