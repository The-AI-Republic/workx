# Track 22: Feature Flags & Lazy Loading

**Priority: P2** · **Effort: M** · **Status: NOT STARTED**

> Source: second-pass claudy↔browserx research (2026-05-14). Grounded in a full read of claudy's `feature()` shim and browserx's build define + flag recorder — see "Validation Notes". This is plan.md "Priority 8", confirmed never tracked.

## Problem

BrowserX has **no compile-time feature gating / dead-code elimination**. The two things that look like it are not:

- `__BUILD_MODE__` (`vite.config.mjs:116` `define: { __BUILD_MODE__: JSON.stringify('extension') }`, `vite.config.server.mts:13` `'server'`) — **platform branch selection**, not feature isolation.
- `FeatureFlagRecorder` (`core/session/state/SessionServices.ts:23` interface, `:115` `InMemoryFeatureFlagRecorder`, `:142` `config.featureFlagRecorder ?? (isTest ? new InMemoryFeatureFlagRecorder() : undefined)`) — a **recorder for test/observability attribution**, prod default `undefined`. It *observes* flags; it does not gate or eliminate anything.

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

In production Bun builds `feature('X')` is a **compile-time constant** so `if (feature('X')) { … }` branches are stripped entirely; the dev shim reads env (`envBool`) with `false` defaults. `shims/preload.ts` installs it before app code. Usage (`entrypoints/cli.tsx:100-212`): `if (feature('DAEMON') && args[0]==='--daemon-worker')`, `if (feature('BRIDGE_MODE') && args[0]==='remote-control')` — **the gate guards entrypoint dispatch / a dynamic import**, so a disabled subsystem is both dead-code-eliminated *and* never loaded. Compile-time isolation is cleanly separate from runtime remote gates (GrowthBook), often layered.

## BrowserX Mapping

### The real seam

| Concern | BrowserX location | State |
|---|---|---|
| Constant injection | `vite.config.mjs:115-116`, `vite.config.server.mts:12-13` `define: { __BUILD_MODE__: … }` | **The exact substrate** — Vite `define` constant-folds + tree-shakes; used only for platform today |
| Flag observation | `SessionServices.ts:23-147` `FeatureFlagRecorder` / `InMemoryFeatureFlagRecorder`, prod `undefined` | Attribution only — **not** gating |
| Heavy optional subsystems | Track 21 relay, Track 23 x402, voice, heavy MCP | Bundled unconditionally today |

### Key design decisions (and divergences from claudy)

1. **Vite `define` is browserx's `bun:bundle`.** Add `define: { __FEATURE_<X>__: JSON.stringify(bool) }` per target/env to the existing `vite.config.*`. `core/features/feature.ts` `feature('X')` returns the injected `__FEATURE_X__` constant; a dev fallback reads env (mirrors claudy's `envBool`). Vite already constant-folds + tree-shakes `define` values (proven by `__BUILD_MODE__`) — disabled `if (feature('X'))` branches are eliminated. **Divergence:** mechanism is Vite `define`, not `bun:bundle`; semantics identical.

2. **Gate guards a dynamic import** (port claudy's `cli.tsx` pattern): `if (feature('REMOTE_BRIDGE')) { const m = await import('./remote/relay') }`. Disabled subsystems are *neither bundled nor loaded* — the bundle-size win for the extension.

3. **Two explicit layers; keep `FeatureFlagRecorder`.** Compile-time `feature()` (elimination/isolation) vs runtime flag (rollout). The existing `FeatureFlagRecorder` stays as the runtime *attribution* layer — pair with it, don't replace it (it already exists for exactly that and is otherwise dead in prod).

4. **First feature-gated subsystems:** Track 21 (relay), Track 23 (x402), voice, heavy MCP bridges — the things that must not bloat a default extension build. Prove the bundle-size delta with analysis (don't assume tree-shaking worked).

5. **P2, not P0/P1 — honest scoping.** This is bundle hygiene + experimental isolation, not a correctness gap. `__BUILD_MODE__` + ad-hoc dynamic imports already cover the most urgent need. Land it before Track 21/23 ship so they can ship dark, but it does not block correctness.

### Phase plan

- **Phase 1:** `core/features/feature.ts` backed by Vite `define` (`__FEATURE_*__`); flag registry; CI sets per-target/env defaults; dev env fallback.
- **Phase 2:** convert 2–3 heavy optional subsystems to `feature()`-gated dynamic imports; verify bundle-size reduction with a bundle analyzer.
- **Phase 3:** document the compile-time-vs-runtime split; integrate with `FeatureFlagRecorder` for runtime attribution; require an expiry/removal note per experimental flag.

## Dependencies

- Build config (`vite.config.mjs`, `vite.config.server.mts`, `vite.config.content.mjs`, `vite.config.desktop.mts`) + existing `__BUILD_MODE__` define infra
- **Track 21** (Relay) & **Track 23** (x402): natural first feature-gated subsystems — coordinate so they ship dark
- `SessionServices.FeatureFlagRecorder` (existing) for runtime attribution

## Risks

- Vite constant-folding must actually eliminate the gated `import()` — verify with a bundle analyzer per target, not assumption (the whole value is the size delta).
- Flag sprawl — single registry; mandatory expiry/removal note per experimental flag (claudy carries ~28 and it is already a lot).
- Don't conflate with `__BUILD_MODE__` (platform) or `FeatureFlagRecorder` (attribution) — three distinct concerns; the doc must keep them separate so a future reader doesn't "already have it."
- P2 priority is deliberate — do not let it preempt the P0/P1 tracks; it is an enabler for 21/23, sequenced just before them.

## Validation Notes (verified vs claudy + browserx source, 2026-05-14)

- claudy: `shims/bun-bundle.ts:1-41` (`FEATURE_FLAGS`, `feature()`, `envBool`, compile-time-constant note), `shims/preload.ts`/`macro.ts`; `entrypoints/cli.tsx:100,112,165,185,212` (`feature()`-gated entrypoint/dynamic-import dispatch).
- browserx: `vite.config.mjs:115-116` + `vite.config.server.mts:12-13` (`define: { __BUILD_MODE__ }` — the Vite-define substrate, platform-only); `core/session/state/SessionServices.ts:23` (`FeatureFlagRecorder` interface), `:115` (`InMemoryFeatureFlagRecorder`), `:142` (prod default `undefined` — recorder, not gate).

Corrections vs the first-pass draft:
1. Pinned the exact substrate: browserx already uses Vite `define` for `__BUILD_MODE__` (`vite.config.mjs:116`) — `feature()` is the *same mechanism* extended with `__FEATURE_*__`, not a new build system. The draft said "Vite `define` can replicate" without citing that it is already in use.
2. Verified `FeatureFlagRecorder` is prod-`undefined` recorder-only at `SessionServices.ts:142` — the "looks like coverage but isn't" caveat is now source-pinned, not asserted.
3. Sequenced explicitly before Tracks 21/23 (their dark-ship enabler) while keeping P2 — the draft listed them as dependents without the sequencing implication.
