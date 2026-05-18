# Track 13: Input Pipeline & Browser-Native Mentions — Tasks

> Cross-references: `design.md` for type definitions, file:line citations, and rationale (referenced by `§`).
> Tasks tagged **NEW** create a file; **EXISTS** modify a file already in the repo.
> Within each phase, tasks are ordered for sequential pickup — earlier tasks unblock later ones.
> All `file:line` citations verified against branch `agent-improvements` (design §3, §11).

---

## Phase 1: Relocate + Origin Plumbing — no new affordances

**Goal:** Introduce the core funnel as a behavior-preserving relocation of the ad-hoc slash handling, and plumb channel origin (the §7.1 prerequisite) so the bridge-safe gate has the data it needs. Mentions/bash are no-ops in this phase (return input unchanged).

**Done when:** `tsc` + `npm test` green; `MessageInput.test.ts` + `CommandRegistry` tests pass unchanged in behavior; slash commands dispatch identically (ext + desktop) but via the funnel; a connector `/config` is blocked with a `systemNote` and never forwarded to the model; WS-chat / scheduler turns are unaffected.

### 1A. Envelope and context types
- [ ] **NEW** `src/core/input/types.ts`
  - `InputOrigin`: `{ channel: 'local' | 'connector' | 'remote' | 'scheduler'; channelType?: string; channelId?: string; userId?: string }` (design §4.2).
  - `FunnelContext`: `{ sessionId; origin: InputOrigin; platform: IPlatformAdapter; resultStore: ToolResultStore; commandRegistry; getBrowserController: () => IBrowserController | null; getDomService?: () => DomService | null; tabId?: number }`.
  - `ProcessedInput`: `{ items: InputItem[]; shouldQuery: boolean; nextInput?: string; submitNextInput?: boolean; systemNote?: string; resultText?: string }`.
  - Import `InputItem` from `src/core/protocol/types.ts` (the `:338-357` union — unchanged).

### 1B. Bridge-safe classifier
- [ ] **NEW** `src/core/input/bridgeSafe.ts`
  - `isBridgeSafeForOrigin(commandName: string, origin: InputOrigin, registry): 'safe' | 'unsafe-known' | 'unknown'`.
  - Mirror claudy `commands.ts:674-678` semantics adapted to Track 03: prompt-expanding/skill command → `safe`; UI-only/`local` handled command not on the allowlist → `unsafe-known`; not in registry → `unknown`.
  - Allowlist constant (browserx analog of claudy `BRIDGE_SAFE_COMMANDS` `commands.ts:653-661`) — start conservative; document each entry.
  - `origin.channel === 'local'` callers never invoke this (gate skipped entirely).

### 1C. The funnel skeleton
- [ ] **NEW** `src/core/input/processUserInput.ts`
  - `export async function processUserInput(items: InputItem[], ctx: FunnelContext): Promise<ProcessedInput>`.
  - Stage 1 **normalize** (design §4.4.1): split primary `text` item vs preceding non-text items.
  - Stage 3 **bridge-safe slash gate** (design §4.4.3): only when prompt starts with `/` and `ctx.origin.channel !== 'local'`. `unsafe-known` → `{ items, shouldQuery: false, resultText: "/<name> isn't available over a connector.", systemNote }`; `safe` → fall through to slash dispatch; `unknown` → treat as plain text.
  - Stage 5 **slash dispatch** (design §4.4.5): `parseCommandInput` (`webfront/commands/CommandRegistry.ts:134`) → registry. Prompt-expanding command → enriched `text` items, `shouldQuery: true`; handled command → `{ shouldQuery: false, resultText, nextInput? }`.
  - Stages 2/4/6 (image/bash/mentions) are stubs in Phase 1: return items unchanged, `shouldQuery: true`.

### 1D. Origin plumbing (the §7.1 prerequisite)
- [ ] **EXISTS** `src/core/RepublicAgent.ts`
  - Widen `submitOperation(op, context?: { tabId?: number; origin?: InputOrigin })` (`:481`) — additive, optional, backward-compatible.
  - Add `private buildFunnelContext(op, context)` → `FunnelContext`; default `origin` to `{ channel: 'local' }` when absent (preserves current trusted-UI behavior).
- [ ] **EXISTS** `src/server/agent/ServerAgentBootstrap.ts`
  - `agentHandler` (`:236`) and `submitOp` (`:435`): map `SubmissionContext` → `InputOrigin` and pass via the new context arg.
  - Scheduler launcher (`:638-644`): pass `origin.channel = 'scheduler'`.
- [ ] **EXISTS** `src/server/channel-connectors/connector-bridge.ts`
  - `handleInboundMessage` (`:225-252`): derive `InputOrigin` from `SubmissionContext` (`:235-250`) — `channel:'connector'`, `channelType`, `channelId`, `userId` — and thread it through `submissionHandler`.
- [ ] **EXISTS** `src/webfront/pages/chat/Main.svelte`
  - `sendMessage` (`:705-714`) and `loadAndExecuteSchedulerJob` (`:959-968`): no origin needed (defaults to `local`); confirm no regression in the `client.submitOp(op, { tabId, sessionId })` shape.

### 1E. Funnel insertion + idempotency
- [ ] **EXISTS** `src/core/RepublicAgent.ts` — `submitOperation`, `case 'UserInput': case 'UserTurn':` block (`:509-517`)
  - Insert the funnel call between `:510` and `:511` per design §4.3 (verbatim block in design):
    - Skip if `op.__funnelled` (idempotency — connector/scheduler also build `UserInput`).
    - `processUserInput(op.items, this.buildFunnelContext(op, context))`.
    - `!shouldQuery` → emit `systemNote`/`resultText`/`nextInput`, `return id` (no engine turn).
    - else `op = { ...op, items: processed.items }`, set `__funnelled`, then existing `preSubmitHooks(op, context)` (`:511`) runs on enriched items so the `UserPromptSubmit` hook at `:617` sees expanded text.
  - Verify `toEngineOp` (`:685-705`) does not propagate `__funnelled` downstream (it reconstructs the op — confirmed design §7.6).

### 1F. MessageInput relocation (behavior-preserving)
- [ ] **EXISTS** `src/webfront/components/MessageInput.svelte`
  - Delete the slash branch in `handleKeyDown` (`:208-215`) — leave `onSubmit(value)` (`:216`).
  - Delete the slash branch in `handleButtonClick` (`:304-311`) — leave `onSubmit(value)` (`:312`).
  - Delete `handlePaste` slash logic (`:262-279`) and its `onpaste` binding (`:406`) — pure removal (no image capture exists here yet; that is Phase 2).
  - Keep the dropdown/preview UX (`handleInput` `:230-249`, command-mode nav `:166-201`, dropdown markup `:384-393`); route the *final dispatch* through `onSubmit` → funnel rather than `executeCommand` → `commandRegistry.action()`.
  - Remove `commandRegistry`/`parseCommandInput` imports (`:15`) once dispatch is centralized; `onSubmit(value: string)` contract (`:22,:34`) unchanged.

### 1G. Phase 1 tests
- [ ] **NEW** `src/core/input/__tests__/processUserInput.test.ts`
  - Plain text in → same single `text` item out, `shouldQuery: true`, prompt text byte-identical (the never-rewrite invariant).
  - `origin: local` + `/foo` → slash dispatched, gate skipped entirely.
  - `origin: connector` + unsafe-known `/config` → `shouldQuery: false`, `resultText` set, `systemNote` set, items NOT forwarded.
  - `origin: connector` + safe command → proceeds to dispatch.
  - `origin: connector` + unknown `/zzz` → treated as plain text, `shouldQuery: true`.
  - `__funnelled` op short-circuits (funnel runs exactly once).
- [ ] **EXISTS** `src/core/input/__tests__/` integration
  - `RepublicAgent.submitOperation`: `op.items` is enriched *before* `preSubmitHooks` (assert hook input `user_prompt` at `:617` reflects funnel output).
  - `shouldQuery: false` ⇒ `requireEngine().submitOperation` NOT called.
- [ ] **EXISTS** `webfront/components/__tests__/MessageInput.test.ts`
  - Same input → same command dispatched as before relocation (now via `onSubmit`/funnel). No UX regression to the dropdown.

---

## Phase 2: Image / Paste

**Goal:** Capture pasted screenshots (none captured today — pure addition) and disk-back them + wire-delivered connector images via Track 09, despite Track 09 being a string-only store (§7.4).

**Done when:** a pasted screenshot survives as a retrievable artifact referenced by `context{path}`; connector-delivered `image` items use the same disk-backing stage; large text paste collapses to `[Pasted #N]`; the vision-vs-archival decision (§7.4) is recorded.

### 2A. Paste capture (UI)
- [ ] **EXISTS** `src/webfront/components/MessageInput.svelte`
  - Add a `paste` handler reading `event.clipboardData` image items → emit an `InputItem` `{ type: 'image', image_url: <dataURI> }` into the submission (ext + desktop, shared component).
  - Large text paste (> threshold) → emit a placeholder + a `clipboard`/`context` item per §4.4; keep the visible text as `[Pasted #N]`.

### 2B. Screenshot disk-backing (§7.4)
- [ ] **EXISTS** `src/core/input/processUserInput.ts` — Stage 2 (design §4.4.2)
  - For each inbound `image{image_url}`: parse the data URI, `toolUseId = "paste-" + sha1(bytes).slice(0,12)`.
  - `ctx.resultStore.persist(sessionId, toolUseId, JSON.stringify({ mime, b64 }))` → `PersistedResult.reference`.
  - Replace the item with `context{path: reference}` + a short `text` ref `[Image source: <reference>]` (claudy parity `imageResizer.ts:852`).
  - Idempotent: `FileToolResultStore.persist` swallows `EEXIST` (`resultStore.ts:271`).
  - Cap size via Track 09 `toolLimits` / `PREVIEW_SIZE_BYTES`; disk-local only; never auto-upload.
- [ ] **DECISION (spike)** Record in design §7.4 whether the engine vision path needs a real inline `image` block; if so, additionally emit a resized, size-capped `image{image_url}` alongside the `context{path}` archival ref. The funnel API (`InputItem[]`) already supports both.

### 2C. Phase 2 tests
- [ ] `image{image_url}` in → `context{path}` + `[Image source: …]` text out; `resultStore.persist` called with the JSON envelope.
- [ ] Same image submitted twice → same `toolUseId`, idempotent (no duplicate write).
- [ ] Connector-delivered `image` item (no capture path) → same disk-backing.
- [ ] Oversize image → capped/handled, no throw, `systemNote` if dropped.
- [ ] Large text paste → `[Pasted #N]` + `context{path}`.

---

## Phase 3: Browser-Native Mentions

**Goal:** Parse and resolve `@tab` / `@page` / `@selection` / `@url`, each guarded by a **live** `IPlatformAdapter` capability read, content riding alongside (prompt never rewritten). Includes building the `@selection` backend that does not exist today (§7.2).

**Done when:** mentions resolve into appended `context{path}` (large) / wrapped `text` (small) items with the prompt text untouched; unmet capability degrades via `systemNote` and the turn still proceeds (never throws/aborts a scheduled job); `@url` and (server) `@page` work headless when a browser is attached.

### 3A. Mentions parser
- [ ] **NEW** `src/core/input/mentions.ts`
  - Parse `@tab` / `@tab:<id>` / `@page` / `@selection` / `@url <addr>` from the prompt text.
  - Adapt claudy extraction regexes (`attachments.ts:2764-2765`) to browser nouns; record match positions but **do not splice the prompt** (design §4.4.6, Decision 4).

### 3B. `@selection` backend (§7.2 — new component)
- [ ] **EXISTS** `src/extension/tools/dom/DomService.ts`
  - Add `async getActiveSelection(): Promise<{ text: string; html?: string; url: string } | null>` — `Runtime.evaluate` over the existing CDP client (`window.getSelection().toString()`; `returnByValue: true`; guard empty/whitespace; cap length via Track 09 thresholds).
  - Note: the previously-cited `:1235,1403,1583` are write-side typing methods — do NOT reuse them; this is a new read method.
- [ ] **EXISTS** `src/desktop/tools/browser/NativeBrowserController.ts`
  - Expose the same selection read via the embedded-webview CDP path.

### 3C. Resolution + capability gating
- [ ] **EXISTS** `src/core/input/processUserInput.ts` — Stage 6 (design §4.4.6)
  - `@page` / `@tab`: resolve via `ctx.getDomService().getSerializedDom()` (token-optimized — design §7.5 decision); fall back to `getBrowserController().getSnapshot()` `SerializedDOM` (`BrowserController.ts:158`) only where `DomService` is unavailable. Requires `hasBrowserTools` (live); `@tab`/`@tab:<id>` also requires `hasRealTabs`. Bare `@tab` uses the bound tab (same resolution as `handleTabBinding` `RepublicAgent.ts:719`).
  - `@selection`: `ctx.getDomService().getActiveSelection()`; requires `hasBrowserTools`; `getDomService` undefined (server) ⇒ `systemNote`.
  - `@url <addr>`: capability-independent; fetch/scrape via existing tooling.
  - Each resolved blob: small (< `MENTION_INLINE_MAX`) → wrapped `text` item; large → `ctx.resultStore.persist` → `context{path}` (→ engine `file` via `convertInputItem` `:673-675`). Size cap reuses Track 09 thresholds.
  - Unmet capability (read live at submission time) ⇒ `systemNote`, mention dropped, `shouldQuery` stays `true`.

### 3D. Phase 3 tests
- [ ] Parser: extracts each mention form; prompt text returned unchanged (byte-identical invariant).
- [ ] `@page` (ext, `hasBrowserTools=true`) → appended `context{path}` from `getSerializedDom`; prompt untouched.
- [ ] `@selection` resolves via the new `getActiveSelection`; empty selection → `systemNote`, no item.
- [ ] Server `hasBrowserTools=false`: `@page`/`@tab`/`@selection` → `systemNote`, dropped, turn proceeds; `@url` still resolves.
- [ ] Scheduler job with `@page` and no browser → completes (no throw — Risk: must not abort).
- [ ] Small selection → inline wrapped `text`; large page → `context{path}` (threshold boundary tested).

---

## Phase 4: Escape + Hook Semantics + Chaining (P1)

**Goal:** Capability-gated `!` shell escape (requires the `hasShellExec` flag that does not exist today — §7.3), fold claudy's hook truncation/blocking/`additionalContexts` semantics into the existing `preSubmitHooks`, and command chaining.

**Done when:** `!cmd` runs on shell-capable platforms and injects `<bash-stdout>`/`<bash-stderr>` with `shouldQuery: false`; on shell-less platforms `!` is literal text + `systemNote`; `preSubmitHooks` truncates hook output at 10000, a blocking hook erases the original input to a UI warning, `additionalContexts` become a context item; `nextInput` chains.

### 4A. `hasShellExec` capability (§7.3)
- [ ] **EXISTS** `src/core/platform/IPlatformAdapter.ts` — add `readonly hasShellExec: boolean` (`:58-107`, additive, consistent with `hasRealTabs`/`hasBrowserTools` `:61-62`).
- [ ] **EXISTS** extension adapter → `hasShellExec = false`.
- [ ] **EXISTS** `src/desktop/.../DesktopPlatformAdapter` → `hasShellExec = true` (Tauri shell).
- [ ] **EXISTS** `src/server/platform/ServerPlatformAdapter.ts` → `hasShellExec = true` (exec via `registerExecHandlers` `ServerAgentBootstrap.ts:506-510`).

### 4B. Bash escape
- [ ] **NEW** `src/core/input/bashEscape.ts` — detect leading `!`, strip it, wrap remainder `<bash-input>…</bash-input>` as a `text` marker the exec path recognizes (browserx has no upstream mode layer — design §6.6).
- [ ] **EXISTS** `src/core/input/processUserInput.ts` — Stage 4: gate on `ctx.platform.hasShellExec` (live). Unmet ⇒ `!` treated as literal text + `systemNote`. Met ⇒ run exec, inject `<bash-stdout>`/`<bash-stderr>` result, `shouldQuery: false` (claudy `processBashCommand.tsx:107-112` parity).

### 4C. Fold claudy hook semantics into `preSubmitHooks`
- [ ] **EXISTS** `src/core/RepublicAgent.ts` — `preSubmitHooks` (`:601-649`)
  - Truncate hook output at `MAX_HOOK_OUTPUT_LENGTH = 10000` (claudy `processUserInput.ts:272-279`).
  - Blocking hook → erase original input: emit a UI-only warning system message with `Original prompt: …`, drop the user turn (claudy `:194-209`); preserve any `allowedTools`.
  - `additionalContext` (already on `AggregatedHookResult`) → one truncated `context` `InputItem` (claudy `additionalContexts` → attachment, `:227-240`).
  - `preventContinuation` semantics: keep funnel items, stop the turn (claudy `:213-224`).

### 4D. Command chaining
- [ ] **EXISTS** `src/core/RepublicAgent.ts` — consume `ProcessedInput.nextInput` / `submitNextInput`: prefill (false) or auto-resubmit (true) as a fresh funnelled op.

### 4E. Phase 4 tests
- [ ] `!ls` on `hasShellExec=true` → `<bash-stdout>` injected, `shouldQuery: false`, no engine turn.
- [ ] `!ls` on extension (`hasShellExec=false`) → literal text, `systemNote`, `shouldQuery: true`.
- [ ] Hook returns >10000 chars → truncated with the marker.
- [ ] Blocking hook → original prompt erased to a UI warning, no engine turn, `allowedTools` preserved.
- [ ] `additionalContext` → appears as a `context` item the model sees.
- [ ] `nextInput` with `submitNextInput: true` → a second funnelled submission occurs.

---

## Sequencing & Dependencies

- **Phase 1 is the spine** — 1A→1B→1C→1D→1E→1F→1G in order (1D origin plumbing must precede 1E so the gate has origin; 1F after 1E so the UI delete can't strand input).
- Phases 2, 3 are independent of each other and both depend only on Phase 1; Phase 4 depends on Phase 1 (`hasShellExec` flag is standalone but the exec round-trip rides the funnel).
- External: Track 01 (Hooks, DONE — reuse `HookDispatcher.fire` `core/hooks/HookDispatcher.ts:76-80`), Track 03 (Commands, DONE — `parseCommandInput` `CommandRegistry.ts:134`), Track 09 (Persistence, DONE — `ToolResultStore.persist` `tools/resultStore.ts:50`). Track 16 (Telemetry) and Track 21 (Remote Bridge) integrate later via the same `systemNote`/origin mechanism (design §10).
