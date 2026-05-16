# Track 22 — Tasks

Implements [Track 22: Feature Flags & Lazy Loading](./design.md). All `path:line`
are code-verified vs the working tree on 2026-05-16 (see design "Validation
Notes"). Browserx paths are relative to `src/` unless they are repo-root
`vite.config.*` / `vite.featureFlags.mjs`. Track 22 is the **dark-ship enabler**
for Tracks 21/23 — land Phases 1–3 before they ship; it is P2 and blocks no
correctness path.

## Phase 1 — Substrate: matrix, defines, ambient types, `feature.ts`

- [ ] 1.1 New repo-root `vite.featureFlags.mjs` (Decision 2): `FLAG_DEFAULTS:
      { extension|desktop|server: Record<FlagName, boolean> }` (extension =
      conservative OFF for heavy flags); `featureDefine(platform, env = {})` →
      `{ "__FEATURE_<NAME>__": JSON.stringify(bool) }`, applying a **build-time**
      `APPLEPI_FEATURE_<NAME>` env override (`'1'|'true'`). **Pure data + helper,
      zero `@/`/TS imports** — must be loadable by plain `.mjs` configs at Node
      config-eval time. Seed flags: `REMOTE_BRIDGE`, `X402`, `VOICE`, `MCP_HEAVY`.
- [ ] 1.2 `src/types/globals.d.ts`: beside `declare const __BUILD_MODE__` (`:14`,
      and the `declare global` block `:20`) add `declare const __FEATURE_<NAME>__:
      boolean;` for every flag (mirror both decl forms `__BUILD_MODE__` uses).
- [ ] 1.3 New `src/core/features/feature.ts` (Decision 1): one
      `export const <FLAG> = typeof __FEATURE_<FLAG>__ !== 'undefined' &&
      __FEATURE_<FLAG>__;` per flag + `export type FlagName = …` union (the single
      registry). **No `feature(name: string)`, no object indexing** — that silently
      breaks DCE and is the headline failure mode (Risk 2).
- [ ] 1.4 Wire `define` in all four configs — spread `...featureDefine('<plat>',
      process.env)` next to the existing `__BUILD_MODE__` entry, byte-for-byte
      symmetric: `vite.config.mjs:115-117` (`extension`),
      `vite.config.content.mjs:11-13` (`extension`),
      `vite.config.desktop.mts:27-29` (`desktop`),
      `vite.config.server.mts:12-14` (`server`). Import `featureDefine` from
      `./vite.featureFlags.mjs` in each (works for both `.mjs` and `.mts`).
- [ ] 1.5 Tests (`src/core/features/__tests__/feature.test.ts`): with `define`
      absent (vitest) every export is `false` via the `typeof` guard (no throw, no
      `process.env` dependence); `FlagName` union exactly equals the exported
      const set (compile-time exhaustiveness pin); `vite.featureFlags.mjs`
      `featureDefine('extension')` returns all heavy flags `"false"`, and an
      `APPLEPI_FEATURE_X402=1` env flips only that key.

## Phase 2 — Convert subsystems + verify per target

- [ ] 2.1 Track 21 relay: at the relay-host entry seam replace the static import
      with `import { REMOTE_BRIDGE } from '@/core/features/feature'; if
      (REMOTE_BRIDGE) { const m = await import('<relay entry>'); … }`. Specifier
      must be a **static string literal** (Rollup can't tree-shake a computed
      one). Coordinate with Track 21 (do not invent the relay module here — gate
      its existing/landing entrypoint).
- [ ] 2.2 Track 23 x402: same `if (X402) { await import(...) }` shape at the x402
      entry seam. No-op + zero bytes when OFF; Track 22 must not assume x402's
      internals.
- [ ] 2.3 One heavy MCP bridge: same shape behind `MCP_HEAVY` at its registration
      seam (the heaviest optional bridge; pick via the Phase-2 analyzer in 2.4).
- [ ] 2.4 Extension bundle-analyzer gate: build `vite.config.mjs` (inspect
      code-split `chunks/`) **and** `vite.config.content.mjs` (`dist/content.js`,
      `inlineDynamicImports:true` — no chunk, DCE only) with flags OFF vs a
      forced-ON build (`APPLEPI_FEATURE_*=1`). Record the byte delta per config —
      **this is the acceptance number**. OFF build must contain none of the gated
      modules' identifiers.
- [ ] 2.5 Server absence check: build `vite.config.server.mts` flags-OFF
      (`minify:false` `:20`, `ssr.noExternal:[/^@\//]` `:29-36` forces `@/`
      modules in unless tree-shaken). `grep` `dist/server/index.mjs` to assert the
      OFF subsystem's module/source is absent (Rollup constant-condition DCE +
      tree-shaking still drop it; no minifier safety net — verify, don't assume).
- [ ] 2.6 Desktop spot-check: `vite.config.desktop.mts` build with relay/MCP
      defaults ON (Decision: desktop differs from extension) loads/lazy-chunks
      correctly; OFF flag still DCE'd. Confirms the per-target matrix wired right.

## Phase 3 — Discipline + attribution

- [ ] 3.1 In `feature.ts` add a mandatory registry comment block: each `FlagName`
      → owning track → remove-by condition (e.g. `X402 — Track 23 — delete gate
      once x402 GA, flag and define removed`). PR review rejects a new flag
      without this line (the single-registry discipline; claudy carries 24).
- [ ] 3.2 Wire runtime attribution: where a `feature.ts` constant gates a
      subsystem, also report it through `SessionServices.featureFlagRecorder`
      (`SessionServices.ts:23` `record(feature, enabled)`) when a recorder is
      present (prod default `undefined` `:142` — guard, no-op when absent). This
      is the runtime layer (Decision 3), distinct from the compile gate.
- [ ] 3.3 Doc + guard the three-way split so it can't regress: a comment in
      `feature.ts` (and a `globals.d.ts:14` note) stating compile-time
      `feature.ts` (rebuild to flip, DCE) vs runtime `FeatureFlagRecorder`/Track
      20 (rebuild-free rollout) vs `__BUILD_MODE__` (platform) are three distinct
      concerns. Compose the rebuild-free server lever with **Track 20** (a
      managed-policy key drives a recorder default) — note the seam, do not
      implement Track 20 here.
- [ ] 3.4 Regression test (Risk 2 enforcement): a build-output test that compiles
      a fixture gating `await import('./fixture-heavy')` behind an OFF flag and
      asserts `fixture-heavy`'s marker string is absent from the emitted bundle —
      fails loudly if anyone reverts to an indexed `feature()` form that defeats
      DCE.

## Exit criteria

- `feature.ts` exposes one bare typed injected constant per flag (mirroring the
  80 `__BUILD_MODE__` sites) + a `FlagName` union as the single registry; no
  string-keyed `feature()`, no object indexing anywhere.
- All four `vite.config.*` inject `__FEATURE_*__` from the single dependency-free
  `vite.featureFlags.mjs` matrix; `__FEATURE_*__` declared in
  `src/types/globals.d.ts:14`; a flag can default differently per platform.
- A gated subsystem with its flag OFF is **provably absent** from: the
  `vite.config.mjs` chunks, `dist/content.js`, and `dist/server/index.mjs`
  (analyzer byte delta recorded; server grep clean). ON on `vite.config.mjs`/
  desktop = a lazy chunk; ON on the content script = inlined (no lazy-load
  promised there).
- The rebuild-free rollout lever is `FeatureFlagRecorder` + Track 20 (runtime
  layer), explicitly **not** `feature.ts`; the three-way split is documented and
  guarded by a build-output regression test.
- Tracks 21 (relay) & 23 (x402) ship dark behind OFF-by-default extension flags;
  `npm run type-check` + `npm test` green; no P0/P1 work preempted.
```
