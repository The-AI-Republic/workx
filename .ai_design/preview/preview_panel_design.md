# WorkX Desktop — Local File Preview Panel

**Status:** Ready for implementation
**Issue:** WORKXOS-7 — redesign the new chat UI for WorkX desktop
**Reviewed:** 2026-07-19 against branch `pi-dash/workxos-7` after merging `main`
**Scope:** Local UTF-8 code, Markdown, and text files changed by WorkX's direct file tools
**Audience:** WorkX desktop UI, runtime, and core engineers

---

## 1. Final decision

Add a right-hand Preview Panel to the desktop chat page. The first release is deliberately limited
to successful local text-file changes made through WorkX's existing `edit_file` and `write_file`
tools.

The implementation will:

- emit a structured `local_file_change` payload through the existing `ToolExecutionProgress` path;
- open a preview automatically on wide screens after the first previewable change in a task;
- show a unified diff, current source, and a safe rendered view for Markdown;
- keep preview state in memory and isolated by conversation;
- reuse the runtime's workspace jail for current-content reads; and
- select viewers through a small registry so later resource types remain additive.

It will not attempt to infer changes from terminal output, arbitrary MCP calls, or agent prose.
Browser sessions, connected apps, remote documents, binary files, and a universal artifact protocol
remain out of scope.

---

## 2. Final review findings and resolutions

The pre-implementation review resolved the following ambiguities in the earlier draft:

| Earlier ambiguity | Final resolution |
|---|---|
| Add a new top-level protocol event | Reuse `ToolExecutionProgress`, which already carries typed tool-specific payloads end to end. |
| Emit from `apply_patch`, `edit_file`, and `write_file` | Emit only from the implemented direct mutation tools: `edit_file` and `write_file`. No active `apply_patch` emitter exists in this codebase. |
| Model applying, completed, and failed previews | Emit preview data only after a mutation succeeds. Existing approval/tool events already represent pending and failed operations. |
| Support added, modified, deleted, and renamed files | V1 supports `created` and `modified`. There are no direct delete or rename tools today. |
| One item per path or per operation | Keep one item per successful operation so a chat event always opens the exact diff it announced. |
| Persist preview history | Keep it surface-local and in memory for V1. Reloading the app does not restore completed preview items. |
| Unlimited diff/file payloads | Enforce explicit diff, source, item-count, and per-thread memory ceilings. |
| Large diffs competing with normal replay events | Generate a diff only for at most 512 KiB of combined input and place at most 32 KiB in the event. The current replay ring is 1 MiB. |
| “Sanitize Markdown” without a mechanism | Parse with `marked`, escape raw HTML, sanitize generated HTML with DOMPurify, suppress images, and intercept links. |
| Optional resizable panel | Use a fixed responsive width in V1. Resizing and width persistence are deferred. |

There are no unresolved product or architecture questions blocking implementation.

---

## 3. Scope and preview eligibility

### 3.1 Included mutation paths

V1 observes only:

- `edit_file`, including creation through an empty `old_string`; and
- `write_file`, for both creation and full overwrite.

Both tools already operate on UTF-8 text through the jailed filesystem executor. A successful tool
call that leaves the text unchanged does not produce a preview event.

### 3.2 Excluded mutation paths

V1 does not observe:

- shell commands that redirect, generate, move, or delete files;
- external editors, build tools, or filesystem changes made outside WorkX;
- legacy `PatchApplyBegin`, `PatchApplyEnd`, `TurnDiff`, or
  `ApplyPatchApprovalRequest` messages, because no active local mutation path emits a complete,
  reliable diff through them;
- MCP or connected-app mutations;
- browser operations; or
- files that the agent only reads.

These exclusions are explicit limitations, not cases for tool-name heuristics.

### 3.3 Definition of previewable

A local-file change is previewable when all of the following are true:

1. It arrived as a completed `local_file_change` progress payload.
2. Its path is normalized and relative to the conversation workspace.
3. It represents a real content change.
4. At least one view can be offered:
   - Diff, when before plus after text is at most 512 KiB and the complete unified diff is at most
     32 KiB; or
   - Source, when the resulting file is at most 1 MiB.

Markdown rendering is available only when Source is available and the extension is `.md` or
`.markdown`, matched case-insensitively. `.mdx` remains Source-only.

| Resource | Available views | Default view |
|---|---|---|
| Code or plain UTF-8 text | Diff and/or Source | Diff, otherwise Source |
| Markdown | Diff and/or Rendered and Source | Diff, otherwise Source |
| Change outside either diff budget | Source, if file is at most 1 MiB | Source |
| Resulting file over 1 MiB | No V1 preview | N/A |
| No eligible diff or source | No preview item and no auto-open | N/A |

The limits are V1 UI limits and intentionally stricter than the file tool's existing 5 MiB read
limit.

---

## 4. User experience

### 4.1 Opening and closing

The panel is hidden initially and consumes no chat width.

For a live change in the active conversation on a wide screen:

- the first previewable change after `TaskStarted` opens the panel and selects that item;
- subsequent changes select the newest item while the panel remains open;
- closing the panel suppresses further auto-open for the rest of that task; and
- the next `TaskStarted` clears the suppression, but does not open the panel until another
  previewable change arrives.

On narrow screens, a change updates an unread badge on the Preview button but never opens a modal
drawer automatically. This avoids taking over the screen while the agent is working.

Live changes in a background conversation and changes reconstructed from attach replay also update
unread state without auto-opening. Auto-open is reserved for a new live change the user is already
watching.

At all widths:

- the Preview button toggles the panel or drawer;
- clicking a previewable file-change event in chat opens and selects its exact preview item;
- manually opening the preview or selecting a preview item clears unread state;
- switching conversations shows that conversation's in-memory preview state; and
- changing a conversation's working directory clears its preview items before the new workspace is
  used.

Approval denial, stale-write rejection, no-match, no-op, timeout, or execution failure creates no
preview item. The existing tool/approval event remains the source of truth for those outcomes.

### 4.2 Activity list

The panel shows previewable operations newest first. Repeated changes to the same path appear as
separate items because each item represents one exact operation diff.

Each item shows:

- `Created` or `Modified`;
- the workspace-relative path;
- a timestamp; and
- a notice when the diff was omitted because it exceeded the payload limit.

The store retains at most 20 items and 1 MiB of unified-diff text per conversation. It evicts the
oldest items until both limits are satisfied. This is activity history for the current UI surface,
not durable version history.

### 4.3 Layout

Reuse the existing `isWideMode` breakpoint, currently `(min-width: 1500px)`.

Wide mode:

```text
┌────────────┬────────────────────────────┬────────────────────────┐
│ Left nav   │ Chat                       │ Preview                │
│            │                            │ operation list         │
│            │ agent/tool events          │ ─────────────────────  │
│            │                            │ diff/rendered/source   │
└────────────┴────────────────────────────┴────────────────────────┘
```

- The preview is a sibling of the chat region inside `Main.svelte`, not a child of global
  `AppShell.svelte`.
- Width is `clamp(400px, 34vw, 520px)` and is not user-resizable in V1.
- Chat and preview scroll independently.

Narrow mode:

- use a right-side modal drawer with `width: min(92vw, 720px)`;
- close on Escape or backdrop click;
- focus the close button on open and restore focus to the Preview button on close; and
- expose `role="dialog"`, `aria-modal="true"`, and an accessible label.

---

## 5. Verified WorkX implementation baseline

The design relies on these current repository facts:

- `edit_file` and `write_file` are implemented in
  `src/tools/file-search/FileAccessTool.ts` and receive a trusted workspace plus per-session
  `FileStateCache` through `ToolContext`.
- The tools call `fsExecutor`, which routes the desktop runtime build to
  `src/server/tools/fs/NodeFsExecutor.ts`.
- `NodeFsExecutor` provides workspace containment, symlink-aware path checks, sensitive-path
  blocking, LF normalization, strict UTF-8 decoding, and file metadata.
- The 5 MiB agent read ceiling is enforced by `ReadFileTool` before calling the executor; it is not
  enforced inside `NodeFsExecutor.readFile`. The preview service therefore needs its own size gate.
- `ToolContext.onProgress` already carries tool-specific structured data. `TurnManager` wraps it in
  `ToolExecutionProgress`, and desktop channel routing delivers the raw protocol event to
  `Main.svelte`.
- `src/tools/runtimeMetadata.ts` is the canonical location for typed progress payloads.
- `EventProcessor` already special-cases other progress types such as `data_query`.
- `Main.svelte` processes both active- and background-thread events and replays the uncommitted event
  tail during attach.
- `AppShell.svelte` and `layoutStore.ts` already implement the wide/drawer responsive convention.
- `marked` is installed. `diff` and `dompurify` are not direct dependencies yet.
- Tool progress events are not durable conversation history. They may be recovered from the bounded
  live replay tail, but not after a completed turn and full app reload.

The central implementation seam is therefore the successful return path in the two local file
tools, not `EventProcessor` inference and not a new protocol family.

### 5.1 Architectural non-interference invariants

Preview is an optional observer of a completed mutation. The implementation must preserve these
boundaries:

- Do not change model prompts, tool definitions, tool parameters, tool result strings, approval
  policy, concurrency classification, or filesystem mutation semantics.
- Do not add a second file-change tracker, modify rollout history, or add preview state to `Session`,
  `TurnManager`, or `SessionManager`.
- Do not add a new top-level protocol event. Use the established tool-progress extension point.
- Keep every preview progress event below 32 KiB of diff text. `SwitchableEventGate` shares a 1 MiB
  replay ring across normal agent events, so preview must never place whole large files or large
  patches on that channel.
- Skip diff generation before invoking `jsdiff` when the combined UTF-8 size of before and after
  text exceeds 512 KiB. The size gate prevents an optional UI feature from adding unbounded CPU or
  latency to the agent's successful tool path.
- Catch all preview generation and dispatch failures after a successful write. They may remove the
  preview, but they must not change the tool result or task outcome.
- Register `preview.readLocalText` only through the existing optional service factory mechanism and
  only for the desktop-runtime profile.
- Keep all selection, rendering, and responsive behavior in the webfront. Core/runtime code emits a
  local-file change fact and has no dependency on Svelte or panel concepts.

With these invariants, disabling or removing the preview UI leaves current agent execution and
conversation behavior unchanged.

---

## 6. Runtime event contract

### 6.1 Typed progress payload

Add this type to `src/tools/runtimeMetadata.ts`:

```ts
export type LocalFileChangeOperation = 'created' | 'modified';

export interface LocalFileChangeProgress extends ToolProgressData {
  type: 'local_file_change';
  status: 'completed';
  operation: LocalFileChangeOperation;
  path: string; // normalized, workspace-relative, forward slashes
  size: number; // resulting on-disk byte size
  mtimeMs: number; // resulting on-disk mtime from the executor
  unifiedDiff?: string; // complete patch; absent when over the V1 limit
  diffOmittedReason?: 'input_too_large' | 'diff_too_large' | 'generation_failed';
  message: string; // e.g. "Modified src/app.ts"
}
```

No new `EventMsg` member, event-scope mapping, wire name, or server streaming mapping is required.
The existing `ToolExecutionProgress` envelope supplies `tool_name`, `call_id`, `session_id`,
`turn_id`, and `timestamp`.

### 6.2 Emission rules

Create a shared helper in the file-tool package that:

1. receives the trusted workspace root, accepted path, before text, after text, operation, and
   resulting file metadata;
2. converts the accepted path to a normalized workspace-relative display path without exposing the
   absolute workspace root;
3. measures before plus after text and skips diff generation when their combined UTF-8 size exceeds
   512 KiB;
4. otherwise builds a unified, three-context-line patch from LF-normalized before/after text using
   `diff` (`jsdiff`);
5. includes the complete patch only when its UTF-8 size is at most 32 KiB; and
6. calls `context.onProgress` with `toolUseID = context.callId`, falling back to a deterministic
   turn/tool/path identifier only when the call ID is absent.

Emit exactly once, after the executor confirms the write, and only when `before !== after`.

Tool-specific before/after rules:

- `edit_file`: stat before execution to distinguish an absent file from an existing empty file.
  For a modification, use the full cache entry as `before`; for creation use `''`. Use
  `res.newContentLf` as `after`.
- `write_file`: use the pre-write stat to classify the operation. For an overwrite, use the required
  full cache entry as `before`; for creation use `''`. Use the same LF normalization as
  `writeIfUnchanged` for `after`.

Do not emit when validation, approval, freshness, encoding, path, match, uniqueness, or executor
checks reject the mutation. The file tools currently return some semantic failures as strings while
the registry still reports tool execution success, so the emitter must be gated on the executor's
successful discriminant (`ok === 'true'` or `written === 'true'`), not on `ToolExecutionEnd`.

Preview generation is ancillary. Load `diff` lazily inside the helper, and wrap diff construction
and `onProgress` dispatch so a preview failure is logged but never converts an already-successful
file mutation into a failed tool call. When generation fails, emit the small change descriptor with
`diffOmittedReason: 'generation_failed'` so an eligible Source view still works.

### 6.3 Why completed-only

The file executors validate freshness and mutation atomically within their current contract. Before
that call returns, the UI cannot know that an edit will be applied. Emitting only after success makes
the event truthful and avoids duplicating approval and failure state already visible in chat.

---

## 7. Frontend state and extension seam

### 7.1 Preview item

```ts
export type LocalFilePreviewView = 'diff' | 'rendered' | 'source';

export interface LocalFilePreviewItem {
  id: string; // ToolExecutionProgress Event.id; stable across replay
  sessionId: string;
  sourceCallId?: string;
  turnId?: string;
  resource: {
    type: 'local-text-file';
    path: string;
  };
  operation: 'created' | 'modified';
  size: number;
  mtimeMs: number;
  unifiedDiff?: string;
  diffOmittedReason?: 'input_too_large' | 'diff_too_large' | 'generation_failed';
  availableViews: LocalFilePreviewView[];
  createdAt: number;
}

export interface ThreadPreviewState {
  items: LocalFilePreviewItem[];
  selectedItemId: string | null;
  selectedView: LocalFilePreviewView | null;
  open: boolean;
  unread: boolean;
  autoOpenSuppressed: boolean;
}
```

`previewStore` is a Svelte store keyed by session ID. It is the single owner of item retention,
selection, open state, unread state, and task-scoped auto-open suppression.

Its projector consumes raw protocol events before chat formatting:

- `TaskStarted` resets `autoOpenSuppressed` and leaves the panel closed/open as the user left it.
- Completed `local_file_change` progress creates an item when at least one view is available.
- A duplicate event ID replaces the existing item rather than appending.
- `clearSession(sessionId)` runs on thread deletion or working-directory change.
- `removeSession(sessionId)` runs when the thread is removed from the UI.

Projection receives `{ isActive, isWide, isReplay }` from `Main.svelte`. It may auto-open only when
`isActive && isWide && !isReplay && !autoOpenSuppressed`; all other new items set unread state. A
new item becomes the selected item even while closed so reopening shows the latest operation.

The default view is Diff when available, otherwise Source. Rendered Markdown is always an explicit
tab choice in V1.

### 7.2 Renderer registry

Resolve the selected view through a small registry:

```ts
interface PreviewRenderer {
  id: string;
  supports(item: LocalFilePreviewItem, view: LocalFilePreviewView): boolean;
  component: import('svelte').Component;
}
```

The initial registry contains only Diff, Markdown, and Source renderers. The panel owns selection,
layout, and lifecycle; renderers own presentation for one view. A future feature can widen the
resource union and register a renderer without putting app- or browser-specific branches in the
panel shell.

---

## 8. Current-content service

Diff text travels in the progress payload. Source and rendered Markdown load the current file only
when selected.

### 8.1 Service contract

Register a desktop-runtime-only service:

```ts
// request
interface ReadLocalPreviewTextRequest {
  sessionId: string;
  path: string; // workspace-relative path from a preview item
}

// response
interface ReadLocalPreviewTextResponse {
  path: string;
  contentLf: string;
  size: number;
  mtimeMs: number;
  encoding: 'utf8';
}
```

Service name: `preview.readLocalText`.

The service must:

1. require both parameters and reject absolute paths;
2. load the thread index entry by `sessionId` without hydrating the agent;
3. derive the workspace root from `entry.workspace.workingDirectory` rather than accepting a root
   from the UI;
4. call the jailed runtime stat operation;
5. reject missing files and files larger than 1 MiB before reading;
6. call the jailed strict-UTF-8 reader and recheck the returned size; and
7. return LF-normalized text and metadata.

Use stable service error codes for `INVALID_ARGUMENT`, `THREAD_NOT_FOUND`, `NO_WORKSPACE`,
`NOT_FOUND`, `ACCESS_DENIED`, `TOO_LARGE`, `UNSUPPORTED_TEXT`, and `READ_FAILED`. The service may use
the shared lexical policy for early traversal/protected-path errors, but all authoritative jail
rejections map to `ACCESS_DENIED`; the UI must not parse `NodeFsExecutor` error prose.

Keep the service platform-neutral by injecting stat/read dependencies into
`createPreviewServices`; `ServerAgentBootstrap` supplies `NodeFsExecutor` only for the
`desktop-runtime` profile. Do not add Tauri filesystem permissions and do not register this service
for the browser extension or general server profile.

This is intentionally not a file browser: there is no directory listing, arbitrary root, file
picker, or write method. The UI calls it only with paths from trusted preview events, while the
runtime jail remains the security boundary.

### 8.2 Read lifecycle

Do not cache file content in V1. Read whenever Source or Rendered becomes active, and reload when the
selected item changes.

Use a monotonically increasing request token in the viewer and ignore a response if the user has
changed session, item, or view before it returns. When the returned `mtimeMs` or `size` differs from
the preview item's metadata, show:

> Current file has changed since this diff.

The Diff view remains available even if the current file was later removed or can no longer be
read.

---

## 9. Rendering contract

### 9.1 Unified diff

Use the direct `diff` dependency for both generation and `parsePatch` rendering.

The viewer must support:

- one file and multiple hunks;
- old and new line-number gutters;
- context, addition, deletion, and `No newline at end of file` rows;
- wrapped long lines without horizontal page overflow;
- terminal and modern theme colors; and
- a text-only raw-patch fallback if parsing fails.

Render all patch content through Svelte text interpolation, never `{@html}`. V1 is unified and
read-only; side-by-side mode, staging, reverting, comments, and syntax highlighting are deferred.

### 9.2 Source

Render source as selectable, copyable monospace text. Show line numbers up to 10,000 lines. Above
that threshold, render one plain `<pre>` without per-line DOM nodes and display a performance notice.

The source header shows the path, byte size, and the stale-content notice when applicable.

### 9.3 Markdown

Use a preview-local `marked` instance rather than changing global parser defaults.

The pipeline is:

1. raw Markdown;
2. a custom Marked renderer that escapes raw HTML and renders image tokens as alt text only;
3. `DOMPurify.sanitize` with no scripts, styles, forms, frames, objects, embeds, or images; and
4. Svelte `{@html}` only with the sanitized result.

Intercept anchor clicks. Only `http:` and `https:` links are actionable; open them through the
existing `openExternalUrl` helper. Relative and unsupported-scheme links remain visible but do not
navigate. This prevents Markdown preview from becoming an implicit browser or network loader.

---

## 10. Event and UI integration

```text
edit_file / write_file
        │
        ├─ executor validates and writes
        ▼
LocalFileChangeProgress (completed)
        │
        ▼
ToolExecutionProgress
        │
        ├───────────────► EventProcessor ─► clickable chat event
        │
        ▼
previewStore.project(sessionId, event)
        │
        ▼
PreviewPanel
  ├─ DiffView
  ├─ MarkdownPreview ──► preview.readLocalText
  └─ SourcePreview   ──► preview.readLocalText
```

Integration rules:

1. In both active- and background-thread event paths, project the raw event before calling
   `EventProcessor`.
2. During attach replay, project replay events in event-sequence order as well as formatting them
   for the timeline.
3. `EventProcessor` special-cases `local_file_change`, producing a successful tool event. It adds
   `metadata.previewItemId = event.id` only when the payload has at least one eligible view, using
   the same pure eligibility helper as the projector.
4. `Main.svelte` passes an event-click handler to `EventDisplay`. When `previewItemId` exists, it
   opens the preview and selects that ID; other event clicks retain current behavior.
5. Compare old and new workspace paths before merging `session_index_changed`; clear that session's
   preview state when they differ.
6. Projector/store errors must be caught and logged so preview cannot interrupt transcript event
   handling.

Preview state is deliberately independent of `EventProcessor` operation maps. Chat formatting can
change without corrupting preview selection, and a preview renderer failure cannot suppress the chat
event.

---

## 11. Implementation sequence

### Slice A — structured successful-change emission

- Add `LocalFileChangeProgress` and constants for the V1 limits.
- Add the path-normalization/diff helper.
- Emit after successful `edit_file` and `write_file` mutations.
- Add direct tool tests for creation, modification, omission, no-op, and failure paths.

Gate: a real file mutation produces exactly one structured progress payload with no absolute path,
and a rejected mutation produces none.

### Slice B — workspace-scoped content reads

- Add `createPreviewServices` and typed errors.
- Register it in `registerAllServices` only when preview dependencies exist.
- Inject jailed Node stat/read operations from the desktop-runtime bootstrap.
- Add service tests for thread/workspace resolution and every error boundary.

Gate: the UI can safely read an eligible changed file by session/path, but cannot select a root,
escape the workspace, read protected paths, or exceed the preview limit.

### Slice C — state and viewers

- Add preview UI types, store/projector, retention limits, and renderer registry.
- Add Diff, Source, and safe Markdown viewers.
- Add unit/component tests, including malicious Markdown fixtures and stale async reads.

Gate: a synthetic progress event deterministically creates the correct item and each view renders
without executing file content.

### Slice D — chat and responsive integration

- Add the Preview button, unread badge, wide panel, and narrow drawer to `Main.svelte`.
- Project live, background, and replay events.
- Add clickable chat deep links and workspace-change clearing.
- Add responsive, theme, keyboard, and integration tests.

Gate: editing a code, Markdown, or plain-text file in a real desktop conversation reveals the exact
operation diff and current content without leaving WorkX.

---

## 12. Expected files

| File | Change |
|---|---|
| `src/tools/runtimeMetadata.ts` | Add `LocalFileChangeProgress` and operation type |
| `src/tools/file-search/localFileChange.ts` *(new)* | Normalize paths and emit a bounded local-file change fact |
| `src/tools/file-search/FileAccessTool.ts` | Emit completed previews from successful edit/write paths |
| `src/tools/file-search/__tests__/FileAccessTool.test.ts` | Cover emission and non-emission rules |
| `src/tools/file-search/__tests__/localFileChange.test.ts` *(new)* | Cover paths, patch generation, and size/CPU gates |
| `src/core/services/preview-services.ts` *(new)* | Session-scoped, injected jailed text-read service |
| `src/core/services/index.ts` | Register optional preview services/dependencies |
| `src/core/services/__tests__/preview-services.test.ts` *(new)* | Cover service success and security/error cases |
| `src/server/agent/ServerAgentBootstrap.ts` | Inject Node stat/read only for desktop runtime |
| `src/types/ui.ts` | Add preview items/views and `previewItemId` event metadata |
| `src/webfront/stores/previewStore.ts` *(new)* | Per-session state, projection, selection, and retention |
| `src/webfront/stores/__tests__/previewStore.test.ts` *(new)* | Cover projection, dedupe, limits, auto-open, and clearing |
| `src/webfront/components/preview/PreviewPanel.svelte` *(new)* | Panel shell, operation list, tabs, close control |
| `src/webfront/components/preview/DiffView.svelte` *(new)* | Unified diff renderer and raw fallback |
| `src/webfront/components/preview/SourcePreview.svelte` *(new)* | Current-text loader and source view |
| `src/webfront/components/preview/MarkdownPreview.svelte` *(new)* | Safe rendered Markdown view |
| `src/webfront/components/preview/renderers.ts` *(new)* | Initial renderer registry |
| `src/webfront/components/event_display/EventProcessor.ts` | Format file-change progress and attach preview item ID |
| `src/webfront/pages/chat/Main.svelte` | Project events and integrate button/panel/drawer/deep links |
| `package.json`, `package-lock.json` | Add direct `diff` and `dompurify` dependencies |

No change is expected in `src/core/protocol/events.ts`, `event-scope.ts`, server agent-event mapping,
Tauri capabilities, or `AppShell.svelte`.

---

## 13. Required verification

### 13.1 Runtime and tool tests

- `edit_file` create emits `created` with a valid added-lines patch.
- `edit_file` modify emits `modified` with the exact before/after hunk.
- `write_file` create and overwrite emit the correct operation.
- Existing empty file versus missing file is classified correctly.
- Absolute tool input never leaks an absolute path to the event.
- CRLF input is compared and diffed in the executor's LF-normalized form.
- Combined diff input over 512 KiB skips diff generation and reports `input_too_large`.
- A generated patch over 32 KiB reports `diff_too_large` and omits the patch.
- Rejected, denied, stale, no-match, not-unique, unsupported-encoding, and unchanged operations emit
  no preview progress.
- A diff/progress callback exception does not change a successful tool result.

### 13.2 Service tests

- Reads a valid file from the workspace stored on a suspended thread entry.
- Rejects missing session ID/path, unknown/deleted thread, missing workspace, absolute path, traversal,
  symlink escape, protected file, missing file, file over 1 MiB, and invalid UTF-8.
- Never accepts a workspace root from the UI.
- Returns LF-normalized content, byte size, and mtime.

### 13.3 Store and integration tests

- Ignores unrelated progress payloads and non-previewable file changes.
- Deduplicates replayed event IDs.
- Projects events for active and background conversations.
- Auto-opens once per task for an active, wide, live change; respects manual suppression; and resets
  suppression on `TaskStarted`.
- Does not auto-open for narrow, background, or replayed changes and sets unread state instead.
- Enforces 20-item and 1-MiB-per-thread retention limits.
- Clears state when the workspace changes or a thread is removed.
- Clicking the chat event opens the exact operation item.
- A late source-read response cannot replace content for a newly selected item.

### 13.4 Rendering and accessibility tests

- Diff line numbers and row types are correct for multi-hunk patches.
- A malformed patch falls back to escaped raw text.
- Markdown scripts, raw HTML, event attributes, images, unsafe URLs, and embedded content do not
  execute or load.
- HTTP(S) links use the external opener; other links do not navigate.
- Source and diff content remain selectable and copyable.
- Wide and narrow layouts work in modern and terminal themes.
- Drawer Escape, backdrop close, focus restoration, labels, and tab semantics are keyboard usable.

Before handoff, run the focused Vitest suites, `npm run type-check`, `npm run lint`, and
`npm run build:desktop`.

---

## 14. Acceptance criteria

The first release is complete when all of the following are true:

1. A successful `edit_file` or `write_file` content change produces one structured,
   workspace-relative preview event.
2. No failed or unchanged mutation produces a preview event.
3. A previewable change appears in the correct conversation and automatically opens the wide panel
   according to the task-scoped dismissal rules.
4. The Diff view represents the exact successful tool operation.
5. Source and Markdown views read only the current, jailed workspace file and visibly report when it
   has changed since the diff.
6. File content cannot execute HTML, script, embedded resources, or unsafe navigation.
7. Oversized payloads and in-memory history are bounded as specified.
8. Thread switching, background events, live replay, workspace changes, and narrow layouts behave as
   specified.
9. The focused tests, type check, lint, and desktop build pass.

---

## 15. Deferred extensions

- Terminal/external file reconciliation through Git or filesystem observation.
- Delete and rename previews when direct tools support those operations.
- Durable preview history across app restarts.
- Syntax highlighting, side-by-side diff, comments, editing, staging, and revert.
- Images, PDFs, spreadsheets, HTML, and local dev-server previews.
- Browser-session and connected-app previews.
- User resizing and persisted panel width.

These additions should reuse the panel lifecycle and renderer registry. They do not require a
generic app/browser payload contract in V1.

---

## 16. References

- Codex app features: <https://developers.openai.com/codex/app/features>
- Codex open-source TUI: <https://github.com/openai/codex/tree/main/codex-rs/tui/src>
- Claude Cowork — Live Artifacts: <https://support.claude.com/en/articles/14729249-use-live-artifacts-in-claude-cowork>

Reference-product behavior changes over time. Re-verify it only when implementing parity beyond this
local-file scope.
