# Apple Pi File Tools — Read / Edit / Write (Code Mode, Phase 4)

**Status**: Draft
**Branch**: `feat/046-applepi-file-tools` (off `agent-improvements`)
**Date**: 2026-05-15
**Scope**: Apple Pi desktop + server. Browserx (extension) out of scope (no filesystem).
**Depends on (not yet merged into `agent-improvements`):**
- PR #223 — per-session agent modes; `coder_*` prompt fragments promise dedicated file tools.
- PR #225 — `src/tools/file-search/` abstraction (`RipgrepExecutor`, `FileSearchTool` base, the desktop-`invoke`/server-`child_process` executor split, hybrid binary sourcing, the Rust-command pattern). Phase 4 reuses this abstraction's shape.

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
- This is a localized change (two construction sites) and keeps tools decoupled from `Session` (they see an interface, not the session).
- In-process only — no serialization concern. Desktop tools still call Rust via `invoke`; the cache + gate logic stays in JS, only the atomic write/stat crosses IPC.

### 4.3 The filesystem executor (desktop/server split) — sibling of Phase 3's `RipgrepExecutor`

`src/tools/file-search/` already establishes the pattern: one module hides the desktop-`invoke` vs server-`child_process` split behind a typed contract. Phase 4 adds a sibling `FileSystemExecutor` with the same shape:

```ts
interface FileSystemExecutor {
  readFile(path, opts): Promise<{ content: string; mtimeFloorMs: number; size: number }>;
  stat(path): Promise<{ exists: boolean; mtimeFloorMs: number; size: number }>;
  // Atomic: stat+compare+write in ONE step. expectedMtimeFloorMs===null ⇒ create-only.
  writeIfUnchanged(path, content, expectedMtimeFloorMs: number | null, endings: 'LF' | 'CRLF'):
    Promise<{ written: true; mtimeFloorMs: number } | { written: false; reason: 'stale' | 'exists' }>;
}
```

- **Desktop** → new Rust commands (no shell, argv/struct args — no injection surface, mirroring `ripgrep_execute`):
  - `fs_read_file(path) -> { content, mtime_ms, size }`
  - `fs_stat(path) -> { exists, mtime_ms, size }`
  - `fs_write_if_unchanged(path, content, expected_mtime_ms: Option<u64>, endings) -> Result<WriteOutcome>` — **stats, compares `floor(mtime)`, applies the full-content fallback, and writes within one command**. This is where claudy's "no await between recheck and write" invariant is honored: the TOCTOU-critical section lives entirely in Rust, not across the JS↔IPC boundary. Registered in `tauri/src/main.rs` `generate_handler!`.
- **Server** → Node `fs` in-process; can do claudy's tight synchronous re-check-then-write directly (same logical contract).

### 4.4 The tool abstraction (`FileAccessTool`, sibling of `FileSearchTool`)

A small base sharing result/error shaping and the executor handle; subclasses declare schema + behavior:

| Tool | Mutating? | Approval | Notes |
|---|---|---|---|
| `read_file` | No | `StaticRiskAssessor(0)` (auto-approve, like grep/glob) | Populates `FileStateCache` (offset SET). Size pre-gate, line/byte cap, `cat -n`, offset/limit, dedup stub, never persisted (`maxResultSizeChars: Infinity`). |
| `edit_file` | **Yes** | custom `FileWriteRiskAssessor` (score >30 ⇒ ASK) **+ hard path-safety guard** | Exact-match + uniqueness-or-`replace_all` + empty-`old_string`=new-file. Read-before-edit + atomic recheck via `writeIfUnchanged`. Preserves file endings. |
| `write_file` | **Yes** | same as edit | New file = no prior read; existing file = read-before-overwrite. Always LF. |

Deferred: `notebook_edit`, multi-edit (the `getPatchForEdits` substring rule is documented for if/when multi-edit lands). MVP edit = exact match only — **claudy's curly-quote/de-sanitization/`.md` niceties are explicitly deferred** (they mitigate claudy's own API sanitization; add only if Apple Pi's model pipeline shows the same need).

### 4.5 Safety — and the server gap

Read auto-approves. Edit/Write must NOT. Two layers:

1. **A hard, mode-independent path-safety guard inside the tools themselves** (not relying solely on ApprovalGate). Blocks/asks for: outside the project root unless explicitly targeted, `.git/`, `.ssh/`, `.env*`, `settings.json`/config files, `.vscode/`/`.idea/`. This mirrors claudy's bypass-immune `safetyCheck` denials and — critically — is robust on **server, where no ApprovalGate is wired at all** (`src/server` has no `PolicyRulesEngine`/`setApprovalGate`; `ToolRegistry.execute` skips approval when `this.approvalGate` is absent). Self-gating tools are defense-in-depth that works on every platform.
2. **A `FileWriteRiskAssessor`** returning a non-zero score so the existing `defaultRules` `riskAbove:30 ⇒ ASK` rule prompts on desktop/extension where the gate exists; declare `runtime.concurrency.isReadOnly:()=>false, isDestructive:()=>true`.

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
  validateInput-equiv: cache.get → missing|partial ⇒ "read it first"
                       floor(stat.mtime) > entry ⇒ (full-read fallback) else "modified since read"
                       exact-match + uniqueness | replace_all
  hard path-safety guard (mode-independent)
  ApprovalGate (FileWriteRiskAssessor >30 ⇒ ASK) [desktop/ext; absent on server → guard is the floor]
  → FileSystemExecutor.writeIfUnchanged → invoke('fs_write_if_unchanged', expectedMtime)
        Rust: stat→compare→(fallback)→write  ── atomic, single command ──
        returns {written:false,'stale'} ⇒ surface "modified since read, re-read"
  → cache.set(absPath,{content:updated, mtimeFloorMs:new, offset:undefined})   [Edit entry]
  → short confirmation (≤100k)
```

Server is identical except `FileSystemExecutor` uses in-process Node `fs` (claudy's tight sync recheck-then-write) and the ApprovalGate layer is currently absent (the in-tool path guard is the safety floor).

---

## 6. Phasing (independently mergeable)

| Phase | Scope | Ships |
|---|---|---|
| **4a — Freshness substrate + `read_file`** | `FileStateCache` + `Session` ownership + the cache-delivery seam (`TurnManager`/`ToolRegistry` context widening) + `FileSystemExecutor` (desktop `fs_read_file`/`fs_stat`, server Node) + `read_file` (read-only, auto-approve, caps, `cat -n`, dedup). | Code mode can read files structurally; cache is populated. Independently useful before edit/write exist. |
| **4b — `edit_file`** | Exact-match+uniqueness algorithm, read-before-edit gate, `fs_write_if_unchanged` Rust command (atomic), endings preservation, `FileWriteRiskAssessor` + in-tool path-safety guard. | Structured, trustworthy edits (the claudy-parity milestone). |
| **4c — `write_file`** | Create vs read-before-overwrite, always-LF, same atomic command + guard. | Full read/edit/write. |
| **4d — hardening (follow-up)** | Server ApprovalGate + `getDefaultRules('server')`; generalize `SensitivePathEnhancer`; sub-agent cache semantics; optional notebook/multi-edit; token-accurate caps. | Production hardening. |

---

## 7. Open Questions

1. **Output cap for `read_file`**: claudy uses a real token count post-read. Recommend a **byte/line proxy** for v1 (no tokenizer dependency), revisit if it mis-sizes.
2. **Exact sensitive-path policy list** (block vs ask vs allow-with-prompt) — needs a concrete decision; §4.5 is the starting set.
3. **Server approval**: ship 4a–4c with the in-tool guard as the floor and defer server ApprovalGate wiring to 4d, or block on it? Recommend defer (guard is robust); flag clearly.
4. **Claudy edit-normalization niceties** (curly quotes, de-sanitization, `.md` trailing space): recommend **defer** until evidence Apple Pi's model needs them.
5. **Sub-agent `FileStateCache`**: independent per session in v1; clone/merge-on-fork (claudy's `cloneFileStateCache`/`mergeFileStateCaches`) deferred.
6. **LRU bound sizing** for Apple Pi sessions (claudy: 100/25 MB) — adopt claudy's defaults initially.

---

## 8. Success Criteria

- **SC-1** After `read_file`, the session `FileStateCache` holds a Read entry (offset set, floored mtime); a subsequent identical `read_file` returns the dedup stub, not a re-read.
- **SC-2** `edit_file` without a prior `read_file` is refused with "read it first" (not a blind write).
- **SC-3** `edit_file` after the file changed on disk since the read is refused with "modified since read" — except the full-read content-equality fallback suppresses false positives from mtime-only jitter.
- **SC-4** A concurrent on-disk modification between the JS pre-check and the write is caught by the **Rust atomic** `fs_write_if_unchanged` (returns `stale`), never a silent overwrite. (Desktop TOCTOU closed in Rust, not JS.)
- **SC-5** `edit_file` exact-match: a non-unique `old_string` errors unless `replace_all`; empty `old_string` creates a new file only when absent/empty.
- **SC-6** Writing `.git/`, `settings.json`, `.ssh/`, `.env`, or outside the project root is blocked/asked **even on server (no ApprovalGate)** by the in-tool guard.
- **SC-7** `read_file` is never persisted (no Read→file→Read loop); large files are size-gated pre-read.
- **SC-8** `edit_file` preserves the file's existing line endings; `write_file` writes LF. Post-write the cache entry is an Edit entry (offset undefined) and the next `read_file` does not serve a stale stub.
- **SC-9** Desktop and server produce identical tool-visible behavior via the `FileSystemExecutor` contract.

---

## 9. Settled Decisions (for reviewers)

- **The freshness gate is the feature**, not file I/O. Port claudy's `FileStateCache` semantics verbatim (floored mtime, offset-as-discriminator, isPartialView≡unread, full-read content fallback, never-persist-read).
- **Atomicity moves into Rust on desktop.** Claudy's in-process "no await between recheck and write" is impossible across the WebView↔Rust IPC boundary; the atomic stat-compare-write is one Rust command (`fs_write_if_unchanged`). Server keeps it in-process.
- **Cache delivery = thread through the execution request/context** (Option A), Session owns the cache. Rejected a registry-side sessionId→cache map (second ownership authority).
- **Edit is exact-match only for v1.** Claudy's quote/sanitization niceties are claudy-pipeline-specific; deferred.
- **In-tool hard path-safety guard is mandatory and mode-independent** — it is the only write safety floor on server (no ApprovalGate there) and mirrors claudy's bypass-immune safety denials.
- **Sibling abstraction, not subclass:** `FileSystemExecutor`/`FileAccessTool` parallel Phase 3's `RipgrepExecutor`/`FileSearchTool`; reuse the executor-split + result-shaping shape.
- **Reuses Phase 3 (#225) and Phase 1+2 (#223)** — must merge/rebase onto whatever order lands; this branch is off `agent-improvements` per current policy.
