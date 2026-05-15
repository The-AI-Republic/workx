# Track 13: Input Pipeline & Browser-Native Mentions

**Priority: P0** · **Effort: L** · **Status: NOT STARTED**

> Source: second-pass claudy↔browserx research (2026-05-14). Grounded in a full read of claudy's input funnel and browserx's submission seam — see "Validation Notes" for exact `file:line` citations. This is the spine other input/UX work (Track 24.1 command ranking, screenshot paste, mentions) hangs off.

## Problem

BrowserX has **no input processing/expansion layer**. A user message travels: `MessageInput.svelte` → `onSubmit(value: string)` (raw string) → UI client builds a `UserInput`/`UserTurn` `Op` with `items: InputItem[]` → `RepublicAgent` → `preSubmitHooks()` → engine. Nothing between the keystroke and the model:

- normalizes/expands input (no `@`-mention, no `!` shell escape, no large-paste collapse, no argument expansion)
- captures pasted screenshots (the web clipboard `image` is dropped)
- produces a uniform result envelope (every call site special-cases raw strings)

Worse, the only "parsing" that exists is **ad hoc in the Svelte component**: `MessageInput.svelte` hand-detects a leading `/` in `handleKeyDown`/`handleButtonClick`/`handlePaste` and calls a client-side `commandRegistry` action directly (`MessageInput.svelte:204-218, 262-279, 293-314`). This is the exact "mention UX accretes ad hoc" failure mode — it must be replaced by a real funnel *before* more input affordances are added.

## What Claudy Does

### The funnel — `utils/processUserInput/processUserInput.ts`

`processUserInput()` (`:85-270`) is the single public entry. It calls `processUserInputBase()`, then runs `executeUserPromptSubmitHooks()` (`:182-263`) with: output truncation (`MAX_HOOK_OUTPUT_LENGTH = 10000`, `applyTruncation` `:274-279`), blocking-error short-circuit that **erases the original input** (`:194-209`), `preventContinuation` (`:213-224`), and `additionalContexts` folded in as `createAttachmentMessage` (`:231-240`).

`processUserInputBase()` (`:281-589`) is the funnel, in strict order:

1. **Image normalization** (`:314-345`): `maybeResizeAndDownsampleImageBlock` per image block; trailing text block becomes `inputString`, the rest `precedingInputBlocks`.
2. **Pasted images** (`:351-420`): `storeImages(pastedContents)` writes them to **disk** so the model can reference a path (`:360-362`); parallel resize via `Promise.all`; emits `[Image source: ${sourcePath}]` metadata text.
3. **Bridge-safe slash gate** (`:428-453`): remote/bridge input with `/` is resolved through `isBridgeSafeCommand`; unsafe commands short-circuit with a message instead of leaking raw `/config` to the model.
4. **Keyword routing** (`:467-493`): ultraplan keyword on the *pre-expansion* input.
5. **Attachment extraction** (`:496-514`): gated by `shouldExtractAttachments`, `getAttachmentMessages(inputString, context, ideSelection, [], messages, querySource)` → `toArray`.
6. **Mode dispatch** (`:516-588`): `bash` → `processBashCommand` (`!` → `<bash-input>`); `/` → `processSlashCommand`; else → `processTextPrompt`.

### The uniform envelope — `ProcessUserInputBaseResult` (`:64-83`)

```ts
type ProcessUserInputBaseResult = {
  messages: (UserMessage|AssistantMessage|AttachmentMessage|SystemMessage|ProgressMessage)[]
  shouldQuery: boolean
  allowedTools?: string[]; model?: string; effort?: EffortValue
  resultText?: string          // -p mode result
  nextInput?: string           // chain into another command
  submitNextInput?: boolean
}
```

`processTextPrompt()` (`processTextPrompt.ts:19-100`) builds a `createUserMessage({content, imagePasteIds, permissionMode, isMeta})` (text blocks then image blocks) and returns `{ messages: [userMessage, ...attachmentMessages], shouldQuery: true }` — **mentions/attachments are separate model-visible context messages, not concatenated into the user's text.**

### Mentions — `utils/attachments.ts`

A typed `Attachment` union (`:440`): `FileAttachment` (`:295`), `AgentMentionAttachment` (`:335`), etc. `parseAtMentionedFileLines` (`:1905`) parses `@file:Lstart-Lend`; mentions become `'at-mention'` typed `AttachmentMessage`s (`:1952`) resolved by `getAttachmentMessages`. The user's prompt text is untouched; resolved content rides alongside as context.

## BrowserX Mapping

### The real seams

| Concern | BrowserX location | State |
|---|---|---|
| UI entry | `webfront/components/MessageInput.svelte` `onSubmit(value:string)` | Raw string; ad-hoc `/` handling in the component (wrong layer) |
| Command parse | `parseCommandInput` (`webfront/commands/CommandRegistry.ts:134`) → `{commandName,args}` | Client-side dispatch only (Track 03); strict filter (Track 24.1) |
| Wire content | `InputItem` (`core/protocol/types.ts:338-357`): `text` \| `image{image_url}` \| `clipboard{content?}` \| `context{path?}` | **Output shape already exists** — `context` carries resolved mentions, `image` carries screenshots |
| Submission op | `Op` `UserInput{items}` / `UserTurn{items,tabId,approval_policy,…}` (`types.ts:31-52`) | Items arrive already-formed; nothing enriches them |
| Hook seam | `RepublicAgent.preSubmitHooks()` (`RepublicAgent.ts:601-650`) fires `hookDispatcher.fire('UserPromptSubmit', {user_prompt})`; returns `false` to block | **Already exists (Track 01).** Only joins `text` items (`:608-611`); no expansion |
| Mention backends | `BrowserController.getSnapshot(): Promise<SerializedDOM>` (`core/tools/browser/BrowserController.ts:158`); `ExtensionBrowserController.getSnapshot` `:282`; `NativeBrowserController.getSnapshot` `:311`; `DomService` selection via `window.getSelection()` (`extension/tools/dom/DomService.ts:1235,1403,1583`) | Resolution backends for `@page`/`@selection`/`@tab` exist |

### Key design decisions (and divergences from claudy)

1. **The funnel lives in core, not the Svelte UI, and not as a port of claudy's React layer.** Introduce `core/input/processUserInput.ts` operating on the protocol `InputItem[]`, invoked in `RepublicAgent.handleSubmission` for `UserInput`/`UserTurn` **immediately before `preSubmitHooks()`**. This keeps it shared across extension/desktop/server and feeds the hook seam that already exists. `MessageInput.svelte`'s in-component `/` handling is deleted in favor of routing through it.

2. **Reuse the existing `UserPromptSubmit` hook — do not re-implement `executeUserPromptSubmitHooks`.** Claudy runs hooks *inside* `processUserInput`; browserx already runs them in `preSubmitHooks()` (`RepublicAgent.ts:613-628`). The funnel runs *before* it and enriches `op.items`; the hook then sees the expanded text. **Divergence:** claudy's blocking/`additionalContexts`/truncation semantics (`processUserInput.ts:194-262`) should be folded into `preSubmitHooks` (truncation `MAX=10000`, blocking erases input, `additionalContexts` → a `context` InputItem) rather than duplicated.

3. **Uniform envelope = enriched `InputItem[]` + control flags.** browserx analog of `ProcessUserInputBaseResult`:
   ```ts
   type ProcessedInput = {
     items: InputItem[]            // enriched: mentions→context, screenshot→image, paste→context(path)
     shouldQuery: boolean          // false ⇒ command/handled, don't run a turn
     nextInput?: string            // command chaining
     systemNote?: string           // e.g. "/x unavailable over remote"
   }
   ```
   Adopt this **now**, before more affordances accrete — the explicit lesson from `MessageInput.svelte`'s ad-hoc growth.

4. **Browser-native mention vocabulary**, resolving through existing services into `context` InputItems (model-visible, separate from the user's `text` item — mirrors claudy's separate `AttachmentMessage`):
   - `@tab` / `@tab:<id>` → `BrowserController.getSnapshot()` for that tab (generalizes the existing `UserTurn.tabId` + `TabContext.svelte` single-tab binding to inline, multi-tab refs)
   - `@page` → current tab `SerializedDOM` snapshot
   - `@selection` → `DomService` `window.getSelection()` serialization
   - `@url <addr>` → existing fetch/scrape path → `context`
   Parser modeled on claudy's `parseAtMentionedFileLines` regex (`attachments.ts:1905`), adapted to browser nouns.

5. **Screenshot paste = disk-backed, reusing Track 09.** The web clipboard delivers an `image` to the UI; the funnel stores it via the Track 09 tool-result/artifact persistence path and replaces it with a `context{path}` + small `image` reference, exactly as claudy's `storeImages` does (`processUserInput.ts:360-362`). **Divergence:** browserx has no terminal `pastedContents` map — the capture is the web `paste` event in `MessageInput.svelte`; the funnel's job is disk-backing + metadata, not capture.

6. **`!` shell escape is desktop/server only.** Gate on platform (`__BUILD_MODE__`); the extension has no shell. Mirrors claudy's `processBashCommand` mode but produces a `text` InputItem wrapped in a structured marker the existing exec tool path recognizes.

### Phase plan

- **Phase 1 (P0):** `core/input/processUserInput.ts` skeleton + `ProcessedInput` envelope; route existing `UserInput`/`UserTurn` through it in `RepublicAgent.handleSubmission` *before* `preSubmitHooks`; delete `MessageInput.svelte` ad-hoc `/` handling and route slash through the funnel (behavior-preserving — no new affordances yet).
- **Phase 2 (P0):** screenshot/image paste → Track 09 disk-backed `context{path}` + `image` reference; large-paste collapse (`[Pasted #N]`).
- **Phase 3 (P0):** `@tab` / `@page` / `@selection` mention parser → resolved `context` InputItems via `BrowserController.getSnapshot` / `DomService`.
- **Phase 4 (P1):** `@url` expansion; `!` shell escape (desktop/server); fold claudy's truncation/blocking/`additionalContexts` semantics into `preSubmitHooks`; `nextInput` command chaining.

## Dependencies

- **Track 01** (Hooks/Events): reuses the existing `UserPromptSubmit` `HookDispatcher` seam (`RepublicAgent.preSubmitHooks`) — do not duplicate
- **Track 03** (Commands): slash dispatch routes through the new funnel; `parseCommandInput` becomes a funnel stage, not a UI concern
- **Track 09** (Tool Result Persistence): disk-backing for pasted screenshots / large pastes reuses its storage path
- **Track 16** (Telemetry): claudy emits `user_prompt` OTEL + negative/keep-going keyword events from `processTextPrompt` — wire equivalently once Track 16 lands
- `BrowserController` / `DomService` (existing) for mention resolution

## Risks

- Mention resolution is expensive (`@page` = full `SerializedDOM`) → resolve lazily, cache per submission, cap size (reuse Track 09 thresholds).
- Screenshot privacy → never auto-upload; disk-local only; redact on telemetry (Track 16).
- Layer regression → Phase 1 must be a strict behavior-preserving move of current `/`-handling from `MessageInput.svelte` into the core funnel; existing `webfront/components/__tests__/MessageInput.test.ts` + `CommandRegistry` tests are the safety net.
- Double-hook risk → the funnel must run **once**, before `preSubmitHooks`; ensure remote/bridge inputs (which also build `UserInput` ops) are not funnelled twice.

## Validation Notes (verified vs claudy + browserx source, 2026-05-14)

Both implementations read end-to-end. Citations:

- claudy: `utils/processUserInput/processUserInput.ts:64-83` (`ProcessUserInputBaseResult`), `:85-270` (`processUserInput` + hooks), `:194-262` (blocking/preventContinuation/additionalContexts/truncation), `:281-589` (`processUserInputBase` funnel order), `:351-420` (pasted-image disk store), `:428-453` (bridge-safe slash gate), `:516-588` (mode dispatch); `processTextPrompt.ts:19-100` (envelope construction, separate attachment messages); `utils/attachments.ts:295,335,440,1905,1952` (`Attachment` union, `parseAtMentionedFileLines`, `'at-mention'`).
- browserx: `webfront/components/MessageInput.svelte:204-218,262-279,293-314` (ad-hoc in-component `/` handling — to be removed); `webfront/commands/CommandRegistry.ts:134` (`parseCommandInput`); `core/protocol/types.ts:31-52` (`UserInput`/`UserTurn` Op), `:338-357` (`InputItem` = text|image|clipboard|context); `core/RepublicAgent.ts:507-510,596-650` (`UserInput`/`UserTurn` handling + `preSubmitHooks` firing `UserPromptSubmit`); `core/tools/browser/BrowserController.ts:158` (`getSnapshot`), `extension/tools/browser/ExtensionBrowserController.ts:282`, `desktop/tools/browser/NativeBrowserController.ts:311`, `extension/tools/dom/DomService.ts:1235,1403,1583` (`window.getSelection()`).

Corrections vs the first-pass draft of this doc:
1. The first draft proposed a generic `src/core/input/` with a new `UserPromptSubmit`-style hook point. Reading the source showed browserx **already has** that hook (`RepublicAgent.preSubmitHooks` → `hookDispatcher.fire('UserPromptSubmit')`, delivered by Track 01). The funnel must run *before* it and reuse it — not introduce a parallel hook.
2. The output shape is not a new content-block type — browserx's `InputItem` already has `context` and `image` variants; the design now targets those exactly.
3. Identified the precise wrong-layer bug: parsing currently lives in `MessageInput.svelte` (component), so Phase 1's real work is *relocating* it to core, not greenfield.
4. `@tab` is not new ground — `UserTurn.tabId` + `TabContext.svelte` already bind one tab; mentions generalize this to inline/multi-tab refs through the existing `BrowserController.getSnapshot` contract.
