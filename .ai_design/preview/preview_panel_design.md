# WorkX Desktop — Agent Artifact Preview Panel

**Status:** Draft / proposal
**Issue:** WORKXOS-7 — redesign the new chat UI for workx desktop
**Scope:** Design only. No implementation is included in this document.
**Audience:** WorkX desktop UI + core engineers.

---

## 1. Problem & motivation

Today the WorkX desktop chat page is a **single column**: the user talks to the AI
agent and reads a stream of chat/tool events. When the agent *produces or changes an
artifact* — a new design doc (`.md`/text), an edited source file, a diff, or a Google
Sheet — the user has no way to **see the result in-app**. They must open an external
editor, browser, or app to inspect what the agent did.

Both of the reference products the issue calls out solve this with a **right-hand
preview surface**:

- **OpenAI Codex app** (macOS)
- **Claude Cowork**

The issue asks two things:

1. **Deep research** on *how* Codex app and Claude Cowork do this — in particular,
   "is it a built-in browser?"
2. A **design** for how WorkX desktop can offer the same capability: the user can
   preview what the AI agent changed, without leaving WorkX.

This document answers (1) in §2–§3 and proposes (2) in §5–§10.

### Goals

- Let the user **preview artifacts the agent created or changed** directly inside
  WorkX desktop, in a dedicated panel next to the chat.
- Support the artifact types the agent actually produces first: **markdown/text
  documents, code files, and code diffs**.
- Reuse the structured tool-event data WorkX already streams (see §4) so the panel
  populates automatically — the user should not have to hunt for what changed.
- Fit the existing Tauri + Svelte 5 architecture and responsive layout.

### Non-goals (this iteration)

- Building a full IDE / editor. Preview is read-first; editing is out of scope.
- Live/interactive "app" artifacts (Cowork-style Live Artifacts that fetch data via
  MCP). Noted as a future extension in §11.
- Native Google Sheets / Office rendering. Handled as a **future extension** (§11);
  the first cut renders exported/text-serializable forms (CSV/markdown table, or an
  external "Open in browser" fallback).

---

## 2. Deep research: how the reference products do it

### 2.1 OpenAI Codex app

Codex does **not** use a single mechanism. It exposes **three distinct preview
surfaces**, chosen by artifact type:

1. **Git diff / review pane (for code).**
   "The diff pane shows a Git diff of your changes in your local project or worktree
   checkout." The user can add inline comments for Codex to address, **stage or revert
   specific chunks or entire files**, switch between staged / unstaged / "compare with
   main", and view **"Last turn changes"** (only what the last agent turn changed).
   Commit / push / PR creation happen from this pane. When Codex pulls a GitHub PR, the
   same pane shows reviewer comments, changed files, and diffs inline. This is a
   **structured git-diff renderer**, not a browser.

2. **In-app browser (a real built-in browser / webview).**
   "For frontend projects, Codex can use the in-app browser to preview local pages,
   inspect page elements, or verify UI fixes." It is used to "preview, review, and
   comment on local development servers, file-backed previews, and public pages that
   don't require sign-in." Explicit limitations: it "doesn't support authentication
   flows, signed-in pages, your regular browser profile, cookies, extensions, or
   existing tabs." Users can drop **browser comments** on page elements and ask Codex
   to address them. → **This is the "built-in browser" the issue asks about** — a
   sandboxed webview scoped to local/preview URLs, not a full Chrome profile.

3. **Artifact viewer (for non-code generated files).**
   The task sidebar "previews non-code generated files in the sidebar — PDFs,
   spreadsheets, documents, and presentations," and lets the user "open generated
   files directly from the sidebar" and "inspect the output and request revisions in
   the same thread without opening an external application." Rendering is **inline in
   the sidebar**; the surfaced list is driven by the agent's decomposed steps
   (plan visibility, source tracking, artifact inspection).

**So, for Codex, the answer to "is it a built-in browser?" is: partly.** A built-in
browser/webview handles *web pages and file-backed HTML previews*; **code** uses a
dedicated **git-diff review pane**; **documents/PDF/spreadsheets/slides** use a native
**artifact viewer** rendered inline. The right mechanism is chosen per artifact type.

### 2.2 Claude Cowork

Cowork centers on an **Artifacts pane**:

- **"Any files Claude reads or creates appear in the Artifacts pane"** — the user
  **clicks a file to preview** it. So the pane is populated automatically from the
  agent's file activity (read + write), which is exactly the behavior WorkX wants.
- **Live artifacts** are "persistent, interactive HTML pages" rendered in a **live
  preview pane**. The renderer handles **HTML, React, SVG, Mermaid diagrams, code
  files, and formatted documents**. These run in a sandbox and can pull fresh data
  from connected apps / local files via MCP connectors when opened.
- **Version history:** every iteration saves the previous version; the user can
  compare an earlier version with the current one and restore it.
- Artifacts "live on your computer" (local storage, not cloud-only).

**Cowork's answer to "built-in browser?":** the live-artifact preview is effectively a
**sandboxed HTML rendering surface** (a webview/iframe for HTML/React/SVG/Mermaid),
plus inline renderers for code and formatted documents — again, **per-type rendering
inside one pane**, with version history layered on top.

### 2.3 Synthesis — the pattern both share

Neither product is "just an embedded browser." The shared, transferable pattern is:

> A **right-hand preview panel** that (a) is **auto-populated from the agent's file /
> tool activity**, (b) shows a **navigable list of artifacts**, and (c) renders each
> artifact with a **type-appropriate viewer** — diff renderer for code, markdown/doc
> renderer for text, a **sandboxed webview** for HTML/web previews, and native viewers
> for binary docs — with the webview reserved for genuinely web-shaped content.

That synthesis is what §5 adapts to WorkX.

### 2.4 Comparison

| Capability | Codex app | Claude Cowork | Proposed WorkX (Phase 1) |
|---|---|---|---|
| Panel populated automatically from agent file activity | Task sidebar + diff pane | Artifacts pane (reads *and* writes) | Yes — from tool events (§4) |
| Code changes | Git diff / review pane, chunk stage/revert | Code file view | Diff renderer (read-only) |
| Markdown / text docs | Artifact viewer | Formatted-document render | `marked` renderer (reuse) |
| HTML / local web page | **Built-in browser (webview)** | Live-artifact HTML sandbox | Tauri webview (Phase 2) |
| PDF / spreadsheet / slides | Native artifact viewer | (formats implicit) | CSV/table now; native later |
| Interactive / data-connected apps | — | Live Artifacts via MCP | Future (§11) |
| Version history | "Last turn changes" view | Full save/compare/restore | "This turn's changes" (Phase 1); history later |

---

## 3. Answering the issue's explicit question

> "Do a deep research on how codex app or claude cowork do that (is it a built in
> browser?)"

**Not a single built-in browser.** Both use a **multi-viewer preview panel** and pick
the viewer by artifact type. A built-in **browser/webview** is one viewer among
several — used for **web/HTML previews** (Codex's in-app browser; Cowork's live-artifact
HTML sandbox). **Code diffs** use a **structured diff/review pane**, and
**documents/binary files** use **native inline viewers**. WorkX should copy the
*pattern* (auto-populated panel + per-type viewers), not implement a browser as the
whole solution.

---

## 4. What WorkX already has to build on

WorkX desktop is **Tauri + Svelte 5**, with a reactive store architecture. The relevant
existing pieces (verified against the current tree at `main`):

**Layout / shell**
- `src/webfront/components/layout/AppShell.svelte` — 2-column shell (left nav + main
  content). Responsive via the `isWideMode` store (breakpoint ~1500px); in narrow mode
  the left panel becomes a slide-in drawer (`fade` + `fly` transitions).
- `src/webfront/components/layout/LeftPanel.svelte` — nav (Chat, Scheduler, Skills,
  Apps, Usage) + login status.
- `src/webfront/stores/layoutStore.ts` — `isWideMode` readable store + `NAV_ITEMS`.
- `src/webfront/stores/themeStore.ts` — `terminal` vs `modern` themes, dark mode.
- Routing: `svelte-spa-router` (`push()`); i18n via `_t`.

**Chat page**
- `src/webfront/pages/chat/Main.svelte` — the single main chat area. Renders
  `processedEvents: ProcessedEvent[]` through `EventDisplay`. Multi-thread aware:
  `threadStates: Map<string, ThreadConversationState>`, each with its own
  `eventProcessor`, `messages`, `processedEvents`.
- `src/webfront/components/MessageDisplay.svelte` — already renders markdown with
  **`marked`** (`"marked": "^17.0.0"` in `package.json`). Reusable for doc preview.

**Structured tool/artifact data model (the key enabler)**
- `src/types/ui.ts`:
  - `ProcessedEvent` — `{ id, category ('tool'|'output'|...), title, content, style,
    status, metadata, ... }`.
  - `EventMetadata` — includes `toolName`, `toolParams`, `command`, `exitCode`,
    **`filesChanged`**, **`diffSummary`**, `duration`, `tokenUsage`, `costUSD`.
  - `ContentBlock` — already has a **`{ type: 'diff'; additions; deletions; context }`**
    variant, plus `code`, `table`, `list`, `text`. A diff shape already exists.
- `src/webfront/components/event_display/EventProcessor.ts` — processes tool lifecycle:
  `McpToolCallBegin/End` (`toolName`, `toolParams`, `result`, `error`, `duration_ms`),
  **`PatchApplyBegin/End`** (with **`path`**, `success`, `num_files`, `description`),
  `ExecCommand*`.
- `src/core/protocol/events.ts` — protocol events: `PatchApplyBeginEvent { path, ... }`,
  `PatchApplyEndEvent { path, success, error? }`, `McpToolCall*`.

**Tauri layer**
- `tauri/tauri.conf.json` — window 1000×700, **`"csp": null`**, shell plugin,
  updater. `withGlobalTauri` unused here.
- `tauri/capabilities/default.json` — `core:window:*`, **`shell:allow-open`**,
  notification/autostart/updater. **No filesystem read/write capability yet** — must be
  added for direct file reads (see §8).

**Gap:** there is **no diff renderer, no code viewer, and no webview/preview component**
today. The preview panel is greenfield — but the *data* to drive it (which files the
agent touched, with paths and diff summaries) is already flowing through the event
pipeline.

---

## 5. Proposed design for WorkX

### 5.1 High-level shape

Add a **right-hand Preview Panel** to the chat page — a third column beside the chat —
that mirrors the shared pattern from §2.3:

```
 ┌───────────┬───────────────────────────┬──────────────────────┐
 │ LeftPanel │   Chat (Main.svelte)      │   Preview Panel       │
 │ (nav)     │   messages + tool events  │   ┌────────────────┐  │
 │           │                           │   │ artifact list  │  │
 │           │   [event] wrote design.md │   ├────────────────┤  │
 │           │   [event] edited App.tsx  │   │  viewer:       │  │
 │           │                           │   │  - markdown    │  │
 │           │                           │   │  - diff        │  │
 │           │                           │   │  - code        │  │
 │           │                           │   │  - webview     │  │
 │           │                           │   └────────────────┘  │
 └───────────┴───────────────────────────┴──────────────────────┘
```

The panel has two regions:

1. **Artifact list** (top or side-rail) — every file the agent **read or changed** this
   session, newest first, with a type icon and a change badge (added / modified /
   deleted). This is the Cowork "any file Claude reads or creates appears here" and the
   Codex "task sidebar / open generated files" behavior.
2. **Viewer** — renders the selected artifact with a **type-appropriate viewer** (§6).

### 5.2 Where the panel lives & responsive behavior

- **Wide mode (`isWideMode` true, ~≥1500px):** dock the Preview Panel as a **third
  column** on the right. Chat area flexes; panel has a fixed/resizable width
  (`--preview-panel-width`, default ~380–460px).
- **Narrow mode:** the Preview Panel becomes a **slide-in overlay from the right**,
  mirroring the existing left-panel drawer pattern in `AppShell.svelte` (`fade`
  backdrop + `fly` from `x:+`), opened by an artifact click or a header toggle.
- **Empty state:** panel is collapsed/hidden until the agent produces its first
  previewable artifact, then auto-reveals (configurable). This avoids stealing chat
  width when there is nothing to show.

Reuse the **exact drawer mechanics** already proven for the left panel (see the
`AppShell.svelte` narrow-mode drawer: backdrop `role=button`, `role=dialog`, Esc to
close, auto-close on wide→narrow transitions) so the right panel is symmetric and
low-risk.

### 5.3 Trigger — how the panel populates

The panel subscribes to the same event stream the chat renders. Concretely:

- A new store, `previewStore.ts` (Svelte store), holds
  `artifacts: Map<path, ArtifactRecord>` and `selectedArtifactId`.
- `EventProcessor.ts` already sees `PatchApplyBegin/End` (→ `path`, `success`,
  `diffSummary`, `filesChanged`) and `McpToolCallEnd` for file-ish tools (write/read).
  Add a thin **collector** that, when such an event resolves, upserts an
  `ArtifactRecord` into `previewStore` — **no new backend data is required**; it is a
  projection of events already flowing.
- Artifacts are **per-thread** (thread state already isolates `eventProcessor`), so the
  panel shows the active thread's artifacts and switches with the thread.
- The list supports a **"This turn's changes"** filter (Codex's "Last turn changes"),
  driven by `TaskStarted`/`TaskComplete` boundaries the chat already tracks.

### 5.4 ArtifactRecord (proposed type, add to `src/types/ui.ts`)

```ts
type ArtifactKind =
  | 'markdown' | 'text' | 'code' | 'diff'
  | 'image' | 'html' | 'csv' | 'unknown';

interface ArtifactRecord {
  id: string;                 // stable per path per thread
  path: string;               // from PatchApply / tool params
  kind: ArtifactKind;         // inferred from extension + event
  change: 'added' | 'modified' | 'deleted' | 'read';
  toolName?: string;          // McpToolCall origin, if any
  diffSummary?: string;       // reuse EventMetadata.diffSummary
  updatedAt: Date;
  turnId?: string;            // for "this turn" filtering
  // content is loaded lazily by the viewer (§6/§8), not stored eagerly
}
```

---

## 6. Rendering strategy — one viewer per artifact kind

| Kind | Viewer | How (reuse first) |
|---|---|---|
| `markdown` | Rendered doc | Reuse **`marked`** (already used in `MessageDisplay.svelte`); add a toggle for raw source vs rendered. |
| `text` | Monospace `<pre>` | Plain, wrapped, with copy button. |
| `code` | Syntax-highlighted read view | Add a light highlighter (e.g. `highlight.js` / `shiki`); no full editor. |
| `diff` | Side-by-side or unified diff | New `DiffView.svelte`: **parse the unified-diff string with [`jsdiff`](https://github.com/kpdecker/jsdiff) (`parsePatch`) and hand-render** with themed Svelte markup. Read-only in Phase 1 (no stage/revert). See §6.1. |
| `image` | `<img>` via asset protocol | Tauri asset protocol (§8). |
| `csv` | Table | Parse to `ContentBlock` `table` and render. Also the interim path for **spreadsheet/Google-Sheet exports**. |
| `html` | **Sandboxed webview** | Tauri's **native (system) webview — not a bundled browser engine** (§8.3). Sandboxed `<iframe>` for self-contained HTML/SVG/Mermaid artifacts; Tauri **v2 embedded child webview** for local dev-server URLs. The "built-in browser" slice, reserved for genuine web content. |
| `unknown` / binary | Fallback | Metadata card + **"Open externally"** using existing `shell:allow-open`. |

Design principle (from §2.3): **default to a native, sandboxed, type-specific renderer;
use the webview only for web-shaped content.** This keeps the common case (markdown docs
and code diffs — what the agent produces most) fast, themed, and dependency-light, and
avoids over-relying on an embedded browser.

### 6.1 Diff viewer — `jsdiff` (parse) + hand-rolled `DiffView.svelte` (render)

The diff viewer splits cleanly into two layers, and we pick a different answer for each:

- **Parsing** a unified diff (hunk headers `@@ -a,b +c,d @@`, `\ No newline at end of
  file`, renames, binary markers) is fiddly and error-prone — **do not hand-roll this.**
  Use **`jsdiff`** (the `diff` package): `parsePatch(str)` returns a structured
  `{ oldFileName, newFileName, hunks: [{ oldStart, newStart, lines }] }[]`, i.e. already
  split **per file** — which is exactly what the artifact list needs.
- **Rendering** is where we have hard constraints a drop-in HTML lib fights: the
  `terminal`/`modern` theme tokens, `_t` i18n, and `svelte/transition` consistency. So
  we **hand-roll** a small (~50-line) `DiffView.svelte` over jsdiff's hunk data, styling
  added/removed/context lines with existing theme colors.

**Why not `diff2html`?** It bundles parse + render and emits its own HTML/CSS, which
clashes with our two themes and bypasses `_t`. It's the faster drop-in, but it *owns the
DOM*; jsdiff gives us the parse for free and leaves rendering under our control. (jsdiff
and diff2html are not really competitors — jsdiff is a data/parse lib, diff2html is a
renderer that happens to parse internally; we only want the parse half.)

**Sourcing the diff string (important — the collector alone is not enough).** The
`PatchApply*` events the §5.3 collector keys off carry only `path`/`num_files`/`success`
— **no diff body**. The actual unified-diff text lives in **`TurnDiffEvent { diff,
files_changed }`** (verified in `src/core/protocol/events.ts`; also
`ApplyPatchApprovalRequestEvent.patch`). Because `TurnDiffEvent.diff` is a **whole-turn,
all-files** diff, `DiffView` sources it there and uses `jsdiff.parsePatch()` to split by
file, mapping each file back to its `ArtifactRecord.path`. Note the existing
`ContentBlock` `diff` shape (`additions`/`deletions`/`context` — three flat arrays) is
**lossy** (no line interleaving/position) and is unsuitable as the diff-viewer source;
it remains fine for inline chat summaries only.

**Dependency:** adds `diff` (jsdiff) to `package.json` — small, dependency-free, MIT.

---

## 7. UX details

- **Auto-select** the most recent artifact when the panel first opens; keep the user's
  manual selection sticky afterward.
- **Change badges** in the list: `A` (added, green), `M` (modified, amber), `D`
  (deleted, red), `R` (read, muted) — consistent with `themeStore` colors.
- **Header actions** per artifact: `Rendered ⇄ Source` toggle (docs), `Copy path`,
  `Open externally` (shell), and later `Copy diff`.
- **Deep link from chat:** a tool event in the chat that changed a file (e.g. "edited
  `App.tsx`") gets a click affordance that selects that artifact in the panel — the two
  surfaces stay in sync (Codex "open generated files directly from the sidebar").
- **Theming/i18n:** all strings via `_t`; colors via existing `terminal`/`modern`
  tokens; transitions via `svelte/transition` to match `AppShell.svelte`.

---

## 8. Tauri / security considerations

Reading agent-changed files and rendering web content needs care:

1. **Reading file contents.** Two options:
   - **(a) Route through core/agent events** — prefer surfacing content that already
     flows through the event stream (patch bodies, tool results) so no new file-system
     capability is needed for the common case.
   - **(b) Direct file read** — for arbitrary paths, add a **scoped** `fs` capability in
     `tauri/capabilities/default.json` (read-only, restricted to the active
     project/workspace roots). Currently there is **no fs capability**, so this is an
     explicit, reviewable addition — keep it least-privilege.
2. **Images / binary via asset protocol.** Enable the Tauri **asset protocol** scoped to
   workspace roots to render images without inlining bytes.
3. **HTML/webview sandboxing.** WorkX is **Tauri v2** (`tauri = "2"`, `@tauri-apps/api
   ^2.10`, schema `config/2`), so the web-preview surface uses Tauri's **native system
   webview** (WKWebView / WebView2 / WebKitGTK). We do **not** integrate a browser engine
   (Chromium/CEF/Servo) — that would add ~100MB+ and defeat the point of Tauri vs
   Electron; the "built-in browser" is the platform webview, scoped and sandboxed. Pick
   the mechanism by content:
   - **Self-contained HTML/SVG/Mermaid artifacts** → a **sandboxed `<iframe>`** inside
     the existing app window (`sandbox` attr + scoped CSP). Cheapest; docks in the panel.
     Shares the app's webview context, so isolation comes from `sandbox` + CSP.
   - **Local dev-server URLs** (Codex's actual "in-app browser" case) → a **Tauri v2
     embedded child webview** (`WebviewWindow`, or an embedded `Webview` via v2's
     multi-webview API). A separate native webview instance with its own origin/context,
     own CSP, and **no shared cookies/profile/extensions** — matching Codex's "no auth,
     no cookies, no extensions" isolation, with real navigation.

   Either way, apply a **restrictive CSP** to this surface. Note `tauri.conf.json`
   currently sets top-level **`"csp": null`**; the preview surface must **not** inherit
   "no CSP" — give it its own locked-down policy (no arbitrary remote script;
   local/preview origins only).
4. **Never execute untrusted artifact content in the app's main context.** HTML/JS
   artifacts run only inside the sandboxed surface, never the Svelte app window.

---

## 9. Data flow (end to end)

```
core/agent  ──emits──▶  protocol events (events.ts)
                        PatchApplyBegin/End { path, success, diffSummary }
                        McpToolCallEnd     { toolName, result }
                              │
                              ▼
         EventProcessor.ts  ──(existing)──▶ ProcessedEvent[] ──▶ chat render
                              │
                              └──(new collector)──▶ previewStore.artifacts
                                                          │
                                                          ▼
                                    PreviewPanel.svelte (list + viewer)
                                     ├─ markdown → marked
                                     ├─ diff     → DiffView.svelte (jsdiff.parsePatch, from TurnDiffEvent)
                                     ├─ code     → highlighter
                                     ├─ html     → sandboxed webview
                                     └─ image    → asset protocol
```

The **only new upstream work** is the collector projection; everything else is UI.

---

## 10. Phased implementation plan

**Phase 1 — Docs & diffs (highest value, lowest risk).**
- `previewStore.ts` + `ArtifactRecord` type in `src/types/ui.ts`.
- Collector in `EventProcessor.ts` for `PatchApply*` and file-ish `McpToolCall*`.
- `PreviewPanel.svelte`: artifact list + markdown viewer (reuse `marked`) + `DiffView`
  (read-only; `jsdiff` parse of `TurnDiffEvent.diff`, hand-rolled render — §6.1) +
  plain-text/code view. Adds the `diff` (jsdiff) dependency.
- `AppShell.svelte`: third column in wide mode; right slide-in drawer in narrow mode.
- "This turn's changes" filter.

**Phase 2 — Web & media previews.**
- Sandboxed `html` webview + local dev-server preview (the "built-in browser" slice).
- Image via asset protocol; scoped `fs` capability for direct reads.
- Syntax highlighting for code.

**Phase 3 — Parity niceties.**
- Version history (Cowork-style save/compare/restore per artifact).
- Inline diff comments → feed back to the agent (Codex-style).
- Stage/revert chunks (only if WorkX takes on git operations in-app).

**Future (§11).**
- Google Sheets / Office / interactive "live" artifacts.

---

## 11. Future extensions

- **Google Sheets / spreadsheets:** Phase-1 fallback renders CSV/exported table or
  "Open externally". A richer path could embed the Sheet via the connector's web view
  (subject to the auth limits Codex's browser also has) or render a read-only grid from
  an exported range. Native Office rendering is a larger effort.
- **Live / interactive artifacts** (Cowork Live Artifacts): HTML apps that pull fresh
  data via MCP connectors on open — a natural extension once the sandboxed webview and
  connector plumbing exist.
- **Version history & restore** across turns.

---

## 12. Alternatives considered

1. **Pure built-in browser only** (render everything as HTML in a webview). Rejected:
   neither Codex nor Cowork does this; a browser is heavyweight and worse than native
   renderers for markdown/diffs (the agent's most common outputs), and it complicates
   theming and security (§8).
2. **Open artifacts in a separate Tauri `WebviewWindow`** instead of a docked panel.
   Rejected as the default: it breaks the "see it beside the chat" feedback loop both
   reference products optimize for. May still be offered as a "pop out" action later.
3. **No panel — inline everything in chat.** Rejected: large docs/diffs bloat the chat
   transcript and can't be revisited without scrolling; both reference products
   deliberately separate the *conversation* from the *artifact surface*.

---

## 13. Open questions

- Should the panel show **read** files (Cowork does) or only **changed** files? Proposed
  default: changed files by default, with a toggle to include reads.
- Content sourcing for arbitrary paths: prefer event-stream content (§8a) vs adding a
  scoped `fs` capability (§8b)? Impacts the Tauri capability surface and review.
- Width/resizing persistence — store `--preview-panel-width` in user settings?
- Does WorkX want in-app **git operations** (stage/revert/commit) like Codex, or keep
  preview strictly read-only? Determines whether Phase 3 chunk staging is in scope.

---

## 14. References (research sources)

- Codex app — Features: <https://developers.openai.com/codex/app/features>
- Codex app — overview: <https://developers.openai.com/codex/app>
- Codex app workspace (PR review pane, task sidebar, artifact viewer):
  <https://codex.danielvaughan.com/2026/04/17/codex-app-workspace-pr-review-task-sidebar-artifact-viewer/>
- Claude Cowork — Live Artifacts (Help Center):
  <https://support.claude.com/en/articles/14729249-use-live-artifacts-in-claude-cowork>
- Claude Cowork — getting started / tutorial:
  <https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork>,
  <https://www.datacamp.com/tutorial/claude-cowork-tutorial>

*(Web research conducted 2026-07; product UIs evolve — re-verify specifics before
implementation.)*
