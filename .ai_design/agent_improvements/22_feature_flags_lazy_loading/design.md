# Track 22: Feature Flags & Lazy Loading

**Priority: P2** · **Effort: M** · **Status: READY TO IMPLEMENT**

> Source: second-pass claudy↔browserx research (2026-05-14), implementation-readiness + multi-platform pass (2026-05-15), mechanism-correctness pass (2026-05-16). Grounded in a full read of claudy's `feature()` macro and browserx's Vite `define` substrate + the 80 existing `__BUILD_MODE__` compile-gate sites across all four deploy targets — see "Validation Notes". This is plan.md "Priority 8", confirmed never tracked. All `path:line` are code-verified vs the working tree on 2026-05-16; browserx paths are relative to `src/` unless they are repo-root `vite.config.*`.

## Problem

BrowserX has **no compile-time feature gating / dead-code elimination**. The two things that look like it are not:

- `__BUILD_MODE__` (`vite.config.mjs:116` `'extension'`, `vite.config.content.mjs:12` `'extension'`, `vite.config.desktop.mts:28` `'desktop'`, `vite.config.server.mts:13` `'server'`) — **platform branch selection**, not feature isolation. It *is*, however, the exact substrate we extend (see below).
- `FeatureFlagRecorder` (`src/core/session/state/SessionServices.ts:23` interface, `:115` `InMemoryFeatureFlagRecorder`, `:142` prod default `undefined`) — a **recorder for test/observability attribution**. It *observes* flags; it does not gate or eliminate anything. It is the *runtime* layer, kept and reused — not replaced.

Experimental subsystems (Track 21 relay, Track 23 x402, voice, heavy MCP bridges) cannot ship dark without bloating the size-critical extension bundle.

## What Claudy Does

`shims/bun-bundle.ts` (41 lines, **24 flags**):

```ts
const FEATURE_FLAGS: Record<string, boolean> = {
  BRIDGE_MODE: envBool('CLAUDE_CODE_BRIDGE_MODE', false),
  DAEMON:      envBool('CLAUDE_CODE_DAEMON', false),
  VOICE_MODE:  envBool('CLAUDE_CODE_VOICE_MODE', false),
  /* …24 total… */
}
export function feature(name: string): boolean { return FEATURE_FLAGS[name] ?? false }
```

`feature` is imported from `bun:bundle` (`entrypoints/cli.tsx:1`), resolved via a **Bun bundler alias**, and in production Bun builds **`feature('X')` is treated as a compile-time macro** — the call is inlined to a literal, so `if (feature('X')) { … }` branches are dead-code-eliminated. `shims/preload.ts`/`macro.ts` install the *`MACRO`* globals (version, URLs) for the dev path; the `feature()` resolution is the build alias, **not** `preload`. Usage (`entrypoints/cli.tsx:100,112,165,185,212`): `if (feature('DAEMON') && args[0]==='--daemon-worker')`, `if (feature('BRIDGE_MODE') && (args[0]==='remote-control' || …))` — **the gate guards entrypoint dispatch + a dynamic import**, so a disabled subsystem is both dead-code-eliminated *and* never loaded. Compile-time isolation is kept **cleanly separate** from the runtime remote gate: `cli.tsx:110-112` — *"feature() must stay inline for build-time dead code elimination; isBridgeEnabled() checks the runtime GrowthBook gate"* — the two are layered, never merged.

**The non-portable bit:** claudy's `feature('X')` constant-folds *only because Bun macro-inlines the call*. Vite/Rollup has no equivalent for an object-indexed function return (`FEATURE_FLAGS[name]`) — see "Key design decisions" #1. The portable analogue is browserx's already-proven bare-constant pattern.

## BrowserX Mapping

### The real seam

| Concern | BrowserX location | State |
|---|---|---|
| Constant injection | `vite.config.mjs:115-117`, `vite.config.content.mjs:11-13`, `vite.config.desktop.mts:27-29`, `vite.config.server.mts:12-14` `define:{ __BUILD_MODE__ }` | **The exact substrate** — Vite `define` is textual identifier substitution; esbuild/Rollup then constant-fold + tree-shake. Platform-only today. |
| Proven compile-gate pattern | 80 sites read the bare injected constant directly, e.g. `src/config/AgentConfig.ts:76`, `src/core/storage/index.ts:77-96`, `src/storage/rollout/provider/createRolloutStorageProvider.ts:15-37` (`if (__BUILD_MODE__ === 'extension')`) | **The house pattern we mirror** — never wrapped in a `mode('x')` function; that is *why* it DCEs. |
| Ambient typing | `src/types/globals.d.ts:14` `declare const __BUILD_MODE__: …` | Where `__FEATURE_*__` declarations must be added so app code typechecks. |
| Runtime flag layer | `SessionServices.ts:23-147` `FeatureFlagRecorder`, prod `undefined` | Attribution / rollout — **kept**, this is the no-rebuild lever (with Track 20), *not* `feature()`. |
| Env availability | `process.env` on desktop/server; **none in the extension SW** (`src/utils/logger.ts:12` guards `typeof process`) | Only relevant to the test/ts-node fallback (see #1) — not a production runtime override. |
| Heavy optional subsystems | Track 21 relay, Track 23 x402, voice, heavy MCP | Bundled unconditionally today. |

### Two layers — strictly separated (the central correction)

This track has **two non-interchangeable concepts**. Conflating them is the trap; claudy avoids it (`cli.tsx:110-112`) and so must we:

1. **Compile-time layer (`feature.ts` injected constants).** Turns code *physically absent* from the artifact. Enables ship-dark + keeps unvetted code out of the server image. **Flipping it requires a rebuild — that is inherent, not a defect.** Applies to all four targets.
2. **Runtime layer (`FeatureFlagRecorder` + Track 20 managed policy).** Code is *present but inert*; flips **without a rebuild** (per-deployment / staged rollout). This is the server fleet lever. It does **not** strip bytes.

A subsystem may be **layered** (compile-gated *and* runtime-gated, like claudy's bridge). They are never the same switch and never collapse into one. The earlier draft's claim that `APPLEPI_FEATURE_*` env vars give a *rebuild-free* flip *through `feature.ts`* was wrong: Vite `define` bakes `__FEATURE_*__` into the built artifact, so the `typeof __FEATURE_X__` guard folds to a literal at build time and any `process.env` fallback in `feature.ts` is **provably dead in every real build** — it can fire only in vitest/ts-node where `define` is absent. Rebuild-free rollout is the **runtime layer's** job, not `feature()`'s.

### Per-Platform Behavior

Four Vite configs, **two of them extension** (`vite.config.mjs` main SW/UI + `vite.config.content.mjs` content script).

- **BrowserX extension (Chrome MV3) — the reason this track exists.** Bundle size is size-critical (Web Store review + MV3 SW cold start). Heavy optional subsystems default **OFF** and must be DCE'd from `vite.config.mjs` *and* `vite.config.content.mjs`. **Two sub-behaviors:**
  - `vite.config.mjs` (background SW + sidepanel + welcome, code-split, `entryFileNames`/`chunkFileNames`): a gated `await import()` becomes a **lazy chunk** → OFF = DCE'd & absent; ON = present but not loaded until the gate runs. Both claudy benefits hold.
  - `vite.config.content.mjs` (`build.lib`, `formats:['iife']` `:32`, `inlineDynamicImports:true` `:39`): **no code-splitting** — dynamic imports are inlined. OFF = the `if(false)` branch is DCE'd and the now-unreferenced module is tree-shaken (size win holds). ON = code is **inlined into `content.js`**, *not* a lazy chunk (no runtime lazy-load benefit on the content script). The bundle-size delta is the metric on both.
  - **Hard constraint:** the extension SW has no `process.env`; on the extension a flag is a *pure compile-time constant baked at build, with no runtime override at all*. Extension defaults must be conservative (OFF for anything heavy) because a wrong extension default cannot be hot-flipped — only re-published.
- **Apple Pi desktop (Tauri), `vite.config.desktop.mts`.** Not Web-Store-policed; lazy loading still trims cold start (code-split, like `vite.config.mjs`). Per-target *defaults differ*: subsystems OFF on the extension (relay host worker, shell-heavy MCP) default **ON** here. Rebuild-free flips go through the runtime layer, same as server.
- **Apple Pi Server (headless, Docker/K8s), `vite.config.server.mts`.** SSR build, `minify:false` (`:20`), `ssr.noExternal:[/^@\//]` (`:29-36`) forces every `@/`-aliased module *into* the bundle unless tree-shaken. Bundle size barely matters; the compile layer's value here is **(a)** keeping a production image from shipping unvetted experimental paths (relay/x402 default OFF until vetted; **flipped by a rebuild**, by design). The **rebuild-free fleet/staged-rollout lever is the runtime layer** (`FeatureFlagRecorder` + Track 20 managed-policy key), *not* `feature()`. Because `minify:false` removes the minifier's dead-branch pass, the server acceptance check is an explicit **grep of `dist/server/index.mjs`** confirming the OFF subsystem's module is absent (Rollup's own constant-condition DCE + tree-shaking still drop it; we verify, not assume).

### Key design decisions (and divergences from claudy)

1. **`feature.ts` exposes one typed injected constant per flag — mirroring the 80 `__BUILD_MODE__` sites — not a `feature('X')` indexed function.** Vite `define` is identifier substitution; it replaces a bare token `__FEATURE_REMOTE_BRIDGE__`, but it **cannot** see through `FEATURE_FLAGS[name]` inside a function, and Rollup/esbuild will not constant-fold an object-indexed return across a call boundary. Claudy's `feature('X')` only folds because **Bun macro-inlines it** — no Vite equivalent without a custom transform plugin (rejected for P2; revisit only if call-site ergonomics demand it). So:

   ```ts
   // src/core/features/feature.ts  (only file app code imports)
   declare const __FEATURE_REMOTE_BRIDGE__: boolean;
   declare const __FEATURE_X402__: boolean;
   declare const __FEATURE_VOICE__: boolean;
   declare const __FEATURE_MCP_HEAVY__: boolean;

   // Each export is a literal after `define` runs → robust DCE.
   // The `typeof` guard handles vitest/ts-node where `define` is absent;
   // it is NOT a production runtime override (see "Two layers").
   export const REMOTE_BRIDGE = typeof __FEATURE_REMOTE_BRIDGE__ !== 'undefined' && __FEATURE_REMOTE_BRIDGE__;
   export const X402          = typeof __FEATURE_X402__          !== 'undefined' && __FEATURE_X402__;
   export const VOICE         = typeof __FEATURE_VOICE__         !== 'undefined' && __FEATURE_VOICE__;
   export const MCP_HEAVY     = typeof __FEATURE_MCP_HEAVY__     !== 'undefined' && __FEATURE_MCP_HEAVY__;

   export type FlagName = 'REMOTE_BRIDGE' | 'X402' | 'VOICE' | 'MCP_HEAVY';
   ```

   Call site (mirrors `if (__BUILD_MODE__ === 'extension')`):

   ```ts
   import { REMOTE_BRIDGE } from '@/core/features/feature';
   if (REMOTE_BRIDGE) { const { startRelay } = await import('./remote/relay'); await startRelay(); }
   ```

   With `define` setting `__FEATURE_REMOTE_BRIDGE__ → false`, the export folds to `false`, the `if` branch is DCE'd, and `./remote/relay` is tree-shaken out — verified per target with a bundle analyzer. **Divergences from claudy:** (i) mechanism is Vite `define` + bare typed constants, not a `bun:bundle` macro; (ii) no `feature('X')` string API (it would defeat both DCE and type-safety); (iii) the env/`typeof` fallback is test/ts-node-only, not a universal runtime read.

2. **Single dependency-free defaults matrix, shared by configs and `feature.ts`.** The per-platform default map cannot live in `src/core/features/featureDefaults.ts`: `vite.config.mjs` and `vite.config.content.mjs` are plain `.mjs` loaded by Node at config-eval time and **cannot import a `.ts` file or anything using the `@/` alias**. It lives at repo root as **`vite.featureFlags.mjs`** — pure data + a `featureDefine(platform)` helper, **zero app imports** — imported by all four Vite configs *and* re-exported (with `FlagName`) for typing. Shape:

   ```js
   // vite.featureFlags.mjs  (repo root, no @/ imports, loadable by .mjs configs)
   export const FLAG_DEFAULTS = {
     extension: { REMOTE_BRIDGE: false, X402: false, VOICE: false, MCP_HEAVY: false },
     desktop:   { REMOTE_BRIDGE: true,  X402: false, VOICE: true,  MCP_HEAVY: true  },
     server:    { REMOTE_BRIDGE: false, X402: false, VOICE: false, MCP_HEAVY: true  },
   };
   // → { __FEATURE_REMOTE_BRIDGE__: "false", … }  spread into each config's `define`
   export function featureDefine(platform, env = {}) {
     const out = {};
     for (const [name, def] of Object.entries(FLAG_DEFAULTS[platform])) {
       const ov = env[`APPLEPI_FEATURE_${name}`];          // build-time override only
       const val = ov === undefined ? def : ov === '1' || ov === 'true';
       out[`__FEATURE_${name}__`] = JSON.stringify(val);
     }
     return out;
   }
   ```

   `APPLEPI_FEATURE_*` here is a **build-time** knob (CI/per-build), explicitly *not* a runtime one — it changes what gets baked, so flipping it still means a rebuild. The genuinely rebuild-free server lever is decision 3.

3. **Keep `FeatureFlagRecorder`; it is the runtime layer.** Compile-time `feature.ts` (elimination/isolation) vs runtime flag (rollout/attribution). `FeatureFlagRecorder` (`SessionServices.ts:23`, prod `undefined`) stays as the runtime layer and is the **rebuild-free** per-deployment lever, composing with **Track 20** (a managed-policy key can drive a recorder default for staged server rollout). `feature.ts` evaluations are reported into it for attribution (Phase 3). Pair, don't replace.

4. **First feature-gated subsystems:** Track 21 (relay), Track 23 (x402), voice, heavy MCP bridges. Prove the extension bundle-size delta with a bundle analyzer on *both* extension configs (don't assume tree-shaking worked).

5. **P2, honest scoping.** Bundle hygiene + experimental isolation, not a correctness gap. Land just before Tracks 21/23 so they ship dark; does not block correctness; does not preempt P0/P1.

## Implementation Plan (file-level, ordered)

**Phase 1 — substrate: matrix, defines, ambient types, `feature.ts`.**
- `vite.featureFlags.mjs` (repo root): `FLAG_DEFAULTS` per-platform map + `featureDefine(platform, env)` (decision 2). No `@/`/TS imports.
- `src/types/globals.d.ts`: add `declare const __FEATURE_<NAME>__: boolean;` for every flag, beside the existing `__BUILD_MODE__` declaration (`:14`).
- `src/core/features/feature.ts`: one exported typed `const` per flag + `FlagName` union (decision 1). No string API; no object indexing.
- Add `...featureDefine('<platform>', process.env)` into the `define` block of **all four** configs next to `__BUILD_MODE__`: `vite.config.mjs:115-117` (`extension`), `vite.config.content.mjs:11-13` (`extension`), `vite.config.desktop.mts:27-29` (`desktop`), `vite.config.server.mts:12-14` (`server`).

**Phase 2 — convert subsystems + verify per target.**
- Convert 2–3 heavy optional subsystems (Track 21 relay worker, Track 23 x402, one heavy MCP bridge) to the `if (FLAG) { await import(...) }` pattern at their entrypoint seams.
- Bundle-analyze `extension` (`vite.config.mjs` chunks **and** `vite.config.content.mjs` `content.js`) flags-OFF vs a forced-ON build; record the byte delta — the acceptance criterion.
- Grep `dist/server/index.mjs` (built `vite.config.server.mts`, `minify:false`) to confirm an OFF subsystem's module is absent (no minifier safety net there).

**Phase 3 — discipline + attribution.**
- The `FlagName` union in `feature.ts` is the single flag registry; add a mandatory expiry/removal note per experimental flag (a comment block listing flag → owning track → remove-by condition).
- Report each `feature.ts` constant into `FeatureFlagRecorder` for runtime attribution; document the three-way split (compile-time `feature.ts` vs runtime `FeatureFlagRecorder`/Track 20 vs `__BUILD_MODE__` platform) so a future reader cannot conflate them.

## Dependencies

- Build config (all four `vite.config.*`) + existing `__BUILD_MODE__` `define` infra + `src/types/globals.d.ts:14`.
- **Track 21** (Relay) & **Track 23** (x402): natural first feature-gated subsystems — coordinate so they ship dark.
- **Track 20** (Managed Settings): the rebuild-free server rollout lever — a managed-policy key drives a `FeatureFlagRecorder` default (the runtime layer, not `feature.ts`).
- `SessionServices.FeatureFlagRecorder` (existing) for runtime attribution + rollout.

## Risks

- Vite/Rollup must actually eliminate the gated `import()` — **verify with a bundle analyzer per target** (extension main + content); the value is the extension size delta. Do not assume.
- The `feature.ts` constant must remain a *bare typed export* fed by `define`. Re-introducing a `feature('X')` indexed function silently breaks DCE (the headline failure mode) — enforce via review + a test asserting an OFF module is absent from a built bundle.
- Server `minify:false` (`vite.config.server.mts:20`) + `ssr.noExternal:[/^@\//]` (`:29-36`) — Rollup's own DCE/tree-shaking still drops the module, but verify by grepping the built `dist/server/index.mjs`; don't rely on a minifier pass that isn't there.
- Content script (`inlineDynamicImports:true`) gives an OFF-case size win but **no runtime lazy-load** — don't promise lazy loading there.
- Flag sprawl — the `FlagName` union is the single registry; mandatory expiry/removal note (claudy carries 24 and it is already a lot).
- Don't conflate the three layers: compile-time `feature.ts` (rebuild to flip, by design) vs runtime `FeatureFlagRecorder`/Track 20 (rebuild-free) vs `__BUILD_MODE__` (platform).
- Extension has **no runtime override**: a wrong extension build default cannot be hot-flipped — extension defaults must be conservative (OFF for anything heavy).
- P2 priority is deliberate — sequence just before Tracks 21/23, don't preempt P0/P1.

## Validation Notes (verified vs claudy + browserx working tree, 2026-05-14 / multi-platform 2026-05-15 / mechanism-correctness 2026-05-16)

- claudy: `shims/bun-bundle.ts:1-41` (**24 flags**, `feature()` Bun macro-inlined); `shims/macro.ts` installs the `MACRO` globals; `shims/preload.ts` imports `macro` and notes `bun:bundle` is the *build alias* (not preload); `entrypoints/cli.tsx:1` (`import { feature } from 'bun:bundle'`), `:100,112,165,185,212` (`feature()` gates guarding dynamic imports), `:110-112` (explicit compile-vs-runtime/GrowthBook layering — the model this track copies).
- browserx: `vite.config.mjs:115-117`, `vite.config.content.mjs:11-13` (+ `:32` iife, `:39` `inlineDynamicImports:true`), `vite.config.desktop.mts:27-29`, `vite.config.server.mts:12-14` (+ `:20` `minify:false`, `:29-36` `ssr.noExternal:[/^@\//]`) — the four-config `define` substrate; `src/types/globals.d.ts:14` (`__BUILD_MODE__` ambient decl — where `__FEATURE_*__` go); `src/config/AgentConfig.ts:76`, `src/core/storage/index.ts:77-96`, `src/storage/rollout/provider/createRolloutStorageProvider.ts:15-37` (3 of 80 bare-constant compile-gate sites — the house pattern); `src/core/session/state/SessionServices.ts:23,115,142` (recorder = runtime layer, not gate); `src/utils/logger.ts:12` (`typeof process` guard — the test/ts-node fallback pattern; proves the extension SW has no `process.env`).

Corrections vs prior drafts:
1. **Mechanism (2026-05-16):** `feature('X')` as an indexed function does **not** DCE under Vite (Bun-macro-only). Replaced with bare typed per-flag injected constants mirroring the 80 existing `__BUILD_MODE__` sites — the only form proven to fold + tree-shake here.
2. **Two-layer split (2026-05-16):** the `APPLEPI_FEATURE_*` "rebuild-free server flip via `feature.ts` `process.env` fallback" was impossible — `define` bakes the constant, so that fallback is dead in every real build. Rebuild-free rollout is the runtime layer (`FeatureFlagRecorder` + Track 20); compile flips inherently need a rebuild. The two server goals (keep-out-of-image vs rebuild-free rollout) are not the same flag.
3. **Config wiring (2026-05-16):** the defaults matrix moved out of `src/core/features/*.ts` (un-importable by `.mjs` configs) into a dependency-free repo-root `vite.featureFlags.mjs` with a `featureDefine()` helper; `__FEATURE_*__` ambient decls added to `src/types/globals.d.ts:14`.
4. **Content-script nuance (2026-05-16):** `inlineDynamicImports:true` → OFF-case DCE works on the content script but there is **no** runtime lazy-load there; the lazy-chunk benefit is `vite.config.mjs`/desktop only.
5. **Multi-platform (2026-05-15):** per-target default matrix across all four configs; the bundle payoff is overwhelmingly an extension concern (Web Store + MV3 SW cold start), near-irrelevant on the server Docker image.
6. **Source pins (2026-05-14/15):** `FeatureFlagRecorder` is prod-`undefined` recorder-only (`SessionServices.ts:142`); sequenced before Tracks 21/23 while keeping P2; claudy flag count corrected `~28 → 24`; all browserx paths prefixed `src/`.
