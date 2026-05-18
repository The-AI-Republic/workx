# Track 22 — Tasks

Implements [Track 22: Feature Flags & Lazy Loading](./design.md). All `path:line`
are code-verified vs the working tree on 2026-05-16 (see design "Validation
Notes"). Browserx paths are relative to `src/` unless they are repo-root
`vite.config.*` / `vite.featureFlags.mjs`. **Phase 0 is a hard prerequisite for
Phase 2** — it retires the one true blocker (the extension service worker cannot
use claudy's dynamic-`import()` model, and the codebase contradicts itself about
it). Phases 1 & 3 do not depend on Phase 0 and can proceed in parallel. P2;
blocks no correctness path.

## Phase 0 — Prerequisite spike: SW strip mechanism (BLOCKING for Phase 2)

- [ ] 0.1 Resolve the dynamic-import contradiction: `service-worker.ts:49-51`
      + `:58` declare `await import()` banned in MV3 service workers; `:992-994`
      runs a live `await import('@/core/skills/SkillDomainFilter')` in the SW.
      Determine empirically: does `vite.config.mjs` emit a SW-loadable chunk for
      `:992`, and does it execute in a **packaged** MV3 build (not just dev)?
      Output: SW supports lazy `import()` (Y/N).
- [ ] 0.2 Strip prototype: add a temporary `define: { __FEATURE_MCP__: 'false' }`
      to `vite.config.mjs`, gate the MCP import + construction (`:31-33`,
      `:256-263`) behind it, `npm run build` the extension, and bundle-analyze
      `dist/background.js` + `dist/chunks/` for any `core/mcp/*` identifiers.
      Output: measured MCP byte delta; PASS only if `core/mcp` fully leaves the
      bundle.
- [ ] 0.3 If 0.2 fails (side effects pin it): trace what keeps `core/mcp` alive
      (top-level side effects, `package.json` `sideEffects`, singletons built at
      import) and scope the import-purity refactor. Repeat for A2A (`core/a2a`).
- [ ] 0.4 **Exit deliverable** — a one-page decision in this folder:
      `phase0-sw-strip-decision.md` recording (a) SW mechanism chosen
      (lazy-import vs static-import + tree-shake), (b) MCP & A2A measured deltas,
      (c) any required import-purity refactors, (d) go / re-scope call. If the SW
      cannot strip without disproportionate refactors, re-scope Track 22's SW
      value (sidepanel/desktop/server still benefit) before Phase 2.

## Phase 1 — Substrate (independent of Phase 0)

- [ ] 1.1 New repo-root `vite.featureFlags.mjs`: `FLAG_DEFAULTS:
      { extension|desktop|server: Record<FlagName, boolean> }` (extension =
      conservative OFF for `MCP`/`A2A`/`REMOTE_BRIDGE`/`X402`/`VOICE`; desktop =
      heavier ON; server = experimental OFF); `featureDefine(platform, env = {})`
      → `{ "__FEATURE_<NAME>__": JSON.stringify(bool) }` with a **build-time**
      `APPLEPI_FEATURE_<NAME>` override. **Pure data + helper, zero `@/`/TS
      imports** (must load in plain `.mjs` configs at Node config-eval time).
- [ ] 1.2 `src/types/globals.d.ts`: beside `declare const __BUILD_MODE__` (`:14`
      + the `declare global` block `:20`) add `declare const __FEATURE_<NAME>__:
      boolean;` for every flag, mirroring both decl forms.
- [ ] 1.3 New `src/core/features/feature.ts`: one `export const <FLAG> = typeof
      __FEATURE_<FLAG>__ !== 'undefined' && __FEATURE_<FLAG>__;` per flag +
      `export type FlagName` union (the single registry). **No
      `feature(name: string)`, no object indexing** (silently breaks DCE — the
      headline failure mode, Risk).
- [ ] 1.4 Spread `...featureDefine('<plat>', process.env)` into the `define`
      block next to `__BUILD_MODE__` in all four configs: `vite.config.mjs:115-117`
      (`extension`), `vite.config.content.mjs:11-13` (`extension`),
      `vite.config.desktop.mts:27-29` (`desktop`), `vite.config.server.mts:12-14`
      (`server`); import `featureDefine` from `./vite.featureFlags.mjs`.
- [ ] 1.5 Tests (`src/core/features/__tests__/feature.test.ts`): `define` absent
      ⇒ every export `false` via the `typeof` guard (no throw, no `process.env`
      dependence); `FlagName` exactly equals the exported const set;
      `featureDefine('extension')` returns all heavy flags `"false"`;
      `APPLEPI_FEATURE_X402=1` flips only that key.

## Phase 2 — Convert MCP + A2A, verify per target (needs Phase 0)

- [ ] 2.1 Gate **MCP** using the Phase-0-chosen SW mechanism: import
      (`service-worker.ts:31-33`), construct + auto-connect (`:256-263`), and the
      event-registration side effect `setupMCPToolRegistration` (`:769-853`) all
      behind `import { MCP } from '@/core/features/feature'`; `registerAllServices`
      already tolerates `mcp: undefined` (`:493`, `:499`). Apply the Phase-0
      import-purity refactor to `core/mcp` if 0.3 required it.
- [ ] 2.2 Gate **A2A** identically behind `A2A`: import (`:34-36`), construct +
      auto-connect (`:268-275`), `setupA2AToolRegistration` (`:865-944`);
      `registerAllServices` tolerates `a2a: undefined` (`:508`).
- [ ] 2.3 Extension analyzer gate: build `vite.config.mjs` (background +
      sidepanel) and `vite.config.content.mjs` with `MCP`/`A2A` OFF vs forced ON
      (`APPLEPI_FEATURE_*=1`); record the per-config byte delta — **the
      acceptance number**. OFF build must contain no `core/mcp`/`core/a2a`
      identifiers.
- [ ] 2.4 Server absence check: build `vite.config.server.mts` with the flags OFF
      (`minify:false` `:20`, `ssr.noExternal:[/^@\//]` `:29-36`); `grep`
      `dist/server/index.mjs` to assert the gated modules are absent (Rollup
      constant-DCE + tree-shake still drop them; no minifier safety net).
- [ ] 2.5 Desktop spot-check: `vite.config.desktop.mts` build with MCP/A2A
      defaulted ON loads correctly; an OFF flag still strips. Confirms the
      per-target matrix wired right.

## Phase 3 — Discipline + attribution (independent of Phase 0)

- [ ] 3.1 In `feature.ts` add a mandatory registry comment block: each `FlagName`
      → owning track → remove-by condition. PR review rejects a new flag without
      this line.
- [ ] 3.2 Where a `feature.ts` const gates a subsystem, also report it via
      `SessionServices.featureFlagRecorder` (`SessionServices.ts:23`
      `record(feature, enabled)`) when present (prod default `undefined` `:142` —
      guard, no-op when absent). The runtime layer, distinct from the gate.
- [ ] 3.3 Document + guard the three-way split: comment in `feature.ts` (and a
      `globals.d.ts:14` note) — compile-time `feature.ts` (rebuild to flip, DCE)
      vs runtime `FeatureFlagRecorder`/Track 20 (rebuild-free rollout) vs
      `__BUILD_MODE__` (platform). Note the Track 20 seam (managed-policy key →
      recorder default); do not implement Track 20 here.
- [ ] 3.4 Regression test: compile a fixture gating `await import` / static-import
      of `./fixture-heavy` behind an OFF flag; assert `fixture-heavy`'s marker is
      absent from the emitted bundle — fails loudly if anyone reverts to an
      indexed `feature()` form that defeats DCE.

## Exit criteria

- Phase 0 decision recorded: the SW strip mechanism is chosen and **MCP & A2A
  measured to actually leave `background.js`/`chunks/`** (or Track 22's SW scope
  consciously re-scoped with the deltas documented).
- `feature.ts` exposes one bare typed injected constant per flag (mirroring the
  80 `__BUILD_MODE__` sites) + a `FlagName` union as the single registry; no
  string-keyed `feature()`.
- All four `vite.config.*` inject `__FEATURE_*__` from the single
  dependency-free `vite.featureFlags.mjs`; `__FEATURE_*__` declared in
  `src/types/globals.d.ts:14`; a flag can default differently per platform.
- MCP + A2A OFF ⇒ provably absent from the extension bundle (analyzer delta
  recorded) and `dist/server/index.mjs` (grep clean); ON ⇒ behaves as today.
- Rebuild-free rollout is `FeatureFlagRecorder` + Track 20 (runtime layer),
  explicitly **not** `feature.ts`; the three-way split is documented and guarded
  by the 3.4 regression test.
- Tracks 21/23 can later ship dark behind OFF-by-default extension flags using
  the same substrate; `npm run type-check` + `npm test` green; no P0/P1 work
  preempted.
```
