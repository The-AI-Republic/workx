# Apple Pi Desktop Code Mode — Tasks

> Dependency-ordered implementation tasks. See [design.md](./design.md) for the full spec.
> Invariants referenced as **R1–R8**; acceptance tied to **SC-1–SC-14** (design §6/§9).
> Scope: **desktop only**. Server/extension out of scope.

> **✅ TRACK COMPLETE.** Phases G–4d delivered and merged via **PR #228**
> (merge commit `cb64c28c` into `agent-improvements`). A design+code review
> of #228 found 12 issues — including a **CRITICAL** `grep`/`glob` jail
> escape — all fixed in hardening commit `f3dd325b` before merge (jail in
> `sessionScope`/Rust, cache scoping, case-folded keys, assessor tests, +8).
> Phase **4e is intentionally deferred** (post-parity hardening, not gaps).
> ⚠️ **Outstanding:** manual desktop QA — the Rust runtime FS/jail behavior
> and desktop settings UI are unproven in CI; smoke-test live
> `agent-improvements` before any release.

## Overview

| Phase | Description | Tasks | Status |
|-------|-------------|-------|--------|
| **G** | Prerequisite gates (external — must merge first) | G1, G2 | ✅ done |
| **4a** | Workspace root + delivery seam | T4a.1 – T4a.6 | ✅ done |
| **4b** | Freshness substrate + `read_file` | T4b.1 – T4b.7 | ✅ done |
| **4c** | `edit_file` (atomic, the parity milestone) | T4c.1 – T4c.7 | ✅ done |
| **4d** | `write_file` | T4d.1 – T4d.3 | ✅ done |
| **4e** | Hardening | T4e.1 – T4e.5 | ☐ deferred (intentional) |

**Critical path:** `G1 → G2 → T4a.3 → T4a.4 → T4b.1 → T4b.2 → T4b.4 → T4b.5 → T4c.1 → T4c.2 → T4c.4` — delivered.

**Hard rule:** no Phase-4 task may start until **G1 and G2 are both done**. The design is built as a sibling of #225's abstraction and is selectable only via #223's mode mechanism; starting earlier means building against APIs that do not exist on `agent-improvements`.

---

## Phase G: Prerequisite gates (external)

These are not tasks we author here — they are merge gates owned by the existing PRs. Tracked so the critical path is honest.

| Task | Status | Description | Blocked by |
|------|--------|-------------|------------|
| G1 | ✅ | **#225 (ripgrep grep/glob) code on `agent-improvements`** — `src/tools/file-search/` (`RipgrepExecutor`, `FileSearchTool`), desktop-`invoke` executor split, Rust ripgrep command. Landed on `agent-improvements` via PR #228 (`cb64c28c`). | #225 / #228 |
| G2 | ✅ | **#223 merged** — per-session `AgentMode`/`MODES`, `coder_*` prompt fragments, `defaultMode`. Merged to `agent-improvements` as `cda951c1`. | #223 |

Exit criteria (met): on `agent-improvements`, `src/tools/file-search/RipgrepExecutor` exists AND `AgentMode==='code'` selects the coder fragments per session.

---

## Phase 4a: Workspace root + delivery seam (the upstream deliverable, design §4.1/§4.5)

Code mode is non-functional without a user-chosen project directory. This phase builds the workspace primitive *and* the single delivery seam (reused by 4b for the cache).

| Task | Status | File(s) | Description | Blocked by | Verifies |
|------|--------|---------|-------------|------------|----------|
| T4a.1 | ✅ | config schema / `IUserPreferences` | Add `preferences.workspaceRoot?: string` (absolute path). Default unset. Non-LLM-writable. | G1,G2 | — |
| T4a.2 | ✅ | desktop UI (settings + a header/empty-state affordance) | Folder-picker → write `preferences.workspaceRoot` via `TauriConfigStorage`; restore on launch; re-promptable. (Native picker deferred to 4e; v1 text field.) | T4a.1 | SC-1 |
| T4a.3 | ✅ | `ToolRegistry.ts` | Widen the single `ToolContext` build to forward request-supplied `workspaceRoot`/`fileStateCache`/`agentMode` into `context.metadata`. Scoped to the file/search tools only (review hardening — was broadcast to every tool). | T4a.1 | SC-2 |
| T4a.4 | ✅ | `TurnManager.ts` | In `executeBrowserTool`, inject `workspaceRoot` (resolved from `preferences.workspaceRoot`) into the `ToolExecutionRequest`. | T4a.3 | SC-2 |
| T4a.5 | ✅ | `src/tools/file-search/pathPolicy.ts` (+ `sessionScope.ts`) | Shared path-resolution helper: resolve to absolute, collapse `..` (explicit over-pop reject), assert containment in `workspaceRoot`; export the bypass-immune blocklist set. Advisory in tools, mirrored authoritative in Rust. | T4a.3 | SC-2, SC-8 |
| T4a.6 | ✅ | file/search tool registration (`registerDesktopTools.ts`) | Gate registration/availability: actionable "select a project folder" when unset; never default to app cwd; graceful no-`Session`/no-cache degrade. | T4a.4 | SC-1 |

### T4a.3 details (the seam — read it twice)
- The build in `ToolRegistry` forwards the §4.5 seam (`workspaceRoot`/`fileStateCache`/`agentMode`) **only to the file/search tools** (`FILE_SEAM_TOOLS`); every other tool keeps `{ tabId }`. (Review hardening: broadcasting the mutable cache to all tools was a HIGH finding.)
- All `registry.execute` call sites converge here; the session-less path has no `Session` → handlers treat absent cache as "not read" with a distinct terminal message and absent workspace as "disabled" (never throw).

---

## Phase 4b: Freshness substrate + `read_file` (design §4.4/§4.6/§4.7)

| Task | Status | File(s) | Description | Blocked by | Verifies |
|------|--------|---------|-------------|------------|----------|
| T4b.1 | ✅ | `src/core/files/FileStateCache.ts` | LRU (100 / 25 MB), key normalized + **case-folded** abs path (review hardening for macOS/Windows), entry `{content(LF), mtimeFloorMs, offset?, limit?, isPartialView?}`. Ports claudy semantics (R2). | G1,G2 | SC-3 |
| T4b.2 | ✅ | `src/core/Session.ts` | Private `fileStateCache` + `getFileStateCache()`, constructor-initialized; sub-agents get their own via own `Session` (verified isolated). | T4b.1 | SC-10 |
| T4b.3 | ✅ | `TurnManager.ts` | Extend the T4a.4 injection to also pass `this.session.getFileStateCache()` into the request. | T4a.3, T4b.2 | SC-3, SC-10 |
| T4b.4 | ✅ | `tauri/src/main.rs` + `tauri/src/fs_commands.rs` | Net-new `fs_read_file` + `fs_stat` (struct args, no shell). Floored `mtime_ms` (R3); detect endings/encoding/BOM; CRLF→LF normalize; path jailed in Rust (authoritative). | T4a.5 | SC-2, SC-9 |
| T4b.5 | ✅ | `src/tools/file-search/FileAccessTool.ts` | Base: result/error shaping, executor handle, absent-cache/workspace graceful degrade, recovery-message mapping, fs-invoke timeout (review hardening). | T4a.6 | SC-12 |
| T4b.6 | ✅ | `read_file` tool + register | `StaticRiskAssessor(0)`; pre-read 5 MB reject; 2000-line\|256 KB output cap; 1-indexed `offset`; `cat -n`; never persisted; on success `cache.set` with `offset` SET. | T4b.4, T4b.5 | SC-3, SC-7-read, SC-11 |
| T4b.7 | ✅ | `src/tools/file-search/__tests__/` | Unit tests: cache populate/normalize/case-fold/LRU; `read_file` caps; offset/limit; never-persist; no-Session degrade. | T4b.6 | SC-3 |

---

## Phase 4c: `edit_file` — the atomic, data-loss-safe milestone (design §4.6/§4.7, R1/R3/R4/R5/R6)

| Task | Status | File(s) | Description | Blocked by | Verifies |
|------|--------|---------|-------------|------------|----------|
| T4c.1 | ✅ | `tauri/src/fs_commands.rs` + `main.rs` | Net-new **atomic** `fs_apply_edit`. One command: jail → empty-`old_string`-create branch → re-read fresh + re-stat → mtime check + whole-file jitter fallback → exact-match against fresh bytes → substitute → re-apply endings/encoding/BOM → write. No async split. (R1, R3, R6.) | T4b.4 | SC-5, SC-6, SC-7, SC-13 |
| T4c.2 | ✅ | `edit_file` tool + `FileAccessTool` | JS *advisory* pre-check; authoritative path = `fs_apply_edit`. On `ok:true` `cache.set` `offset:undefined`. Range-read→edit contract test-locked (SC-14). | T4c.1, T4b.5 | SC-4, SC-13, SC-14 |
| T4c.3 | ✅ | `FileAccessTool` recovery map | Every `reason` → model-actionable `message` per design §4.7; returned as tool result text. | T4c.2 | SC-12 |
| T4c.4 | ✅ | `src/core/approval/assessors/FileWriteRiskAssessor.ts` + register | Score 45 crossing `riskAbove:30 ⇒ ASK`. Wired into `edit_file`/`write_file`; **unit-tested** (review hardening — was untested). | T4c.2 | SC-11 |
| T4c.5 | ✅ | `coder_*` prompt fragment (#223's set) | Edit-recovery rule: on `stale`/`no_match`/`not_unique`, re-read / widen / `replace_all` — never blind-retry. | G2, T4c.3 | SC-12 |
| T4c.6 | ✅ | Rust path-jail in `fs_commands.rs` | Bypass-immune blocklist (narrowed: bare `settings.json` removed, design-aligned) + workspace containment in the command (R5); symlink/`..` resolved before containment. | T4c.1 | SC-8 |
| T4c.7 | ✅ | tests (TS + Rust) | Atomic-edit correctness; stale/no_match/not_unique; empty-old_string create/exists; endings round-trip; jail denial (incl. grep/glob jail tests, review hardening). | T4c.4 | SC-5,6,7,8,9,12,13,14 |

### T4c.1 details (the correctness core)
- This command IS the integrity gate (R4: the JS pre-check is advisory; a permission prompt sits between it and the write).
- `expected_content_lf` = the cache entry's `content` verbatim. Step-4 jitter fallback compares it to the **whole** fresh file → equal only for full-read entries; a range read's slice never equals the whole file → on **mtime jitter** it correctly hard-fails to `stale` (SC-14). An unchanged file (mtime matches) is NOT stale — the "always stale" review concern was a misread of this trade-off; locked by a regression test.
- Match/substitute run on **freshly re-read disk bytes**, never the cache (R1) — fail-safe `no_match` instead of clobbering (SC-6).

---

## Phase 4d: `write_file` (design §4.7)

| Task | Status | File(s) | Description | Blocked by | Verifies |
|------|--------|---------|-------------|------------|----------|
| T4d.1 | ✅ | `tauri/src/fs_commands.rs` + `main.rs` | Net-new `fs_write_if_unchanged`: `expected_mtime_ms=None` ⇒ create-only; else read-before-overwrite (mtime guard, full overwrite). New files LF. Same jail (T4c.6). | T4c.1 | SC-8 |
| T4d.2 | ✅ | `write_file` tool + register | New file = no prior read; existing = require non-`isPartialView` entry (distinct cache-absent terminal message — review hardening). `FileWriteRiskAssessor`. On success `cache.set` `offset:undefined`. | T4d.1, T4c.4 | SC-11 |
| T4d.3 | ✅ | tests | create-only vs read-before-overwrite; jail; approval. | T4d.2 | SC-8, SC-11 |

---

## Phase 4e: Hardening (post-parity, non-blocking — intentionally deferred, NOT delivered in #228)

| Task | Status | Description | Verifies |
|------|--------|-------------|----------|
| T4e.1 | ☐ | `file_unchanged` dedup stub for `read_file` (offset!==undefined precondition). | SC-3 |
| T4e.2 | ☐ | Sub-agent cache fork semantics (claudy `cloneFileStateCache`/merge-on-fork) — only if needed beyond per-session isolation. | SC-10 |
| T4e.3 | ☐ | Multi-edit tool + the `old_string ⊄ prior new_string` substring guard. | — |
| T4e.4 | ☐ | Generalize `SensitivePathEnhancer` beyond `terminal` (defense-in-depth on top of the in-command jail). | SC-8 |
| T4e.5 | ☐ | Token-accurate `read_file` cap (replace the byte/line proxy). | — |

---

## Cross-cutting

- **Verification gate per phase:** `npm run type-check` + `eslint` clean; `vitest` green; `cargo check` clean. ✅ Met for #228 (`tsc`/`eslint` 0, `vitest` 69/69, Rust `fs_commands` 6/6 + `ripgrep_commands` 3/3). ⚠️ Manual desktop QA (picker, real edit, external-edit→`stale`, `.git/` denial, grep/glob jail) still **outstanding**.
- **Invariant review checklist:** R1 (fresh-bytes substitution server-side), R3 (floored ms both sides), R4 (Rust command authoritative), R5 (jail in command — incl. grep/glob, post-review), R6 (endings/encoding round-trip), R8 (no-workspace disabled — incl. grep/glob, post-review).
- **Branching/PR:** delivered as PR #228 (base `agent-improvements`), carrying #223/#225; review findings hardened in `f3dd325b`; merged `cb64c28c`.
- **Status legend:** ☐ todo · ◐ in progress · ✅ done · ⛔ blocked (external).
