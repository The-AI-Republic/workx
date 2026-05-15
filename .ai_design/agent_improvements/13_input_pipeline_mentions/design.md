# Track 13: Input Pipeline & Browser-Native Mentions

**Priority: P0** · **Effort: L** · **Status: READY TO IMPLEMENT**

> Source: second-pass claudy↔browserx research (2026-05-14), implementation-readiness + multi-platform pass (2026-05-15). Grounded in a full read of claudy's input funnel and browserx's submission seam across all three deploy targets — see "Validation Notes". This is the spine other input/UX work (Track 24.1 command ranking, screenshot paste, mentions) hangs off.

## Problem

BrowserX has **no input processing/expansion layer**. A user message travels: `MessageInput.svelte` → `onSubmit(value: string)` (raw string) → UI client builds a `UserInput`/`UserTurn` `Op` with `items: InputItem[]` → `RepublicAgent` → `preSubmitHooks()` → engine. Nothing between the keystroke and the model:

- normalizes/expands input (no `@`-mention, no `!` shell escape, no large-paste collapse, no argument expansion)
- captures pasted screenshots (the web clipboard `image` is dropped)
- produces a uniform result envelope (every call site special-cases raw strings)

Worse, the only "parsing" that exists is **ad hoc in the Svelte component**: `MessageInput.svelte` hand-detects a leading `/` in `handleKeyDown`/`handleButtonClick`/`handlePaste` and calls a client-side `commandRegistry` action directly (`MessageInput.svelte:204-218, 262-279, 293-314`). That component is **shared by BrowserX (extension) and Apple Pi (desktop)** via `webfront/` (`webfront/pages/chat/Main.svelte`), so the ad-hoc layer is duplicated mis-placement across two platforms — and **Apple Pi Server has no Svelte at all**, so server input (WS chat, connector bridges, scheduler) gets *zero* of this handling today. This is the exact "mention UX accretes ad hoc" failure mode — it must be replaced by a real core funnel *before* more input affordances are added.

## What Claudy Does

### The funnel — `utils/processUserInput/processUserInput.ts`

`processUserInput()` (`:85-270`) is the single public entry. It calls `processUserInputBase()`, then runs `executeUserPromptSubmitHooks()` (`:182-263`) with: output truncation (`MAX_HOOK_OUTPUT_LENGTH = 10000`, `applyTruncation` `:274-279`), blocking-error short-circuit that **erases the original input** (`:194-209`), `preventContinuation` (`:213-224`), and `additionalContexts` folded in as `createAttachmentMessage` (`:231-240`).

`processUserInputBase()` (`:281-589`) is the funnel, in strict order:

1. **Image normalization** (`:314-345`): `maybeResizeAndDownsampleImageBlock` per image block; trailing text block becomes `inputString`, the rest `precedingInputBlocks`.
2. **Pasted images** (`:351-420`): `storeImages(pastedContents)` writes them to **disk** so the model can reference a path (`:360-362`); parallel resize via `Promise.all`; emits `[Image source: ${sourcePath}]` metadata text.
3. **Bridge-safe slash gate** (`:428-453`): remote/bridge input with `/` is resolved through `isBridgeSafeCommand`; unsafe commands short-circuit with a message instead of leaking raw `/config` to the model.
4. **Keyword routing** (`:467-493`): ultraplan keyword on the *pre-expansion* input.
5. **Attachment extraction** (`:496-514`): gated by `shouldExtractAttachments`, `getAttachmentMessages(...)` → `toArray`.
6. **Mode dispatch** (`processUserInputBase` tail, `~:460-589`; `processSlashCommand` dyn-import `:480`): `bash` → `processBashCommand` (`!` → `<bash-input>`); `/` → `processSlashCommand`; else → `processTextPrompt`.

### The uniform envelope — `ProcessUserInputBaseResult` (`:64-83`)

```ts
type ProcessUserInputBaseResult = {
  messages: (UserMessage|AssistantMessage|AttachmentMessage|SystemMessage|ProgressMessage)[]
  shouldQuery: boolean
  allowedTools?: string[]; model?: string; effort?: EffortValue
  resultText?: string; nextInput?: string; submitNextInput?: boolean
}
```

`processTextPrompt()` (`processTextPrompt.ts:19-100`) builds `createUserMessage({content, imagePasteIds, permissionMode, isMeta})` and returns `{ messages: [userMessage, ...attachmentMessages], shouldQuery: true }` — **mentions/attachments are separate model-visible context messages, not concatenated into the user's text.**

### Mentions — `utils/attachments.ts`

Typed `Attachment` union (`:440`): `FileAttachment` (`:295`), `AgentMentionAttachment` (`:335`), etc. `parseAtMentionedFileLines` (`:1905`) parses `@file:Lstart-Lend`; mentions become `'at-mention'` typed `AttachmentMessage`s (`:1952`) resolved by `getAttachmentMessages`. The user's prompt text is untouched; resolved content rides alongside as context.

## BrowserX Mapping

### The real seams

| Concern | BrowserX location | State |
|---|---|---|
| UI entry (ext + desktop, shared) | `webfront/components/MessageInput.svelte` `onSubmit(value:string)`, used by `webfront/pages/chat/Main.svelte` | Raw string; ad-hoc `/` handling in the component (wrong layer); shared by extension **and** desktop |
| Input entry (server) | WS chat `registerChatHandlers.submitOp` (`ServerAgentBootstrap.ts:428-441`); connector bridge `{type:'UserInput'}` (`connector-bridge.ts:228`); scheduler `{type:'UserInput',items:[{text:execution.input}]}` (`ServerAgentBootstrap.ts:638-644`) | No Svelte; raw text → `submitOperation`; **zero** input processing today |
| Command parse | `parseCommandInput` (`webfront/commands/CommandRegistry.ts:134`) → `{commandName,args}` | Client-side dispatch only (Track 03); strict filter (Track 24.1) |
| Wire content | `InputItem` (`core/protocol/types.ts:338-357`): `text` \| `image{image_url}` \| `clipboard{content?}` \| `context{path?}` | **Output shape already exists** — `context` carries resolved mentions, `image` carries screenshots |
| Submission op | `Op` `UserInput{items}` / `UserTurn{items,tabId,…}` (`types.ts:31-52`) | All platforms converge here via `submitOperation` |
| Hook seam | `RepublicAgent.preSubmitHooks()` (`RepublicAgent.ts:601-650`) fires `hookDispatcher.fire('UserPromptSubmit',{user_prompt})`; returns `false` to block | **Already exists (Track 01).** Only joins `text` items (`:608-611`); no expansion |
| Mention backends | `BrowserController.getSnapshot(): Promise<SerializedDOM>` (`core/tools/browser/BrowserController.ts:158`); `ExtensionBrowserController.getSnapshot:282`; `NativeBrowserController.getSnapshot:311`; `DomService` selection via `window.getSelection()` (`extension/tools/dom/DomService.ts:1235,1403,1583`) | Resolution backends per platform |
| Capability gate | `IPlatformAdapter.hasBrowserTools` / `hasRealTabs` (`IPlatformAdapter.ts:61-62`); `ServerPlatformAdapter` `hasRealTabs=false`, `hasBrowserTools` **dynamic** (`ServerPlatformAdapter.ts:19,26`) | The correct gate for `@page`/`@tab` — not `__BUILD_MODE__` |

### Per-Platform Behavior

The funnel is **one core module**; what differs per platform is the *input source* and which *mention vocabulary resolves*. Gating is by `IPlatformAdapter` capability flags, **not** `__BUILD_MODE__` (refinement vs first draft — see Divergence 6), because `ServerPlatformAdapter.hasBrowserTools` flips to `true` at runtime when a browser is attached (`ServerPlatformAdapter.ts:26`); a build-mode compare would wrongly deny `@page` to a server that *does* have a browser.

- **BrowserX (extension).** Source: `webfront/MessageInput.svelte`. Full mention vocabulary — `@tab`/`@page`/`@selection` always resolve (`ExtensionBrowserController`, real tabs, `DomService` selection). Screenshot paste via the web `paste` event. `!` shell escape **disabled** (no shell). The ad-hoc `/` handling here is what Phase 1 relocates.
- **Apple Pi (desktop, Tauri).** Source: the **same** `webfront/MessageInput.svelte` (shared `webfront/`). `@page`/`@tab` resolve via `NativeBrowserController.getSnapshot` (`NativeBrowserController.ts:311`); `@selection` via the embedded webview. Screenshot paste via the same web clipboard path. `!` shell escape **enabled** (desktop has a shell). Because the component is shared, deleting the ad-hoc layer fixes extension *and* desktop in one move.
- **Apple Pi Server (headless).** **No Svelte.** Three input sources, all already converging on `submitOperation`: WS chat handler, connector bridges (`connector-bridge.ts:228` — Slack/Telegram/etc. plain text), and the scheduler (`ServerAgentBootstrap.ts:638`). The funnel runs in core so all three finally get normalization, slash-safety, and `@url`/`!` expansion they have *never* had. Mention degradation: `@page`/`@tab`/`@selection` resolve **only if `hasBrowserTools===true`** (a browser was attached); otherwise the funnel emits a `systemNote` ("@page unavailable — no browser attached to this server session") and drops the mention rather than erroring. `@url <addr>` (fetch/scrape) and `!` shell escape are **always available** server-side (server has exec via `registerExecHandlers`). No clipboard, so no paste capture — but `image` InputItems arriving over the wire from a connector still get disk-backed (Track 09). The bridge-safe slash gate (claudy `:428-453`) is **most important here**: connector input must not leak raw `/config` to the model.

### Key design decisions (and divergences from claudy)

1. **The funnel lives in core, not the Svelte UI, and not as a port of claudy's React layer.** Introduce `core/input/processUserInput.ts` operating on protocol `InputItem[]`, invoked in `RepublicAgent.handleSubmission` for `UserInput`/`UserTurn` **immediately before `preSubmitHooks()`**. One placement serves extension, desktop, *and* all three server input sources. `MessageInput.svelte`'s in-component `/` handling is deleted in favor of routing through it (fixes ext + desktop together).
2. **Reuse the existing `UserPromptSubmit` hook — do not re-implement `executeUserPromptSubmitHooks`.** Claudy runs hooks *inside* `processUserInput`; browserx already runs them in `preSubmitHooks()` (`RepublicAgent.ts:613-628`). The funnel runs *before* it and enriches `op.items`; the hook sees expanded text. **Divergence:** fold claudy's blocking/`additionalContexts`/truncation semantics (`processUserInput.ts:194-262`) into `preSubmitHooks` (truncation `MAX=10000`, blocking erases input, `additionalContexts` → a `context` InputItem) rather than duplicating.
3. **Uniform envelope = enriched `InputItem[]` + control flags.** browserx analog of `ProcessUserInputBaseResult`:
   ```ts
   type ProcessedInput = {
     items: InputItem[]            // enriched: mentions→context, screenshot→image, paste→context(path)
     shouldQuery: boolean          // false ⇒ command/handled, don't run a turn
     nextInput?: string            // command chaining
     systemNote?: string           // e.g. "@page unavailable — no browser attached" / "/x unavailable over remote"
   }
   ```
   `systemNote` is the **graceful-degradation channel** that makes one funnel safe across platforms with different capabilities.
4. **Browser-native mention vocabulary**, resolving through existing services into `context` InputItems (model-visible, separate from the user's `text` item — mirrors claudy's separate `AttachmentMessage`), each guarded by an `IPlatformAdapter` capability check:
   - `@tab` / `@tab:<id>` → `BrowserController.getSnapshot()` (requires `hasRealTabs`)
   - `@page` → current snapshot (requires `hasBrowserTools`)
   - `@selection` → `DomService` `window.getSelection()` (requires `hasBrowserTools`)
   - `@url <addr>` → fetch/scrape → `context` (**capability-independent — works headless**)
   Parser modeled on claudy's `parseAtMentionedFileLines` regex (`attachments.ts:1905`), adapted to browser nouns. Unmet capability ⇒ `systemNote`, mention dropped, turn proceeds.
5. **Screenshot paste = disk-backed, reusing Track 09.** The web clipboard delivers an `image` to the UI (ext + desktop); the funnel stores it via the Track 09 artifact path and replaces it with `context{path}` + a small `image` reference, as claudy's `storeImages` does (`processUserInput.ts:360-362`). **Divergence:** browserx has no terminal `pastedContents` map — capture is the web `paste` event in `MessageInput.svelte` (server has none); the funnel's job is disk-backing + metadata, not capture.
6. **`!` shell escape and `@page` gate on capability, not `__BUILD_MODE__`.** Mirrors claudy's `processBashCommand` mode but gates on `IPlatformAdapter.hasBrowserTools` / a `canExec` capability. **Divergence vs first draft:** the original said "gate on `__BUILD_MODE__`"; that is wrong for server, whose browser capability is *dynamic* (`ServerPlatformAdapter.ts:26`). Capability flags are the correct, runtime-accurate gate.

## Implementation Plan (file-level, ordered)

Safety net: `webfront/components/__tests__/MessageInput.test.ts` + `CommandRegistry` tests. Phase 1 must be strictly behavior-preserving.

**Phase 1 (P0) — relocate, no new affordances.**
- New `core/input/processUserInput.ts` exporting `processUserInput(items, ctx): ProcessedInput`; `ProcessedInput` type in `core/input/types.ts`.
- Call it in `RepublicAgent.handleSubmission` for `UserInput`/`UserTurn` **immediately before** `preSubmitHooks()` (`RepublicAgent.ts:596-650`). Guard against double-funnelling remote/bridge ops (idempotent marker on the op).
- Delete ad-hoc `/` handling from `MessageInput.svelte:204-218,262-279,293-314`; route slash through the funnel (`parseCommandInput` becomes a funnel stage). This fixes extension + desktop simultaneously (shared component).
- Server: no code change needed at the source — WS/connector/scheduler ops already hit `submitOperation`; they now get the funnel for free. Add the bridge-safe slash gate (claudy `:428-453`) keyed on the op's channel origin (connector/remote ⇒ filter).

**Phase 2 (P0) — image/paste.**
- Screenshot/large-paste capture in `MessageInput.svelte` (ext + desktop) → funnel disk-backs via Track 09 store → `context{path}` + small `image` ref; large text paste → `[Pasted #N]` collapse to `context`.
- Server: wire-delivered `image` InputItems (connector) disk-backed by the same funnel stage; no capture path.

**Phase 3 (P0) — mentions.**
- `@tab`/`@page`/`@selection`/`@url` parser in `core/input/mentions.ts`; resolve via `BrowserController.getSnapshot`/`DomService`, each preceded by an `IPlatformAdapter` capability check; unmet ⇒ `systemNote`. Verified backends: `ExtensionBrowserController:282`, `NativeBrowserController:311`, `DomService:1235,1403,1583`.

**Phase 4 (P1) — escape + hook semantics + chaining.**
- `!` shell escape (capability-gated: desktop + server) → structured `text` marker the exec path recognizes.
- Fold claudy truncation/blocking/`additionalContexts` into `preSubmitHooks`.
- `nextInput` command chaining.

## Dependencies

- **Track 01** (Hooks/Events): reuses the existing `UserPromptSubmit` `HookDispatcher` seam — do not duplicate.
- **Track 03** (Commands): slash dispatch routes through the funnel; `parseCommandInput` becomes a funnel stage.
- **Track 09** (Tool Result Persistence): disk-backing for pasted screenshots / large pastes / wire images reuses its storage path.
- **Track 16** (Telemetry): claudy emits `user_prompt` OTEL + keyword events from `processTextPrompt` — wire equivalently once Track 16 lands.
- **Track 21** (Remote Bridge): the bridge-safe slash gate protects connector/relay input — same `systemNote` mechanism.

## Risks

- Mention resolution is expensive (`@page` = full `SerializedDOM`) → resolve lazily, cache per submission, cap size (reuse Track 09 thresholds).
- Screenshot privacy → never auto-upload; disk-local only; redact on telemetry (Track 16).
- Layer regression → Phase 1 is a strict behavior-preserving move; the shared-component nature means a bug hits ext + desktop at once — lean on `MessageInput.test.ts`.
- Double-hook / double-funnel → funnel must run **once**, before `preSubmitHooks`; connector/scheduler ops also build `UserInput` — mark funnelled ops idempotent.
- Server with no browser → `@page`/`@tab` must degrade via `systemNote`, never throw and abort a scheduled/connector job.

## Validation Notes (verified vs claudy + browserx source, 2026-05-14 / multi-platform pass 2026-05-15)

- claudy: `utils/processUserInput/processUserInput.ts:64-83,85-270,194-262,281-589,351-420,428-453,516-588`; `processTextPrompt.ts:19-100`; `utils/attachments.ts:295,335,440,1905,1952`.
- browserx core: `webfront/components/MessageInput.svelte:204-218,262-279,293-314`; `webfront/pages/chat/Main.svelte` (shared ext+desktop host); `webfront/commands/CommandRegistry.ts:134`; `core/protocol/types.ts:31-52,338-357`; `core/RepublicAgent.ts:507-510,596-650`; `core/tools/browser/BrowserController.ts:158`; `extension/tools/browser/ExtensionBrowserController.ts:282`; `desktop/tools/browser/NativeBrowserController.ts:311`; `extension/tools/dom/DomService.ts:1235,1403,1583`.
- browserx platforms: `core/platform/IPlatformAdapter.ts:60-62`; `src/server/platform/ServerPlatformAdapter.ts:19,26` (`hasRealTabs=false`, dynamic `hasBrowserTools`); `src/server/agent/ServerAgentBootstrap.ts:428-441` (WS chat), `:638-644` (scheduler input op); `src/server/channel-connectors/connector-bridge.ts:228` (connector `UserInput` op).

Corrections vs the first-pass draft:
1. browserx **already has** the `UserPromptSubmit` hook (`RepublicAgent.preSubmitHooks`); the funnel reuses it, not a parallel hook.
2. Output is not a new content-block type — `InputItem` already has `context`/`image`; the design targets those.
3. The wrong-layer bug is in `MessageInput.svelte`; Phase 1 is *relocation*, not greenfield.
4. `@tab` generalizes the existing `UserTurn.tabId` binding, not new ground.
5. **Multi-platform (2026-05-15):** `MessageInput.svelte` is shared by extension *and* desktop (one fix covers both); Apple Pi Server has *no* Svelte — input is WS/connector/scheduler ops that have had zero processing; the core-funnel placement is what finally covers them.
6. **Gate refinement (2026-05-15):** `@page`/`@tab`/`!` gate on `IPlatformAdapter` capability flags, **not** `__BUILD_MODE__` — `ServerPlatformAdapter.hasBrowserTools` is runtime-dynamic; build-mode gating would misclassify a server with an attached browser. Unmet capability → `systemNote`, graceful drop.
