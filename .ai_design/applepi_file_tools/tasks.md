# Apple Pi Desktop Code Mode — Tasks

> Dependency-ordered implementation tasks. See [design.md](./design.md) for the full spec.
> Invariants referenced as **R1–R8**; acceptance tied to **SC-1–SC-14** (design §6/§9).
> Scope: **desktop only**. Server/extension out of scope.

## Overview

| Phase | Description | Tasks | Critical path |
|-------|-------------|-------|---------------|
| **G** | Prerequisite gates (external — must merge first) | G1, G2 | ✅ blocks everything |
| **4a** | Workspace root + delivery seam | T4a.1 – T4a.6 | ✅ Yes |
| **4b** | Freshness substrate + `read_file` | T4b.1 – T4b.7 | ✅ Yes |
| **4c** | `edit_file` (atomic, the parity milestone) | T4c.1 – T4c.7 | ✅ Yes |
| **4d** | `write_file` | T4d.1 – T4d.3 | No |
| **4e** | Hardening | T4e.1 – T4e.5 | No |

**Critical path:** `G1 → G2 → T4a.3 → T4a.4 → T4b.1 → T4b.2 → T4b.4 → T4b.5 → T4c.1 → T4c.2 → T4c.4`

**Hard rule:** no Phase-4 task may start until **G1 and G2 are both done**. The design is built as a sibling of #225's abstraction and is selectable only via #223's mode mechanism; starting earlier means building against APIs that do not exist on `agent-improvements`.

---

## Phase G: Prerequisite gates (external)

These are not tasks we author here — they are merge gates owned by the existing PRs. Tracked so the critical path is honest.

| Task | Status | Description | Blocked by |
|------|--------|-------------|------------|
| G1 | ⛔ | **#225 merged to `agent-improvements`** — `src/tools/file-search/` (`RipgrepExecutor`, `FileSearchTool`), the desktop-`invoke` executor-split pattern, the Rust ripgrep command. (Or: explicitly vendor that pattern into this branch — a scoped decision, not a default.) | #225 review/merge |
| G2 | ⛔ | **#223 merged** — per-session `AgentMode`/`MODES`, `coder_*` prompt fragments, `defaultMode`. Without it there is no per-session selection of code mode; the prompt is static and registration global. | #223 review/merge |

Exit criteria: on `agent-improvements`, `src/tools/file-search/RipgrepExecutor` exists AND `AgentMode==='code'` selects the coder fragments per session.

---

## Phase 4a: Workspace root + delivery seam (the upstream deliverable, design §4.1/§4.5)

Code mode is non-functional without a user-chosen project directory. This phase builds the workspace primitive *and* the single delivery seam (reused by 4b for the cache).

| Task | Status | File(s) | Description | Blocked by | Verifies |
|------|--------|---------|-------------|------------|----------|
| T4a.1 | ☐ | config schema / `IUserPreferences` | Add `preferences.workspaceRoot?: string` (absolute path). Default unset. | G1,G2 | — |
| T4a.2 | ☐ | desktop UI (settings + a header/empty-state affordance) | Folder-picker (Tauri dialog plugin) → write `preferences.workspaceRoot` via `TauriConfigStorage`; restore on launch; re-promptable. | T4a.1 | SC-1 |
| T4a.3 | ☐ | `ToolRegistry.ts:459-468` | Widen the single `ToolContext` build to forward request-supplied `workspaceRoot` (and, for 4b, `fileStateCache`) into `context.metadata`. This is the one chokepoint; covers main + sub-agents. | T4a.1 | SC-2 |
| T4a.4 | ☐ | `TurnManager.ts:1057-1069` | In `executeBrowserTool`, inject `workspaceRoot` (resolved from `preferences.workspaceRoot`) into the `ToolExecutionRequest`. | T4a.3 | SC-2 |
| T4a.5 | ☐ | new `src/tools/file-search/` sibling util | Shared path-resolution helper: resolve to absolute, resolve symlinks + `..`, assert containment in `workspaceRoot`; export the bypass-immune blocklist set (design §4.8 layer 1). Used by tools (advisory) and mirrored in Rust (authoritative). | T4a.3 | SC-2, SC-8 |
| T4a.6 | ☐ | file/search tool registration (`registerDesktopTools.ts`) | Gate registration/availability: tools unavailable + actionable "select a project folder" message when `workspaceRoot` unset; never default to app cwd. Graceful no-`Session`/no-cache degrade (design §4.5). | T4a.4 | SC-1 |

### T4a.3 details (the seam — read it twice)
- The build at `ToolRegistry.ts:459-468` currently forwards only `tabId`. Add `fileStateCache` and `workspaceRoot` passthrough from `request` → `context.metadata`.
- All three `registry.execute` call sites converge here: `TurnManager.ts:1071`, `buildSubAgentInvoker.ts:49`, `tools/index.ts:53`. The last has no `Session` → request fields absent → handlers must treat absent cache as "not read" and absent workspace as "disabled" (never throw). Bake the absence handling into the `FileAccessTool` base, not each tool.

---

## Phase 4b: Freshness substrate + `read_file` (design §4.4/§4.6/§4.7)

| Task | Status | File(s) | Description | Blocked by | Verifies |
|------|--------|---------|-------------|------------|----------|
| T4b.1 | ☐ | new `src/core/files/FileStateCache.ts` | LRU (100 / 25 MB), key `path.normalize(absPath)`, entry `{content(LF), mtimeFloorMs, offset?, limit?, isPartialView?}`. Ports claudy semantics (R2). | G1,G2 | SC-3 |
| T4b.2 | ☐ | `src/core/Session.ts` | Private `fileStateCache` field + `getFileStateCache()`, constructor-initialized (sync), mirroring `getToolResultStore()`. Sub-agents get their own via own `Session` (`RepublicAgentEngine.ts:73`). | T4b.1 | SC-10 |
| T4b.3 | ☐ | `TurnManager.ts:1057-1069` | Extend the T4a.4 injection to also pass `this.session.getFileStateCache()` into the request (seam already widened in T4a.3). | T4a.3, T4b.2 | SC-3, SC-10 |
| T4b.4 | ☐ | `tauri/src/main.rs` + new `tauri/src/fs_commands.rs` | Net-new `fs_read_file` + `fs_stat` `#[tauri::command]`s (struct args, no shell, mirror `terminal_execute`). Return `mtime_ms = floor` integer ms == JS `Math.floor(statMtimeMs)` (R3); detect endings/encoding/BOM; CRLF→LF normalize content; path jailed (T4a.5 logic in Rust — authoritative). | T4a.5 | SC-2, SC-9 |
| T4b.5 | ☐ | new `src/tools/file-search/FileAccessTool.ts` | Base (sibling of `FileSearchTool`): result/error shaping, executor handle, absent-cache/workspace graceful degrade, the recovery-message mapping table (design §4.7). | T4a.6 | SC-12 |
| T4b.6 | ☐ | new `read_file` tool + register (`registerDesktopTools.ts`) | `StaticRiskAssessor(0)`; pre-read 5 MB reject (via `fs_stat`); 2000-line\|256 KB output cap; 1-indexed `offset`; `cat -n` at map time; never persisted (`maxResultSizeChars: Infinity`); on success `cache.set` with `offset` SET (Read entry). | T4b.4, T4b.5 | SC-3, SC-7-read, SC-11 |
| T4b.7 | ☐ | `src/tools/file-search/__tests__/` | Unit tests: cache populate/normalize/LRU; `read_file` caps; offset/limit; never-persist; no-Session degrade. | T4b.6 | SC-3 |

---

## Phase 4c: `edit_file` — the atomic, data-loss-safe milestone (design §4.6/§4.7, R1/R3/R4/R5/R6)

| Task | Status | File(s) | Description | Blocked by | Verifies |
|------|--------|---------|-------------|------------|----------|
| T4c.1 | ☐ | `tauri/src/fs_commands.rs` + `main.rs` | Net-new **atomic** `fs_apply_edit`. One command: jail → empty-`old_string`-create branch → re-read fresh + re-stat → mtime check + whole-file jitter fallback vs `expected_content_lf` → exact-match (`no_match`/`not_unique`) **against fresh bytes** → substitute → re-apply endings/encoding/BOM → write. No async split. (R1, R3, R6.) | T4b.4 | SC-5, SC-6, SC-7, SC-13 |
| T4c.2 | ☐ | `edit_file` tool + `FileAccessTool` | JS *advisory* pre-check: non-empty `old_string` ⇒ require cache entry with `isPartialView!==true` (range read OK); empty `old_string` ⇒ skip cache check. Authoritative path = `fs_apply_edit`. On `ok:true` `cache.set` with `offset:undefined` (Edit entry). | T4c.1, T4b.5 | SC-4, SC-13, SC-14 |
| T4c.3 | ☐ | `FileAccessTool` recovery map | Map every `reason` → model-actionable `message` exactly per design §4.7 table; returned as the tool result text, not bare codes. | T4c.2 | SC-12 |
| T4c.4 | ☐ | new `src/core/approval/assessors/FileWriteRiskAssessor.ts` + register | Non-zero score crossing `riskAbove:30 ⇒ ASK` (`defaultRules.ts:16-18`); `runtime.concurrency.isReadOnly:()=>false, isDestructive:()=>true`. Wire into `edit_file` registration. | T4c.2 | SC-11 |
| T4c.5 | ☐ | `coder_*` prompt fragment (in #223's fragment set) | Assert the edit-recovery rule (design §4.2): on `stale`/`no_match`/`not_unique`, re-read / widen / `replace_all` — never blind-retry. | G2, T4c.3 | SC-12 |
| T4c.6 | ☐ | Rust path-jail in `fs_commands.rs` | Bypass-immune blocklist + workspace containment enforced **in the command** (R5); symlink/`..` resolved before containment. Not reliant on `SensitivePathEnhancer` (terminal-only). | T4c.1 | SC-8 |
| T4c.7 | ☐ | tests (TS + Rust) | Atomic-edit correctness: no-mtime-bump no-data-loss (SC-6), stale/no_match/not_unique, empty-old_string create/exists, endings/encoding round-trip, jail denial, recovery-loop-bounded. | T4c.4 | SC-5,6,7,8,9,12,13,14 |

### T4c.1 details (the correctness core)
- This command IS the integrity gate (R4: the JS pre-check is advisory; a permission prompt sits between it and the write).
- `expected_content_lf` = the cache entry's `content` verbatim. Step-4 jitter fallback compares it to the **whole** fresh file → equal only for full-read entries; a range read's slice never equals the whole file → it correctly hard-fails to `stale` (SC-14). Callers do not special-case range reads.
- Match/substitute run on **freshly re-read disk bytes**, never the cache (R1) — this is what makes the no-mtime-bump external-edit case fail safe (`no_match`) instead of clobbering (SC-6).

---

## Phase 4d: `write_file` (design §4.7)

| Task | Status | File(s) | Description | Blocked by | Verifies |
|------|--------|---------|-------------|------------|----------|
| T4d.1 | ☐ | `tauri/src/fs_commands.rs` + `main.rs` | Net-new `fs_write_if_unchanged`: `expected_mtime_ms=None` ⇒ create-only (must not exist); else read-before-overwrite (mtime guard, full overwrite — no stale-base hazard). New files LF. Same jail (T4c.6). | T4c.1 | SC-8 |
| T4d.2 | ☐ | `write_file` tool + register | New file = no prior read; existing = require non-`isPartialView` entry. `FileWriteRiskAssessor`. On success `cache.set` `offset:undefined`. | T4d.1, T4c.4 | SC-11 |
| T4d.3 | ☐ | tests | create-only vs read-before-overwrite; jail; approval. | T4d.2 | SC-8, SC-11 |

---

## Phase 4e: Hardening (post-parity, non-blocking)

| Task | Status | Description | Verifies |
|------|--------|-------------|----------|
| T4e.1 | ☐ | `file_unchanged` dedup stub for `read_file` (offset!==undefined precondition). | SC-3 |
| T4e.2 | ☐ | Sub-agent cache fork semantics (claudy `cloneFileStateCache`/merge-on-fork) — only if needed beyond per-session isolation. | SC-10 |
| T4e.3 | ☐ | Multi-edit tool + the `old_string ⊄ prior new_string` substring guard. | — |
| T4e.4 | ☐ | Generalize `SensitivePathEnhancer` beyond `terminal` (defense-in-depth on top of the in-command jail). | SC-8 |
| T4e.5 | ☐ | Token-accurate `read_file` cap (replace the byte/line proxy). | — |

---

## Cross-cutting

- **Verification gate per phase:** `npm run type-check` + `eslint` clean; `vitest` green; `cargo check` clean (4b+ touch Rust). Manual desktop QA for 4a (picker), 4c (real edit on a project, external-edit-during-prompt → `stale`, `.git/` denial).
- **Invariant review checklist** (cite in PRs): R1 (fresh-bytes substitution server-side), R3 (floored ms both sides), R4 (Rust command authoritative), R5 (jail in command), R6 (endings/encoding round-trip), R8 (no-workspace disabled).
- **Branching/PR:** per current policy, each phase is its own branch off `agent-improvements`, independently mergeable, PR base `agent-improvements`.
- **Status legend:** ☐ todo · ◐ in progress · ✅ done · ⛔ blocked (external).
