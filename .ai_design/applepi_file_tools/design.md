# Apple Pi Desktop — End-to-End Code Mode

**Status**: Draft (implementation-ready)
**Branch**: `feat/046-applepi-file-tools` (off `agent-improvements`)
**Date**: 2026-05-15
**Scope**: **Desktop only** (Tauri WebView + Rust). Extension has no filesystem; server lacks an ApprovalGate and a working-root primitive — both explicitly out of scope here and deferred. Desktop is a real simplification: it has an ApprovalGate, a single Rust executor, and a UI to host a folder picker.

This is the authoritative design for making the desktop Apple Pi agent do real coding work end-to-end: read, edit, write, grep, and glob over a user's project, with the read-before-edit freshness discipline that makes structured editing trustworthy rather than `sed -i` guesswork.

---

## 1. What "end-to-end code mode" actually requires

For a user to do real coding work, four things must be true, in dependency order. The first is the one the codebase has *no* primitive for and is the true gating blocker — it sits upstream of the file-tool engineering everyone focuses on:

1. **A workspace.** The agent must operate on a *user-chosen project directory*. Today there is none: `TerminalTool.setDefaultCwd` has zero callers, `TerminalTool.defaultCwd` stays `null`, and `get_project_root` (`tauri/src/commands.rs:28-34`) returns the *Apple Pi app's own* runtime-cwd parent — meaningless and unsafe as a code target. Without a workspace root, every file/search tool has nowhere to operate and no jail anchor. **§4.1.**
2. **A mode.** Code mode must be *selectable per session* so the coder prompt + coding tools surface only when wanted. The per-session mode mechanism (`AgentMode`/`MODES`/`coder_*` fragments) does not exist on `agent-improvements` — it is PR #223. **§4.2 + §3.**
3. **Tools.** Search (`grep`/`glob`) and file (`read`/`edit`/`write`) tools, scoped to the workspace. Search is PR #225's `file-search` abstraction (also not on `agent-improvements`); file tools are new here. **§4.3–§4.7.**
4. **Trust.** The freshness gate (read-before-edit, atomic mtime-guarded write against fresh disk bytes) + desktop approval + a self-contained path jail. **§4.4–§4.8, §7.**

If any of 1–3 is missing, code mode is non-functional regardless of how good the file tools are. §3 makes the ordering a hard gate.

---

## 2. Reference model — the minimal trustworthy core (from claudy)

Verified against `/home/rich/dev/study/claudy/src`. Claudy's *minimum viable* coding loop is **Bash + Read + Edit** (`tools.ts:271-298`, simple mode); Write/Grep/Glob are layered conveniences. The only state shared between tools is one per-session cache. The mechanisms a port MUST replicate for trustworthiness (everything else is deferrable):

- **One per-session `readFileState` cache**, keyed by `path.normalize(absPath)`, entries `{content, timestamp:floor(mtimeMs), offset, limit, isPartialView?}` (`utils/fileStateCache.ts:4-15`). Read populates it with **`offset` set**; Edit/Write require a non-partial entry and store back with **`offset:undefined`**. The offset-presence distinction is load-bearing for the read-before-edit gate and the read-dedup.
- **The atomic mutate section**: inside the tool's execute, after all `await`s, do a **synchronous fresh disk re-read**, re-compare `floor(mtime)` (with a full-read-only content-equality fallback for mtime jitter), run the substitution **against those fresh disk bytes**, write, then update the cache — **zero `await` between recheck and write** (`FileEditTool.ts:444-525`, comment `:443`). `validateInput`'s identical checks are advisory only: a blocking permission prompt sits between `validateInput` and `call` (`toolExecution.ts:683` vs `:1207`, prompt at `:921-930`), so the in-call recheck is the real integrity gate.
- **Floor mtime identically at store-time and compare-time** (`Math.floor(mtimeMs)`, `utils/file.ts:66-82`) or watcher/IDE touches cause infinite false "modified since read".
- **Exact-string Edit semantics**: exact match, uniqueness-unless-`replace_all`, empty-`old_string` ⇒ new file, no-op edit errors.
- **Bypass-immune safety**: `.git`, `.vscode`, `.idea`, `.claude`, shell rc/config files prompt *even in the most permissive mode* (`permissions.ts:1226-1281`; blocklist `filesystem.ts:57-79`).
- **Read is never persisted** (`maxResultSizeChars: Infinity`), self-bounded by a pre-read size gate + post-read token/line cap; output is `cat -n` line-numbered at map time, not stored.
- **System-prompt guardrails are part of the mechanism**: read-before-edit, no gold-plating, verify-before-claiming-done, risky-action confirmation (`constants/prompts.ts:199-267`).

Deferrable without losing trust: the `file_unchanged` dedup stub, curly-quote normalization, PDF/image/notebook reads, LSP notifications, multi-edit.

---

## 3. Prerequisites & dependency ordering (HARD GATE)

Desktop code mode cannot work end-to-end until these land, in this order. This is not a footnote; it is the implementation schedule.

| # | Prerequisite | Why it blocks | State |
|---|---|---|---|
| P1 | **#225 merged to `agent-improvements`** (or its `file-search` executor-split + Rust ripgrep command vendored) | `grep`/`glob` and the `RipgrepExecutor`/`FileSearchTool` abstraction the file tools are built as siblings of do not exist on this branch. | unmerged |
| P2 | **#223 merged** (per-session `AgentMode`/`MODES`/`coder_*` fragments) | No mechanism to *select* code mode per session or gate the coder prompt/tools; today the prompt is static and registration is global. | unmerged |
| P3 | **Workspace-root primitive** (§4.1) | No user-chosen project directory exists anywhere; tools would default to the packaged app's cwd. Upstream of P4–P6. | does not exist |
| P4 | Net-new Rust fs commands (§4.6) | No fs read/stat returning mtime; no atomic check-then-write. | does not exist |
| P5 | Per-session `FileStateCache` delivery seam (§4.5) | The read-before-edit gate needs per-session freshness state to reach handlers. | does not exist |
| P6 | Write-aware risk assessor + registration (§4.8) | Edit/Write must ASK; only read-only `StaticRiskAssessor(0)` and `TerminalRiskAssessor` exist. | does not exist |

---

## 4. Architecture

### 4.1 The workspace root — the upstream deliverable

A first-class, user-chosen, persisted project directory. Without it, nothing downstream is usable.

- **Selection**: a folder picker in the desktop UI (Tauri dialog). The selected absolute path is the **workspace root**.
- **Persistence**: stored in `config.json` via the existing `TauriConfigStorage` (a new `preferences.workspaceRoot` or a dedicated key). Restored on launch; re-promptable.
- **Threading**: the workspace root is delivered to tools the same way the `FileStateCache` is (§4.5) — via the single `ToolContext` build. It is also passed into every Rust fs command as the **jail anchor** (the only path policy these commands get; the terminal sandbox does not cover direct `invoke` fs, and `SensitivePathEnhancer` is terminal-only).
- **Resolution rule**: every file/search tool path is resolved to an absolute path, symlinks resolved, and **must be inside the workspace root** (after `..`/symlink resolution) or the tool hard-denies. There is no "outside the workspace with a prompt" in v1 — fail closed.
- **Unset behavior**: if no workspace is selected, code-mode file/search tools are **disabled with a clear "select a project folder" message** — never silently default to the app cwd.

### 4.2 Code-mode selection & prompt (depends P2 / #223)

Code mode is the per-session `AgentMode='code'` from #223: it selects the `coder_*` prompt fragments and surfaces the coding tools. This design does not re-specify the mode mechanism (see `.ai_design/applepi_agent_modes/design.md`); it requires only that:

- the coder system prompt asserts the §2 guardrails (read-before-edit, no gold-plating, verify-before-done, risky-action confirmation) — these shape behavior the mechanical checks cannot;
- the coding tools (`read_file`/`edit_file`/`write_file`/`grep`/`glob`) are present when mode is `code` and a workspace is set.

### 4.3 Tool suite & how they interlock

```
grep / glob ──► read_file ──► edit_file / write_file
(locate)        (loads +       (mutates; requires a non-partial
                 populates      read entry; re-reads fresh bytes
                 cache entry)   in the atomic op)
```
The only state passed between tools is the per-session `FileStateCache` (§4.4). Search tools never touch it; `read_file` populates it; `edit_file`/`write_file` require an entry and rewrite it. `grep`/`glob` reuse PR #225's `RipgrepExecutor` (workspace root as the search root). `read_file`/`edit_file`/`write_file` are new, built as a `FileAccessTool` sibling of #225's `FileSearchTool`, sharing the desktop-`invoke` executor pattern.

### 4.4 The freshness substrate — `FileStateCache`, per-session, owned by `Session`

New `src/core/files/FileStateCache.ts`, semantics ported from claudy:

```ts
export interface FileState {
  content: string;          // RAW disk bytes, LF-normalized, no line numbers
  mtimeFloorMs: number;     // Math.floor(mtimeMs); floored on store AND compare
  offset?: number;          // SET by read (read-vs-edit discriminator); undefined after edit/write
  limit?: number;
  isPartialView?: boolean;  // injected/partial ⇒ treated as "not read" by the edit gate
}
```
- Bounded LRU (defaults: 100 entries / 25 MB, claudy's). Keys = `path.normalize(absolutePath)`. Eviction ⇒ forced re-read (acceptable).
- **Owned by `Session`** as a private field with `getFileStateCache()`, mirroring `Session.getToolResultStore()`/`getMemoryService()` (constructor-initialized, synchronous, no async). Sub-agents construct their own `Session` (`RepublicAgentEngine.ts:73`) ⇒ a per-session cache **auto-isolates per sub-agent** with zero extra work.

### 4.5 Cache + workspace delivery seam — the one chokepoint

All tool dispatch — main turn (`TurnManager.ts:1071`), sub-agents (own `Session`, same path via `SubAgentRunner`), the test-only `tools/index.ts:53` — converges on a single `ToolContext` build at **`ToolRegistry.ts:459-468`**, which today forwards only `tabId` and drops the rest of `request.metadata`. The seam:

1. `TurnManager.executeBrowserTool` (builds the request, `TurnManager.ts:1057-1069`) injects `fileStateCache: this.session.getFileStateCache()` and `workspaceRoot` into the request.
2. The single `ToolContext` build is widened to forward these into `context.metadata`.
3. Handlers read `context.metadata.fileStateCache` / `.workspaceRoot`.

Rejected: a registry-side `Map<sessionId, cache>` (second ownership authority; `Session` is the natural owner). The `tools/index.ts:53` path has no `Session` — tools MUST degrade gracefully: absent cache ⇒ behave as "not read yet" (refuse edits, allow reads without populating); absent workspace ⇒ disabled per §4.1. Never throw on absence.

### 4.6 The atomic fs Rust commands (net-new, desktop)

The WebView cannot spawn processes or touch the fs; everything goes through Rust `invoke`. Claudy's "no `await` between recheck and write" is impossible across the JS↔IPC boundary, so **the entire recheck→substitute→write critical section lives inside one Rust command**. No existing command is adaptable (`skills_write_file` is a non-atomic `fs::write`). New `#[tauri::command]`s, registered in `tauri/src/main.rs generate_handler!`, mirroring the `terminal_execute` pattern (struct args, no shell, `Result<T,String>`):

- `fs_read_file(workspace_root, path, offset?, limit?) -> { content_lf, mtime_ms, size, endings, encoding, bom }` — path jailed to `workspace_root`; `mtime_ms = floor` integer ms (must equal JS `Math.floor(statMtimeMs)`); content CRLF→LF normalized; detects endings/encoding/BOM for round-trip.
- `fs_stat(workspace_root, path) -> { exists, mtime_ms, size }`.
- `fs_apply_edit(workspace_root, path, old_string, new_string, replace_all, expected_mtime_ms, expected_content_lf) -> Result<EditOutcome>` — **the atomic edit**. Server-side, in one command: (1) jail-check path; (2) re-read fresh bytes + re-stat; (3) if `floor(mtime) != expected_mtime_ms`: if fresh-LF `== expected_content_lf` proceed (benign-touch jitter fallback, claudy parity) else return `stale`; (4) exact-substring match `old_string` in **fresh bytes** — `0 ⇒ no_match`, `>1 && !replace_all ⇒ not_unique`; (5) substitute (first or all); (6) re-apply original endings+encoding+BOM; (7) write. Empty `old_string` ⇒ create-new (reject if exists & non-empty). Returns `{ ok:true, new_content_lf, mtime_ms, endings, encoding, bom }` or `{ ok:false, reason:'stale'|'not_found'|'no_match'|'not_unique'|'denied' }`.
- `fs_write_if_unchanged(workspace_root, path, content, expected_mtime_ms: Option<u64>, endings, encoding, bom) -> Result<WriteOutcome>` — full overwrite (no find/replace ⇒ no stale-base hazard). `expected_mtime_ms = None` ⇒ create-only (must not exist). Always LF unless `endings` says CRLF (write always normalizes to LF for new files; edit preserves).

**Why the edit substitution is server-side, not JS:** claudy applies the edit to *freshly re-read disk bytes* inside its atomic section (`FileEditTool.ts:444-491`); the cache is only the jitter oracle, never the edit base. Computing the new blob in JS from the cache and writing-if-mtime-matches is unsafe: a file changed on disk **without** an mtime advance (coarse FS granularity, mtime-preserving editor, sub-ms change) passes the mtime guard and silently overwrites the concurrent change. Running match+substitute against fresh bytes inside `fs_apply_edit` fails safe (`no_match`) exactly as claudy does.

### 4.7 The file tools (`read_file`, `edit_file`, `write_file`)

A `FileAccessTool` base (sibling of #225's `FileSearchTool`) sharing result/error shaping and the executor handle. Subclasses declare schema + behavior.

- **`read_file`** — read-only, `StaticRiskAssessor(0)` (auto-approve like `grep`/`glob`). Pre-read size gate (reject very large files before reading); post-read line/byte cap (byte/line proxy for claudy's token cap — v1, no tokenizer); `cat -n` numbering applied at map time; `offset`/`limit`; **never persisted** (`maxResultSizeChars: Infinity`). On success: `cache.set(absPath, {content:LF, mtimeFloorMs, offset, limit})` — a Read entry. Optional `file_unchanged` dedup (deferrable).
- **`edit_file`** — mutating. JS *advisory* pre-check for a fast clear error (cache entry exists, not `isPartialView`, mtime not obviously stale → "read it first" / "re-read"). The **authoritative** gate + substitution is `fs_apply_edit` against fresh bytes. Exact-match + uniqueness-or-`replace_all` + empty-`old_string`=new-file. On `ok:true`: `cache.set(absPath, {content:new_content_lf, mtimeFloorMs:new, offset:undefined})` — an Edit entry. v1 = exact match only; claudy's curly-quote/de-sanitization niceties deferred (consequence: a curly-quote mismatch returns `no_match` — a safe, conservative failure, documented to users).
- **`write_file`** — mutating. New file = no prior read (create-only). Existing file = read-before-overwrite (non-partial cache entry required). `fs_write_if_unchanged`. New files written LF. On success: cache `set` with `offset:undefined`.

### 4.8 Approval & path safety (desktop has an ApprovalGate)

Desktop wires `ApprovalGate` + `PolicyRulesEngine(getDefaultRules('desktop'))` + enhancers in `DesktopAgentBootstrap.configureDesktopPlatformForAgent` (`:232-262`). Two layers:

1. **Self-contained path jail in the tool/Rust command (mandatory, mode-independent).** `SensitivePathEnhancer` is hard-gated to `terminal` (`SensitivePathEnhancer.ts:36-40`) so the approval pipeline gives file tools *zero* path protection even on desktop. Therefore each fs Rust command enforces: path resolves (symlinks, `..`) inside `workspace_root`; and a bypass-immune blocklist mirroring claudy (`.git/`, `.vscode/`, `.idea/`, `.claude/`, `.ssh/`, `.env*`, shell rc/`*.config` dotfiles) — hard-deny regardless of approval mode. This is the only path safety; it must be in the command, not the prompt.
2. **`FileWriteRiskAssessor`** (new) — non-zero score that crosses the shared `riskAbove:30 ⇒ ASK` rule (`defaultRules.ts:16-18`) so `edit_file`/`write_file` prompt the desktop UI for ordinary in-workspace writes; declare `runtime.concurrency.isReadOnly:()=>false, isDestructive:()=>true`. `read_file`/`grep`/`glob` use `StaticRiskAssessor(0)` (auto-approve). The ASK flows through the existing `ApprovalGate.check → ApprovalManager.requestApproval → desktop UI` path (`ApprovalGate.ts:232-256`).

The terminal sandbox does not cover direct `invoke` fs commands; the §4.8.1 jail is the substitute and must be treated as security-critical.

---

## 5. End-to-end desktop flow

```
User picks project folder ─► persisted preferences.workspaceRoot (TauriConfigStorage)
User sets session to Code mode (#223) ─► coder prompt + coding tools surface

model → grep "useState" ─► RipgrepExecutor (root = workspaceRoot) ─► file:line hits
model → read_file(path) ─► ApprovalGate auto (StaticRiskAssessor 0)
        ─► invoke fs_read_file(workspaceRoot,path) [jailed]
        ─► cache.set(abs,{content:LF,mtimeFloorMs,offset,limit})  [Read entry]
        ─► cat -n + caps; never persisted
model → edit_file(path,old,new) ─►
        JS advisory pre-check (cache entry? not partial? mtime not stale) → fast error if not
        self-contained jail check (workspaceRoot + blocklist, bypass-immune)
        ApprovalGate (FileWriteRiskAssessor >30 ⇒ ASK desktop UI)
        ─► invoke fs_apply_edit(workspaceRoot,path,old,new,replace_all,
                                expectedMtimeFloorMs, expectedContentLF)
              Rust (one atomic command): jail → re-read fresh → mtime check
              (+jitter fallback) → exact-match/uniqueness → substitute fresh
              → re-apply endings/encoding/BOM → write
           ok:false ⇒ surface reason ('stale' ⇒ "modified since read, re-read")
        ─► cache.set(abs,{content:new_content_lf,mtimeFloorMs:new,offset:undefined}) [Edit entry]
        ─► short confirmation
```
Sub-agents: identical, with their own `Session`/`FileStateCache` (auto-isolated). No server/extension path.

---

## 6. Invariants (non-negotiable — state these as rules in code review)

- **R1 — Edit substitution runs against freshly re-read disk bytes, inside the atomic Rust command.** Never compute the post-edit blob in JS from the cache. Rationale: a disk change without an mtime advance otherwise causes silent data loss; fresh-bytes match fails safe (`claudy FileEditTool.ts:444-491`).
- **R2 — One per-session `FileStateCache`, owned by `Session`, keyed by normalized abs path.** Read sets `offset` defined; Edit/Write require a non-partial entry and store `offset:undefined`. The offset-presence distinction gates read-before-edit and read-dedup.
- **R3 — `Math.floor(mtimeMs)` integer ms on both store and compare, from the same source.** Desktop: Rust returns floored integer ms equal to JS `Math.floor(statMtimeMs)`. Mixing precision/source ⇒ infinite false "modified since read".
- **R4 — The JS pre-check is advisory; the atomic Rust command is authoritative.** A blocking approval prompt occurs between the pre-check and the write; only the in-command recheck closes the TOCTOU window.
- **R5 — Path jail + bypass-immune sensitive blocklist live in the Rust command.** Not in the prompt, not relying on `SensitivePathEnhancer` (terminal-only) or any approval mode. Resolve symlinks/`..` before the workspace-containment check; fail closed.
- **R6 — Cache holds LF-normalized content; the command round-trips original endings + encoding + BOM.** Edit preserves the file's endings; new files via Write are LF. Encoding/BOM are not optional.
- **R7 — `read_file` is never persisted and is size-gated pre-read.** Persisting a read the model re-reads is circular; large files are rejected before reading.
- **R8 — No workspace ⇒ file/search tools disabled with a clear message.** Never default to the app cwd.

---

## 7. Phasing (dependency-ordered; each independently shippable)

| Phase | Scope | Ships |
|---|---|---|
| **P1·prereq** | #225 merged to `agent-improvements` (or vendor `file-search` executor + Rust ripgrep). | `grep`/`glob` foundation present. |
| **P2·prereq** | #223 merged (per-session modes + `coder_*`). | Code mode selectable per session. |
| **4a — Workspace root** | Folder picker UI + `preferences.workspaceRoot` persistence + delivery through the `ToolContext` seam + Rust jail-anchor plumbing. Disabled-when-unset UX. | Tools have a real, safe place to operate. |
| **4b — `read_file` + freshness substrate** | `FileStateCache` + `Session` ownership + the delivery seam (`TurnManager`/`ToolRegistry` widening, graceful no-Session degrade) + `fs_read_file`/`fs_stat` Rust + `read_file` (read-only, caps, `cat -n`, never-persist). | Code mode reads project files structurally; cache populated. |
| **4c — `edit_file`** | `fs_apply_edit` atomic Rust command (R1–R6); JS advisory pre-check; self-contained jail; `FileWriteRiskAssessor`. | Trustworthy, data-loss-safe edits — the claudy-parity milestone. |
| **4d — `write_file`** | `fs_write_if_unchanged` (create-only vs read-before-overwrite); same jail + assessor. | Full read/edit/write. |
| **4e — hardening** | `file_unchanged` dedup; sub-agent cache clone/merge-on-fork; multi-edit (+substring guard); token-accurate caps; generalize `SensitivePathEnhancer`; (later) server parity. | Production hardening. |

---

## 8. Open Questions

1. **Workspace selection UX**: single folder per session vs a recent-projects list vs per-tab workspace? v1 recommendation: one persisted workspace, re-promptable; revisit multi-project later.
2. **`read_file` output cap**: byte/line proxy for v1 (no tokenizer); revisit if it mis-sizes vs real token budget.
3. **Sensitive-path blocklist final list** and whether any entries are "ask" vs "hard-deny" on desktop (server has no ask — but server is out of scope here). §4.8.1 is the starting set; pin before 4c.
4. **Sub-agent cache fork**: v1 independent per session (auto). Clone/merge-on-fork (claudy `cloneFileStateCache`) deferred to 4e — confirm acceptable.
5. **LRU bounds** (100/25 MB claudy default) — adopt; revisit if eviction thrash causes spurious re-reads.

---

## 9. Success Criteria

- **SC-1** With no workspace selected, `read_file`/`edit_file`/`write_file`/`grep`/`glob` are unavailable with an actionable "select a project folder" message; never operate on the app's own directory.
- **SC-2** With a workspace set, `grep`/`glob`/`read_file` operate over that directory; paths outside it (post symlink/`..` resolution) are hard-denied.
- **SC-3** `read_file` populates a per-session Read entry (offset set, floored mtime, LF content); a subsequent identical read can serve the dedup stub (if implemented) and never re-persists.
- **SC-4** `edit_file` without a prior `read_file` of that path is refused ("read it first"); a partial-view entry does not satisfy the gate.
- **SC-5** `edit_file` after the file changed on disk with a newer mtime+different bytes is refused ("modified since read"); a benign touch (newer mtime, byte-identical) succeeds via the in-command jitter fallback.
- **SC-6 (the core correctness criterion)** A file changed on disk **with no mtime advance** never causes silent data loss: `fs_apply_edit` matches `old_string` against fresh bytes and returns `no_match` rather than writing a stale-derived blob. Verified-equivalent to claudy.
- **SC-7** `edit_file` exact-match against fresh bytes: non-unique ⇒ `not_unique` unless `replace_all`; zero ⇒ `no_match`; empty `old_string` creates a file only when absent/empty.
- **SC-8** Writing `.git/`, `.ssh/`, `.env`, `settings.json`/dotfiles, or outside the workspace is hard-denied by the in-command jail **regardless of approval mode**; symlink/`..` escapes resolved first.
- **SC-9** `edit_file` preserves the file's existing line endings + encoding + BOM; the post-write cache entry has `offset:undefined`; the next `read_file` returns correct fresh content (no stale dedup).
- **SC-10** Sub-agents operate with their own isolated `FileStateCache` (a sub-agent edit does not satisfy the parent's read-before-edit gate and vice versa).
- **SC-11** Ordinary in-workspace `edit_file`/`write_file` trigger the desktop approval prompt; `read_file`/`grep`/`glob` auto-approve.
