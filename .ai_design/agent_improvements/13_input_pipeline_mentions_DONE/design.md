# Track 13: Input Pipeline & Browser-Native Mentions

**Priority: P0** · **Effort: L** · **Status: DONE (merged to `agent-improvements` via PR #229)**

> Source: second-pass claudy↔browserx research + a full implementation-readiness pass (2026-05-15) that read claudy's entire input funnel and browserx's submission seam, protocol, platform adapters, server input sources, browser/DOM backends, and the *as-built* dependency tracks (01 Hooks, 03 Commands, 09 Persistence — all DONE). All line numbers below are verified against branch `agent-improvements`. Where the earlier draft was wrong (a non-existent method, a non-existent backend, a non-existent capability flag, dropped channel origin), this revision replaces the claim with a concrete, system-consistent design — see **§7 Hard Problems** and **§11 Corrections Ledger**.

---

## 1. Problem

BrowserX has **no input processing/expansion layer**. A user message travels: `MessageInput.svelte` → `onSubmit(value: string)` (raw string) → `Main.svelte.sendMessage` builds `{type:'UserInput', items:[{type:'text', text}]}` → `client.submitOp` → `RepublicAgent.submitOperation` → `preSubmitHooks()` → engine. Nothing between the keystroke and the model:

- normalizes/expands input (no `@`-mention, no `!` shell escape, no large-paste collapse, no argument expansion)
- captures pasted screenshots (`MessageInput.svelte` has **zero** clipboard-image handling — the web clipboard `image` is silently dropped)
- produces a uniform result envelope (every call site special-cases a raw string → one `text` item)

The only "parsing" that exists is **ad hoc in the Svelte component**: `MessageInput.svelte` hand-detects a leading `/` in `handleKeyDown` (slash branch `:208-215`), `handleButtonClick` (slash branch `:304-311`), and `handlePaste` (`:262-279`, slash-mode activation only), and calls a client-side `commandRegistry.get(name).action(args)` directly via `executeCommand` (`:131-155`). That component is **shared by BrowserX (extension) and Apple Pi (desktop)** via `webfront/` (`webfront/pages/chat/Main.svelte:1514-1525`), so the ad-hoc layer is duplicated mis-placement across two platforms — and **Apple Pi Server has no Svelte at all**, so server input (WS chat, connector bridges, scheduler) gets *zero* of this handling today. This is the exact "mention UX accretes ad hoc" failure mode — it must be replaced by a real core funnel *before* more input affordances are added.

---

## 2. What Claudy Does (verified reference, not a port target)

### The funnel — `utils/processUserInput/processUserInput.ts`

`processUserInput()` (`:85-140`) is the single public entry. It calls `processUserInputBase()` (`:281-589`, the funnel), then — **only if `result.shouldQuery === true`** (`:174-176`) — runs `executeUserPromptSubmitHooks()` (`utils/hooks.ts:3826-3855`) and folds the results into `result.messages` (`:182-264`).

`processUserInputBase()` strict stage order:

1. **Input normalization & image resize** (`:314-345`): string → `inputString`; array → per-block `maybeResizeAndDownsampleImageBlock` (`imageResizer.ts:445`); trailing text block → `inputString`, rest → `precedingInputBlocks`.
2. **Pasted-image disk storage** (`:351-420`): `storeImages(pastedContents)` (`imageStore.ts:84-99`) writes each image to `join(configHome,'image-cache',sessionId,'${id}.${ext}')` mode `0o600`, base64-decoded, FIFO-capped at 200; emits metadata text `[Image source: ${sourcePath}]` (`imageResizer.ts:835-880`).
3. **Bridge-safe slash gate** (`:422-453`): if `bridgeOrigin && inputString.startsWith('/')`, resolve via `findCommand` + `isBridgeSafeCommand` (`commands.ts:674-678`): `local-jsx`→unsafe, `prompt`→safe, `local`→explicit `BRIDGE_SAFE_COMMANDS` allowlist (`commands.ts:653-661`). Unsafe-but-known → **short-circuit** with `<local-command-stdout>/X isn't available over Remote Control.</local-command-stdout>`, `shouldQuery:false`. Unknown → falls through to plain text. Raw `/config` never reaches the model.
4. **Keyword routing** (`:455-493`): ultraplan keyword on the *pre-expansion* input.
5. **Attachment extraction** (`:495-514`): `getAttachmentMessages` → `toArray`, gated by `shouldExtractAttachments`.
6. **Mode dispatch**: `bash` → `processBashCommand` (wraps `<bash-input>…</bash-input>`, runs the tool, returns **`shouldQuery:false`**); `/` → `processSlashCommand`; else → `processTextPrompt`.

**The uniform envelope** `ProcessUserInputBaseResult` (`:64-83`): `{ messages[], shouldQuery, allowedTools?, model?, effort?, resultText?, nextInput?, submitNextInput? }`.

**`processTextPrompt()`** (`processTextPrompt.ts:19-100`): builds exactly one `UserMessage`; resolved attachments/mentions ride **alongside** as separate `AttachmentMessage`s spread *after* the user message (`:84,97`) — **the user's prompt text is never rewritten**.

**Mentions** (`attachments.ts`): `Attachment` discriminated union (`:440-670`). Extraction regexes — quoted `/(^|\s)@"([^"]+)"/g` (`:2764`), regular `/(^|\s)@([^\s]+)\b/g` (`:2765`); line-range parse `parseAtMentionedFileLines` (`:2836-2852`): `/^([^#]+)(?:#L(\d+)(?:-(\d+))?)?(?:#[^#]*)?$/`. `getAttachmentMessages` (`:2937-2970`) yields `createAttachmentMessage` (`:3201-3210`) — content rides alongside, prompt untouched.

**`!` bash escape**: detected **upstream of the funnel** in `components/PromptInput/inputModes.ts:16-21` (`input.startsWith('!')` → `mode:'bash'`, `!` stripped at `:23-29`). claudy's funnel never parses `!` itself — it receives `mode:'bash'`. **browserx has no equivalent upstream mode layer**, so the browserx funnel must detect `!` itself (see §6.6).

**Hook semantics to fold in** (`processUserInput.ts:182-264`): `MAX_HOOK_OUTPUT_LENGTH = 10000` (defined `:272`, helper `applyTruncation` `:274-279`); blocking error **erases the original input** (returns a fresh result with only a UI warning system message, `:194-209`); `preventContinuation` keeps funnel messages but stops the turn (`:213-224`); `additionalContexts` → one truncated `hook_additional_context` attachment (`:227-240`).

---

## 3. BrowserX Ground Truth — verified seams

| Concern | Verified location | State |
|---|---|---|
| UI entry (ext + desktop, shared) | `webfront/components/MessageInput.svelte`; contract = `onSubmit(value: string)` (`:22,:34`) — single raw string | Ad-hoc `/` in `handleKeyDown:208-215`, `handleButtonClick:304-311`, `handlePaste:262-279`; `executeCommand:131-155`. **No image capture.** Shared by ext + desktop |
| UI host / Op build | `webfront/pages/chat/Main.svelte` — `sendMessage:662-730` builds `{type:'UserInput',items:[{type:'text',text}]}` + `client.submitOp(op,{tabId:currentTabId,sessionId:activeSessionId})` (`:705-714`); 2nd site `loadAndExecuteSchedulerJob:959-968` | Two webfront `UserInput` producers; both single-text-item |
| Input entry (server) | WS chat `chat.ts:handleChatSend:38-76` builds `{type:'UserTurn',items,tabId,…}` (`:55-63`) → `ServerAgentBootstrap.ts:submitOp:428-441`; connector bridge `connector-bridge.ts:225-230` builds `{type:'UserInput',items:[{type:'text',text}]}`; scheduler `ServerAgentBootstrap.ts:638-644` builds `{type:'UserInput',…}` | No Svelte; all three converge on `RepublicAgent.submitOperation`; **zero** input processing today |
| Command parse | `parseCommandInput(input): ParsedCommandInput \| null` (`webfront/commands/CommandRegistry.ts:134`) → `{commandName,args?}`; singleton `commandRegistry` (`:155`), strict `NAME_PATTERN=/^[a-z0-9-]+$/` (`:35`) | Track 03 (DONE). UI-layer module — the wrong-layer locus |
| Wire content | `InputItem` (`core/protocol/types.ts:338-357`): `text{text}` \| `image{image_url}` (data URI) \| `clipboard{content?}` \| `context{path?}` | **Output shape already exists.** `convertInputItem` (`RepublicAgent.ts:656-680`): `context{path}`→engine `file{path}`; `image{image_url}`→engine `image{data,mimeType}`; `clipboard`→`text` |
| Submission op | `Op.UserInput{items}` (`types.ts:34-38`) / `Op.UserTurn{items,tabId(req),approval_policy,sandbox_policy,model,effort?,summary}` (`:39-55`); `Submission{id,op,context?:{tabId?,sessionId?}}` (`:15-27`) | All platforms converge at `RepublicAgent.submitOperation` |
| **Dispatcher + hook seam** | `RepublicAgent.submitOperation(op,context?:{tabId?}):Promise<string>` (`:481`); `UserInput`/`UserTurn` case (`:509-517`); `preSubmitHooks(op,context?):Promise<boolean>` (`:601-649`) fires `hookDispatcher.fire('UserPromptSubmit',hookInput)` (`:617`), returns `false` ⇒ skip engine (`:618-626`) | Track 01 (DONE). **There is no `handleSubmission` method** — the earlier draft's named insertion site is wrong. Exact seam: between `:510` and `:511`. The hook **cannot mutate `op.items` today** (text joined once `:606-609`, op forwarded unchanged via `toEngineOp` `:516`) |
| Hook API | `HookDispatcher.fire(event,input:HookInput,opts?):Promise<AggregatedHookResult>` (`core/hooks/HookDispatcher.ts:76-80`); `HookInput.user_prompt?` (`core/hooks/types.ts:173`), also `current_url?`/`current_domain?`/`tab_id?` (`:189-191`); result `{shouldContinue, additionalContext: readonly string[], systemMessages: readonly string[], stopReason?}` | Reuse — do not re-implement |
| Persistence (Track 09) | `ToolResultStore.persist(sessionId,toolUseId,content:string):Promise<PersistedResult>` (`tools/resultStore.ts:49-53`); `PersistedResult{reference,kind:'cache'\|'file',originalSize,preview,hasMore}` (`:25-40`); factory `createToolResultStore` switches on `__BUILD_MODE__` (server→`FileToolResultStore` disk `{root}/{sid}/tool-results/{tuid}.txt`; ext/desktop→`CacheToolResultStore` IndexedDB) | **String-only store** — binary screenshots need an encoding strategy (see §7.4) |
| Snapshot backends | `BrowserController.getSnapshot():Promise<SerializedDOM>` (`core/tools/browser/BrowserController.ts:158`; `SerializedDOM={root,metadata}` `core/tools/browser/types.ts:12-19`); `ExtensionBrowserController.getSnapshot:282`; `NativeBrowserController.getSnapshot:311` (returns a **degenerate single-node tree** — entire HTML in `root.textContent`). Token-optimized alt: `DomService.getSerializedDom():Promise<SerializedDom>` (`extension/tools/dom/DomService.ts:175`; `SerializedDom={page:{context,body,…}}` `types/domTool.ts:87`) | Two distinct DOM representations — design must choose (see §7.5) |
| **`@selection` backend** | **DOES NOT EXIST.** The cited `DomService.ts:1235,1403,1583` are all *write-side* `window.getSelection()` in `private` typing/editing methods (`clearContentEditable`, `setSelectionForContentEditable`, `findAndReplaceAllText`). No public read-selection API anywhere in `src/` | Must build a new CDP-backed method (see §7.2) |
| Capability gate | `IPlatformAdapter` (`core/platform/IPlatformAdapter.ts:58-107`) — **only** `platformId`/`hasRealTabs:61`/`hasBrowserTools:62`. `ServerPlatformAdapter`: `hasRealTabs=false` (`:19`), `hasBrowserTools` mutable, set once in `initialize()` from `CHROME_REMOTE_URL`/`CHROME_WS_ENDPOINT` (`:20,:22-32`), reset in `dispose()` (`:121-123`) | **No `canExec`/shell flag exists** — `!` gating needs a new flag (see §7.3). `hasBrowserTools` is init-time env-driven, not a live getter — funnel must read the live field and tolerate `false` |
| Tab binding | `UserTurn.tabId` (server chat only, `chat.ts:55`) **or** `Submission.context.tabId` (dominant, webfront) → both reach `preSubmitHooks:629-633` → `handleTabBinding(submissionContext?:{tabId?}):719` (CASE1 `-1`→create, CASE2 ==→validate, CASE3 ≠→switch) | `@tab` generalizes this — must feed the *same* `handleTabBinding` |
| **Channel origin** | On `SubmissionContext` (`channelType`,`channelId`,`userId`,`sessionId` — `connector-bridge.ts:235-250`), **NOT on the `Op`**. `submitOperation` forwards only `{tabId}` (`ServerAgentBootstrap.ts:236,:435`) — **origin is dropped before the funnel** | Bridge-safe gate cannot key off the op as the draft assumed — origin must be plumbed (see §7.1) |

### Per-platform behavior

The funnel is **one core module**; per platform what differs is the *input source* and which *mention vocabulary resolves*. Gating is by `IPlatformAdapter` capability (read **live, at submission time**), never `__BUILD_MODE__`.

- **BrowserX (extension).** Source `MessageInput.svelte`. Full vocabulary — `@tab`/`@page`/`@selection` resolve. Screenshot paste via the web `paste` event (capture must be **added** — none today). `!` **disabled** (no shell; new `hasShellExec=false`). The ad-hoc `/` layer here is what Phase 1 relocates.
- **Apple Pi (desktop, Tauri).** **Same** shared `MessageInput.svelte`. `@page`/`@tab` resolve via `NativeBrowserController.getSnapshot:311` (coarse: HTML-in-`textContent`). `@selection` via the embedded webview (CDP eval — see §7.2). Screenshot paste via the same web clipboard path. `!` **enabled** (`hasShellExec=true`). Deleting the ad-hoc layer fixes ext + desktop in one move.
- **Apple Pi Server (headless).** No Svelte. Three sources (WS chat, connector bridges, scheduler), all already converging on `RepublicAgent.submitOperation` — the core-funnel placement is what finally covers them. `@page`/`@tab`/`@selection` resolve **only if `hasBrowserTools===true`** (env-attached browser); else `systemNote` + drop. `@url` and `!` (`hasShellExec=true` server) are **always available**. No clipboard ⇒ no paste capture, but wire `image` items disk-back. The **bridge-safe slash gate is most important here** — connector input must not leak raw `/config` to the model.

---

## 4. Architecture — the core funnel

### 4.1 Module layout

```
src/core/input/
  types.ts            // ProcessedInput, FunnelContext, InputOrigin
  processUserInput.ts  // processUserInput(items, ctx): Promise<ProcessedInput> — the funnel
  mentions.ts          // parse + resolve @tab/@page/@selection/@url
  bridgeSafe.ts        // isBridgeSafeForOrigin(commandName, origin) — Track 03-aware
  bashEscape.ts        // detect/strip leading `!`, build <bash-input> marker
  __tests__/...
```

`core/input/` is new (verified absent). It sits in `core/` so it serves extension, desktop, and all three server sources from one placement — the central architectural decision (Decision 1).

### 4.2 The envelope — `ProcessedInput` (`core/input/types.ts`)

```ts
/** Where this submission originated — drives the bridge-safe slash gate and capability degradation. */
export interface InputOrigin {
  /** 'local' = trusted UI/WS chat on this host; 'connector'/'remote' = untrusted bridge. */
  channel: 'local' | 'connector' | 'remote' | 'scheduler';
  channelType?: string;   // e.g. 'slack', 'telegram' — from SubmissionContext.channelType
  channelId?: string;
  userId?: string;
}

export interface FunnelContext {
  sessionId: string;
  origin: InputOrigin;
  platform: IPlatformAdapter;          // live capability reads (hasBrowserTools/hasRealTabs/hasShellExec)
  resultStore: ToolResultStore;        // Track 09 — disk-back large mention content + images
  commandRegistry: ICommandRegistry;   // Track 03 — slash dispatch + bridge-safe classification
  getBrowserController: () => IBrowserController | null;
  getDomService?: () => DomService | null;   // extension/desktop only; undefined ⇒ no @selection
  tabId?: number;                      // resolved tab binding (Submission.context.tabId | UserTurn.tabId)
}

export interface ProcessedInput {
  /** Enriched items: original text preserved; mentions/screenshots/paste appended as
   *  context{path} (large) or text (small, wrapped) or image{image_url}. NEVER rewrites user text. */
  items: InputItem[];
  /** false ⇒ handled (slash/bash/blocked) — caller must NOT submit a turn to the engine. */
  shouldQuery: boolean;
  /** Command chaining (e.g. /discover → prefilled next input). */
  nextInput?: string;
  submitNextInput?: boolean;
  /** Graceful-degradation channel surfaced to the user as a system event (not model-visible).
   *  e.g. "@page unavailable — no browser attached" / "/config isn't available over a connector". */
  systemNote?: string;
  /** Terminal handled output (slash/bash stdout) for non-interactive/connector replies. */
  resultText?: string;
}
```

`systemNote` is the **single graceful-degradation channel** that makes one funnel safe across platforms with different live capabilities — the browserx analog of claudy's per-stage short-circuit messages, unified.

### 4.3 Entry signature & placement

```ts
// core/input/processUserInput.ts
export async function processUserInput(
  items: InputItem[],
  ctx: FunnelContext,
): Promise<ProcessedInput>
```

**Exact insertion seam — `src/core/RepublicAgent.ts`, inside `submitOperation`, the `case 'UserInput': case 'UserTurn':` block (`:509-517`)**, between line `:510` (`case 'UserTurn': {`) and line `:511` (`const shouldContinue = await this.preSubmitHooks(op, context);`):

```ts
case 'UserInput':
case 'UserTurn': {
  // ── Track 13: input funnel runs ONCE, before hooks, so the hook sees expanded text ──
  if (!(op as any).__funnelled) {
    const processed = await processUserInput(op.items, this.buildFunnelContext(op, context));
    if (!processed.shouldQuery) {
      if (processed.systemNote) this.emitEvent({ type: 'Error', data: { message: processed.systemNote } });
      if (processed.resultText) this.emitHandledResult(processed.resultText);  // slash/bash stdout
      if (processed.nextInput) this.queueNextInput(processed.nextInput, processed.submitNextInput);
      return id;                       // handled — no engine turn
    }
    op = { ...op, items: processed.items } as typeof op;
    (op as any).__funnelled = true;    // idempotency marker — connector/scheduler also build UserInput
    if (processed.systemNote) this.emitEvent({ type: 'SystemNote', data: { message: processed.systemNote } });
  }
  const shouldContinue = await this.preSubmitHooks(op, context);   // existing :511 — now sees enriched items
  if (!shouldContinue) return id;
  return requireEngine().submitOperation(this.toEngineOp(op));
}
```

This satisfies **Divergence 2** (the hook at `:617` now joins *expanded* text because the funnel enriched `op.items` first) without duplicating `executeUserPromptSubmitHooks` — browserx already runs hooks in `preSubmitHooks`; the funnel runs immediately before it.

### 4.4 Funnel stage order (browserx, adapted — not a transplant)

Mirrors claudy's strict order but expressed in browserx's `InputItem[]`/capability/Track-09 vocabulary:

1. **Normalize.** Split `items` into the trailing/primary `text` item (the prompt) vs preceding non-text items (`image`/`clipboard`/`context`) — analog of claudy's `inputString` / `precedingInputBlocks`.
2. **Wire-image disk-backing.** Any inbound `image{image_url}` (connector-delivered, or Phase 2 paste) → Track 09 `persist` (base64 payload, see §7.4) → replace with `context{path}` + a short `text` ref `[Image source: <ref>]`. Mirrors claudy `storeImages`; uses browserx's `convertInputItem` `context{path}`→engine `file` path.
3. **Bridge-safe slash gate** (origin-aware, §7.1). If prompt starts with `/` **and** `origin.channel !== 'local'`: classify via Track 03. Unsafe-but-known → short-circuit `{shouldQuery:false, resultText:"/X isn't available over a connector.", systemNote}`. Safe → continue to slash dispatch. Unknown → treat as plain text.
4. **Bash escape** (§6.6/§7.3). If prompt starts with `!` **and** `ctx.platform` exposes shell exec: strip `!`, wrap remainder `<bash-input>…</bash-input>` as a `text` item, mark for the exec path; `{shouldQuery:false}` after exec result is injected (Phase 4). Capability-unmet ⇒ `systemNote`, treat as plain text.
5. **Slash dispatch.** If prompt starts with `/` (and not gated out): `parseCommandInput` → registry. Prompt-expanding command → enriched `text` items, `shouldQuery:true`. Handled command → `{shouldQuery:false, resultText, nextInput?}`. (Phase 1 relocates the ex-`MessageInput.svelte` dispatch here.)
6. **Mentions** (§7.2/§7.5). Parse `@tab`/`@page`/`@selection`/`@url` from the prompt text (claudy regex, browser nouns). For each, capability-check (live), resolve, then **append resolved content alongside** — never rewrite the prompt: small (< `MENTION_INLINE_MAX`) → wrapped `text` item; large → Track 09 `persist` → `context{path}`. Unmet capability ⇒ `systemNote`, mention dropped, turn proceeds.
7. **Return** `{items: [originalText, ...preceding, ...resolvedMentions, ...imageRefs], shouldQuery:true}`.

---

## 5. Key Design Decisions & Divergences from claudy

1. **Funnel in core, before hooks, operating on protocol `InputItem[]`** (not a port of claudy's React layer). One placement (`RepublicAgent.submitOperation:510→511`) serves extension, desktop, and all three server input sources. `MessageInput.svelte`'s in-component `/` dispatch is removed in favor of routing through it (fixes ext + desktop together — shared component).
2. **Reuse the existing `UserPromptSubmit` hook.** claudy runs hooks *inside* `processUserInput`; browserx already runs them in `preSubmitHooks` (`RepublicAgent.ts:617`). The funnel runs *before* it and enriches `op.items`, so the hook sees expanded text — no parallel hook, no duplicate `executeUserPromptSubmitHooks`. **Divergence:** fold claudy's blocking/`additionalContexts`/truncation semantics (claudy `processUserInput.ts:194-262`, `MAX=10000`) into `preSubmitHooks` (Phase 4), not into the funnel.
3. **Uniform envelope = enriched `InputItem[]` + control flags** (`ProcessedInput`, §4.2). `systemNote` is the unified graceful-degradation channel — browserx's answer to claudy's scattered per-stage short-circuit messages.
4. **Resolved mentions ride alongside via the existing wire shape** — small → wrapped `text` item, large → Track 09 `context{path}` (→ engine `file`). This *is* claudy's "prompt untouched, content rides alongside" (`processTextPrompt.ts:84,97`), realized through browserx's `InputItem`/`convertInputItem` mapping rather than claudy's `AttachmentMessage`. The user's `text` item is never rewritten.
5. **Screenshot paste = disk-backed, reusing Track 09.** **Divergence:** browserx has no terminal `pastedContents` map — capture is the web `paste` event added to `MessageInput.svelte` (Phase 2); the funnel's job is disk-backing + a metadata ref, not capture. Track 09 is string-only — see §7.4 for the binary encoding strategy.
6. **`!` and `@page` gate on live `IPlatformAdapter` capability, not `__BUILD_MODE__`.** **Divergence vs first draft:** the draft said gate on `__BUILD_MODE__` *and* on a `canExec` flag — both wrong. `ServerPlatformAdapter.hasBrowserTools` is runtime-set from env (`:20,:22-32`); a build-mode compare misclassifies a server with an attached browser. And `canExec` does not exist — a new `hasShellExec` flag is introduced (§7.3). Capability flags, read live at submission time, are the correct gate.

---

## 5b. As-Built Resolutions (implemented 2026-05-15, branch `feat/track-13-input-pipeline`)

Decisions the design left open or stated literally, resolved during implementation for system-consistency. The design above is the intent; this is what shipped.

1. **§6.1 MessageInput relocation — kept UI-command dispatch client-side (deliberate divergence).** `/new`,`/help`,`/settings` are pure Svelte router/callback actions; Track 03 designates `webfront/commands` as the UI-only surface. They *cannot* execute in core, and the literal "delete the slash branches" would break `/settings`. Resolution: the funnel is the canonical processor for all model-bound + server input (its real value); UI commands stay correctly in the UI layer. By the time core sees input, UI commands are already handled client-side. Behavior-preserving; no `MessageInput.test.ts` regression.
2. **§7.2 `@selection` backend — adapter-level, not DomService (layering refinement).** Added optional `IBrowserController.getSelectionText?()` instead of a `core/`→`extension/` `DomService` import (which would violate layering). Extension implements it via `chrome.scripting` (the same path as `getPageContent`, no CDP). Strictly better for layering than the design's §7.2.
3. **§7.4 screenshot spike — resolved as the safe hybrid.** Inline `image` is **kept** (vision, no regression) **plus** a Track-09-persisted `{mime,b64}` envelope under a content-addressed idempotent id **plus** an `[Image source: <ref>]` text breadcrumb. No `context{path}` for images (would dump base64 into the prompt as text via `convertInputItem`).
4. **§7.5 `@page`/`@tab` representation — adapter `getPageContent()`.** Resolved via the cross-platform `IBrowserController.getPageContent()` (the abstraction that exists) rather than importing extension's `DomService.getSerializedDom()` into core. Avoids the layering violation; large content collapses to Track 09's `<persisted-output>`.
5. **§7.3 `!` exec — funnel does normalization only (explicit layer boundary).** The funnel detects `!`, gates on `hasShellExec`, and emits the recognizable `<bash-input>` marker (or literal text + systemNote). Actually *running* the command + injecting `<bash-stdout>` is the execution layer's concern, kept out of `core/input/` for the same layering reason UI commands stayed in the UI — the bounded engine-layer follow-up.
6. **§7.1 origin plumbing — centralized in `agentHandler`.** `connector-bridge.ts` needed no edit: it already threads `SubmissionContext` through `submissionHandler` → `agentHandler`, where `deriveInputOrigin` runs centrally. Cleaner than per-connector edits.

**Post-review hardening (security pass):** (a) `@url` now refuses loopback/private/link-local/CGNAT targets (SSRF guard — blocks the cloud-metadata vector) since it is reachable from untrusted connectors; (b) the `!` shell escape is origin-gated to operator-trusted origins (`local`/`scheduler`) — an untrusted connector/remote message can no longer synthesize a `<bash-input>` marker; (c) every mention resolution is bounded by `RESOLUTION_TIMEOUT_MS` (8 s) so a hung URL/tab cannot stall a submission; (d) mention persistence uses a content-addressed idempotent id (shared FNV-1a). DNS-rebinding remains out of scope (would require resolve-and-pin).

## 6. Per-stage detail (browserx)

- **6.1 Slash relocation (Phase 1).** Delete `MessageInput.svelte` slash branches (`:208-215`, `:304-311`) and `handlePaste` slash logic (`:262-279`); keep the dropdown/preview UX but route the *final dispatch* through `onSubmit` → core funnel → `parseCommandInput`. Remove the `commandRegistry`/`parseCommandInput` imports (`:15`) once dispatch is centralized. `onSubmit(value:string)` contract unchanged. Behavior-preserving — covered by `MessageInput.test.ts` + `CommandRegistry` tests.
- **6.2 Server free coverage.** No source change at WS/connector/scheduler — they already reach `RepublicAgent.submitOperation`. They gain the funnel automatically once §4.3 lands. The only server-specific add is origin plumbing (§7.1).
- **6.3 Mentions parser** (`core/input/mentions.ts`). Adapt claudy regexes to browser nouns: `@tab` / `@tab:<id>` / `@page` / `@selection` / `@url <addr>`. Reuse claudy's line-range form only where meaningful (none for browser nouns initially). Parse positions but **do not splice the prompt** — resolved content is appended as separate items.
- **6.4 `@tab` generalizes the tab binding.** `@tab:<id>` resolves a specific tab snapshot; bare `@tab` = the bound tab (`handleTabBinding` resolution at `RepublicAgent.ts:719`). Requires `hasRealTabs` (false on server ⇒ `systemNote`).
- **6.5 `@url <addr>`** — capability-independent (works headless): fetch/scrape → Track 09 `context{path}` (large) or wrapped `text` (small). Reuse existing fetch tooling; cap size with Track 09 thresholds.
- **6.6 Bash escape.** browserx has **no upstream mode layer** (claudy's `inputModes.ts` has no analog), so the funnel detects leading `!` itself, strips it, and emits a `<bash-input>…</bash-input>` `text` marker the exec path recognizes. Gated on `hasShellExec` (§7.3). Wiring the exec round-trip + `<bash-stdout>` injection is Phase 4.

---

## 7. Hard Problems the first draft missed (must be designed, not assumed)

These are the gaps that make this revision "implementation-ready" rather than aspirational. Each was verified to not work as the draft assumed.

### 7.1 Channel origin is dropped before the funnel — must be plumbed

**Problem.** The draft says add the bridge-safe gate "keyed on the op's channel origin." Verified false: the `Op` carries no origin; origin lives on `SubmissionContext` (`channelType`/`channelId`/`userId`/`sessionId`, `connector-bridge.ts:235-250`); `RepublicAgent.submitOperation` accepts only `context?:{tabId?}` (`:481`) and the server handlers forward only `{tabId}` (`ServerAgentBootstrap.ts:236,:435`). By the funnel point, origin is gone.

**Design.** Widen the submission context type, threaded end-to-end:

- `RepublicAgent.submitOperation(op, context?: { tabId?: number; origin?: InputOrigin })` — additive, optional, backward-compatible.
- `ServerAgentBootstrap` `agentHandler`/`submitOp` and `connector-bridge.handleInboundMessage` map `SubmissionContext` → `InputOrigin` (`channel:'connector', channelType, channelId, userId`) and pass it through. Scheduler path → `origin.channel='scheduler'`. WS chat on-host → `origin.channel='local'`. Webfront `client.submitOp` → default `origin.channel='local'`.
- `buildFunnelContext(op, context)` (new private on `RepublicAgent`) defaults `origin` to `{channel:'local'}` when absent (preserves current trusted-UI behavior).
- Bridge-safe gate: `origin.channel !== 'local'` ⇒ classify slash via Track 03 (`isBridgeSafeForOrigin` in `core/input/bridgeSafe.ts`, mirroring claudy `isBridgeSafeCommand` semantics — `local-jsx`/handled-UI commands unsafe, prompt-expanding/skill commands safe, explicit allowlist for the rest). Unsafe-but-known ⇒ short-circuit + `systemNote`; unknown ⇒ plain text; safe ⇒ proceed.

This is a **prerequisite** for Phase 1's server slash-safety and is itself a small, isolated change. It is the only signature change to a hot path and is purely additive.

### 7.2 `@selection` has no backend — build one

**Problem.** Verified: there is **no public read-selection API** in `src/`. The cited `DomService.ts:1235/1403/1583` are write-side `window.getSelection()` in private typing methods. `@selection` cannot "resolve via existing DomService selection."

**Design.** Add a thin read method that evaluates selection in the page via the existing CDP debugger client `DomService` already holds:

```ts
// extension/tools/dom/DomService.ts — new public method
async getActiveSelection(): Promise<{ text: string; html?: string; url: string } | null> {
  // Runtime.evaluate over the existing CDP client:
  //   const s = window.getSelection();
  //   s && s.rangeCount ? { text: s.toString(), url: location.href } : null
  // returnByValue:true; guard empty/whitespace; cap length (reuse Track 09 thresholds).
}
```

Desktop (`NativeBrowserController`) exposes the same via its embedded-webview CDP path. Server has no DOM ⇒ `@selection` requires `hasBrowserTools` and degrades via `systemNote` otherwise. The funnel reaches it through `FunnelContext.getDomService` (undefined on server). This is a **new component**, scoped to Phase 3 — the single largest divergence from the draft and called out explicitly so it is estimated, not assumed free.

### 7.3 `!` shell-escape gating — `canExec` does not exist

**Problem.** `IPlatformAdapter` has only `hasRealTabs`/`hasBrowserTools` (`:61-62`). No `canExec`/shell flag. Server exec is via `registerExecHandlers` (`ServerAgentBootstrap.ts:506-510`), not an adapter capability.

**Design.** Add one capability flag, consistent with the existing pattern:

```ts
// core/platform/IPlatformAdapter.ts — additive
readonly hasShellExec: boolean;
```

- `ExtensionPlatformAdapter.hasShellExec = false` (no shell).
- `DesktopPlatformAdapter.hasShellExec = true` (Tauri shell).
- `ServerPlatformAdapter.hasShellExec = true` (exec handlers registered).

The funnel reads `ctx.platform.hasShellExec` live. Unmet ⇒ `!` is treated as literal text + `systemNote` ("shell escape unavailable on this platform"). Phase 4 wires the actual exec round-trip; Phase 1–3 only need the flag + the literal-text fallback so behavior is well-defined from day one.

### 7.4 Track 09 store is string-only — screenshot encoding

**Problem.** `ToolResultStore.persist(sessionId, toolUseId, content: string)` (`resultStore.ts:50`) is a **string** store. Pasted/wire screenshots are binary.

**Design.** Disk-back the image as a base64 payload with a small JSON envelope so retrieval is unambiguous, and reference it via the existing wire path:

- Funnel computes `toolUseId = "paste-" + sha1(bytes).slice(0,12)` (idempotent — `FileToolResultStore.persist` already swallows `EEXIST`, `:271`).
- `persist(sessionId, toolUseId, JSON.stringify({ mime, b64 }))` → `PersistedResult.reference`.
- Replace the `image` item with `context{path:reference}` + a short `text` ref `[Image source: <reference>]` (mirrors claudy's `[Image source: …]`, `imageResizer.ts:852`). `convertInputItem` (`:673-675`) maps `context{path}`→engine `file{path}`; the engine's file reader (Track 09 `ReadPersistedResultTool`) decodes the envelope.
- **Alternative kept open:** if the engine's image pipeline must see a real `image` block (vision), keep a *resized, size-capped* `image{image_url}` inline **in addition to** the `context{path}` archival ref. Decision deferred to Phase 2 spike; the funnel API supports both (it returns `InputItem[]`).
- Size cap reuses Track 09's `PREVIEW_SIZE_BYTES`/`toolLimits`; never auto-upload; disk-local only; redact on telemetry (Track 16).

### 7.5 `@page`/`@tab` representation — pick the token-optimized one

**Problem.** Two DOM representations: `BrowserController.getSnapshot()` → `SerializedDOM` (`{root,metadata}` structured tree; the draft's choice) vs `DomService.getSerializedDom()` → `SerializedDom` (`{page:{context,body,…}}`, token-optimized HTML body — what the agent already consumes for browser context). `NativeBrowserController.getSnapshot` is degenerate (whole HTML in `root.textContent`).

**Design decision.** For `@page`/`@tab` on extension/desktop, resolve via **`DomService.getSerializedDom()`** (token-optimized — consistent with what the model already sees for browser tools; avoids doubling token cost with a second representation). Fall back to `BrowserController.getSnapshot()` `SerializedDOM` only where `DomService` is unavailable (generic/server-with-browser path). Either way the result is serialized to a string, size-capped, and disk-backed via Track 09 → `context{path}` (large) or inlined as wrapped `text` (small). Rationale: a mention should give the model the *same shape* of page context the browser tools give it — not a divergent tree it must reconcile.

### 7.6 Idempotency / double-funnel

Connector, scheduler, and webfront all build `UserInput`; the funnel must run exactly once. The `__funnelled` marker on the op (§4.3) is checked before processing and set after. Verified safe: `toEngineOp` (`:685-705`) reconstructs the op for the engine and does not carry the marker downstream. Connector retries (`connector-bridge.ts:252` `.catch`) build a fresh op ⇒ correctly re-funnelled.

---

## 8. Implementation Plan (file-level, ordered)

**Safety net:** `webfront/components/__tests__/MessageInput.test.ts`, `CommandRegistry` tests, plus new `core/input/__tests__/processUserInput.test.ts`. Phase 1 must be strictly behavior-preserving (shared component ⇒ a regression hits ext + desktop at once).

**Phase 1 (P0) — relocate + origin plumbing, no new affordances.**
- New `core/input/types.ts` (`ProcessedInput`, `FunnelContext`, `InputOrigin`) and `core/input/processUserInput.ts` (normalize + slash dispatch + bridge-safe gate; mentions/bash are no-ops returning input unchanged).
- `RepublicAgent`: add `buildFunnelContext`, insert the funnel call at `submitOperation` `:510→:511` with the `__funnelled` marker (§4.3).
- Origin plumbing (§7.1): widen `submitOperation` context; map `SubmissionContext`→`InputOrigin` in `ServerAgentBootstrap` (`:236,:435`), `connector-bridge` (`:252`), scheduler (`:638`); webfront defaults to `local`.
- `core/input/bridgeSafe.ts` using Track 03 registry classification.
- Delete `MessageInput.svelte` slash branches (`:208-215`, `:304-311`) + `handlePaste` slash logic (`:262-279`); route dispatch through `onSubmit` → funnel. Keep dropdown UX.
- Tests: behavior-preserving slash dispatch (ext/desktop), connector `/config` blocked + `systemNote`, scheduler/WS unaffected.

**Phase 2 (P0) — image/paste.**
- Add web `paste` image capture to `MessageInput.svelte` (ext + desktop) → `image{image_url}` item (none exists today — pure addition).
- Funnel stage 2: disk-back `image` items via Track 09 with the §7.4 envelope; wire-delivered connector `image` items use the same stage (no capture path).
- Large text paste → `[Pasted #N]` collapse to Track 09 `context{path}`.
- Phase-2 spike: decide inline-`image` vs `context{path}`-only for vision (§7.4).

**Phase 3 (P0) — mentions.**
- `core/input/mentions.ts`: parse `@tab`/`@page`/`@selection`/`@url`; resolve with **live** capability checks.
- New `DomService.getActiveSelection()` + desktop equivalent (§7.2).
- `@page`/`@tab` via `DomService.getSerializedDom()` (fallback `BrowserController.getSnapshot`) (§7.5); `@url` via fetch/scrape. All size-capped, Track 09-backed, appended alongside; unmet capability ⇒ `systemNote`.

**Phase 4 (P1) — escape + hook semantics + chaining.**
- Add `IPlatformAdapter.hasShellExec` (§7.3) across the three adapters; funnel `!` detection + exec round-trip + `<bash-stdout>` injection (`shouldQuery:false`).
- Fold claudy truncation (`MAX=10000`)/blocking-erase/`additionalContexts` into `preSubmitHooks` (`RepublicAgent.ts:601-649`).
- `nextInput`/`submitNextInput` command chaining.

---

## 9. Testing strategy

- **Unit (`core/input/__tests__`):** stage order; prompt-text-never-rewritten invariant; small-vs-large mention routing (text vs `context{path}`); bridge-safe matrix (`local`×safe/unsafe/unknown vs `connector`×…); `__funnelled` idempotency; capability-unmet ⇒ `systemNote` not throw.
- **Integration:** `RepublicAgent.submitOperation` enriches `op.items` *before* `preSubmitHooks` (assert the `UserPromptSubmit` hook at `:617` receives expanded text); `shouldQuery:false` ⇒ no `engine.submitOperation`.
- **Behavior-preserving (Phase 1):** `MessageInput.test.ts` — slash still dispatches the same command for the same input, via the funnel instead of in-component.
- **Server:** connector `/config` → blocked + `systemNote`, never forwarded; scheduler job with `@page` and no browser → completes with `systemNote`, never throws (Risk: must not abort a scheduled job).
- **Capability degradation:** server `hasBrowserTools=false` → `@page`/`@tab`/`@selection` drop with `systemNote`; `@url`/`!` still resolve.

---

## 10. Dependencies

- **Track 01 (Hooks/Events) — DONE.** Reuse `HookDispatcher.fire('UserPromptSubmit',…)` via the existing `preSubmitHooks` seam (`RepublicAgent.ts:617`). Do not duplicate.
- **Track 03 (Commands) — DONE.** `parseCommandInput`/`commandRegistry` (`CommandRegistry.ts:134,:155`) become funnel stages; the bridge-safe classifier reads the registry.
- **Track 09 (Tool Result Persistence) — DONE.** `ToolResultStore.persist` (`resultStore.ts:50`) disk-backs large mention content, pasted screenshots, wire images. Note string-only constraint (§7.4).
- **Track 16 (Telemetry):** emit `user_prompt` + mention/keyword events from the funnel once Track 16 lands (claudy emits these from `processTextPrompt`); redact screenshots.
- **Track 21 (Remote Bridge):** the bridge-safe gate protects connector/relay input — same `systemNote` mechanism; depends on the §7.1 origin plumbing.

---

## 11. Corrections Ledger (vs first-pass draft — verified 2026-05-15)

| Draft claim | Reality | Resolution in this revision |
|---|---|---|
| Funnel called in `RepublicAgent.handleSubmission` | **No such method.** Dispatcher is `submitOperation` (`:481`); `UserInput`/`UserTurn` case `:509-517` | Insert at `:510→:511`, before `preSubmitHooks` (§4.3) |
| `@selection` resolves via `DomService` `window.getSelection()` (`:1235,1403,1583`) | Those are **write-side** typing methods; **no read-selection API exists** | New `DomService.getActiveSelection()` via CDP (§7.2) — scoped Phase 3 |
| `!` gates on `__BUILD_MODE__` / a `canExec` capability | `canExec` **does not exist**; `__BUILD_MODE__` misclassifies env-attached server | New `IPlatformAdapter.hasShellExec` flag, read live (§7.3) |
| Bridge-safe gate keyed on "the op's channel origin" | Origin is on `SubmissionContext`, **dropped** before the funnel | Plumb `InputOrigin` through `submitOperation` (§7.1) — Phase 1 prerequisite |
| Disk-back screenshots "reusing Track 09" | Track 09 `persist` is **string-only** | Base64+JSON envelope + `context{path}` ref, optional inline `image` for vision (§7.4) |
| `@page`/`@tab` via `BrowserController.getSnapshot()` | Two representations exist; that one diverges from what the model already sees | Use `DomService.getSerializedDom()` (token-optimized), fallback `getSnapshot` (§7.5) |
| `hasBrowserTools` "flips true when a browser attaches" (dynamic getter) | Mutable field set **once** in `initialize()` from env, reset in `dispose()` | Funnel reads the **live field at submission time** and tolerates `false` (§3) |
| `MessageInput.svelte:204-218` slash block | Slash branch is `:208-215` (fn `157-220`); `handlePaste` is slash-only, **no image capture** | Phase 1 deletes `:208-215`/`:304-311`/`:262-279`; Phase 2 *adds* paste capture |
| `protocol/types.ts:31-52` for Op/UserTurn; `preSubmitHooks :601-650`/`:613-628`/`:608-611` | `Op` `:32-117`; `UserTurn` `:39-55`; `preSubmitHooks` `:601-649`; fire `:617`; join `:606-609` | All citations re-pinned in §3 |

### Verified-accurate citations (unchanged from draft)

`IPlatformAdapter.ts:61-62`; `ServerPlatformAdapter.ts:19,26`; `ServerAgentBootstrap.ts:428-441,:638-644`; `connector-bridge.ts:228`; `BrowserController.ts:158`; `ExtensionBrowserController.ts:282`; `NativeBrowserController.ts:311`; `CommandRegistry.ts:134`; `InputItem` `protocol/types.ts:338-357`. claudy: `processUserInput.ts:64-83,85-140,182-264,281-589,422-453`; `processTextPrompt.ts:19-100`; `commands.ts:653-678`; `attachments.ts:2757-2790,2836-2852,2937-2970`; `imageStore.ts:84-99`; `hooks.ts:3826-3855`; `processUserInput.ts:272-279` (`MAX_HOOK_OUTPUT_LENGTH`).
