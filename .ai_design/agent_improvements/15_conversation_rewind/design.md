# Track 15: Conversation Rewind & Fork

**Priority: P1** · **Effort: S–M** (fork substrate already exists) · **Status: READY TO IMPLEMENT**

> Source: second-pass claudy↔browserx research (2026-05-14), implementation-readiness + multi-platform pass (2026-05-15). Grounded in a full read of claudy's rewind flow and browserx's rollout layer across all three deploy targets — see "Validation Notes". **Effort S–M:** the forked-session substrate is already implemented and wired; net-new work is the slice function + a trigger surface per platform + `summarize_up_to`.

## Problem

When an agent run goes wrong there is no user-facing way to rewind to a prior turn and continue from there. The capability is *partially scaffolded but unreachable*: browserx has a working `forked` session mode, but nothing computes the slice point, and there is no command, UI, or API to invoke it. On Apple Pi Server this is a missed operational lever: a failed unattended scheduled job cannot be resumed from its last good checkpoint — it can only be re-run from scratch.

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

`getRestoreOptions(canRestoreCode)` (`:93`) shows `code`/`both` only when file backups exist. `onSelectRestoreOption()` (`:177-243`): `nevermind` aborts; `summarize`/`summarize_up_to` pass `direction:'up_to'|'from'` to a summarizer (`:195`); `code`/`both` call file restore (`:216`); `conversation`/`both` truncate the conversation to the chosen `UserMessage` (`:224`). The two axes (conversation, code) are **independent**.

### Code axis — `utils/fileHistory.ts` (1116 lines)

`FileHistorySnapshot` (`:39`) / `FileHistoryState` (`:45`); the file-history state-machine (`updateFileHistoryState` `:87`, `recordFileHistorySnapshot` from `sessionStorage.js` `:29`) backs up modified files per turn and rolls them back, gating the `code` option. **Filesystem-specific and explicitly deferred (Divergence 6, P3 desktop-only) — exact entry-point names not pinned since this axis is out of v1 scope.**

## BrowserX Mapping

### The real seam — the fork substrate already exists

| Concern | BrowserX location | State |
|---|---|---|
| History modes | `InitialHistory = {mode:'new'} \| {mode:'resumed',…} \| {mode:'forked',rolloutItems,sourceConversationId}` (`core/session/state/types.ts:177-194`) | **`forked` already defined** + `isForkedHistory` guard |
| Fork execution | `Session.ts:248-254` — `mode:'new'\|'forked'` creates a **new rollout**, forked branch (`:252-254`) then `persistRolloutResponseItems` (`:2179`); second forked path `:2562-2568` | **Already wired**: fork = new conversation seeded with items, source untouched |
| Storage model | `RolloutWriter.addItems` (append-only, `:49-69`); `RolloutItem` union w/ `sequence` (`types.ts:162-182`) | Append-only; no per-suffix delete |
| Provider (interface) | `RolloutStorageProvider` (`provider/RolloutStorageProvider.ts:24-49`): `getItemsByRolloutId`, `getLastSequenceNumber`, `deleteItemsByRolloutIds` (whole-rollout) | No "delete items above N" — confirms **fork-not-truncate** |
| Provider (per platform) | ext `IndexedDBRolloutStorageProvider:235`; desktop `TauriRolloutStorageProvider:116`; server `TSRolloutStorageProvider:236` | Slice fn touches only the interface — platform-agnostic |
| Read history | `RolloutRecorder.getItemsByRolloutId` / resume (`RolloutRecorder.ts:174-196`) | Source for the slice |
| Listing/UI data | `RolloutRecorder.listConversations` → `ConversationItem{head,tail,itemCount}` (`types.ts:202-219`) | Drives selector / server turn-list |
| TTL cleanup | `RolloutRecorder.cleanupExpired()` via `StorageQuotaManager.ts:183,370`; `rolloutTTL` default 60d (`config/defaults.ts:31`) | Per-provider; controls fork proliferation |
| Server trigger seam | `registerSessionHandlers` (`ServerAgentBootstrap.ts:443-473`) → `src/server/handlers/sessions.ts` (`listSessions`/`resetSession`/`compactSession`) | **No rewind handler today** — add one |

### Per-Platform Behavior

The slice + fork is **pure core**, storage-provider-agnostic by construction (it calls only `RolloutStorageProvider.getItemsByRolloutId` + the existing `forked` `InitialHistory` path). It therefore behaves identically on all three providers. What differs per platform is the **trigger surface** and the **operational value**:

- **BrowserX (extension)** & **Apple Pi (desktop).** Trigger: shared `webfront` `/rewind` (`/checkpoint`) Track 03 command → `MessageSelector.svelte` (turn list → `conversation` / `summarize_up_to` / `nevermind`). Provider: `IndexedDBRolloutStorageProvider` (ext) / `TauriRolloutStorageProvider` (desktop). Human-driven recovery from a bad turn. One component serves both (shared `webfront`).
- **Apple Pi Server (headless).** **No selector UI.** Trigger is a new WS/HTTP session handler `rewindSession(key, targetSequence)` (sibling of `compactSession`), registered in `ServerAgentBootstrap.registerSessionHandlers`. The "selector" is the remote operator client rendering the turn list returned by the existing `listConversations`/`SessionIndex`; the client posts the chosen `targetSequence` back. Provider: `TSRolloutStorageProvider`. **Net-new operational value (the headless win):** the scheduler/`JobExecutor` can call the *same* core slice fn programmatically to **resume a failed unattended job from its last successful checkpoint** instead of re-running from zero — directly composes with Track 12 (a job that hard-failed mid-run after a rate-limit cascade restarts from the last good turn, not the beginning). Expose this both as an operator action and a scheduler-internal capability.

### Key design decisions (and divergences from claudy)

1. **Reuse the existing `forked` mechanism — do not add a truncate primitive.** Net-new core work is one slice function:
   ```
   rewindToMessage(sourceConversationId, targetSequence) →
     items = provider.getItemsByRolloutId(sourceConversationId)
     slice = items.filter(i => i.sequence <= targetSequence)
     return Session(InitialHistory{ mode:'forked', rolloutItems: slice, sourceConversationId })
   ```
   `Session.ts:248-256` already turns that into a new rollout with the source intact — the project's "never destroy by default" stance for free. **Divergence from claudy:** claudy truncates the in-memory message list; browserx forks at the storage layer because its rollout is append-only and the forked path already exists.
2. **`targetSequence` from a selected user turn.** Map the chosen user-message turn to its `RolloutItem.sequence`; slice is `sequence <= target`.
3. **`/rewind` command = thin trigger (mirror claudy exactly) for ext/desktop; a session handler for server.** Track 03 `local` command (aliases `/checkpoint`) that opens the selector and returns "skip". Server gets the equivalent as `rewindSession` RPC, not a command.
4. **Selector is a Svelte component, not Ink — and server has none.** `MessageSelector.svelte` (ext + desktop): list user turns, pick one, choose a `RestoreOption`. **Divergence:** start minimal — `conversation` / `summarize_up_to` / `nevermind`. Server: the turn list + chosen option travel over the WS protocol; no UI component server-side.
5. **`summarize_up_to` reuses Track 05/05b compaction.** Compact the pre-cut segment (direction `up_to`) and seed the fork with `[compacted_item, ...slice-after-cut]`. The `RolloutItem` union already has a `compacted` variant (`types.ts:165`) — emit that. Pure reuse, no new storage type. Works on all platforms (compaction is core).
6. **Code/artifact axis = desktop-only, P3, optional; server side-effects explicitly out of scope.** Browser DOM/page state is **not** snapshottable (claudy's `fileHistory` assumes a filesystem). The only browserx analog is desktop file edits / downloads — per-turn snapshot keyed to `RolloutItem.sequence`, deferred P3. On Apple Pi Server the analog (exec'd shell side effects, written files) is *also* non-rewindable and arguably more dangerous — rewind restores the *conversation*, never the side effects; the server `rewindSession` response must state this explicitly so an operator does not assume filesystem rollback.

## Implementation Plan (file-level, ordered)

Safety net: `storage/rollout/__tests__` real rollout fixtures.

**Phase 1 (P1, S) — core slice fn.**
- New `core/session/rewind.ts`: `rewindToMessage(sourceConversationId, targetSequence): Promise<InitialHistory>` using `RolloutStorageProvider.getItemsByRolloutId` + `sequence<=target` filter → `{mode:'forked',...}`. No new storage primitive.
- Unit-test against `RolloutRecorder` with fixtures from `storage/rollout/__tests__`; assert source rollout untouched and slice boundary lands on a user-turn.

**Phase 2 (P1, S–M) — trigger surfaces.**
- ext/desktop: Track 03 `local` command `/rewind` (`/checkpoint`) → `openMessageSelector`; `webfront/components/MessageSelector.svelte` (turn list from `listConversations`; options `conversation`/`nevermind`). Routed through the Track 13 funnel like any command.
- server: add `rewindSession(key, targetSequence)` to `SessionHandlersDeps` (`src/server/handlers/sessions.ts`) + register in `ServerAgentBootstrap.registerSessionHandlers` (`:443-473`), mirroring `compactSession`'s shape (`:462-472`): look up the session in the registry, build the forked `InitialHistory` via `core/session/rewind.ts`, re-seat the agent. Return a result that names the new forked conversation id and explicitly notes side effects are *not* rewound.

**Phase 3 (P1, S) — summarize_up_to.**
- Wire `summarize_up_to` to Track 05/05b: compact pre-cut segment → emit a single `compacted` `RolloutItem` (`types.ts:165`) seeded into the fork (consistent with Track 05b's prompt-cache interlock). Available on all three triggers.

**Phase 4 (P3, optional) — desktop file snapshots.**
- Desktop-only per-turn file-backup keyed to `RolloutItem.sequence` + `code`/`both` options. No DOM, no server exec rollback.

**Cross-cutting — fork proliferation.**
- Verify `StorageQuotaManager` (which calls `RolloutRecorder.cleanupExpired()`, `:183,370`) actually runs on Apple Pi Server (server schedules the Track 09 tool-result sweep via `schedulePeriodicSweep` but rollout-TTL cleanup wiring must be confirmed, not assumed). Use `sourceConversationId` (already in the type) as the "forked from" link for pruning/UX.

## Dependencies

- **Existing forked-session substrate** (`Session.ts:248-254,2562-2568`; `InitialHistory` `types.ts:177-194`) — hard reuse.
- **Track 03** (Commands): `/rewind`/`/checkpoint` `local` command + selector open hook (ext/desktop only).
- **Track 05 / 05b** (Memory/Compaction): `summarize_up_to`.
- **Track 12** (Rate-Limit): the headless win — resume a failed unattended job from last checkpoint via the same slice fn.
- **Track 14** (Plan Review): a rejected plan = rewind to the turn before `BeginPlan` (special case).
- **Track 13** (Input Pipeline): selector opened via the command path that routes through the funnel.

## Risks

- Slice correctness: `RolloutItem.sequence` ordering must map cleanly to user-turn boundaries — pin with tests using real fixtures.
- Fork proliferation: every rewind makes a new rollout — rely on per-provider `cleanupExpired` + `rolloutTTL` (60d default); **confirm `StorageQuotaManager` runs on the server** (open wiring question, not an assertion).
- `summarize_up_to` must not corrupt prompt-cache stability — single `compacted` item, consistent with Track 05b.
- Side-effect illusion: rewind restores conversation only. The server `rewindSession` response and any UI must state that exec'd commands / file writes / sent connector messages are **not** undone — otherwise an operator assumes a full rollback that did not happen.
- Selector UX scope creep: ship `conversation`/`nevermind` first; `code`/`both` is P3 desktop-only.

## Validation Notes (verified vs claudy + browserx source, 2026-05-14 / multi-platform pass 2026-05-15)

- claudy: `commands/rewind/rewind.ts:8-12` (`openMessageSelector`, `type:'skip'`), `commands/rewind/index.ts:6,8` (`aliases:['checkpoint']`, `type:'local'`); `components/MessageSelector.tsx:31` (`RestoreOption` union — exact), `:93` (`getRestoreOptions`), `:123` (`summarize_up_to`), `:177` (`onSelectRestoreOption`), `:195` (`direction 'up_to'\|'from'`) — all verified exact; `utils/fileHistory.ts:39,45` (types) + state-machine (deferred P3, names unpinned).
- browserx core: `core/session/state/types.ts:177-194`; `core/Session.ts:248-254,2562-2568`; `storage/rollout/RolloutWriter.ts:49-69`; `storage/rollout/types.ts:162-182,202-219,309-331`; `storage/rollout/provider/RolloutStorageProvider.ts:24-49`; `storage/rollout/RolloutRecorder.ts:109-196`; `storage/StorageQuotaManager.ts:183,370`; `config/defaults.ts:31`.
- browserx platforms: ext `storage/rollout/provider/IndexedDBRolloutStorageProvider.ts:235`; desktop `storage/rollout/provider/TauriRolloutStorageProvider.ts:116`; server `storage/rollout/provider/TSRolloutStorageProvider.ts:236`, `src/server/handlers/sessions.ts:18-23,96,122`, `src/server/agent/ServerAgentBootstrap.ts:443-473` (`registerSessionHandlers`, `compactSession` shape `:462-472`).

Corrections vs the first-pass draft:
1. browserx **already implements and wires** a `forked` `InitialHistory` mode — the work is the slice fn + trigger surfaces, not building fork. Effort M → S–M.
2. The provider has **no per-suffix delete** — fork-from-slice is the only viable model, and it is the one already scaffolded.
3. `summarize_up_to` maps onto the existing `compacted` `RolloutItem` variant — pure Track 05b reuse.
4. Code/DOM restore confirmed desktop-file-only, P3 — DOM not snapshottable.
5. **Multi-platform (2026-05-15):** the slice/fork is provider-agnostic core (same on `IndexedDB`/`Tauri`/`TS` providers); only the *trigger* differs — shared `webfront` selector for ext+desktop vs a new `rewindSession` WS handler for the server. The headless-specific value (resume a failed scheduled job from last checkpoint, composing with Track 12) is net-new and is the strongest reason this track matters for Apple Pi Server.
