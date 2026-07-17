# Implementation Spec — Multi-Thread Session Management

Code-level contract for [design.md](./design.md) v5. Symbol names are authoritative; line
numbers are intentionally omitted because main moved while this design branch was open.
Verified against main merged through `a05b1f13` on 2026-07-16.

## 1. Shared types

Add these to `src/core/registry/types.ts` (or a nearby dependency-neutral lifecycle module):

```ts
export type SessionRuntimeState =
  | 'suspended' | 'hydrating' | 'idle' | 'running' | 'suspending' | 'deleting';

export type ManagedSessionKind = 'interactive';
export type SessionCapacityClass = 'managed-interactive' | 'eager';
export type ClientMessageId = string;
export type SubmitInput = Extract<Op, { type: 'UserInput' }>;

export type SubmitAck =
  | {
      status: 'accepted';
      clientMessageId: ClientMessageId;
      submissionId: string;
    }
  | {
      status: 'queued';
      clientMessageId: ClientMessageId;
      position: number;
      /** Present only while the session itself waits in the global capacity FIFO. */
      capacityPosition?: number;
      phase: 'capacity' | 'hydration' | 'suspension';
    }
  | {
      status: 'rejected';
      clientMessageId: ClientMessageId;
      reason: 'queue-full' | 'deleted' | 'busy' | 'not-found'
        | 'client-id-conflict' | 'submit-failed';
    };

export interface ThreadIndexEntry {
  sessionId: string;
  title: string;
  /** Always normalizeSearchTitle(title); repaired on read if an old/imported row differs. */
  searchTitle: string;
  titleSource: 'generated' | 'user' | null;
  titleUpdatedAt: number;
  createdAt: number;
  lastActiveAt: number;
  pinned: boolean;
  deletedAt: number | null;
  purgeAfter: number | null;
  purgeState?: 'pending' | 'failed';
  agentMode: AgentMode;
  origin: { kind: 'new' } | { kind: 'fork'; sourceSessionId: string };
  schemaVersion: 1;
}

export interface RolloutSnapshot {
  readonly sessionId: string;
  /** RolloutMetadataRecord.itemCount; zero when metadata does not exist yet. */
  readonly revision: number;
  readonly items: ReadonlyArray<RolloutItem>;
}

export interface ReplayCursor {
  runtimeEpoch: string;
  eventSeq: number;
}

export interface SequencedChannelEvent extends ChannelEvent {
  runtimeEpoch: string;
  eventSeq: number;
}

export interface ReplayBatch {
  runtimeEpoch: string;
  baseRolloutRevision: number;
  firstSeq: number;
  throughSeq: number;
  truncated: boolean;
  events: SequencedChannelEvent[];
}

export interface SessionRuntimeView {
  state: SessionRuntimeState;
  awaitingInputCount: number;
  awaitingInputKinds: Array<'approval' | 'foreground'>;
  durability: 'ok' | 'degraded';
  durabilityReason?: 'terminal-marker-write';
  lastFailure?: {
    kind: 'hydration';
    code: 'history' | 'assembly' | 'auth-reconcile' | 'unknown';
    ts: number;
    retryable: true;
  };
}

export interface ThreadListItem extends ThreadIndexEntry {
  runtime: SessionRuntimeView;
}

export interface SessionAttachResult {
  entry: ThreadIndexEntry;
  snapshot: RolloutSnapshot;
  runtime: SessionRuntimeView;
  replay: ReplayBatch | null;
}
```

`RolloutSnapshot.items` is the canonical cached value for a live epoch. Freeze deeply in
tests/development; assembler passes `structuredClone(snapshot.items)` into legacy Session
reconstruction because current response objects may be mutated later. Attach serializes the
canonical value. Thus both consumers share one revision/content boundary without sharing
mutable response objects.

Protocol additions in `src/core/protocol/events.ts`:

```ts
export interface SessionRuntimeEventData {
  sessionId: string;
  state: SessionRuntimeState;
  prevState: SessionRuntimeState;
  awaitingInputCount: number;
  awaitingInputKinds: Array<'approval' | 'foreground'>;
  durability: 'ok' | 'degraded';
  durabilityReason?: 'terminal-marker-write';
  ts: number;
  reason?: 'opened' | 'evicted' | 'hydration-failed' | 'shutdown' | 'deleted';
}

export interface SessionSubmissionStateEventData {
  sessionId: string;
  clientMessageId: ClientMessageId;
  state: 'accepted' | 'failed';
  submissionId?: string;
  reason?: 'hydration-failed' | 'deleted' | 'shutdown'
    | 'capacity-canceled' | 'submit-failed';
  ts: number;
}

export interface SessionIndexChangedEventData {
  sessionId: string;
  change: 'upsert' | 'soft-deleted' | 'restored' | 'purged';
  entry?: ThreadIndexEntry; // omitted only after purge
  ts: number;
}

export interface BrowserAttentionRequiredEventData {
  requestId: string;
  sessionId: string;
  tabId: number;
  reason: 'login' | 'permission' | 'user-gesture';
  expiresAt: number;
}

// Add to EventMsg:
// | { type: 'session_runtime_state'; data: SessionRuntimeEventData }
// | { type: 'session_submission_state'; data: SessionSubmissionStateEventData }
// | { type: 'session_index_changed'; data: SessionIndexChangedEventData }
// | { type: 'browser_attention_required'; data: BrowserAttentionRequiredEventData }
```

Map runtime/submission state to `'thread'` and index-changed to `'channel'` in
`src/core/protocol/event-scope.ts`; browser-attention-required is also thread-scoped. Every surface needs list mutations even when it is not
viewing that session. `ChannelEvent` gets optional `runtimeEpoch` and
`eventSeq` fields for additive transport compatibility. Events emitted while a runtime epoch
exists set both; durable index events for a never-hydrated/suspended session may omit them.

New lifecycle services also need machine-readable failures; current ServiceResponse carries
only a message. Put the shared code/event fields in `src/core/protocol/events.ts`, the
throwable domain error in `src/core/services/errors.ts`, and the client error beside
UIChannelClient; extend the wire shape additively:

```ts
export type SessionServiceErrorCode =
  | 'INVALID_ARGUMENT' | 'SESSION_NOT_FOUND' | 'SESSION_DELETED'
  | 'SESSION_NOT_LIVE' | 'STALE_CONTROL' | 'UNSUPPORTED_MODE'
  | 'SESSION_RESET_UNSUPPORTED_IN_LIFECYCLE_MODE';

export interface ServiceResponseEvent {
  // existing fields unchanged
  error?: string;
  errorCode?: SessionServiceErrorCode;
  retryable?: boolean;
}

export class SessionServiceError extends Error {
  constructor(
    readonly code: SessionServiceErrorCode,
    message: string,
    readonly retryable = false,
  ) { super(message); }
}

export class ServiceRequestError extends Error {
  readonly code?: string;
  readonly retryable: boolean;
}
```

ChannelManager recognizes `SessionServiceError` and copies code/retryable while retaining the
string `error` for old clients. `UIChannelClient` rejects failures with ServiceRequestError;
legacy/untyped handlers leave code undefined. Do not infer codes by parsing messages.

## 2. Scope and sources of truth

- Add compile-time `MULTI_THREAD_LIFECYCLE` through the existing
  `src/core/features/feature.ts` + `vite.featureFlags.mjs` system, default false while Phases
  3a/3c merge. Phase 3b's registry-owned config propagation is not gated. Add
  `SessionManagerOptions.lifecycleMode: 'client' | 'eager'`. Extension and
  desktop runtime pass `client` only when the build flag is true; headless server always
  passes `eager` (shared `ServerAgentBootstrap` also checks its desktop-runtime mode).
- Managed lifecycle applies only when mode is client and
  `type:'primary' && !internal`.
- `scheduled`, `api`, and `internal:true` sessions remain eager/ephemeral and bypass
  lifecycle capacity in the first delivery. They still use `AgentAssembler`, AuthContext,
  centralized config handling, and session-scoped browser resources.
- Capacity classification is total and happens before construction:
  `client && type === 'primary' && !internal` is `managed-interactive`; every other
  combination is `eager`. In client mode, `AgentRegistry.maxConcurrent` (default 5) becomes
  the independent eager/non-internal budget; managed-interactive handles do not contribute
  to `getActiveCount()`/`canCreateSession()`. `internal:true` retains its current bypass. In
  eager/headless mode every non-internal handle retains today's shared `maxConcurrent`
  behavior. This is a counter/filter change over the same registry live map, not a second
  registry.
- `ThreadIndexStore` is the durable session-list/mode source of truth.
- The manager live map contains only HYDRATING reservations and live handles; SUSPENDED
  sessions are represented by ThreadIndex + rollout, not placeholder `AgentSession`s.
- `threadStore` is the only webfront projection. It does not persist its own durable thread
  list; only `activeSessionId` may remain local UI preference.
- Every service operation requires explicit `sessionId`. Migration aliases may fill it from
  their own request context, never from a process-global primary pointer.
- In eager mode, `session.submit` is the direct-accept passthrough and durable thread-list
  services are not registered unless a future headless product explicitly adopts them.

Client startup order is: initialize storage → run/repair ThreadIndex backfill → construct
manager/services → if there are no non-deleted entries, create one index-only New Chat →
start UI/alarms. Do not create an initial live primary agent in extension service-worker or
desktop `ServerAgentBootstrap` client mode. Scheduled infrastructure remains lazy/eager on
its own path.

## 3. Submission and control routing

### 3.1 UserInput uses a correlated service request

Today's `UIChannelClient.submitOp()` and `UIChannelTransport.sendOp()` are `Promise<void>`,
and `SidePanelChannel` discards an agent-handler return value. They cannot carry a
`SubmitAck`. Reuse the existing correlated `ServiceRequest`/`ServiceResponse` machinery:

```ts
// UI
client.serviceRequest<SubmitAck>('session.submit', {
  sessionId,
  clientMessageId: crypto.randomUUID(),
  input,
});

// client handler
session.submit({ sessionId, clientMessageId, input })
  -> SessionManager.submit(...)

// headless server handler (uniform API, no client lifecycle)
session.submit(...) -> agent.submitOperation(input) -> accepted ACK
```

The UI generates one `clientMessageId` and retains it for same-worker dedupe until it receives
a terminal submission-state event. `position` is 1-based in that session's FIFO;
`capacityPosition` is 1-based in the global FIFO when applicable. SessionManager keeps an
in-memory dedupe map for pending IDs plus a per-session 128-entry recent-ACK LRU. Completed
IDs enter that LRU; eviction is oldest-first. A duplicate retained in either structure
returns the original ACK and never calls the agent twice.
If the same ID is presented with structurally different input, reject
`client-id-conflict`; never alias two messages onto one acknowledgement.

Compute `inputDigest = hex(SHA-256(stableJson(input)))`, where stableJson recursively sorts
object keys and preserves array order. Pass `{clientMessageId,inputDigest}` through
RepublicAgent's submit context into the TaskRunner start marker (§14). On startup/hydration,
scan the newest markers and seed the per-session recent-ACK LRU from the last 128 that contain
a client ID. A retry whose durable marker is retained returns accepted with the original
submissionId; digest mismatch is still `client-id-conflict`. This is completed-turn receipt
recovery, not a durable pending queue.

The target-state generic ChannelManager agent handler throws if it receives `UserInput`;
otherwise a future caller could silently bypass lifecycle. Rewire production sources by
symbol, not old line number: `registerServiceHandlers`' agent handler,
`handleContextMenuClick`, and `executeQuickAction`.

Cutover compatibility: until Phase 4 has migrated the webfront, the generic handler accepts
UserInput only through a named `legacySubmit` shim. It generates a `legacy:<uuid>` client ID,
calls SessionManager.submit, discards the ACK, and emits a generic Error event on rejection.
No code may call `agent.submitOperation(UserInput)` directly. Phase 4 removes all in-repo
legacy callers; Phase 5 changes the generic handler to throw. Instrument the shim with a
numeric-only `session_legacy_submit` telemetry event.

Context-menu/quick-action sources do not have a UI surface ID. If their explicit tab already
has a non-deleted lease owner, target that session; otherwise use the newest unexpired viewed
lease (`selectedAt`, tie surfaceId), else newest non-deleted ThreadIndex entry, else create an
index-only entry. Claim/setCurrent for that session before submit; contention fails visibly
and never steals the tab. Pass the resolved sessionId/requestedTabId into `session.submit`;
never restore a global primary pointer. The UI exposes the resulting RUNNING/awaiting badge
even if another surface currently displays a different session.

Queued service requests return immediately. Later acceptance/failure is delivered through
`session_submission_state`. The UI state transition is:

```
draft -> sending(clientMessageId) -> accepted(submissionId) -> turn events
                                \-> failed/retryable
                                \-> delivery-unknown -> explicit resend(new clientMessageId)
```

On reconnect/attach, reconcile local `sending` items against durable start markers before
showing a result. A match becomes accepted (and an unmatched recovered start becomes
interrupted). If the runtime epoch changed and there is no marker/event, mark the item
`delivery-unknown`, not retryable: a crash could have happened after a pre-submit hook or
command side effect but before durable turn start. Never automatically resend it. The user
may choose Resend, which creates a fresh clientMessageId and carries a duplicate-side-effect
warning. The worker pending queue remains deliberately non-durable.

### 3.2 Exhaustive `Op` disposition

| `Op.type` | Route | SUSPENDED/HYDRATING/SUSPENDING behavior |
|---|---|---|
| `UserInput` | `session.submit` service RPC | bounded FIFO; may trigger hydration |
| `SetSessionMode` | new `session.setMode` service RPC | persist immediately; no hydration required |
| `Interrupt` | existing `agent.interrupt` service RPC | no-op/not-running result; never queue |
| `ExecApproval`, `PatchApproval` | `SessionHandle.dispatchControl` | reject `STALE_CONTROL`; never hydrate/queue |
| `Compact`, `ManualCompact`, `AddToHistory`, `OverrideTurnContext`, `GetHistoryEntryRequest`, `GetPath` | live-only `dispatchControl` | reject `SESSION_NOT_LIVE` |
| `UserTurn`, `Review`, `ListMcpTools`, `ListCustomPrompts` | compatibility/live-only direct control until callers migrate | reject `SESSION_NOT_LIVE`; never queue |
| `Shutdown` | manager `delete`/shutdown orchestration | never sent directly to agent |
| `ServiceRequest` | ServiceRegistry | never reaches agent handler |

`dispatchControl` checks runtime state and approval request ownership before calling
`RepublicAgent.submitOperation`. For Compact/ManualCompact, transition IDLE→RUNNING under
the session queue before dispatch and roll back to IDLE if enqueue fails; the lifecycle-work
lease covers execution thereafter. Only `UserInput` participates in submit FIFO/order.

### 3.3 Queue bounds and result semantics

- Per-session pending UserInput depth: 8.
- Global sessions-waiting-for-capacity depth: 32.
- FIFO order is per session. No cross-session ordering is promised.
- RUNNING is not a lifecycle delay: a new UserInput receives retryable `busy` and the UI
  preserves it as a draft. Only SUSPENDED/HYDRATING/SUSPENDING inputs enter this queue.
- On IDLE, dispatch only the FIFO head and transition RUNNING. The next head waits for a
  later rechecked background-work empty edge; never bulk-submit all queued messages into one agent.
- Accepted means `RepublicAgent.submitOperation` returned a submission ID; it does not mean
  the turn succeeded.
- Hook-blocked input still follows the existing agent behavior (local submission ID plus
  emitted Error); it is an accepted submission, not a transport rejection.
- Delete, hydration failure, and shutdown emit a failed event for every queued ID.

## 4. Auth, config, and rebuild contracts

### 4.1 AuthContext

```ts
export type AuthChangeReason =
  | 'login' | 'logout' | 'routing' | 'credentials-refreshed';

export interface AuthChangedEvent {
  generation: number;
  previous: IAuthManager | null;
  current: IAuthManager | null;
  reason: AuthChangeReason;
}

export interface AuthContext {
  current(): IAuthManager | null;
  generation(): number;
  subscribe(listener: (event: AuthChangedEvent) => void): () => void;
}

export interface MutableAuthContext extends AuthContext {
  update(next: IAuthManager | null, reason: AuthChangeReason): void;
}
```

`update` increments generation before synchronously notifying a snapshot of listeners.
Platform bootstrap owns one context. `ModelClientFactory` stores the context object; token
and refresh closures call `auth.current()` each time. Delete `setAuthManager` and every
sweep that pushes manager snapshots into factories. Tests use `TestAuthContext.none()`.
Login/logout/routing changes request an `auth` rebuild. `credentials-refreshed` needs no
client rebuild because the token closures read live context, but still increments generation
so hydration publishes only after observing the latest context.

The platform registry subscribes once to AuthContext, snapshots live assembled handles, and
applies required auth rebuilds with `Promise.allSettled`; it unsubscribes on registry
shutdown. This lands with Phase 2 on every platform and replaces bootstrap auth sweeps.

### 4.2 Config generation and exhaustive impacts

`AgentConfig.emitChangeEvent` increments `_generation` before callbacks. Add
`generation(): number`. The impact map must be compile-time exhaustive:

```ts
type ConfigSection = IConfigChangeEvent['section'];
type RebuildReason = 'auth' | 'model' | 'provider' | 'tools' | 'prompt' | 'full';
type ManagerAction = 'reload-hooks' | 'reload-approval' | 'rebind-plugins';

interface ConfigImpact {
  rebuild: ReadonlyArray<RebuildReason>;
  actions: ReadonlyArray<ManagerAction>;
}

const CONFIG_IMPACT = { /* table below */ }
  satisfies Record<ConfigSection, ConfigImpact>;
```

| Section | Rebuild | Manager action / rationale |
|---|---|---|
| `model` | model + prompt | selected model affects client and prompt |
| `provider` | provider | credentials/routing/client |
| `tools` | tools + prompt | registry, prompt, memory-tool sync |
| `preferences` | prompt | persona, memory, summary preferences |
| `profile` | full | active profile may alter model/provider/tools/preferences |
| `policy` | full | `reload-hooks` + `reload-approval` + `rebind-plugins`; `reload()` replaces all config but emits only policy today, so this is deliberately conservative |
| `efficientModel` | none | next efficient-client request reads current config |
| `hooks` | none | `reload-hooks` |
| `approval` | none | `reload-approval` |
| `enabledPlugins` | tools + prompt | `rebind-plugins`; plugin tools change exposure and prompt |
| `cache`, `extension`, `security`, `appServer` | none | no live agent graph work |

There is no `instructions` section in the current union. Do not add a dead mapping for it.
Each platform registry/manager owns its only config subscription and sweeps a snapshot of
live agents with `Promise.allSettled`; remove RepublicAgent self-subscriptions and bootstrap
direct sweeps on extension, desktop, and headless server. Client HYDRATING agents reconcile
captured generations before publish. Scheduled/internal live agents are included.

For IDLE agents, apply impacts under their session queue immediately. For RUNNING agents,
union rebuild reasons and manager actions in per-session pending sets; the rechecked
background-work empty edge drains them before the runtime transition to IDLE or next queued submission. This applies to
approval/hooks/plugins too—do not mutate a registry underneath an active tool call. Eager
scheduled/internal agents drain at their observed terminal/background-work-empty seam.

For SUSPENDING, record impacts but do not touch the disposing graph; a successful suspend
discards them because next hydration reads current config, while a flush rollback applies
them before returning to dispatchable IDLE. DELETING ignores new impacts.

For each HYDRATING session, manager keeps `pendingRebuildReasons` and
`pendingManagerActions`. Config/Auth callbacks add impacts synchronously when generation
increments. Before publish, hydration drains and applies both sets; after each awaited action
it compares generations again and repeats if they advanced. Once generations are stable,
publish/transition occurs with no intervening await. Sections with no rebuild still advance
the captured generation. This closes a second config change arriving during the first
reconciliation.

### 4.3 One rebuild method

```ts
RepublicAgent.rebuildExecutionContext(
  reasons: ReadonlySet<RebuildReason>,
): Promise<void>;
```

| Work | auth | model | provider | tools | prompt | full |
|---|---:|---:|---:|---:|---:|---:|
| clear/build model client | ✓ | ✓ | ✓ |  |  | ✓ |
| credential read (factory only) | ✓ | ✓ | ✓ |  |  | ✓ |
| recompose base prompt |  | ✓ | ✓ | ✓ | ✓ | ✓ |
| reload user instructions |  |  |  |  | ✓ | ✓ |
| rebuild memory service | ✓ | ✓ | ✓ |  | ✓ | ✓ |
| sync memory tools/summary hook | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

Mutate the existing `TurnContext`; preserve approval/sandbox overrides. If
`hasLiveBackgroundWork()` is true, union reasons into `pendingReasons`; flush once at the
existing turn-boundary checkpoint. `pendingModeSwitch` stays separate. During migration,
`refreshModelClient` and `hotSwapModelClient` are aliases only; Phase 5 removes in-repo use.

Prepare fallible model/prompt/memory replacements in locals before mutating TurnContext.
Commit prepared values synchronously, then dispose superseded resources. If preparation
fails, dispose the candidate and leave the old execution context usable. Tool/summary-hook
sync is idempotent post-commit; a failure is emitted and retained in pending reasons for one
retry at the next idle boundary rather than rolling back an already-swapped model client.

## 5. AgentAssembler and teardown

### 5.1 Input/output interfaces

```ts
export interface AssembleInput {
  sessionId: string;
  kind: 'new' | 'resume' | 'fork';
  history: RolloutSnapshot;
  /** Relevant to fork only: true for agent-free durable fork, false for immediate legacy fork. */
  historyAlreadyPersisted: boolean;
  sourceSessionId?: string;
  config: AgentConfig;
  auth: AuthContext;
  services: SessionServices;
  preferences: { agentMode: AgentMode };
  metadata: {
    title: string;
    titleSource: ThreadIndexEntry['titleSource'];
    origin: ThreadIndexEntry['origin'];
  };
  /** Installed on RepublicAgent before initialize; owned by SessionManager. */
  eventDispatcher: EventDispatcher;
}

export type AgentDisposeReason =
  | 'suspend' | 'compat-close' | 'delete' | 'shutdown' | 'completed'
  | 'error' | 'tab-closed' | 'manual' | 'assembly-failed';

export interface AssembledAgent {
  readonly agent: RepublicAgent;
  readonly subAgentRunner: SubAgentRunner | null;
  applyManagerActions(actions: ReadonlySet<ManagerAction>): Promise<void>;
  flushRollout(): Promise<void>;
  dispose(reason: AgentDisposeReason): Promise<DisposeReport>;
}

export interface DisposeReport {
  ok: boolean;
  failedSteps: string[]; // internal step identifiers only; never user/telemetry content
}

export interface AgentAssembler {
  assemble(input: AssembleInput): Promise<AssembledAgent>;
}
```

`sessionId` is reserved by `session.open` before construction and is authoritative.
Extend current core `InitialHistory` to carry it in all variants:

```ts
type InitialHistory =
  | { mode: 'new'; sessionId: string }
  | { mode: 'resumed'; sessionId: string; rolloutItems: RolloutItem[] }
  | {
      mode: 'forked';
      sessionId: string;
      sourceConversationId: string;
      rolloutItems: RolloutItem[];
      historyAlreadyPersisted: boolean;
    };
```

Assembler translates `AssembleInput` into this legacy constructor shape. Assert after
construction that `agent.getSession().sessionId === input.sessionId`; mismatch is an
assembly failure, never a map-key substitution.

For a durable top-level fork, `historyAlreadyPersisted:true`: Session reconstructs history
and sets its fork-context flag but skips today's `persistRolloutResponseItems` copy. Existing
ephemeral/scheduled immediate forks pass false and retain current persist-on-construction
behavior. This avoids duplicating a prefix that Phase 3a writes agent-free (spec §7.5).

### 5.2 Construction phases and ownership

1. Construct platform adapter, model factory, services, and RepublicAgent.
2. Initialize once with required `AuthContext` and injected `agentMode`/prompt loader.
3. Wire policy, approval, enhancers, x402, sub-agent runner, task output, skills, plugins.
4. Return the assembled handle; SessionManager activates its preinstalled event gate and
   publishes.

Each successful step pushes a cleanup closure. Failure runs closures in reverse and throws
the original error with cleanup failures attached/logged. `dispose` is idempotent and owns
plugin binder/resolver teardown (currently missing). Delete the extension `onAgentCreated`
callback. Late-bound service-worker dependencies remain lazy getters; do not reorder boot.

`dispose` runs every cleanup step with allSettled semantics and resolves a report; repeated
calls return the same promise/report. `flushRollout` remains separately fallible so suspend
can abort before destructive cleanup.

### 5.2.1 Pre-publish event gate

RepublicAgent emits SessionStart, config warnings, and other events during `initialize`; the
current registry installs its dispatcher afterward, losing them. SessionManager creates a
`SwitchableEventGate` when HYDRATING starts and passes its dispatcher into AssembleInput.
Assembler calls `agent.setEventDispatcher` **before** initialize.

The gate buffers up to the normal 512-event/1-MiB replay bounds without broadcasting. After
tombstone/mode/config/auth checks, manager publishes the handle and synchronously activates
the gate: buffered events receive epoch sequences and enter one per-session outbound promise
chain before later live events. Activation itself has no await, so ordering cannot invert.
If the pre-publish buffer drops an event, carry `truncated=true` into the epoch ring/attach
result; do not silently reset the flag during activation.
Assembly failure closes/discards the gate and publishes only typed hydration failure. The
gate is wrapped by telemetry at creation, keeping the manager path the sole event chokepoint.

Extension assembler absorbs the current inline `AgentRegistry.createSession` graph:
`ExtensionPlatformAdapter`, SessionServices/cache, PolicyRulesEngine, ApprovalGate and both
enhancers, ApprovalConfigStorage, x402 capability, sub-agent tool/runner, TaskOutputStore,
SkillRegistry, and PluginSessionBinder/resolvers. Server assembler absorbs the current
`ServerAgentBootstrap` factory closure. Both return the real runner when present.

When constructing the first rollout for an index-only chat, seed non-empty metadata.title
from AssembleInput after recorder initialization. A user may rename an empty thread before
first hydration; absence of rollout metadata is normal and does not make rename fail.

Delete RepublicAgent's pre-read used only for the missing-key warning. Add
`ModelClientFactoryOptions.onMissingKey(providerId)` and invoke it from the factory's existing
provider-config read; the assembler maps it to today's BackgroundEvent. This leaves one
credential-store read without dropping the warning.

### 5.3 Teardown matrix

| Reason | SessionEnd hook | Abort work | close marker | rollout flush | purge persisted tool results |
|---|---:|---:|---:|---:|---:|
| suspend | yes, `suspend` | no (eligibility already proves idle) | no | yes | no |
| compat-close | yes, `compat-close` | yes, then await idle | no | yes | no |
| delete | yes, `delete` | yes after confirmation | yes | yes | purge coordinator |
| shutdown/manual/completed | yes, matching reason | yes when needed | existing caller policy | yes | no |
| error/tab-closed | yes, matching reason | yes | existing caller policy | yes | no |
| assembly-failed | only if SessionStart already fired; reason `assembly-failed` | yes if partially started | no | best effort | only transient graph |

Split `RepublicAgent.cleanupOnce()` into reason-aware internal cleanup behind
`AssembledAgent.dispose`. `AgentSession.terminate` delegates exactly once and does not call
`Session.dispose` separately. Suspension may dispose the in-memory Session object, engine,
tools, prompt extensions, memory, platform adapter, and binder, but must not fire a terminal
shutdown reason, record a close marker, abort work, or delete durable resources.

Clarify hook semantics additively: every assembled runtime graph emits SessionStart with
`session_start_reason:'create'|'hydrate'`; its disposal emits exactly one SessionEnd with the
matching lifecycle reason. `suspend` is a runtime end, not a durable-chat deletion. Existing
hook consumers that ignore the new reason still receive a balanced start/end pair.
The cleanup stack records whether SessionStart ran so an initialization/wiring failure emits
a matching assembly-failed end exactly once; failure before start emits neither.

`compat-close` exists only for lifecycle-mode `session.close`: set a force-suspend claim
synchronously, stop dispatch, abort/await current work, transition through IDLE→SUSPENDING,
flush, then dispose with that reason. Inputs arriving after the claim join the normal pending
FIFO and may rehydrate only after close finishes. Flush failure clears the claim and returns
the intact graph to IDLE. It never writes a close marker or deletes the index/rollout.

Separate lifecycle reason from TaskRunner's narrower abort reason in Session cleanup:

```ts
interface SessionDisposeOptions {
  lifecycleReason: AgentDisposeReason;
  abortReason?: TurnAbortReason;
  abortTasks: boolean;
  recordCloseEvent: boolean;
  flushRollout: boolean;
  cleanupToolResults: boolean;
}
```

### 5.4 Per-agent prompt context (D6; Phase 2, not cleanup)

Turn `PromptLoader`'s set-once module composer into an instance created by the assembler:

```ts
type AgentPromptExtension =
  (runtime: PromptRuntimeContext) => string | Promise<string>;

interface AgentPromptLoader {
  load(mode: AgentMode, runtime: PromptRuntimeContext): Promise<string>;
  supportsMode(mode: AgentMode): boolean;
  registerExtension(name: string, extension: AgentPromptExtension): () => void;
  dispose(): void;
}

interface CreatePromptLoaderInput {
  agentType: AgentType;
  staticPlatformContext: Readonly<Partial<RuntimeContext>>;
  dynamicContext?:
    (runtime: PromptRuntimeContext) => Partial<RuntimeContext>;
}

createPromptLoader(input: CreatePromptLoaderInput): AgentPromptLoader;
```

The factory snapshots/freezes static context. Extensions are instance-local, execute in
registration order, and may be async because `load` is already async. Same-name registration
replaces only that instance's prior entry. The returned unregister function and `dispose`
are idempotent. An extension failure is logged with its name and omitted for that load; it
does not replace the composed base prompt with the fallback prompt.

Inject the instance into `RepublicAgent`, `TurnManager`, and hooks instead of importing
module-level `loadPrompt`. The assembler performs this complete owner migration:

1. `RepublicAgent.syncMemoryTools` registers `core-memory` on its own loader.
2. `SessionSummaryHook` receives the loader and owns its summary unregister thunk.
3. The extension assembler registers a `skills` extension for that agent; Phase 3c changes
   its value source from today's global active-tab filter to `SessionSkillView` (§15.2).
4. The plan-review dynamic context becomes the instance `dynamicContext` callback and reads
   the runtime's own ToolRegistry; remove the service-worker singleton provider/fallback.
5. Extension, desktop, and headless server assemblers pass their own agent type/static
   platform context. No server bootstrap preconfigures process-global prompt state.

After the migration, no production path calls `configurePromptComposer`, `loadPrompt`,
`setDynamicRuntimeContext`, or module-level extension registration. Keep module exports only
as a test compatibility adapter backed by one test-owned instance and delete them in Phase
5. Multi-session UI is gated on this Phase-2 fix.

## 6. Background-work and awaiting-input accounting

```ts
Session.hasLiveBackgroundWork(): boolean {
  return (this.activeTurn?.getTasks().size ?? 0) > 0
    || this.runningTaskIds.size > 0
    || this.shadowAgentScheduler?.hasPending() === true
    || this.lifecycleWorkTokens.size > 0;
}
```

`activeTasks` is deliberately a retained UI/task-state registry and may contain terminal
entries through panel grace; never use its size as liveness. Add `runningTaskIds` before any
task's first await for foreground, background, and child-engine registration paths, notify
after insertion, and remove it in a finally block after terminal hooks complete. A terminal retained task stays visible
but does not block config, IDLE, or LRU. Add `ShadowAgentScheduler.hasPending()` over current
diagnostics plus `subscribePendingChanged(listener)` fired only on zero↔nonzero boundaries;
Session subscribes it to the same liveness-edge notifier and unsubscribes on disposal.

Use one synchronous lease API for work that outlives a hook callback or waits in an internal
queue:

```ts
type LifecycleWorkKind =
  | 'title' | 'prompt-suggestion' | 'session-summary' | 'compaction';

interface LifecycleWorkLease {
  readonly token: string;
  readonly signal: AbortSignal;
  finish(): void; // idempotent
}

Session.beginLifecycleWork(
  kind: LifecycleWorkKind,
  options?: { abortAfterMs?: number },
): LifecycleWorkLease;
```

The method inserts the token before returning and schedules a liveness-edge notification.
`finish` removes it and schedules another edge check. Title and suggestion use
`abortAfterMs:30_000`; expiry aborts,
marks their generation stale, logs, and finishes. Summary and compaction do not expire their
lease: their underlying shadow/model operations already have bounded/retry semantics, and
silently ceasing to count still-running destructive work would be unsafe. Forced
delete/shutdown aborts and awaits their owners; ordinary suspension can start only after
leases finish. `beginLifecycleWork` rejects once disposal begins. Disposal aborts every lease
signal, suppresses idle callbacks, and clears tokens only after owner cleanup settles.

Await TaskCreated before starting task work. Await idempotent TaskCompleted/Stop hooks before
removing the running ID (their existing timeouts bound delay). Hook failure is logged and
does not change the task result. All task paths schedule a liveness-edge check after finally.

`SessionServices.onBackgroundWorkChanged(sessionId)` is an internal manager callback, not a
new wire event. Session schedules it on both false→true and true→false liveness edges.
`noteWorkMutation()` recomputes the full predicate synchronously, compares it with a stored
`lastBusy`, updates `lastBusy` before invoking the callback, and otherwise no-ops; this
coalesces duplicate task/lease/scheduler notifications without losing an edge.
Manager re-checks `hasLiveBackgroundWork()` under the session queue: a true edge moves an
IDLE graph to RUNNING; a false edge applies deferred config, refreshes the snapshot, and
moves RUNNING to IDLE. A newer edge always wins the recheck, so a task that starts between
notification and handling cancels a stale idle transition. Manager-driven UserInput already
sets RUNNING, making its subsequent true edge idempotent.

Each title/suggestion continuation owns the lease AbortController and a generation token. At grace expiry,
abort, remove the token, and mark its result stale; a model client that ignores abort may
finish, but its title commit is discarded. Disposal also aborts it. No continuation may call
back into a disposed graph after it stops blocking suspension.

Replace TaskRunner's two post-TaskComplete microtasks with
`session.schedulePostTurnContinuations()`: before terminal TaskComplete is emitted it
synchronously reserves eligible title/suggestion leases (including suggestion single-flight
and cooldown checks), then starts async work. Token removal schedules the liveness-edge
check. Set suggestion single-flight before its first await. This closes
the terminal-event/microtask race and prevents two fast completions from stacking calls.

`SessionSummaryHook.handlePostTurn` is awaited only until it launches `void runExtraction()`.
When its predicate passes, acquire a `session-summary` lease before that launch, pass it into
`runExtraction`, and finish it in the same `finally` that calls `markExtractionCompleted`.
The manual extraction path follows the same rule. This covers file setup/read work before the
request becomes visible to `ShadowAgentScheduler.hasPending()`.

AutoCompactHook is likewise awaited only until it queues Compact. Add a narrow engine API:

```ts
interface TrackedEngineSubmission {
  submissionId: string;
  settled: Promise<{ outcome: 'completed' | 'failed' | 'cancelled' }>;
  cancel(reason: 'delete' | 'shutdown' | 'interrupt'): void;
}

RepublicAgentEngine.submitTrackedOperation(op: EngineOp): TrackedEngineSubmission;
```

The engine resolves `settled` exactly once after handler completion/failure; clearing the
queue resolves every not-started tracked item as cancelled. RepublicAgent's Compact and
ManualCompact branches acquire a `compaction` lease before enqueue, use the tracked API, and
finish the lease from `settled.finally`. AutoCompactHook also clears its `pending` flag from
that settlement (event observation is not the correctness path). Enqueue failure finishes
the lease synchronously. Thus the current-task→queued-compact handoff has no false-idle gap.

Tracked operations own an AbortController. Engine dispose cancels queued and active tracked
operations and awaits settlement. Thread the signal through CompactService's summary-
extraction wait, shadow preparation, retry sleep, and model request; check it immediately
before any history/rollout commit. A provider that ignores abort may finish its request, but
the final guard forbids post-dispose mutation. Make `SessionSummaryHook.detach` async: abort,
unregister its hook, await its stored extraction promise (the shadow-model portion is bounded
by its profile, and local file I/O must settle), then unregister its prompt extension. The
AssembledAgent cleanup stack awaits that detach before purging files. Title/suggestion already use generation guards and are awaited only up
to their 30 s abort grace. Delete/purge therefore cannot race an orphaned writer.

Title success calls injected
`SessionServices.commitGeneratedTitle(sessionId,title): Promise<boolean>`. The manager
serializes the whole decision: if current `titleSource==='user'`, return false without
touching rollout; otherwise update rollout metadata, then ThreadIndex with
`titleSource:'generated'`, then emit the index event. `session.rename` writes ThreadIndex
first with `titleSource:'user'`, then rollout metadata. On startup/list reconciliation,
user-source index wins; otherwise rollout title repairs a missing/older generated index
value. This prevents stage-2 auto-title from overwriting a manual rename and makes a crash
between the two store writes recoverable.

If rename's rollout write fails (or metadata does not exist yet), return the authoritative
updated index entry, enqueue a
best-effort metadata repair, and surface only a diagnostic warning; do not roll back the user
rename. If generated commit's index write fails after rollout success, return false so title
generation may retry, while list reconciliation also repairs it.

Manager owns `awaitingInputTokens: Map<sessionId, Set<string>>`:

- add `approval:<id>` on `ApprovalRequested` and legacy
  `ExecApprovalRequest`/`ApplyPatchApprovalRequest` events;
- remove by ID on `ApprovalGranted`/`ApprovalDenied` or matching Exec/Patch control response;
  `ApprovalAutoApproved` creates no token because no request was exposed to the user;
- add `foreground:<requestId>` on browser attention request;
- remove on resolve, abort, or delete;
- terminal TaskComplete/TaskFailed/TurnAborted clears orphan tokens for that submission.

Runtime events publish count and distinct kinds. LRU eligibility uses count zero, not a
boolean inferred from the latest event.

## 7. ThreadIndex storage, backfill, and purge

### 7.1 Store plumbing

- Add `thread_index` with key path `sessionId` to `STORE_KEY_PATHS` and `STORE_NAMES`.
- Bump `IndexedDBAdapter.DB_VERSION` 5 → 6 and create the object store in upgrade.
- Add the name to `NodeSQLiteAdapter`/desktop store allowlists so its generic
  `CREATE TABLE IF NOT EXISTS` path creates the SQLite table.
- Implement `ThreadIndexStore` over `StorageAdapter`: `get`, `list`, `upsert`, `patch`,
  `softDelete`, `undelete`, `purge`, and `flush`.
- Serialize writes per session with `PerKeyOperationQueue`. A suspend awaits index and
  rollout flushes before removing the live handle.

### 7.2 Deterministic backfill

Union IDs from rollout provider metadata and `SessionStorage.loadAllSessions()`:

| Field | Backfill rule |
|---|---|
| title | rollout `sessionMeta.title` when string, else `''` |
| searchTitle | `normalizeSearchTitle(title)` |
| titleSource | non-empty migrated title → `user` (preservation-first); empty → null |
| titleUpdatedAt | rollout.updated when title non-empty, else createdAt |
| createdAt | minimum finite rollout.created / persisted.createdAt; now only if neither exists |
| lastActiveAt | maximum finite rollout.updated / persisted.lastActivityAt / createdAt |
| pinned | false |
| deletedAt, purgeAfter | null |
| agentMode | configured default mode |
| origin | `{kind:'new'}` (legacy source provenance is unavailable) |
| schemaVersion | 1 |

Upsert only missing entries; never overwrite user mutations. Write config-storage marker
`thread_index_backfill_v1` after all writes finish. `session.list` still lazily indexes
missing rollout IDs, so an interrupted migration/import is recoverable.

`normalizeSearchTitle(value)` is `value.normalize('NFKC').toLowerCase()` after title trim.
Every rename/generated-title transaction updates both fields; reads lazily repair imported
rows. `session.list` excludes deleted entries by default and sorts pinned first, then
`lastActiveAt` descending, then `sessionId` ascending. It also runs the title reconciliation
rule above. `lastActiveAt` is updated on accepted UserInput, terminal turn, and explicit
user-navigation selection—not on streaming deltas or viewed heartbeat.

Index mutation service shapes:

```ts
session.list({
  includeDeleted?: boolean;
  query?: string;
  limit?: number;       // default 50, valid 1..100
  cursor?: string;      // opaque base64url cursor returned by the previous page
}): Promise<{
  entries: ThreadListItem[];
  nextCursor: string | null;
}>;
session.get({ sessionId: string; includeDeleted?: boolean }): Promise<ThreadListItem>;
session.pin({ sessionId, pinned: boolean }): Promise<ThreadIndexEntry>;
session.rename({ sessionId, title: string }): Promise<ThreadIndexEntry>;
session.delete({ sessionId, abortRunning?: boolean }): Promise<
  | { status: 'deleted'; entry: ThreadIndexEntry }
  | { status: 'requires-confirmation'; running: true }
  | { status: 'not-found' }
>;
session.undelete({ sessionId }): Promise<
  | { status: 'restored'; entry: ThreadIndexEntry }
  | { status: 'purge-started' | 'not-found' }
>;
```

List/search always responds with a bounded page. Normalize query with the same function and
apply substring matching to `searchTitle`. The cursor encodes version, normalized query,
includeDeleted, and the last row's `(pinned,lastActiveAt,sessionId)` tuple; validate all fields
and return `INVALID_ARGUMENT` if it does not match the request. ThreadIndexStore may scan/sort
all small rows internally in v1, but it slices before runtime projection/transport. A 10,000-
row fixture must return at most 100 entries within the history latency budget. The webfront
resets cursor when query changes and loads subsequent pages on scroll/"more".
`session.get` is the bounded direct lookup for restored selection and runtime events about a
row outside loaded pages; it uses `SESSION_NOT_FOUND`/`SESSION_DELETED` and never hydrates.

Pin/rename are idempotent. Rename trims whitespace and accepts 1–120 Unicode code points;
both reject soft-deleted entries with `SESSION_DELETED`; invalid input uses
`INVALID_ARGUMENT`.
`abortRunning:true` aborts with user-request reason,
waits for terminal teardown, then soft-deletes. An initial delete of a RUNNING session returns
`requires-confirmation` without a tombstone. The confirmed call re-checks state, sets the
tombstone synchronously before its first await, and then aborts; IDLE/SUSPENDED delete also
sets it immediately. Any work that began during the confirmation UI is included in abort.

### 7.3 Snapshot loader

Replace the old `{sessionId,rolloutItems}` hook with:

```ts
loadRolloutSnapshot(sessionId: string): Promise<RolloutSnapshot>
```

Revision is `RolloutMetadataRecord.itemCount`. Missing metadata for an existing ThreadIndex
entry returns frozen `{sessionId,revision:0,items:[]}`. Unknown/deleted ID is typed
`SESSION_NOT_FOUND`/`SESSION_DELETED`. SessionManager coalesces concurrent loads and caches
the snapshot for the live epoch; hydration and attach share it.

### 7.4 Soft delete and hard purge

Set the in-memory tombstone before the first await, persist soft-delete fields first, then
fail queued messages, cancel capacity reservation, and dispose a live handle with `delete`.
Persist-first means a crash during teardown cannot resurrect the list row. A failed teardown
is retried during startup maintenance. `undelete` is allowed only after live teardown has
finished and before purge starts.

`SessionDeletionCoordinator.purge(sessionId)` runs idempotent steps:

1. ensure no live handle/reservation;
2. delete rollout item records and metadata;
3. `SessionCacheManager.clearSession`;
4. `SessionStorage.deleteSession`;
5. new `TokenUsageStore.deleteSession`;
6. delete task plan/state and collect known task IDs first;
7. `TaskOutputStore.cleanupSession(taskIds)`;
8. persistent `ToolResultStore.cleanup(sessionId)`;
9. delete ThreadIndex row last.

On failure keep the row, set `purgeState:'failed'`, and retry next sweep. Extension uses the
existing `session-cleanup` alarm. Desktop calls the coordinator at startup and every two
hours while the sidecar lives; the timer is stopped on shutdown.

At purge start, atomically patch `purgeState:'pending'`; undelete accepts only rows with no
purgeState. A startup sweep treats both pending and failed rows as retry candidates, which
covers process death in the middle of deletion.

### 7.5 Agent-free durable fork

`session.rewind({sessionId,targetSequence})` flushes the source first if it is live, computes
the existing pure rewind slice, reserves a new ID, then calls a new
`RolloutForkWriter.write(newId, items)` before creating the index entry. The writer uses
`RolloutRecorder.create({type:'create',sessionId:newId})`, drops source session/recovery
markers, records the already pairing-trimmed slice, flushes, and shuts the recorder down. It
therefore writes fresh metadata/session_meta for the new ID without constructing an agent.
Only after its flush succeeds, create:

```ts
{ sessionId: newId, origin: { kind: 'fork', sourceSessionId: sessionId }, ... }
```

If rollout writing fails, do not create the index. If the index write fails after rollout
success, lazy indexing recovers the orphan with origin `new` (history remains intact; source
provenance is the only lost metadata). Hydration reads the new snapshot and passes
`kind:'fork'`, source ID, and `historyAlreadyPersisted:true`. Source rollout is never written.
`session.attach` can therefore render the fork immediately with zero live agent.

## 8. Surface leases

The extension uses one-shot `chrome.runtime.onMessage`, so there is no reliable connection
disconnect identity. The webfront owns it:

```ts
type SurfaceId = string; // crypto.randomUUID(), one per document lifetime

session.setViewed({ surfaceId, sessionId, visible: true, touch: true })
  -> { leaseExpiresAt: number };
session.setViewed({ surfaceId, sessionId: null, visible: false });
session.releaseSurface({ surfaceId });
```

- Heartbeat every 20 s while visible; lease TTL 60 s.
- Initial user navigation sends `touch:true`; heartbeats send `touch:false` so they do not
  continuously reorder the recent list. Bootstrap restoration also uses `touch:false`.
- Best-effort release on `visibilitychange` hidden and `pagehide`.
- One map entry per surface; setting another session atomically replaces the old one.
- Lease records keep `selectedAt` separate from `expiresAt`; heartbeats extend only expiry.
- Validate that a target index exists and is not deleted before replacement; use
  `SESSION_NOT_FOUND`/`SESSION_DELETED`, and leave the surface's previous valid lease intact.
- Release includes the surface ID only and cannot clear another surface.
- Expired entries are pruned before every LRU choice and on the manager maintenance tick.
- Visual active selection stays local UI state; the lease exists only for eviction safety.

Desktop uses the same webfront protocol. Tests use an injected clock.

## 9. Attach, replay, and event ordering

### 9.1 Sole outbound chokepoint

Wrap the event dispatcher installed after assembly:

```ts
agent event -> SessionManager.sequenceAndStore -> telemetry -> ChannelManager.broadcastEvent
```

Narrow production `EventDispatcher` to `(event: Event) => void`. Its only job is to copy and
synchronously enqueue the event into the switchable gate/per-session outbound chain; it must
not dynamically import or await transport work before enqueue. The chain owns replay-ring
mutation and broadcast promises in sequence order, catches/logs every rejection internally,
and remains live after a failed send. Ring append precedes broadcast, so a transport failure
does not erase replayable output. This makes current fire-and-forget emission call sites
safe: they cannot ignore a rejected dispatcher promise or invert two events. Tests use a
deferred/rejecting broadcaster to prove capture order and chain recovery.

Delete the 100 ms `session.agent.getNextEvent()` loop in service worker
`setupPeriodicTasks`. Retain `getNextEvent` only as a legacy/test API; production must not
drain it. This fixes current duplicate delivery and makes replay sequencing meaningful.

Also prevent an undrained memory queue: add RepublicAgent construction option
`retainLegacyEventQueue` (default true only for direct legacy tests, false in every production
assembler). `emitEvent` pushes to `eventQueue` only when enabled; dispatcher delivery is
unchanged. Phase 5 deletes the queue/API after remaining tests migrate.

At each HYDRATING attempt (after capacity reservation, before assembly), generate
`runtimeEpoch=crypto.randomUUID()`, set eventSeq=0,
and store the snapshot revision as `baseRolloutRevision`. A UUID prevents a restarted MV3
worker from reusing an epoch still held by an open UI. Each outbound event increments first,
then appends/broadcasts the same immutable envelope. Ring bounds are 512 events or 1 MiB,
drop-oldest; dropping sets `truncated=true`.

### 9.2 `session.attach`

```ts
session.attach({
  surfaceId,
  sessionId,
  after?: { runtimeEpoch, eventSeq },
}): Promise<SessionAttachResult>
```

Under the session queue, capture one boundary `throughSeq`, then return the cached snapshot
and ring events `(after, throughSeq]`. If epochs differ, return the entire retained current
epoch and its truncation flag. Attach is read-only and never waits for capacity.

UI algorithm:

1. Start buffering live events for sessionId before issuing attach.
2. Apply snapshot via the shared pure rollout-to-conversation projection.
3. Apply replay in sequence order; dedupe by `(runtimeEpoch,eventSeq)`.
4. Drop buffered events in the returned epoch with seq <= throughSeq.
5. Apply remaining buffered events in order and store the cursor.
6. If truncated, show partial-output warning. On terminal runtime IDLE, refetch snapshot and
   clear the warning.

After TaskRunner terminal persistence and rollout flush, the manager loads a fresh snapshot,
transitions to IDLE, and clears the finished epoch's ring. Snapshot refresh must precede the
IDLE runtime event so an attach observing IDLE always gets committed history.

Task completion alone does not imply IDLE. TaskRunner registers eligible post-turn lifecycle
work synchronously before emitting its terminal event. Session notifies only when active
tasks, shadow jobs, and lifecycle-work leases cross the empty/non-empty boundary; the
manager's rechecked empty edge is the RUNNING → IDLE trigger and dispatches at most one
queued input.

## 10. Runtime state machine and queue serialization

Legal transitions are exactly the design §3.1 table. `transition` asserts them in all builds
and emits both the new runtime event and the derived legacy event during migration.

Soft-deleted entries retain logical DELETING state even when absent from the live map.
`undelete` transitions to SUSPENDED after clearing delete/purge fields; hard purge removes
the state entry and is the only terminal deletion. A delete tombstone arriving in
SUSPENDING wins over eviction and transitions directly to DELETING.

Use generalized `PerKeyOperationQueue` from today's `LeaseLifecycleQueue`. Public methods
mutate session state under that queue, but release it before requesting capacity. Required
maps/sets:

```ts
live: Map<sessionId, AssembledAgent>;
states: Map<sessionId, SessionRuntimeState>;
openFlights: Map<sessionId, Promise<OpenResult>>;
pendingSubmits: Map<sessionId, PendingSubmit[]>;
capacityReservations: Map<sessionId, { replacing?: sessionId }>;
evictionClaims: Set<sessionId>;
pendingHydrations: FIFO<sessionId>; // unique IDs, max 32
capacityTicketBySession: Map<sessionId, number>;
deleteTombstones: Set<sessionId>;
```

Concurrent `open` callers receive the same `openFlights` promise. Hydration completion order:

1. verify tombstone absent;
2. reconcile config/auth generations to a stable point as specified in §4.2;
3. publish live handle and activate/drain the preinstalled event gate;
4. transition HYDRATING → IDLE;
5. dispatch at most one pending submission.

Failure disposes partial graph, releases reservation, transitions to SUSPENDED, emits
hydration failure and failed submission events, and drains capacity queue. No failure path
leaves HYDRATING or an orphan reservation.

## 11. Capacity scheduler and LRU

Defaults and validation:

```ts
{ maxLive: 5, hardMax: 10, maxPendingHydrations: 32, maxPendingPerSession: 8 }
// require 1 <= maxLive <= hardMax; both queue bounds > 0
```

These values govern only `managed-interactive`. The separate eager/non-internal budget uses
the existing `RegistryConfig.maxConcurrent` default and validation (5 today); do not silently
derive it from `maxLive` or `hardMax`. Eager construction never reserves, evicts, or queues
behind a managed-interactive handle. Managed admission never counts, evicts, or waits for an
eager handle. `internal:true` still bypasses the eager budget. Thus client mode may have up
to `hardMax` managed graphs plus `maxConcurrent` eager non-internal graphs, plus explicitly
internal infrastructure graphs; platform-specific outer limits still apply. In headless
eager mode this split is inactive and the existing registry limit remains authoritative.

Count `capacityReservations + live(IDLE|RUNNING|SUSPENDING)` for managed interactive
sessions, except a reservation paired to a still-live replacement victim consumes that
victim's existing slot rather than an additional slot. HYDRATING is represented by its
reservation and must not be double-counted.

Admission pseudocode under one short manager queue key `__capacity__`:

```ts
if (already reserved/live) return admitted;
pruneExpiredSurfaceLeases();
if (counted < maxLive) reserve(requester);
else if (victim = oldestEligibleIdle()) {
  claimEviction(victim);            // synchronous marker; no session queue wait here
  reserve(requester, { replacing: victim }); // paired before releasing scheduler
  scheduleVictimRecheckAndSuspendOutsideLock(victim);
} else if (counted < hardMax) reserve(requester);
else if (!pendingHydrations.has(requester) && queueHasRoom) enqueue(requester);
else return queueFull;
```

Eligible victim: managed interactive, unclaimed, IDLE, no background work, no pending submissions,
no awaiting-input token, and no live surface lease. Order by `lastActiveAt`, stable tie
`sessionId`. Slow suspend/assembly never runs under capacity scheduler. Every release/failure
drains FIFO, records the next reservation before leaving the scheduler, then starts hydration
outside it.

A replacement reservation is non-assembling until its victim has fully suspended. On
successful teardown, atomically clear `replacing` and start requester hydration; therefore
managed interactive agent graphs never exceed `hardMax`, even when the pool is exactly full. If victim
eligibility changed before SUSPENDING or teardown fails, cancel/re-admit the requester rather
than assembling against an unfreed slot.

Suspend order is: transition SUSPENDING → await rollout + index flush → dispose. If either
flush fails, do not call dispose; transition the intact graph back to IDLE, clear the
eviction claim, and re-admit the requester by its existing ticket. If flush succeeded,
dispose allSettled, remove the handle, transition SUSPENDED, and release/convert capacity
even when the report contains cleanup failures. A submit queued during a flush rollback is
then dispatched from IDLE in FIFO order.

`claimEviction` is only a synchronous duplicate-pick guard. After leaving capacity, enqueue
on the victim's session queue, re-check every eligibility predicate, then transition to
SUSPENDING. The capacity scheduler never awaits or enters a session queue. This is the exact
lock order; tests force a submit between claim and re-check.

Assign a monotonic capacity ticket the first time a session must wait/replace. Re-admission
after a failed victim keeps that ticket, so it cannot jump behind later arrivals. The global
FIFO is unique by session and ordered by ticket; delete/cancel removes its ticket. Reported
`capacityPosition` is a snapshot and may improve as earlier sessions leave.

State stays SUSPENDED while waiting capacity. A prewarm `session.open` reports queued/busy;
a submit reports queued if enqueued and queue-full only when the global/per-session bound is
exhausted. New Chat index creation is capacity-independent.

Exact open contract:

```ts
type OpenRequest =
  | { sessionId?: undefined; intent?: 'index-only' }
  | { sessionId: string; intent: 'prewarm' };

interface OpenResult {
  entry: ThreadIndexEntry;
  runtime: SessionRuntimeView;
  capacityStatus: 'not-requested' | 'admitted' | 'queued' | 'busy' | 'failed';
  capacityPosition?: number;
  liveCount: number;
  maxLive: number;
}
```

Use `failed` for a completed-but-failed prewarm and populate `runtime.lastFailure`.
Hydration failures resolve a typed result rather than leaking raw
constructor errors through the service boundary. Clear `lastFailure` when a later hydration
succeeds. The value is manager-memory only; after worker restart the session is simply
SUSPENDED/retryable.

New open always uses `index-only`. Existing-session open accepts only explicit `prewarm`;
UserInput triggers hydration without requiring an open call. Implement `open` as a normal
promise-returning method (not an `async` wrapper) when an `openFlights` entry exists so
coalesced callers receive the exact stored promise object.

## 12. Durable per-session mode

`ThreadIndexEntry.agentMode` is desired/applied durable mode and seeds AssembleInput.
`threadStore.mode` becomes a projection, not separately persisted.

Creation/backfill uses `preferences.defaultMode ?? DEFAULT_MODE`, normalized through the
target `AgentPromptLoader.supportsMode(mode)`. Unsupported modes (notably `code` for the
extension `workx` agent type) become `DEFAULT_MODE`; `session.setMode` rejects them rather
than persisting a mode the composer will ignore (`UNSUPPORTED_MODE`).

`session.setMode({sessionId,mode})` behavior:

| State | Behavior |
|---|---|
| SUSPENDED | validate mode, persist index, emit applied ModeChanged; no hydration |
| HYDRATING | persist desired mode; publish step re-reads index under the same session queue and applies newest value |
| IDLE | apply prompt/context, then persist and emit applied |
| RUNNING | set manager/agent pending mode and emit `applied:false`; at turn boundary apply, persist, emit `applied:true` |
| SUSPENDING | persist desired mode; next hydration uses it |
| DELETING | reject deleted |

Do not persist RUNNING pending mode as applied before `applyAgentMode` succeeds. If apply
fails, preserve old index value, clear/retain pending according to retry policy, and emit an
Error; the index must never claim a mode the live TurnContext does not use.

Assembly itself runs outside the session queue. Its publish step re-enters that queue,
re-checks tombstone, then reads current `agentMode` and applies any delta before exposing the
handle. Thus a `setMode` during a slow hydrate cannot be lost without adding another global
generation counter.

## 13. UI integration map

Phase 4 replaces the post-PR-298 split model:

- `ChatHistorySection` reads `threadStore` populated by paged `session.list`; it does not
  directly call RolloutRecorder/listConversations for the primary list. Scroll loads the next
  cursor; debounced search resets the page and sends `query` to the backend.
- Remove the chat-history resume-request bridge for primary navigation.
- Fold `Main.svelte`'s separate `threadStates`/processed-event maps into threadStore.
- Remove `ThreadBar.svelte` and `ThreadTab.svelte`; the left list is navigation.
- `threadStore` holds index fields, runtime view, durable mode projection, conversation
  buffer, attach cursor, pending submissions, and attach/hydration errors per session.
- Persist only local `activeSessionId` if desired; durable list/title/pin/mode comes back from
  `session.list`.

Startup/navigation flows:

```
bootstrap -> session.list(first page) -> merge store -> choose local active -> setViewed -> attach
New Chat  -> session.open({}) -> add index projection -> setViewed -> attach(empty)
click     -> setViewed -> attach -> optional open(prewarm)
send      -> render sending(clientMessageId) -> session.submit
hide      -> stop heartbeat + releaseSurface
```

The persisted active ID may fall outside the first page. Try `setViewed` + `attach` by that
explicit ID and merge the returned entry; on `SESSION_NOT_FOUND`/`SESSION_DELETED`, fall back
to the first listed row. If the first page is empty, call New Chat. Do not page through the
entire index merely to restore selection.

When a runtime/attention event names a session absent from loaded pages, threadStore performs
one coalesced `session.get` and merges the row before updating aggregate badges. Failure to
load a deleted/purged row drops the stale runtime stub. This lets an old thread running in
another surface deep-link correctly without an all-index bootstrap.

Replace `Main.svelte.startNewConversation` rather than adapting it: it must consume the ID
returned by `session.open({})`, select that ID, and leave the previous thread unchanged.
It must not clear the selected thread's buffers first and must never call `session.reset`.

All surfaces merge `session_index_changed` into the list projection. Soft-delete removes it
from the normal list but keeps the returned entry locally for Undo; restored re-inserts by
the canonical sort; purge drops any Undo state.
For an unknown upsert outside the loaded page/query boundary, mark that page dirty rather
than retaining every event forever; known, pinned, currently selected, and attention rows
merge immediately. Refresh the dirty page on next navigation. Runtime-fetched rows outside
loaded pages may be evicted after they become IDLE with no attention and are not selected,
keeping store growth proportional to pages the user actually loaded plus live exceptions.

Startup readiness must also stop depending on a live primary agent. Make
`agent.getAccessState` read bootstrap-owned RuntimeState/AuthContext/config (updated on auth
and config changes), not scan `registry.listSessions`; delete `isPrimarySessionId`. Both
extension and desktop UI use this global service. Keep `agent.healthCheck(sessionId)` only as
a live-agent diagnostic and never use it to disable input for a SUSPENDED chat. A suspended
`agent.interrupt` returns `{success:true,status:'not-running'}` rather than throwing.

The shared raw-rollout projection is a pure webfront function used by attach, committed
refresh, rewind preview, and tests. `restoreAllThreadHistories` and per-session live
`session.getState` history calls are deleted.

## 14. Turn recovery markers and MV3

Current rollout policy does not persist `TaskStarted`, and existing `turn_completion` is not
wired by TaskRunner. Add:

```ts
type RolloutItem =
  | ...
  | {
      type: 'turn_start';
      payload: {
        markerVersion: 1;
        submissionId: string;
        startedAt: number;
        /** Required for managed UserInput; absent for scheduled/internal legacy turns. */
        clientMessageId?: string;
        inputDigest?: string;
      };
    }
  | {
      type: 'turn_completion';
      payload:
        | { turnId: string; stats: unknown } // existing legacy shape
        | {
            markerVersion: 1;
            submissionId: string;
            outcome: 'complete' | 'failed' | 'aborted' | 'interrupted';
            completedAt: number;
          };
    };
```

Keep restart discovery bounded to metadata, never full-rollout scans:

```ts
interface RolloutRecoveryMetadata {
  openTurns: Array<{
    submissionId: string;
    startedAt: number;
    clientMessageId?: string;
    inputDigest?: string;
  }>;
  recentAccepted: Array<{
    clientMessageId: string;
    inputDigest: string;
    submissionId: string;
  }>; // newest first, max 128
}

interface SessionMetaLine {
  /** Metadata-record-only; the original session_meta rollout item is not rewritten. */
  runtimeRecovery?: RolloutRecoveryMetadata;
}
```

Extend `RolloutStorageProvider.addItems` with recovery mutations derived by RolloutWriter
from markerVersion:1 turn_start/turn_completion items; ignore the existing legacy completion
payload. Both current providers already append items and update
metadata in one transaction; in that same transaction update `sessionMeta.runtimeRecovery`.
Start adds `openTurns` and, when client fields exist, upserts/trims `recentAccepted`.
Completion removes the matching open turn. Preserve this JSON field in IndexedDB metadata and
the existing SQLite `session_meta` JSON column, so no second database or SQLite column is
needed. Add provider methods `getRecoveryMetadata(sessionId)` and
`listOpenTurnRecovery()`; the latter may scan only the small metadata store/column and returns
rows whose openTurns are non-empty. Provider-parity tests crash at every transaction boundary.

Add `turn_start` to rollout schema/writer types. Thread the manager metadata through
RepublicAgent/Engine/Session into TaskRunner. At TaskRunner start, await start-marker
persistence before emitting TaskStarted. For managed UserInput, assert both durable fields
are present; other turn sources omit both. A start write failure aborts before model/tool side
effects and emits a failed submission event. On every complete/fail/abort path, persist the
terminal marker before its terminal event. Extend `TurnAbortReason` with `worker_restart`.

On manager startup, call `listOpenTurnRecovery`, append one persisted
`TurnAborted{reason:'worker_restart',submission_id}` plus terminal interrupted marker for each
open turn, and refresh only those snapshots. The atomic completion update removes them, making
recovery idempotent across repeated wakes. Load `recentAccepted` lazily on first
submit/attach/hydrate for a session to seed its ACK LRU; no startup path reads every rollout
item. The client marker lets attach reconcile a local orphan without resubmitting it.

TaskRunner owns a `terminalMarkerWritten` guard. Normal, failed, and aborted branches write
their outcome before emitting the matching terminal event; a `finally` block writes `failed`
if an unexpected throw escaped before any branch did so. Marker-write failure is logged and
reported through lifecycle telemetry but must not replace the user's original task result.
If all terminal-write retries fail, runtime state reports durability degradation and the
metadata intentionally remains open; a later restart conservatively recovers it as
interrupted rather than pretending the turn was durably complete.

## 15. TabGroupRegistry and foreground attention

```ts
interface TabGroupRegistry {
  claimExisting(sessionId: string, tabId: number): Promise<TabLease>;
  createForSession(sessionId: string, options?: { active?: boolean }): Promise<TabLease>;
  setCurrent(sessionId: string, tabId: number): Promise<void>;
  browserContextFor(sessionId: string): Promise<SessionBrowserContext | null>;
  release(sessionId: string, tabId: number): Promise<void>;
  releaseAll(sessionId: string): Promise<void>;
  handleTabClosed(tabId: number): Promise<void>;
  groupFor(sessionId: string): Promise<TabGroupRecord | null>;
  ownerOf(tabId: number): Promise<string | null>;
  isOwned(sessionId: string, tabId: number): Promise<boolean>;
}

interface SessionBrowserContext {
  tabId: number;
  url: string;
  hostname: string;
}

interface BrowserTabDescriptor extends SessionBrowserContext {
  title?: string;
  status?: 'loading' | 'complete';
}

interface ForegroundGrant {
  grantId: string;
  sessionId: string;
  tabId: number;
  expiresAt: number;
}

interface SessionBrowserResources {
  readonly sessionId: string;
  current(): Promise<SessionBrowserContext | null>;
  listOwned(): Promise<BrowserTabDescriptor[]>;
  claimExisting(tabId: number, origin: 'agent' | 'user'): Promise<BrowserTabDescriptor>;
  create(options?: { url?: string; active?: false }): Promise<BrowserTabDescriptor>;
  getOwned(tabId: number): Promise<BrowserTabDescriptor>;
  setCurrent(tabId: number): Promise<void>;
  navigate(tabId: number, url: string): Promise<BrowserTabDescriptor>;
  reload(tabId: number): Promise<void>;
  close(tabId: number): Promise<void>;
  captureVisible(tabId: number, grant?: ForegroundGrant): Promise<string>;
  controller(tabId: number): Promise<IBrowserController | null>;
  releaseAll(): Promise<void>;
}
```

Add `browserResources?: SessionBrowserResources` to IPlatformAdapter and remove its raw
claim/release/current-tab methods after callers migrate. The assembler constructs the adapter
with the authoritative sessionId. Every method verifies ownership; `create` is non-active,
and any operation requiring visibility/activation obtains a ForegroundGrant first. Core
interfaces use BrowserTabDescriptor, never `chrome.tabs.Tab`, so desktop/headless builds do
not depend on Chrome types. Extension methods delegate to TabGroupRegistry + Chrome; desktop
methods delegate to the ID-carrying bridge; headless omits the capability.

Serialize mutations globally because TabLeaseStore persists one shared blob. Group records
in `chrome.storage.session` contain sessionId, groupId, label, tabIds, and currentTabId.
`setCurrent` first verifies ownership; release selects a deterministic remaining tab or null.
`browserContextFor` verifies the current lease, reads the tab, normalizes hostname, and
returns null for no current tab, a closed tab, or a non-web URL. Allocate labels
`a..z, aa..az, ...` from active records and reuse only after release. On suspend,
release/ungroup but leave tabs open. Tab close only removes lease/group membership.

The migration boundary is strict: outside TabGroupRegistry and the session-scoped platform
adapter/bridge executor, agent execution code may not call `chrome.tabs`/`chrome.tabGroups`.
Inventory and migrate (or deduplicate before migrating):

- `core/TabManager`, `core/registry/AgentSession`, `core/TurnManager`,
  `core/hooks/toolRuntimeContext`, and the tab methods in `core/session/state/SessionServices`;
- `tools/BaseTool` active/validation fallbacks plus the canonical `DataExtractionTool`,
  `FormAutomationTool`, `NavigationTool`, `PageVisionTool`, and `WebScrapingTool`;
- the divergent `extension/tools` copies of DOM/DataExtraction/FormAutomation/Navigation/
  PageVision/WebScraping (repository search must cover both trees);
- `extension/platform/ExtensionPlatformAdapter`, the old
  `extension/tools/browser/tabLeaseStore`, and `extension/bridge/BridgeExecutor`;
- service-worker `executeTabCommand`/quick-action browser operations: move session execution
  into the adapter/bridge. An explicit context-menu/shortcut tab may be read at the global
  entrypoint, but it is passed as `requestedTabId` and claimed for the resolved session before
  agent work. Screenshot/activation still requires the focus preflight below.

Keep only truly global Chrome calls outside this boundary: extension install/welcome,
settings/gateway UI, OAuth tabs, scheduler UI launch, channel/content-script transport, and
TabGroupRegistry's own tab listeners/liveness checks. Add a repository guard test over
production files so a future tool cannot reintroduce sessionless active-tab lookup.

Session-scoped ExtensionPlatformAdapter enforces focus policy. Background create is
`active:false`; activation is allowed only with a live viewed-surface lease. A required
foreground action creates:

```ts
interface BrowserAttentionRequest {
  requestId: string;
  sessionId: string;
  tabId: number;
  reason: 'login' | 'permission' | 'user-gesture';
}
```

Service result:

```ts
session.resolveAttention({ surfaceId, requestId }): Promise<
  | { status: 'granted'; grantId: string; expiresAt: number }
  | { status: 'expired' | 'not-found' }
>;
```

Every focus-requiring tool performs this check before side effects. `requestForeground`
returns a promise and adds the awaiting-input token.
`session.resolveAttention({surfaceId,requestId})` verifies the request/session, current
surface lease, and tab ownership, then resolves a one-shot 30 s `ForegroundGrant`. The
platform adapter consumes that grant when it resumes. Abort/delete rejects and removes it.

### 15.1 Desktop bridge identity/focus handoff (D21)

Current `BrowserBridgeToolManager.applyToRegistry(sessionId, ...)` captures no session ID in
its proxy callback, while `BridgeExecutor` uses one `BRIDGE_SESSION_ID` and one current tab.
Replace that with the following end-to-end contract:

```ts
// packages/ws-server node invoke schema; operation defaults to 'tool' for compatibility
interface NodeInvokePayload {
  invokeId: string;
  operation: 'tool' | 'release-session' | 'browser-context';
  sessionId: string;
  toolName?: string;
  parameters?: Record<string, unknown>;
  timeoutMs?: number;
  focusGrantId?: string;
}

interface BrowserBridgeHandle {
  hasActiveNode(): boolean;
  applyToRegistry(sessionId: string, registry: ToolRegistry): Promise<void>;
  getSessionBrowserContext(sessionId: string): Promise<SessionBrowserContext | null>;
  releaseSession(sessionId: string): Promise<void>;
}
```

- Register proxy closure `(params) => invoke(sessionId, tool.name, params)`.
- `NodeBridge.invoke` and `BridgeClient.handleInvoke` carry sessionId/focusGrantId.
- BridgeExecutor owns `currentTabBySession: Map<string, number>` and claims/groups tabs under
  a bridge owner derived from that session (for example `desktop:<sessionId>`); delete the
  process-global `BRIDGE_SESSION_ID`.
- A background invocation may execute non-activating work. If focus is required, executor
  returns typed `FOREGROUND_REQUIRED{tabId,reason}` **before side effects**.
- BrowserBridgeToolManager converts that response into SessionManager
  `requestForeground`, waits for the UI grant, then retries once with `focusGrantId`.
  BridgeExecutor consumes it for the matching session only. No generic automatic retry is
  allowed after a tool has begun side effects.
- Assembled desktop platform disposal calls `BrowserBridgeHandle.releaseSession`; it sends
  `operation:'release-session'`, clears only that session's current tab, and invokes
  TabGroupRegistry.releaseAll. Bridge disconnect releases all remaining bridge owners.

### 15.2 Per-session domain-conditioned skills (D25)

The stored skill catalog and CRUD services remain process-shared. Availability used to build
an agent prompt is a per-load, per-session view:

```ts
interface SessionSkillView {
  buildSystemPrompt(): Promise<string>;
}

createSessionSkillView(
  catalog: SkillRegistry,
  getBrowserContext: () => Promise<SessionBrowserContext | null>,
): SessionSkillView;
```

Make domain matching a pure function over `catalog.getAllSkillMetas()` and the supplied
hostname; remove `SkillRegistry.domainFilter`, the service-worker `ActiveTabService` /
`ChromeActiveTabAdapter` singleton, and global skills prompt registration. No current browser
context means only unconditional skills are advertised. The extension view reads
`TabGroupRegistry.browserContextFor(sessionId)`; the desktop view calls the bridge's
`browser-context` operation, which reads only `currentTabBySession[sessionId]`; headless
server uses null. The assembler registers `() => view.buildSystemPrompt()` on that agent's
`AgentPromptLoader`.

This filtering controls prompt advertisement, matching current behavior; explicit user skill
invocation and global skill CRUD still address the full catalog. Capture context immediately
before each prompt composition. A same-session navigation race may affect one prompt and is
corrected on the next turn, but another session's active tab can never influence the result.

## 16. Observability

Use existing privacy-gated `src/core/telemetry/logEvent`, not DiagnosticRegistry:

| Event | Numeric/boolean metadata |
|---|---|
| `session_hydrated` | duration_ms, live_count, queued_count |
| `session_suspended` | duration_ms, live_count |
| `session_evicted` | live_count |
| `session_capacity_queued` | queue_depth, live_count |
| `session_hydrate_failed` | duration_ms |
| `session_submission_queued` | session_depth, global_depth |

Do not include session IDs, titles, prompts, error strings, URLs, or model content. Add a
doctor check returning current lifecycle counts/status for local support. Unit tests attach
an in-memory telemetry sink and explicitly enable the gate.

## 17. Compatibility and convergence

- `session.create` delegates to index-only `session.open({})`; `session.resume` delegates to
  `open(existingId)` without killing any other session.
- While the rollout flag is false, existing create/resume/close behavior remains eager so
  main's pre-Phase-4 UI is unchanged. Client-mode compatibility `session.close` force-
  suspends/aborts the live graph using the distinct `compat-close` teardown contract (§5.3)
  but retains ThreadIndex + rollout (old UI removes its local tab and old history still lists
  it); it is **not** soft delete. Phase 4 removes this UI call.
- While the rollout flag is false, `session.reset` retains today's eager compatibility
  behavior for the old bundled UI. In lifecycle mode it throws `SessionServiceError` with
  code `SESSION_RESET_UNSUPPORTED_IN_LIFECYCLE_MODE` and performs no mutation: changing
  the inner Session ID would violate the manager
  map/index identity invariant. Phase 4 first migrates New Chat to `session.open({})`; Phase
  5 removes the in-repo reset service and old compatibility branch. It is deliberately not
  an alias because reset-in-place has no safe durable-thread meaning.
- `session.turns` and `session.rewind` require explicit sessionId immediately. Rewind creates
  a new ThreadIndex ID and fork snapshot; source is untouched.
- Keep external `session.create`/`resume` aliases for at least two stable releases. Phase 5
  removes in-repo callers but does not infer safe external removal from silent telemetry.
- Legacy `SessionState` reads use `legacyState()` only for live sessions:
  hydrating→initializing, running→active, idle→idle, deleting/absent→terminated. Suspended and
  suspending are absent/non-dispatchable to legacy loops.
- Rename `AgentRegistry` to `SessionManager` only after behavior converges; the rename PR is
  mechanical and contains no lifecycle behavior changes.
- Phase 4 flips `MULTI_THREAD_LIFECYCLE` defaults on for extension+desktop in the same
  coordinated cutover that migrates submit/health/history/close/reset UI calls. Phase 5 deletes
  the flag and eager client branch after one stable release; server eager mode remains.

## 18. Phase acceptance gates

Each phase is mergeable only when its gate passes:

| Phase | Required acceptance evidence |
|---|---|
| 1 | rebuild reason union; task/shadow/title/suggestion/summary/compaction deferral including task→compact handoff; tracked queue settlement; TurnContext policy preservation; no listener after dispose; no double refresh on create |
| 2 | one initialize/prompt/memory build on extension+server; reserved ID preserved for new/resume/fork; auth closure follows context update; suspension emits balanced SessionEnd(reason=suspend) but no shutdown/abort/close; binder cleanup; two simultaneous agents get distinct base/dynamic/extension prompt contexts |
| 3a-1 | DB upgrade and SQLite allowlist tests; deterministic crash-safe backfill; empty snapshot; durable mode; surface lease clock tests; CRUD/undo/purge retry |
| 3a-2 | same-promise double open; delete during hydrate; generation race; capacity invariant under parallel hydrate; independent managed/eager pool saturation with unchanged headless/internal behavior; no lock cycle; FIFO submit/dedupe/overflow; atomic metadata-backed ACK/open-turn recovery without item scans; durability-degraded failure event; turn recovery idempotence |
| 3b | compile-time exhaustive config map; policy/reload full sweep; allSettled isolation; running deferral; hydrate generation reconciliation |
| 3c | two-session lease isolation; no tab-close termination; suspend leaves tabs open; background activation denied; attention resolve validates surface+ownership; domain-conditioned skill prompts use each session's browser context; repository guard finds no sessionless Chrome call in agent execution |
| 4 | attach race/dedupe/epoch/truncation; two-surface switch/TTL; A↔B streaming; orphan reconciliation/delivery-unknown explicit resend; narrow/wide parity; New Chat never calls reset; no primary history path depends on live agent |
| 5 | repo-wide no in-repo legacy calls, compatibility aliases retained, mechanical rename/typecheck, architecture docs updated |

Run the focused unit/integration suites for touched packages plus repository typecheck and
lint in every phase. Phase 3a-2 and Phase 4 additionally run deterministic fake-clock/fake-
assembler concurrency tests; wall-clock sleeps are not acceptable synchronization.
