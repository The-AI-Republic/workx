# Track 22: Feature Flags & Lazy Loading

**Priority: P2** · **Effort: M** · **Status: READY TO IMPLEMENT — gated on a Phase-0 spike (see §Phase 0)**

> Source: second-pass claudy↔browserx research (2026-05-14), implementation-readiness + multi-platform pass (2026-05-15), mechanism-correctness + SW-constraint pass (2026-05-16). Grounded in a full read of claudy's `feature()` macro, browserx's Vite `define` substrate, the 80 `__BUILD_MODE__` compile-gate sites, and `src/extension/background/service-worker.ts` in full — see "Validation Notes". This is plan.md "Priority 8", confirmed never tracked. All `path:line` are code-verified vs the working tree on 2026-05-16; browserx paths are relative to `src/` unless they are repo-root `vite.config.*` / `vite.featureFlags.mjs`.

## Problem

BrowserX has **no compile-time feature gating / dead-code elimination**. The two things that look like it are not:

- `__BUILD_MODE__` (`vite.config.mjs:116`, `vite.config.content.mjs:12`, `vite.config.desktop.mts:28`, `vite.config.server.mts:13`) — **platform branch selection**, not feature isolation. It *is* the exact substrate we extend.
- `FeatureFlagRecorder` (`src/core/session/state/SessionServices.ts:23` interface, `:115` `InMemoryFeatureFlagRecorder`, `:142` prod default `undefined`) — a **test/observability recorder**. It is the *runtime* layer (kept and reused), not a gate.

Experimental + heavy-optional subsystems cannot ship dark without bloating the size-critical extension bundle. Concretely, the background service worker today statically imports & eagerly constructs **MCP** (`service-worker.ts:31-33,257`) and **A2A** (`:34-36,269`) — both bundled into `background.js` (1.3 MB) + `chunks/` (5.2 MB) unconditionally.

## What Claudy Does — and why it doesn't port cleanly

`shims/bun-bundle.ts` (41 lines, **24 flags**): `feature('X')` imported from `bun:bundle`, **Bun-macro-inlined** to a literal in prod, so `if (feature('X')) { … }` DCEs; usage (`entrypoints/cli.tsx:100,112,165,185,212`) gates entrypoint dispatch **+ a dynamic `import()`** so a disabled subsystem is *neither bundled nor loaded*. Compile-time isolation is kept strictly separate from the runtime gate (`cli.tsx:110-112`: *"feature() must stay inline for build-time dead code elimination; isBridgeEnabled() checks the runtime GrowthBook gate"*).

**Two reasons this is not a copy-paste:**
1. **No macro.** Vite `define` is textual identifier substitution; it cannot fold `FEATURE_FLAGS[name]` inside a function. Claudy folds only because Bun macro-inlines the call. The portable analogue is browserx's bare-constant pattern (80 `__BUILD_MODE__` sites).
2. **`await import()` is illegal in the extension SW.** Claudy is a Bun CLI. browserx's most size-critical target is a Chrome MV3 service worker, where the HTML spec bans dynamic `import()` (`service-worker.ts:49-51`, `:58`). Claudy's entire "gate a dynamic import" mechanism **does not apply to the SW** — the one target the track exists for. (The codebase is *itself inconsistent* here: `:49-51` declares the ban yet `:992-994` runs a live `await import()` in the SW — Phase 0 must resolve this before Phase 2.)

## BrowserX Mapping

### The real seam

| Concern | BrowserX location | State |
|---|---|---|
| Constant injection | `vite.config.mjs:115-117`, `vite.config.content.mjs:11-13`, `vite.config.desktop.mts:27-29`, `vite.config.server.mts:12-14` `define:{…}` | The substrate — Vite `define` → esbuild/Rollup constant-fold + tree-shake. |
| Proven compile-gate pattern | 80 sites read the bare injected constant directly (`src/config/AgentConfig.ts:76`, `src/core/storage/index.ts:77-96`) | The house pattern we mirror — never wrapped in a function; that is *why* it DCEs. |
| Ambient typing | `src/types/globals.d.ts:14` `declare const __BUILD_MODE__` | Where `__FEATURE_*__` declarations go. |
| Runtime flag layer | `SessionServices.ts:23,142` `FeatureFlagRecorder` (prod `undefined`) | Rollout/attribution — kept; the rebuild-free lever (with Track 20), **not** `feature.ts`. |
| Heavy subsystems in the extension bundle **today** | MCP (`service-worker.ts:31-33,257`), A2A (`:34-36,269`) — static import + eager construct | The concrete Phase-2 proof targets (no dependency on Tracks 21/23). |
| SW dynamic-import ban | `service-worker.ts:49-51,58` (ban) vs `:992-994` (live `await import()`) | **Unresolved contradiction → Phase 0 spike.** |

### Two layers — strictly separated

1. **Compile-time layer (`feature.ts` injected constants).** Code *physically absent* from the artifact. Enables ship-dark + keeps unvetted code out of the server image. **Flipping requires a rebuild — inherent, not a defect.** All four targets.
2. **Runtime layer (`FeatureFlagRecorder` + Track 20 managed policy).** Code *present but inert*; flips **without a rebuild** (per-deployment / staged rollout). The server fleet lever. Does **not** strip bytes.

A subsystem may be *layered* (compile-gated *and* runtime-gated, like claudy's bridge). They never collapse into one switch. The earlier draft's "`APPLEPI_FEATURE_*` gives a rebuild-free flip through `feature.ts`" was wrong: Vite `define` bakes `__FEATURE_*__` into the built artifact, so the `typeof __FEATURE_X__` guard folds at build time and any `process.env` fallback in `feature.ts` is **provably dead in every real build** (fires only in vitest/ts-node). Rebuild-free rollout is the runtime layer's job.

### Per-target mechanism (the central correction)

The gate mechanism is **platform-shaped**, because dynamic `import()` is available in some targets and banned in others:

| Target | Vite config | Dynamic `import()`? | Gate mechanism | OFF result | ON result |
|---|---|---|---|---|---|
| **Extension background SW** | `vite.config.mjs` input `background` (`:125`) | **Banned** (`service-worker.ts:49-51`) — pending Phase 0 | Static top-level import + `if (FLAG) { use… }`. DCE relies on Rollup tree-shaking the now-unreferenced module — **only works if that module + its transitive graph are side-effect-free** (`package.json` `sideEffects`, no top-level side effects). | Module gone from `background.js`/`chunks/` (the headline win — *if* tree-shaking holds; verify) | Module present, eagerly loaded as today |
| **Extension sidepanel / welcome** | `vite.config.mjs` inputs `sidepanel`/`welcome` (`:126-127`) | Allowed (web page) | `if (FLAG) { await import('…') }` (claudy pattern) | Lazy chunk not emitted | Lazy chunk, loaded on demand |
| **Content script** | `vite.config.content.mjs` (`inlineDynamicImports:true` `:39`, iife `:32`) | Syntactically allowed but inlined | `if (FLAG) { await import('…') }` | `if(false)` branch DCE'd, module tree-shaken | Inlined into `content.js` (no lazy chunk) |
| **Desktop** | `vite.config.desktop.mts` | Allowed | dynamic-import lazy chunk | chunk not emitted | lazy chunk |
| **Server** | `vite.config.server.mts` (SSR, `minify:false` `:20`, `ssr.noExternal:[/^@\//]` `:29-36`) | Allowed | dynamic-import; Rollup constant-DCE drops the module | module absent (verify by grepping `dist/server/index.mjs` — no minifier safety net) | module present |

**Consequence:** the SW size win — the track's whole point — depends on **static-import + side-effect-free tree-shaking**, *not* claudy's lazy import. This is strictly weaker and target-specific; it must be proven per subsystem with a bundle analyzer, and a subsystem whose module graph has top-level side effects (event registration, singletons constructed at import) will **not** strip and must be refactored to be import-pure first. MCP/A2A's `*Manager.getInstance()` + `setup*ToolRegistration()` are side-effectful and will need the gate to also remove their *construction sites* (`service-worker.ts:256-275`), not just an import.

### Per-platform defaults

Four configs, two of them extension (`vite.config.mjs` SW/sidepanel/welcome + `vite.config.content.mjs`). Extension defaults are conservatively **OFF** for heavy flags (no runtime override exists in the SW — a wrong default can only be re-published, not hot-flipped). Desktop defaults heavier subsystems **ON**; server defaults experimental OFF (flipped by rebuild for vetting; rebuild-free rollout is the runtime layer). The per-platform default matrix is the single `vite.featureFlags.mjs` (decision 2).

### Key design decisions (and divergences from claudy)

1. **`feature.ts` exposes one typed injected constant per flag — not a `feature('X')` function** (Vite has no Bun macro; see "What Claudy Does"). Mirrors the 80 `__BUILD_MODE__` sites:

   ```ts
   // src/core/features/feature.ts  (only file app code imports)
   declare const __FEATURE_MCP__: boolean;
   declare const __FEATURE_A2A__: boolean;
   declare const __FEATURE_REMOTE_BRIDGE__: boolean;
   declare const __FEATURE_X402__: boolean;
   declare const __FEATURE_VOICE__: boolean;

   // Each export is a literal after `define` runs → robust DCE. The `typeof`
   // guard handles vitest/ts-node only; it is NOT a production runtime override.
   export const MCP           = typeof __FEATURE_MCP__           !== 'undefined' && __FEATURE_MCP__;
   export const A2A           = typeof __FEATURE_A2A__           !== 'undefined' && __FEATURE_A2A__;
   export const REMOTE_BRIDGE = typeof __FEATURE_REMOTE_BRIDGE__ !== 'undefined' && __FEATURE_REMOTE_BRIDGE__;
   export const X402          = typeof __FEATURE_X402__          !== 'undefined' && __FEATURE_X402__;
   export const VOICE         = typeof __FEATURE_VOICE__         !== 'undefined' && __FEATURE_VOICE__;

   export type FlagName = 'MCP' | 'A2A' | 'REMOTE_BRIDGE' | 'X402' | 'VOICE';
   ```

   **No string-keyed `feature(name)`** — it defeats DCE *and* type-safety.

2. **Single dependency-free defaults matrix** at repo root **`vite.featureFlags.mjs`** (the `.mjs` Vite configs cannot import a `.ts`/`@/` module at config-eval time). Pure data + `featureDefine(platform, env)` → `{ "__FEATURE_<NAME>__": JSON.stringify(bool) }`; per-platform `FLAG_DEFAULTS`; imported by all four configs and re-typed for `feature.ts`. `APPLEPI_FEATURE_*` here is a **build-time** knob (changes what is baked → still a rebuild), explicitly not the runtime lever (decision 3).

3. **Keep `FeatureFlagRecorder` as the runtime layer.** It is the rebuild-free per-deployment lever and composes with **Track 20** (a managed-policy key drives a recorder default). `feature.ts` evaluations are reported into it for attribution (Phase 3). Pair, don't replace.

4. **First feature-gated subsystems are MCP + A2A (present in the extension bundle today)**, not relay/x402/voice (which don't exist yet — Tracks 21/23 deferred). MCP/A2A make Phase 2 provable now. relay/x402/voice are follow-on conversions when those tracks land.

5. **P2, honest scoping.** Bundle hygiene + experimental isolation, not a correctness gap. Sequence just before Tracks 21/23 so they ship dark; does not block correctness; does not preempt P0/P1. **End-to-end readiness is gated on the Phase-0 spike** (the SW dynamic-import contradiction + side-effect-free-strip feasibility) — a doc edit cannot substitute for it.

## Implementation Plan (file-level, ordered)

**Phase 0 — prerequisite spike (resolves the only true blocker).** Determine empirically how a feature-gated heavy subsystem can be removed from the **background SW** bundle:
- Resolve the `service-worker.ts:49-51` ("dynamic import banned") vs `:992-994` (live `await import()`) contradiction: does the current Vite config emit a SW-loadable chunk for `:992`, and does it work in a packaged MV3 build at runtime? Determines whether the SW can use the lazy-import path at all or is restricted to static-import + tree-shake.
- Prototype: gate MCP (`service-worker.ts:31-33,256-263`) behind a hard-coded `false` constant via `define`, build `vite.config.mjs`, and bundle-analyze whether `core/mcp/*` actually leaves `background.js` + `chunks/`. If side effects pin it, identify the refactor (make `core/mcp` import-pure; gate the construction sites).
- **Exit:** a one-page decision recording the SW mechanism (lazy-import vs static+treeshake), the measured MCP byte delta, and whether MCP/A2A need import-purity refactors. Phases 1–3 below assume this is answered; if the spike shows the SW cannot strip without large refactors, Track 22's SW value is re-scoped before proceeding.

**Phase 1 — substrate.** `vite.featureFlags.mjs` (matrix + `featureDefine`); `src/types/globals.d.ts` `__FEATURE_*__` decls beside `:14`; `src/core/features/feature.ts` (typed per-flag consts + `FlagName`); spread `featureDefine('<plat>', process.env)` into the `define` of all four configs (`vite.config.mjs:115-117`, `vite.config.content.mjs:11-13`, `vite.config.desktop.mts:27-29`, `vite.config.server.mts:12-14`).

**Phase 2 — convert MCP + A2A, verify per target.** Gate MCP (`service-worker.ts:31-33` imports, `:256-263` construct/auto-connect, `:769-853` `setupMCPToolRegistration`) and A2A (`:34-36`, `:268-275`, `:865-944`) behind `MCP`/`A2A` using the Phase-0-chosen SW mechanism. Bundle-analyze `vite.config.mjs` (background + sidepanel) OFF vs ON; record byte delta (acceptance number). Grep `dist/server/index.mjs` for absence on the server build.

**Phase 3 — discipline + attribution.** `FlagName` union = single registry + mandatory expiry note per experimental flag; report `feature.ts` constants into `FeatureFlagRecorder`; document the three-way split (compile-time `feature.ts` / runtime `FeatureFlagRecorder`+Track 20 / `__BUILD_MODE__`).

## Dependencies

- Build config (all four `vite.config.*`) + `__BUILD_MODE__` infra + `src/types/globals.d.ts:14`.
- **Phase 0 spike** — hard prerequisite for Phase 2 (SW strip mechanism).
- **Track 21/23** — follow-on feature-gated subsystems (ship dark); not needed for Phases 0–3 (MCP/A2A carry the proof).
- **Track 20** — the rebuild-free server rollout lever (runtime layer, not `feature.ts`).
- `SessionServices.FeatureFlagRecorder` (existing) for runtime attribution.

## Risks

- **SW cannot use claudy's dynamic-import model** (`service-worker.ts:49-51`); the size win depends on static-import + side-effect-free tree-shaking, which is strictly weaker and unproven until Phase 0. A side-effectful module graph (MCP/A2A construct singletons + register handlers at init) will not strip without import-purity refactors. **Top risk; Phase 0 exists to retire it.**
- The `service-worker.ts:49-51` vs `:992-994` contradiction means the codebase itself doesn't settle SW dynamic import — no doc can; Phase 0 must.
- `feature.ts` must stay a bare typed export fed by `define`; re-introducing an indexed `feature('X')` silently breaks DCE (regression test in Phase 3).
- Server `minify:false` + `ssr.noExternal:[/^@\//]` — verify absence by grepping `dist/server/index.mjs`, no minifier safety net.
- Content script: OFF-case size win only, no runtime lazy-load (`inlineDynamicImports:true`).
- Flag sprawl — `FlagName` union is the single registry; mandatory expiry note.
- Don't conflate the three layers (compile-time / runtime / `__BUILD_MODE__`).
- Extension has no runtime override — conservative OFF defaults for heavy flags.
- P2 — sequence just before Tracks 21/23, don't preempt P0/P1.

## Validation Notes (verified vs claudy + browserx working tree, 2026-05-14 / 2026-05-15 / 2026-05-16)

- claudy: `shims/bun-bundle.ts:1-41` (24 flags, Bun-macro-inlined `feature()`); `shims/macro.ts` (installs `MACRO`, not `feature`); `entrypoints/cli.tsx:1,100,112,165,185,212` (`feature()` gates + dynamic imports; `:110-112` compile-vs-runtime layering — claudy is a Bun CLI, **no SW constraint**).
- browserx build substrate: `vite.config.mjs:115-117` (+ inputs `:125` background SW, `:126` sidepanel, `:127` welcome), `vite.config.content.mjs:11-13` (+ `:32` iife, `:39` `inlineDynamicImports:true`), `vite.config.desktop.mts:27-29`, `vite.config.server.mts:12-14` (+ `:20` `minify:false`, `:29-36` `ssr.noExternal:[/^@\//]`); `src/types/globals.d.ts:14`; `src/config/AgentConfig.ts:76`, `src/core/storage/index.ts:77-96` (bare-constant compile-gate house pattern); `src/core/session/state/SessionServices.ts:23,142` (runtime recorder, not gate); `src/utils/logger.ts:12` (`typeof process` guard pattern).
- browserx SW ground truth (`src/extension/background/service-worker.ts`): `:31-33` static MCP imports, `:34-36` static A2A imports, `:256-263` MCP construct + auto-connect, `:268-275` A2A construct + auto-connect, `:769-853`/`:865-944` MCP/A2A event-registration side effects, `:49-51`+`:58` "dynamic import banned in SWs", **contradicted by** `:992-994` live `await import()`. dist today: `background.js` 1.3 MB, `chunks/` 5.2 MB, `sidepanel.js` 752 KB.

Corrections vs prior drafts:
1. **SW mechanism (2026-05-16):** claudy's "gate a dynamic import" is illegal in the extension SW (`:49-51`). Per-target mechanism table added; the SW path is static-import + side-effect-free tree-shake, unproven until Phase 0; codebase self-contradiction (`:49-51` vs `:992-994`) is now an explicit prerequisite spike.
2. **Proof targets (2026-05-16):** MCP (`:31-33,257`) + A2A (`:34-36,269`) are in the extension bundle *today* — Phase 2 is provable now without Tracks 21/23 (which are deferred). Earlier "no MCP in browser agent" (`SessionServices.ts`) was misleading.
3. **Mechanism (2026-05-16):** indexed `feature('X')` does not DCE under Vite (Bun-macro-only) → bare typed per-flag constants.
4. **Two-layer split (2026-05-16):** rebuild-free server flip via `feature.ts` env fallback is impossible (define bakes the constant); rebuild-free rollout is the runtime layer + Track 20.
5. **Config wiring (2026-05-16):** matrix moved to dependency-free repo-root `vite.featureFlags.mjs`; `__FEATURE_*__` decls in `src/types/globals.d.ts:14`.
6. **Earlier (2026-05-14/15):** per-target default matrix; bundle payoff is overwhelmingly an extension concern; `FeatureFlagRecorder` prod-`undefined`; claudy count `~28 → 24`; `src/` path prefixes.
