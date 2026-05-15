# Apple Pi File Tools — Read / Edit / Write (Code Mode, Phase 4)

**Status**: Draft
**Branch**: `feat/046-applepi-file-tools` (off `agent-improvements`)
**Date**: 2026-05-15
**Scope**: Apple Pi desktop + server. Browserx (extension) out of scope (no filesystem).
**HARD PREREQUISITE (verified):** `src/tools/file-search/` does **not** exist on `agent-improvements`/`feat-046` — it lives only on unmerged PR #225 (`feat/045`). Phase 4 reuses that abstraction's shape, so **#225 must merge into `agent-improvements` before Phase 4 implementation starts**, OR Phase 4 must vendor a minimal copy of the executor-split pattern. This is an ordering gate, not a footnote. PR #223 (per-session modes; `coder_*` fragments promise these tools) should also land first so code mode actually surfaces them.

---

## 0. Design Review — Verified & Corrected (2026-05-15)

This doc was reviewed against the live claudy code (`/home/rich/dev/study/claudy/src`) and the live browserx code on `feat-046`. Findings folded in below; the original §§1–9 are corrected in place.

### 0.1 CORRECTNESS BUG FOUND & FIXED — the edit must apply to *fresh disk bytes*, not the cache

The original design proposed: *"JS computes the new full-file content from the cached `FileStateCache.content`, sends it to `fs_write_if_unchanged(path, content, expectedMtime)`; the mtime guard makes it safe."* **This is not what claudy does and it is unsafe.** Verified in `claudy FileEditTool.ts:444-491`: claudy re-reads disk bytes *inside the atomic section* (`readFileForEdit` :449) and runs `findActualString`/replacement against **those fresh bytes** (:471, :482-488); the cached `readFileState.content` is used **only** as the equality oracle for the mtime-jitter fallback (:463), never as the edit base. The mtime check is *secondary*; the real safety is that the edit is computed against actual current disk content.

Failure mode of the original model: a file changed on disk **without** an mtime advance (coarse-granularity FS, sub-millisecond change flooring to the same ms, an editor preserving mtime) → the mtime guard passes → Rust overwrites with content derived from **stale cached bytes** → **silent data loss**. Claudy fails safe here (`findActualString` against fresh bytes simply errors "string not found").

**Correction (now binding):** `edit_file`'s atomic operation re-reads disk content **server-side** (Rust on desktop / Node in-process on server) and performs the exact-match + uniqueness/`replace_all` substitution against those **freshly-read bytes**, then writes — all within the single atomic command. The frontend never computes the post-edit blob from the cache. `write_file` (full overwrite) keeps the `content + expectedMtime` shape (no find/replace, so no stale-base hazard) but the mtime guard still applies. This reshapes §4.3/§4.4 — see below.

### 0.2 Other verified corrections (binding)

- **Cross-language mtime consistency.** Cache stores the mtime returned by *the executor that performed the read*; the write-check stat must come from the *same executor* with the *same precision*. Convention: integer milliseconds, `floor(mtimeMs)`. Desktop: all of read/stat/write-check mtimes come from Rust, which must return `floor` integer-ms matching Node's `Math.floor(statMtimeMs)`. Server: all from Node. **Never mix sources** for one file's store-vs-compare (verified against claudy `utils/file.ts:66-82` — same floored `mtimeMs` everywhere; a precision mismatch breaks the equality check and causes infinite "modified since read").
- **Line endings + encoding.** Cache stores **LF-normalized** content (claudy `fileRead.ts:94`). The atomic write op must re-apply the file's original line endings (CRLF/LF, detected from disk) **and original encoding/BOM** (utf8/utf16le) — `edit_file` preserves; `write_file` always LF. The executor contract must carry endings *and* encoding, not just endings (original §4.3 missed encoding).
- **Conservative-vs-claudy jitter behavior — decision.** Claudy's full-content fallback *succeeds* when mtime advanced but bytes are byte-identical to the cached full read (benign touch). v1 decision: **implement the fallback in the atomic op** (it already re-reads fresh bytes; compare against the cached `content` passed in for the full-read case) → claudy parity. If deferred, document that v1 is *more conservative* (errors on benign touch) — a usability, not safety, divergence.
- **Authoritative gate = the atomic backend op, not the JS pre-check.** Verified: claudy calls `validateInput` (`toolExecution.ts:683`) long before `call` (`:1207`) with a **blocking permission prompt in between** (`:921-930`). So the JS-side read-before-edit/mtime pre-check is **advisory UX only**; the binding freshness gate is the re-stat+re-match inside the atomic server op. The design must not rely on the JS pre-check for safety.
- **Partial-view reads are not valid edit bases** (claudy `FileEditTool.ts:276,296-299`): if the cache entry `isPartialView` or was a partial read, an edit must refuse with "read it first / re-read" — same as no entry.
- **Server safety floor is deny-only and fully self-contained.** Verified: server wires **no `ApprovalGate`** at all (`ToolRegistry.execute:388` skips approval when unset; `getDefaultRules` has no `'server'` arm, `defaultRules.ts:112`); `SensitivePathEnhancer` is hard-gated to `terminal` (`:38-40`) so it gives **zero** path protection to file tools *even on desktop/extension*. Therefore the in-tool path-safety guard must be entirely self-contained in the tool and, **on server, can only allow or hard-deny (no "ask" — there is no approval UI on that path)**. It must not assume any approval-pipeline help anywhere.
- **Dispatch chokepoint confirmed (good news).** All tool dispatch — main turn, **sub-agents (own `Session` via `RepublicAgentEngine`)**, server — funnels through `ToolRegistry.execute`'s single `ToolContext` build (`ToolRegistry.ts:459-468`, forwards only `tabId`). So a per-session `FileStateCache` on `Session` auto-isolates per sub-agent with no extra work. Correction: there are **three** `registry.execute` call sites (`TurnManager.ts:1071`, `tools/index.ts:53`, `buildSubAgentInvoker.ts:49`), all converging on that one build. The `tools/index.ts:53` path has **no Session** (test/utility) — tools must degrade gracefully (treat absent cache as "not read yet").
- **No atomic primitive exists to adapt.** `skills_write_file` is a plain non-atomic `fs::write` (`skills_commands.rs:61`); there is no fs read/stat/write-with-guard command. The atomic command is **net-new Rust**, added to `tauri/src/main.rs generate_handler!`. Confirmed.
- **No server working-root abstraction.** Desktop has `get_project_root` (`commands.rs:28-34`); the server has **no equivalent** (`process.cwd()` ad hoc). The server file-tool root/jail must be an explicit, pinned config — promoted from open-question to a §4.5 decision.

### 0.3 Net verdict

Architecture is sound and the cache-delivery seam is *simpler* than feared (single chokepoint, sub-agents auto-covered). One real correctness bug (0.1) is fixed by moving the edit transformation server-side. The remaining items are binding clarifications, now in §§4–9. Implementation-readiness gate: **#225 merged first** (or executor pattern vendored).

---

## 1. Overview

Phase 3 gave code mode **search** (`grep`/`glob`). Phase 4 gives it **read / edit / write** — the half that makes code mode actually usable end-to-end. The deliverable is not "file I/O" (that part is trivial). The deliverable is the **read-before-edit freshness gate**: the discipline that makes structured editing *trustworthy* instead of `sed -i` guesswork. That gate is the entire engineering problem; everything else is plumbing around it.

This doc maps claudy's complete read→edit→write lifecycle, states exactly what `agent-improvements` already provides versus what must be built, and specifies the architecture — with particular attention to the one place Apple Pi cannot copy claudy directly: **claudy's atomicity guarantee is in-process; Apple Pi desktop runs the agent in a Tauri WebView with the filesystem behind Rust IPC, so the atomic check-then-write must move into a single Rust command.**

---

## 2. How claudy does it (the reference lifecycle)

```
[model: Read]
  Read.validateInput (deny/binary/size pre-gate)
  → Read.call: readFileInRange (fast <10MB | streaming)
  → readFileState.set(normalize(absPath), {content, timestamp:floor(mtimeMs), offset, limit})
        offset is SET ⇒ this is a "Read entry"
  → map result: addLineNumbers (cat -n), token-gate post-read, never persisted

[model: Edit/Write]
  validateInput:
     e = readFileState.get(normalize(absPath))
     !e || e.isPartialView                → ASK "read it first"
     floor(statMtime) > e.timestamp        → (full-read content-equality fallback) else ASK "modified since read"
     exact-match old_string + uniqueness   → error unless replace_all
  permission: checkWritePermissionForTool
     deny → internal-editable → .claude/** → checkPathSafetyForAutoEdit(.git/.vscode/settings/.ssh…)
          → ask-rule → acceptEdits-mode auto-allow → allow-rule → ASK
     (safetyCheck denials are BYPASS-IMMUNE — prompt even in YOLO)
  call:  ─── ATOMIC, no await between recheck and write ───
     re-stat + re-check mtime (same fallback) → else throw FILE_UNEXPECTEDLY_MODIFIED
     write (Edit: preserve file's CRLF/LF; Write: always LF)
  → readFileState.set(absPath, {content:updated, timestamp:floor(newMtime), offset:undefined, limit:undefined})
        offset UNDEFINED ⇒ "edit entry" (immune to Read's dedup)
  → LSP didChange/didSave + editor notify; short confirmation string (≤100k)
```

Load-bearing invariants a reimplementer must preserve (from deep research of `/home/rich/dev/study/claudy/src`):

1. **`FileStateCache` is per-session, owned by the engine, threaded into every tool** via `ToolUseContext.readFileState` (`Tool.ts:181`). Entry shape: `{content, timestamp, offset, limit, isPartialView?}` (`utils/fileStateCache.ts:4-15`). Keys are `path.normalize()`-d *inside* the cache; all tools pass `expandPath(...)`. LRU 100 entries / 25 MB — **entries are not pinned; eviction forces a re-Read.**
2. **`offset`/`limit` are a Read-vs-Edit discriminator, not just pagination.** Read stores the real offset (default 1); Edit/Write store `undefined`. Read's dedup stub only fires when `offset !== undefined`. Get this wrong → Read→Edit→Read serves stale "file_unchanged".
3. **`Math.floor(mtimeMs)` on both store and compare** — unfloored timestamps cause infinite "modified since read" loops with IDE/file-watchers.
4. **Full-content-equality fallback** for mtime jitter (cloud-sync/AV touch) applies **only to full reads** (`offset===undefined && limit===undefined`). Partial reads can never recover from an mtime touch without a re-Read.
5. **`isPartialView` ≡ "not read"** for the edit gate.
6. **Atomicity**: no `await` between the in-`call` staleness recheck and the write. `validateInput`'s check is *not* sufficient — a permission prompt happens between validate and call.
7. **Write always writes LF; Edit preserves the file's endings.** Different by design (Write corrupted shell scripts when it sampled repo endings).
8. **Safety-path denials (`.git/`, `.claude/`, `.vscode/`, settings) are bypass-immune** — they prompt even in the most permissive mode. The tool's `checkPermissions` returns `behavior` only; mode enforcement is one layer up.
9. **Read is never persisted** (`maxResultSizeChars: Infinity`) — persisting a Read result the model re-reads is circular. It self-bounds via size (pre-read, whole-file) + token (post-read) gates.
10. The edit algorithm is just **exact substring match + uniqueness-or-`replace_all` + empty-`old_string`=new-file**. Claudy's curly-quote normalization / API-tag de-sanitization / `.md` trailing-space exception are mitigations for *claudy's own response sanitization* — **not** intrinsic to editing.

---

## 3. What `agent-improvements` already has vs must build

| Capability | Status | Evidence |
|---|---|---|
| Tool shape (`'function'` def, handler sig, `metadata.platforms`) | **Reuse** | `BaseTool.ts:67-77,166-180,741-798` |
| Desktop tool → Rust command (registration pattern) | **Reuse** (TerminalTool exemplar) | `registerDesktopTools.ts:176-224`, `TerminalTool.ts:166-182` |
| Server fs-tool registration pattern | **Reuse** | `registerServerTools.ts:111-148` (`read_persisted_result`) |
| Phase-3 executor-split + Rust-command pattern | **Reuse** (#225) | `src/tools/file-search/` (RipgrepExecutor, FileSearchTool) |
| ApprovalGate pipeline + assessors + policy rules | **Reuse** | `ApprovalGate.ts:102-270`, `defaultRules.ts`, `StaticRiskAssessor` |
| `Session` owning a per-session cache (field + getter) | **Reuse pattern** | `Session.ts` `getToolResultStore()`/`getMemoryService()` |
| **Per-session cache → tool handler delivery** | **MUST ADD** | `ToolRegistry.ts:459-468` forwards only `tabId`; `ToolContext` has no Session ref |
| **Desktop atomic check-then-write Rust command** | **MUST ADD** | none in `main.rs:335-423`; `skills_write_file` is unconditional overwrite |
| **Desktop fs read/stat returning mtime** | **MUST ADD** | `skills_read_file` returns content only, no mtime |
| **Server fs read/edit/write with freshness** | **MUST ADD** | server uses ad-hoc Node `fs`; no freshness layer |
| **Mutating-tool approval on server** | **MUST ADD** | server wires *no* ApprovalGate; `getDefaultRules` has no `'server'` arm (`defaultRules.ts:112`) |
| **Sensitive-path/`.git`/settings guard for file tools** | **MUST ADD / generalize** | `SensitivePathEnhancer.ts:38-40` hard-gated to `terminal` only |
| Non-zero risk assessor for edit/write | **MUST ADD** | read-only uses `StaticRiskAssessor(0)`; no write-aware assessor |
| Sandbox coverage of direct fs commands | **MUST ADD (decision)** | terminal sandbox wraps shell only; direct `invoke` fs bypasses it |

---

## 4. Architecture

### 4.1 The freshness cache (`FileStateCache`), per-session, owned by `Session`

A new `src/core/files/FileStateCache.ts` ports claudy's semantics:

```ts
export interface FileState {
  content: string;          // RAW disk bytes (no line numbers)
  mtimeFloorMs: number;     // Math.floor(mtimeMs) — floored on store AND compare
  offset?: number;          // SET by read (Read-vs-Edit discriminator); undefined after edit/write
  limit?: number;
  isPartialView?: boolean;  // injected/partial content ⇒ treated as "not read" by the edit gate
}
```

- Bounded LRU (≈100 entries / 25 MB), keys = normalized absolute path. Eviction → forced re-read (acceptable, matches claudy).
- **Owned by `Session`** as a private field with `getFileStateCache()` — exactly mirroring `Session.getToolResultStore()` / `getMemoryService()`. Sub-agent sessions get their own (clone-on-fork semantics deferred; v1 = independent per session).

### 4.2 Delivering the cache to tool handlers — the central seam

This is the one genuinely new piece of plumbing. Today `ToolRegistry.execute` builds `ToolContext` at `ToolRegistry.ts:459-468` forwarding **only `tabId`**; `ToolContext` carries no `Session` reference. Tool handlers are session-agnostic registry callbacks.

**Decision: thread the cache handle through the execution request → context (Option A).** `TurnManager.executeBrowserTool` already holds `this.session` and builds the `ToolExecutionRequest` (`TurnManager.ts:1057-1069`). It injects `fileStateCache: this.session.getFileStateCache()` into the request; `ToolRegistry.execute`'s context build is widened to forward request-supplied cache into `ToolContext.metadata.fileStateCache`. The handler reads `context.metadata.fileStateCache`.

- Rejected Option B (registry-side `Map<sessionId, FileStateCache>`): introduces a second ownership/eviction authority and a hidden global; `Session` is already the natural owner.
- **Verified single chokepoint:** all dispatch — main turn, sub-agents (own `Session` via `RepublicAgentEngine`), server — funnels through the one `ToolContext` build at `ToolRegistry.ts:459-468`. There are **three** `registry.execute` call sites (`TurnManager.ts:1071`, `tools/index.ts:53`, `buildSubAgentInvoker.ts:49`); the cache handle is injected on the request at `TurnManager`'s build (`TurnManager.ts:1057-1069`) and the single context build is widened to forward it. Because sub-agents own their own `Session`, a per-session cache **auto-isolates per sub-agent** with zero extra work.
- The `tools/index.ts:53` path has **no `Session`** (test/utility) — tools MUST degrade gracefully: absent cache ⇒ behave as "file not read yet" (refuse edits, allow reads without populating). Never throw on a missing cache.
- In-process only — no serialization concern. Desktop tools still call Rust via `invoke`; the cache + JS *advisory* pre-check stay in JS; the **authoritative** re-stat + edit + write is one atomic Rust/Node op (§4.3).

### 4.3 The filesystem executor (desktop/server split) — sibling of Phase 3's `RipgrepExecutor`

`src/tools/file-search/` already establishes the pattern: one module hides the desktop-`invoke` vs server-`child_process` split behind a typed contract. Phase 4 adds a sibling `FileSystemExecutor` with the same shape:

```ts
// Detected from disk on read, echoed back on write so endings/encoding round-trip.
interface FileMeta { mtimeFloorMs: number; size: number; endings: 'LF' | 'CRLF'; encoding: 'utf8' | 'utf16le'; bom: boolean; }

interface FileSystemExecutor {
  readFile(path, opts): Promise<{ content: string /* LF-normalized */; meta: FileMeta }>;
  stat(path): Promise<{ exists: boolean; mtimeFloorMs: number; size: number }>;

  // EDIT — atomic, server-side. Re-reads disk, verifies freshness, applies the
  // exact-match substitution against FRESH bytes, re-applies endings+encoding,
  // writes — all in one op. The frontend NEVER computes the post-edit blob.
  applyEditIfUnchanged(args: {
    path: string;
    oldString: string; newString: string; replaceAll: boolean;
    expectedMtimeFloorMs: number;          // from the cache entry
    expectedContent: string;               // cache entry content (LF-norm) — jitter fallback oracle
  }): Promise<
    | { ok: true; newContent: string /* LF-norm */; meta: FileMeta }
    | { ok: false; reason: 'stale' | 'not_found' | 'no_match' | 'not_unique' }
  >;

  // WRITE — full overwrite (no find/replace ⇒ no stale-base hazard).
  // expectedMtimeFloorMs===null ⇒ create-only (must not exist).
  writeIfUnchanged(path, content, expectedMtimeFloorMs: number | null, meta: Pick<FileMeta,'endings'|'encoding'|'bom'>):
    Promise<{ written: true; meta: FileMeta } | { written: false; reason: 'stale' | 'exists' }>;
}
```

**Why `applyEditIfUnchanged` takes `oldString/newString`, not a precomputed blob (correctness fix §0.1):** claudy applies the edit to *freshly re-read disk bytes* inside its atomic critical section, not to the cached content. Porting that faithfully across the JS↔IPC boundary means the **substitution itself must run server-side** against the fresh read. The Rust/Node op: (1) re-read disk + re-stat; (2) if `floor(mtime) !== expectedMtimeFloorMs`: if fresh bytes (LF-norm) `=== expectedContent` → proceed (benign-touch jitter fallback, claudy parity), else return `stale`; (3) exact-substring-match `oldString` in fresh bytes — `0 matches ⇒ no_match`, `>1 && !replaceAll ⇒ not_unique`; (4) substitute (first occurrence or `replaceAll`); (5) re-apply original endings+encoding+BOM; (6) write. Empty `oldString` ⇒ create-new-file (reject if file exists & non-empty). This makes the model **claudy-equivalent**, closing the silent-data-loss hole in the original design.

- **Desktop** → new net-new Rust commands (no shell; struct args; no existing command adaptable — `skills_write_file` is non-atomic `fs::write`). Registered in `tauri/src/main.rs generate_handler!`:
  - `fs_read_file(path) -> { content, mtime_ms, size, endings, encoding, bom }`
  - `fs_stat(path) -> { exists, mtime_ms, size }`
  - `fs_apply_edit(path, old, new, replace_all, expected_mtime_ms, expected_content) -> Result<EditOutcome>`
  - `fs_write_if_unchanged(path, content, expected_mtime_ms: Option<u64>, endings, encoding, bom) -> Result<WriteOutcome>`
  - Rust returns `mtime_ms` as **floored integer ms** matching JS `Math.floor(statMtimeMs)` (cross-language consistency, §0.2). The TOCTOU-critical re-stat→match→write is one Rust command — claudy's "no await between recheck and write" honored Rust-side, since it cannot be honored across IPC.
- **Server** → Node `fs` in-process; performs the same re-read→verify→substitute→write synchronously (claudy's exact model). Same logical contract; same floored-ms convention via Node.

### 4.4 The tool abstraction (`FileAccessTool`, sibling of `FileSearchTool`)

A small base sharing result/error shaping and the executor handle; subclasses declare schema + behavior:

| Tool | Mutating? | Approval | Notes |
|---|---|---|---|
| `read_file` | No | `StaticRiskAssessor(0)` (auto-approve, like grep/glob) | Populates `FileStateCache` (offset SET, LF-normalized content, executor-sourced floored mtime). Size pre-gate, line/byte cap, `cat -n`, offset/limit, dedup stub, never persisted (`maxResultSizeChars: Infinity`). |
| `edit_file` | **Yes** | custom `FileWriteRiskAssessor` (score >30 ⇒ ASK) **+ self-contained path guard** | JS *advisory* pre-check (cache entry exists, not `isPartialView`, mtime not advanced) for a fast/clear error; **authoritative** gate + substitution is `applyEditIfUnchanged` server-side against fresh bytes. Exact-match + uniqueness-or-`replace_all` + empty-`old_string`=new-file. Post-success: cache `set` with new content + new mtime + `offset:undefined`. |
| `write_file` | **Yes** | same as edit | New file = no prior read (create-only); existing file = read-before-overwrite (cache entry required, not partial). Always LF. Atomic via `writeIfUnchanged`. |

Deferred: `notebook_edit`, multi-edit (the `getPatchForEdits` "old_string ⊄ prior new_string" rule is documented for if/when multi-edit lands). MVP edit = **exact match only** — claudy's curly-quote normalization / API-tag de-sanitization / `.md` trailing-space exception are explicitly deferred (they mitigate claudy's own API sanitization). Consequence to document for users: with exact-match-only, files containing curly quotes the model "straightened" will return `no_match` rather than silently mis-editing — a safe, conservative failure.

### 4.5 Safety — and the server gap

Read auto-approves. Edit/Write must NOT. Verified reality: `SensitivePathEnhancer` is hard-gated to `terminal` (`SensitivePathEnhancer.ts:38-40`) so it gives file tools **zero** path protection *even on desktop/extension*; and **server wires no `ApprovalGate` at all**. So the approval pipeline cannot be relied on for path safety anywhere — the guard must be **fully self-contained in the tool**.

1. **A self-contained, mode-independent path-safety guard inside the file tools.** Denies writes to: outside the working root (see decision below) unless explicitly targeted, `.git/`, `.ssh/`, `.env*`, `settings.json`/known config files, `.vscode/`/`.idea/`, home-dir dotfiles. Mirrors claudy's bypass-immune `safetyCheck`. **Semantics differ by platform availability of an approval UI:** where an `ApprovalGate` exists (desktop/extension) a borderline path may surface as *ask*; **on server there is no approval UI, so the guard is allow-or-hard-deny only** (never silently allow a sensitive write because "no gate").
2. **A `FileWriteRiskAssessor`** (non-zero score, trips `defaultRules` `riskAbove:30 ⇒ ASK`) so desktop/extension still prompt for ordinary writes; declare `runtime.concurrency.isReadOnly:()=>false, isDestructive:()=>true`. This is *additive* to layer 1, not a substitute — it is absent on server.

**Working-root decision (promoted from open question — required for implementation):**
- **Desktop:** root = `invoke('get_project_root')` (exists, `commands.rs:28-34`); writes confined to it unless the path is explicitly user-/task-supplied and passes the guard.
- **Server:** there is **no** `get_project_root` equivalent. Root MUST be an explicit config value (e.g. `SessionServices.serverRootDir` / a `FILE_TOOLS_ROOT` env / agent config), resolved once at bootstrap. If unset, `write_file`/`edit_file` are **disabled on server** (fail closed) rather than defaulting to `process.cwd()`.
- The guard resolves symlinks and rejects `..` escapes before the root check (claudy resolves symlink + original path; mirror that).

Follow-ups (not blocking v1): add a `'server'` arm to `getDefaultRules` + wire a server ApprovalGate; generalize `SensitivePathEnhancer` beyond `terminal` (currently hard-gated, `SensitivePathEnhancer.ts:38-40`).

### 4.6 Sandbox

The terminal sandbox wraps **shell commands only**; direct `invoke` fs commands bypass it. Decision: the file tools enforce their **own writable-roots policy** (§4.5 layer 1) independent of the terminal sandbox. Documented explicitly so this isn't mistaken for a sandbox regression.

---

## 5. End-to-end flow on Apple Pi (desktop)

```
model → read_file
  ToolRegistry.execute → ApprovalGate (auto-approve, StaticRiskAssessor 0)
  → context.metadata.fileStateCache  (injected by TurnManager from Session)
  → FileSystemExecutor.readFile → desktop invoke('fs_read_file')
  → cache.set(absPath,{content, mtimeFloorMs, offset, limit})   [Read entry]
  → cat -n + caps; not persisted

model → edit_file
  JS ADVISORY pre-check (fast clear error only — NOT authoritative):
        cache.get → missing|isPartialView ⇒ "read it first"
        floor(cached.mtime) stale-looking ⇒ hint "may be modified"
  self-contained path guard (symlink-resolved, root-confined; deny-only on server)
  ApprovalGate (FileWriteRiskAssessor >30 ⇒ ASK) [desktop/ext only; ABSENT on server]
  → FileSystemExecutor.applyEditIfUnchanged({path, old, new, replaceAll,
                                             expectedMtimeFloorMs, expectedContent})
        → invoke('fs_apply_edit', …)        ── ATOMIC, single Rust command ──
        Rust: re-read fresh bytes + re-stat
              floor(mtime)≠expected ? (fresh==expectedContent ? proceed : return 'stale')
              exact-match old in FRESH bytes → 0:'no_match' | >1&!all:'not_unique'
              substitute → re-apply endings+encoding+BOM → write
        ok:false ⇒ surface reason ('stale'⇒"modified since read, re-read")
  → cache.set(absPath,{content:newContent(LF), mtimeFloorMs:new, offset:undefined})  [Edit entry]
  → short confirmation (≤100k)
```

The substitution runs **server-side against freshly-read disk bytes** — the frontend never builds the post-edit blob from the cache (§0.1 correctness fix). Server is identical except the executor uses in-process Node `fs` (claudy's exact synchronous re-read→verify→substitute→write) and the `ApprovalGate` layer is absent (the self-contained path guard is the only safety floor, deny-only).

---

## 6. Phasing (independently mergeable)

| Phase | Scope | Ships |
|---|---|---|
| **4·0 — Prerequisite (BLOCKER)** | Merge #225 (`feat/045` file-search abstraction) into `agent-improvements` so `RipgrepExecutor`/`FileSearchTool`/`src/tools/file-search/` exist to build the `FileSystemExecutor`/`FileAccessTool` siblings. (Or explicitly vendor the executor-split pattern.) #223 also lands so code mode surfaces the tools. | Phase 4 can start. |
| **4a — Freshness substrate + `read_file`** | `FileStateCache` (LF-norm content, executor-sourced floored mtime) + `Session` ownership + cache-delivery seam (widen the single `ToolRegistry.ts:459-468` ctx build; inject at `TurnManager.ts:1057-1069`; graceful no-Session degrade) + `FileSystemExecutor.readFile/stat` (desktop `fs_read_file`/`fs_stat` returning endings+encoding+bom; server Node) + `read_file` (read-only, auto-approve, caps, `cat -n`, dedup, never-persist). | Code mode reads files structurally; cache populated. Independently useful. |
| **4b — `edit_file`** | Net-new atomic `fs_apply_edit` Rust command + Node equivalent (re-read→verify(+jitter fallback)→exact-match/uniqueness→substitute→re-apply endings/encoding→write, all server-side); JS advisory pre-check; self-contained path guard; `FileWriteRiskAssessor`. | Trustworthy edits — the claudy-parity, data-loss-safe milestone (§0.1). |
| **4c — `write_file`** | `fs_write_if_unchanged` (create-only vs read-before-overwrite), always-LF, encoding round-trip, same guard. | Full read/edit/write. |
| **4d — hardening (follow-up)** | Server `ApprovalGate` + `getDefaultRules('server')`; generalize `SensitivePathEnhancer` past `terminal`; sub-agent cache clone/merge-on-fork; optional notebook/multi-edit (+`getPatchForEdits` substring guard); token-accurate caps. | Production hardening. |

---

## 7. Open Questions

Resolved by the design review (now binding, see §0.2 / §4.5): the edit-content/atomicity model (server-side fresh-read), server working-root (explicit config, fail-closed), the jitter fallback (implement in the atomic op), cross-language mtime precision, line-ending+encoding round-trip, server safety semantics (deny-only).

Genuinely still open:
1. **Output cap for `read_file`**: byte/line proxy for v1 (no tokenizer) — revisit if it mis-sizes vs real token budget.
2. **Exact sensitive-path list** and block-vs-ask matrix per platform — §4.5 is the starting set; needs a final pinned list before 4b coding.
3. **Server approval as a follow-up (4d) vs blocker**: recommend ship 4a–4c with the self-contained deny-only guard as the floor; flag the residual gap (no per-write prompt on server) for the user to accept.
4. **Sub-agent cache fork semantics**: v1 = independent per session (auto via own `Session`); claudy's `cloneFileStateCache`/`mergeFileStateCaches` deferred to 4d — confirm acceptable.
5. **LRU bound sizing** for Apple Pi (claudy: 100 entries / 25 MB) — adopt as defaults; revisit if sessions thrash evictions → spurious re-reads.

---

## 8. Success Criteria

- **SC-1** After `read_file`, the session `FileStateCache` holds a Read entry (offset set, floored mtime); a subsequent identical `read_file` returns the dedup stub, not a re-read.
- **SC-2** `edit_file` without a prior `read_file` is refused with "read it first" (not a blind write).
- **SC-3** `edit_file` after the file changed on disk (newer mtime, different bytes) is refused with "modified since read"; a benign touch (newer mtime, byte-identical to the cached full read) succeeds via the in-op content-equality fallback.
- **SC-4 (the §0.1 correctness criterion)** A file changed on disk **with no mtime advance** does NOT cause silent data loss: because `fs_apply_edit` re-reads fresh bytes and matches `old_string` against *those*, the edit either applies to the true current content or returns `no_match` — it never writes a blob derived from stale cached content. Verified-equivalent to claudy.
- **SC-5** `edit_file` exact-match runs against freshly-read disk bytes: a non-unique `old_string` ⇒ `not_unique` unless `replace_all`; zero matches ⇒ `no_match`; empty `old_string` creates a new file only when absent/empty.
- **SC-6** Writing `.git/`, `settings.json`, `.ssh/`, `.env`, or outside the working root is hard-denied by the self-contained guard **on every platform incl. server (no ApprovalGate, deny-only there)**; symlink/`..` escapes are resolved before the root check.
- **SC-7** `read_file` is never persisted (no Read→file→Read loop); large files are size-gated pre-read.
- **SC-8** `edit_file` preserves the file's existing line endings; `write_file` writes LF. Post-write the cache entry is an Edit entry (offset undefined) and the next `read_file` does not serve a stale stub.
- **SC-9** Desktop and server produce identical tool-visible behavior via the `FileSystemExecutor` contract.

---

## 9. Settled Decisions (for reviewers)

- **The freshness gate is the feature**, not file I/O. Port claudy's `FileStateCache` semantics verbatim (floored mtime, offset-as-discriminator, `isPartialView`≡unread, full-read content fallback, never-persist-read).
- **CORRECTED (§0.1): the edit transformation runs server-side against freshly-read disk bytes**, not in JS against the cache. The atomic op is `fs_apply_edit(path, old, new, replace_all, expectedMtime, expectedContent)` (re-read→verify+jitter-fallback→exact-match→substitute→re-apply endings/encoding→write), not a precomputed-blob `writeIfUnchanged`. This closes a silent-data-loss hole and is verified claudy-equivalent. `write_file` (no find/replace) keeps the blob+mtime shape.
- **Atomicity is one backend op.** Claudy's in-process "no await between recheck and write" is impossible across the WebView↔Rust IPC boundary; desktop = one Rust command, server = one in-process Node op. The JS pre-check is **advisory only** (a permission prompt can occur between it and the write).
- **Cross-language mtime + endings/encoding consistency is binding** (§0.2): same executor sources read-store and write-compare mtime at `floor(ms)`; cache holds LF-normalized content; backend round-trips original endings + encoding + BOM.
- **Cache delivery = thread through the single `ToolContext` build** (Option A); `Session` owns the cache; sub-agents auto-isolate (own `Session`); the no-`Session` `tools/index.ts` path degrades to "not read". Rejected a registry-side sessionId→cache map.
- **Edit is exact-match only for v1.** Claudy's quote/sanitization niceties are claudy-pipeline-specific; deferred. Consequence (curly-quote `no_match`) is a safe conservative failure, documented.
- **Self-contained path guard is mandatory, mode-independent, deny-only on server.** The approval pipeline gives zero path protection to file tools anywhere (`SensitivePathEnhancer` is terminal-gated; server has no `ApprovalGate`). Working root: desktop `get_project_root`; server explicit config, **fail-closed if unset**.
- **Sibling abstraction:** `FileSystemExecutor`/`FileAccessTool` parallel Phase 3's `RipgrepExecutor`/`FileSearchTool`.
- **HARD ORDERING GATE:** Phase 4 cannot start until #225 (file-search abstraction) is on `agent-improvements`; #223 should also land. Not a footnote — Phase 4·0.
