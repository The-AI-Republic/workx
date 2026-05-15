# Track 15: Conversation Rewind & Fork

**Priority: P1** · **Effort: S–M** (revised down — fork substrate already exists) · **Status: NOT STARTED**

> Source: second-pass claudy↔browserx research (2026-05-14). Grounded in a full read of claudy's rewind flow and browserx's rollout layer — see "Validation Notes". **Effort revised from M to S–M:** the forked-session substrate is already implemented and wired in browserx; the net-new work is the slice function + selector UI + `summarize_up_to`.

## Problem

When an agent run goes wrong there is no user-facing way to rewind to a prior turn and continue from there. The capability is *partially scaffolded but unreachable*: browserx has a working `forked` session mode, but nothing computes the slice point, and there is no command or UI to invoke it.

> claudy's `thinkback`/`thinkback-play` is a "Year in Review" **marketing animation, not rewind** — disregard. The real feature is `/rewind`.

## What Claudy Does

### Trigger — `commands/rewind/`

`/rewind` (alias `/checkpoint`) is a **15-line `local` command** (`rewind.ts`) that does exactly one thing:

```ts
export async function call(_args, context): Promise<LocalCommandResult> {
  if (context.openMessageSelector) context.openMessageSelector()
  return { type: 'skip' }   // appends no messages
}
```

All logic lives in the UI component.

### Selector — `components/MessageSelector.tsx`

```ts
type RestoreOption = 'both' | 'conversation' | 'code' | 'summarize' | 'summarize_up_to' | 'nevermind'
```

`getRestoreOptions(canRestoreCode)` (`:93`) shows `code`/`both` only when file backups exist for the chosen message. `onSelectRestoreOption()` (`:177-243`): `nevermind` aborts; `summarize`/`summarize_up_to` pass a `direction: 'up_to' | 'from'` to a summarizer (`:195`); `code`/`both` call file restore (`:216`); `conversation`/`both` truncate the conversation to the chosen `UserMessage` (`:224`). The two axes (conversation, code) are **independent**.

### Code axis — `utils/fileHistory.ts` (1116 lines)

`FileHistorySnapshot { trackedFileBackups: Record<path, FileHistoryBackup> }`, `FileHistoryState { snapshots, snapshotSequence }` (`:33-55`). `fileHistoryMakeSnapshot()` (`:198`) backs up modified files per turn; `fileHistoryRewind()` (`:347`) rolls the filesystem back; `fileHistoryCanRestore()` (`:399`) gates the `code` option. **Filesystem-specific — see divergence.**

## BrowserX Mapping

### The real seam — the fork substrate already exists

| Concern | BrowserX location | State |
|---|---|---|
| History modes | `InitialHistory = {mode:'new'} \| {mode:'resumed',sessionId,rolloutItems} \| {mode:'forked',rolloutItems,sourceConversationId}` (`core/session/state/types.ts:177-194`) | **`forked` already defined** + `isForkedHistory` guard |
| Fork execution | `Session.ts:248-256` — for `mode:'forked'`, creates a **new rollout** then `persistRolloutResponseItems(history)`; also `Session.ts:2558-2562` | **Already wired**: fork = new conversation seeded with provided items, source untouched |
| Storage model | `RolloutWriter.addItems` (append-only, `RolloutWriter.ts:49-69`); items are `RolloutItem` discriminated union w/ `sequence` (`types.ts:162-182`) | Append-only; no per-suffix delete |
| Provider | `RolloutStorageProvider` (`provider/RolloutStorageProvider.ts:24-49`): `getItemsByRolloutId`, `getLastSequenceNumber`, `deleteItemsByRolloutIds` (whole-rollout), `deleteMetadata` | No "delete items above sequence N" — confirms **fork-not-truncate** is the right (and intended) model |
| Read history | `RolloutRecorder.getItemsByRolloutId` / resume path (`RolloutRecorder.ts:174-196`) | Source for the slice |
| Listing/UI data | `RolloutRecorder.listConversations` → `ConversationItem{head,tail,itemCount}` (`types.ts:202-219`) | |

### Key design decisions (and divergences from claudy)

1. **Reuse the existing `forked` mechanism — do not add a truncate primitive.** The net-new core work is a single slice function:
   ```
   rewindToMessage(sourceConversationId, targetSequence) →
     items = provider.getItemsByRolloutId(sourceConversationId)
     slice = items.filter(i => i.sequence <= targetSequence)        // keep up to the chosen user turn
     return Session(InitialHistory{ mode:'forked', rolloutItems: slice, sourceConversationId })
   ```
   `Session.ts:248-256` already turns that into a new rollout with the source intact. **This is the project's "never destroy by default" stance for free** — fork is non-destructive by construction; no hard-truncate path is needed in v1. **Divergence from claudy:** claudy truncates the in-memory message list; browserx forks at the storage layer because its rollout is append-only and the forked path already exists.

2. **`targetSequence` from a selected user turn.** The selector lists prior user-message turns; map the chosen turn to its `RolloutItem.sequence` (the `response_item` payloads carry the conversation). Slice is `sequence <= target`.

3. **`/rewind` command = thin trigger (mirror claudy exactly).** A Track 03 `local` command that opens a selector and returns "skip" (no message appended). Aliases `/checkpoint`.

4. **Selector is a Svelte component, not Ink.** `MessageSelector.svelte`: list user turns (from `RolloutRecorder.listConversations`/history), pick one, choose a `RestoreOption`. **Divergence:** start with the minimal set — `conversation` (fork at slice) / `summarize_up_to` / `nevermind`. Add `code`/`both` only with Phase 4.

5. **`summarize_up_to` reuses Track 05/05b compaction.** Instead of discarding the pre-cut segment, compact it (direction `up_to`) and seed the fork with `[compacted_item, ...slice-after-cut]`. The `RolloutItem` union already has a `compacted` variant (`types.ts:165`) — emit that. Pure reuse, no new storage type.

6. **Code/artifact axis = desktop-only, P3, optional.** Browser DOM/page state is **not** snapshottable (claudy's `fileHistory` assumes a filesystem). The only browserx analog is desktop file edits / downloads — a per-turn snapshot keyed to `RolloutItem.sequence`. Defer (P3). DOM rollback is explicitly out of scope. (First-pass draft already flagged this correctly.)

### Phase plan

- **Phase 1 (P1, S):** `rewindToMessage(sourceConversationId, targetSequence)` slice function on top of the existing `forked` `InitialHistory` path; unit-test against `RolloutRecorder`.
- **Phase 2 (P1, S–M):** `/rewind` (`/checkpoint`) command + `MessageSelector.svelte` (turn list → `conversation` / `nevermind`).
- **Phase 3 (P1, S):** `summarize_up_to` via Track 05/05b → `compacted` `RolloutItem` seeded into the fork.
- **Phase 4 (P3, optional):** desktop file-snapshot per turn + `code`/`both` restore options (no DOM).

## Dependencies

- **Existing forked-session substrate** (`Session.ts:248-256, 2558-2562`; `InitialHistory` `types.ts:177-194`) — hard reuse, not a dependency to build
- **Track 03** (Commands): `/rewind` / `/checkpoint` `local` command + selector open hook
- **Track 05 / 05b** (Memory/Compaction): `summarize_up_to`
- **Track 14** (Plan Mode): a rejected plan = rewind to the pre-plan turn (special case)
- **Track 13** (Input Pipeline): selector opened via the command path that routes through the funnel

## Risks

- Slice correctness: `RolloutItem.sequence` ordering must map cleanly to user-turn boundaries — pin with tests using real rollout fixtures (`storage/rollout/__tests__`).
- Fork proliferation: every rewind makes a new rollout — rely on the existing rollout TTL/`cleanupExpired` (`RolloutStorageProvider.cleanupExpired`, `RolloutStorageConfig.rolloutTTL`); add a "forked from" link via `sourceConversationId` (already in the type) for pruning/UX.
- `summarize_up_to` must not corrupt prompt-cache stability — emit a single `compacted` item, consistent with Track 05b's interlock.
- Selector UX scope creep: ship `conversation`/`nevermind` first; `code`/`both` is P3 and desktop-only.

## Validation Notes (verified vs claudy + browserx source, 2026-05-14)

- claudy: `commands/rewind/rewind.ts` (15-line trigger → `openMessageSelector`), `commands/rewind/index.ts` (aliases `checkpoint`, `type:'local'`); `components/MessageSelector.tsx:31` (`RestoreOption` union), `:93-130` (`getRestoreOptions`, code gated on backups), `:177-243` (`onSelectRestoreOption` — summarize direction, code/conversation branches); `utils/fileHistory.ts:33-55` (`FileHistorySnapshot`/`State`), `:198` (`fileHistoryMakeSnapshot`), `:347` (`fileHistoryRewind`), `:399` (`fileHistoryCanRestore`).
- browserx: `core/session/state/types.ts:177-194` (`InitialHistory` incl. **`forked`** + `isForkedHistory`); `core/Session.ts:248-256` (forked → new rollout + `persistRolloutResponseItems`), `:2558-2562` (forked persistence); `storage/rollout/RolloutWriter.ts:49-69` (append-only `addItems`); `storage/rollout/types.ts:162-182` (`RolloutItem` union incl. `compacted`, `sequence`); `storage/rollout/provider/RolloutStorageProvider.ts:24-49` (provider — `getItemsByRolloutId`, `deleteItemsByRolloutIds` whole-rollout only); `storage/rollout/RolloutRecorder.ts:109-196` (create/resume).

Corrections vs the first-pass draft:
1. The draft said "add a truncate/fork operation … default to fork." Reading the source shows browserx **already implements and wires a `forked` `InitialHistory` mode** (`Session.ts:248-256`). The work is *not* building fork — it is the slice function + selector + command on top of it. Effort revised **M → S–M**; the draft over-scoped it.
2. Confirmed the provider has **no per-suffix delete** (`deleteItemsByRolloutIds` is whole-rollout) — so fork-from-slice is not just preferable, it is the only viable model, and it is the one already scaffolded.
3. `summarize_up_to` maps onto the existing `compacted` `RolloutItem` variant (`types.ts:165`) — no new storage type, pure Track 05b reuse.
4. Code/DOM restore confirmed desktop-file-only, P3 — DOM is not snapshottable; claudy's `fileHistory` is filesystem-coupled.
