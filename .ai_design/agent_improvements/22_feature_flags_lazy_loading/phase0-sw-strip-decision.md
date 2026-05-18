# Track 22 — Phase 0 Decision: SW strip mechanism

**Status: RESOLVED — GO.** Date: 2026-05-16. Empirical, not assumed.

## Question 1 — can the extension service worker strip a feature-gated subsystem?

**Yes, via dynamic `import()` behind the feature-gate constant.** The
`service-worker.ts:49-51` comment ("dynamic import() banned in MV3 service
workers") is **stale**: it cites a 2018 spec issue that predates Chrome's
module service workers. Ground truth already contradicted it (`:992-994` ships a
live `await import()` in this SW). Confirmed empirically here — `vite.config.mjs`
code-splits the gated `await import('../../core/mcp/MCPManager')` into a chunk;
when the gate constant folds to `false`, the branch is DCE'd and **the chunk is
never emitted**. Both OFF and ON builds compile and succeed.

**Mechanism chosen:** dynamic `import()` inside `if (MCP)` / `if (A2A)`, with
the manager classes + tool adapters as `import type` only at top level. This is
strictly better than the static-import + side-effect-free tree-shake fallback
the design hedged on: removal is guaranteed by chunk non-emission, not
contingent on the module graph being side-effect-free.

## Question 2 — does `core/mcp` / `core/a2a` actually leave the bundle?

**Yes.** Controlled A/B, identical source, only `APPLEPI_FEATURE_*` differs
(`npx vite build`, `vite.config.mjs`):

| Artifact | OFF (MCP=A2A=false) | ON (default) | Δ removed when OFF |
|---|--:|--:|--:|
| `background.js` | 799,254 B | 803,835 B | ~4.5 KB |
| `chunks/*.js` total | 4,162,880 B | 4,493,699 B | **~323 KB** |
| **combined** | | | **~335 KB raw** |

String evidence: in the OFF build `core/mcp`, `core/a2a`, `MCPToolAdapter`,
`A2AToolAdapter`, `registerMCPTools` are **absent** from all emitted `.js`; in
the ON build `MCPToolAdapter` (×7) and `A2AToolAdapter` (×3) reappear. The lone
`McpSlotLoader-*.js` chunk is the plugin-slot loader, which references
`@/core/mcp/types` **type-only** (erased) — not a runtime leak.

## Required refactors

**None.** No side-effect pinning was observed; `core/mcp` / `core/a2a` tree-shake
cleanly once their only references are behind a dead gate. The design's
contingency ("if side effects pin it, refactor `core/mcp` to be import-pure")
did not materialize.

## Decision

GO. Phase 2 is implemented with the dynamic-import-behind-gate mechanism.
Defaults are MCP=ON / A2A=ON on every platform that ships them today, so this
change is **behavior-preserving for users** — the OFF path (the ~335 KB win) is
a build-time capability proven by forced-OFF builds, available for future
product-tiering, not a default behavior change in this PR.

Caveat (honestly scoped): correctness was verified at **build/bundle** level
(chunk emission, string absence, byte delta) and via the unit + regression
tests. Runtime behavior in a packaged extension loaded in live Chrome MV3 was
not exercised in this environment; the dynamic-import path is identical in shape
to the already-shipping `service-worker.ts:992-994` import, so the residual risk
is low but not zero — a manual smoke of an MCP-enabled packaged build is
recommended before relying on the OFF default for any platform.
