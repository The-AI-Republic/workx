# Track 14: Plan Mode

**Priority: P1** · **Effort: M** · **Status: READY TO IMPLEMENT**

> Source: second-pass claudy↔browserx research (2026-05-14), implementation-readiness + multi-platform pass (2026-05-15). Grounded in a full read of claudy's plan-mode tools and browserx's approval pipeline across all three deploy targets — see "Validation Notes".

## Problem

BrowserX gates risky actions one at a time by **numeric risk score**. There is no "propose a full plan → freeze all mutations → one approval → execute" workflow. For an agent that takes real-world web/desktop actions (multi-step automation, form fills, purchases, file ops), per-action prompting is noisy and low-trust: the user never sees and approves the *whole intended sequence* before anything happens, and cannot edit the plan.

## What Claudy Does

Plan mode is a **permission mode**, not a tool wrapper or a risk score.

### Enter — `tools/EnterPlanModeTool/EnterPlanModeTool.ts`

A `buildTool` (`:36-126`): `isReadOnly() = true` (`:71-73`), `shouldDefer: true` (`:55`), and `isEnabled()` returns **false when `--channels` is active** (`:56-67`) — *"so plan mode isn't a trap the model can enter but never leave"* (the approval dialog needs the terminal). `call()` (`:77-102`):

```ts
handlePlanModeTransition(appState.toolPermissionContext.mode, 'plan')
context.setAppState(prev => ({ ...prev,
  toolPermissionContext: applyPermissionUpdate(
    prepareContextForPlanMode(prev.toolPermissionContext),     // strips dangerous perms, records prePlanMode
    { type: 'setMode', mode: 'plan', destination: 'session' }) }))
```

`mapToolResultToToolResultBlockParam` (`:103-125`) injects the read-only-exploration instruction ("DO NOT write or edit any files yet… use ExitPlanMode to present your plan for approval").

### Exit — `tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts`

`validateInput()` (`:195-220`) **rejects before the dialog** if `getAppState().toolPermissionContext.mode !== 'plan'`. `checkPermissions()` (`:221-239`) returns `{behavior:'ask', message:'Exit plan mode?'}` for non-teammates. `requiresUserInteraction()` (`:185-194`) true for non-teammates. The plan is a **disk artifact**: `getPlanFilePath(agentId)`/`getPlan(agentId)` (`utils/plans.ts`); a user-edited plan arrives via `permissionResult.updatedInput.plan`, re-written to disk and re-snapshotted (`:251-261`). On approval, `call()` (`:243-418`, restore block `:361-400`) restores `prePlanMode` (circuit-breaker fallback to `'default'` at `:329`) and **restores stripped dangerous permissions** (`restoreDangerousPermissions` `:392`). `allowedPrompts` (the input schema field, `:81`) lets the plan request **semantic grants** (`{tool:'Bash', prompt:'run tests'}`) carried out of plan mode. The result echoes the full approved plan back to the model ("(edited by user)" when changed).

`planModeV2.ts` adds an "interview phase" and multi-agent explore counts — **coding-agent specific, not relevant to browserx**.

## BrowserX Mapping

### The real seam

| Concern | BrowserX location | State |
|---|---|---|
| Approval interception | `ApprovalGate.check(toolName, params, assessor?, ctx?)` (`core/approval/ApprovalGate.ts:102-270`), injected into `ToolRegistry` | Pipeline: domain → assess → enhance → policy → **mode threshold** → hook → `ApprovalManager` |
| Mode | `ApprovalMode = 'balanced'\|'high_speed'\|'yolo'` (`types.ts:152`); `ApprovalGate.mode` (`:33`), `setMode/getMode` (`:54/61`) | Mode only changes the numeric `getAskThreshold()` (balanced 30 / high_speed 60) (`:310-317`) — **no categorical gating** |
| Decision | `ApprovalDecision='auto_approve'\|'ask_user'\|'deny'`; `ApprovalCheckResult` carries denial `reason` (`types.ts:39-45`) | |
| User interaction (ext/desktop) | `ApprovalManager.requestApproval(ApprovalRequest)` → `{decision,reason?}` (`ApprovalGate.ts:232-269`) via shared `webfront` dialog | Interactive, human present |
| User interaction (server) | `src/server/exec/approval-manager.ts` `requestApproval` (`:71`) — WS round-trip, **timeout** `config.server.exec.approvalTimeoutMs` (`:114`) → `decision:'timeout'` (`:121`); `cancelAll()` rejects on shutdown (`:167-177`); resolved remotely via `registerExecHandlers.resolveApproval` (`ServerAgentBootstrap.ts:506-510`) | **No human in-process**; resolves only if an operator client is connected |
| Session trust | `rememberDecision()` + risk-ceiling margin (`:169-181, 275-291`) | Reuse for plan-approved scoped grants |
| Hook seam | `PermissionRequest` fired before `ApprovalManager` (`:204-228`) (Track 01) | |
| Tool nature | Track 02 tool metadata `isReadOnly`/`isDestructive` | The correct signal for "what to freeze" — **not** the risk assessor |

### Per-Platform Behavior

Plan mode's load-bearing per-platform axis is **how the single "Exit plan mode?" approval resolves**, because read-only freezing is identical core logic everywhere.

- **BrowserX (extension)** & **Apple Pi (desktop).** Shared `webfront` `ApprovalManager` surfaces an interactive dialog (sidepanel/popup; desktop window). A human reviews, optionally **edits** the plan, approves/rejects. No timeout pressure. This is the canonical, fully-supported experience. One implementation covers both (shared `webfront`).
- **Apple Pi Server (headless).** `src/server/exec/approval-manager.ts` resolves approvals via a WS round-trip to a connected operator client, **with a timeout** (`:114`). Two sub-cases that the design must treat differently:
  - *Operator connected* (web UI watcher, Slack approver via connector): the "Exit plan mode?" request reaches them; they approve/reject/edit remotely within `approvalTimeoutMs`. Plan mode works — this is the case the existing draft's "ApprovalManager solves the trap for free" claim correctly covers.
  - *Fully unattended* (scheduled job, no client): the exit approval **times out** → resolves `'timeout'` → exit is denied → the agent is stuck in read-only plan mode and the scheduled job aborts. **Plan mode is genuinely a trap here.** This is browserx's analog of claudy's `--channels` trap, and it *does* need claudy's `isEnabled()===false` guard in spirit — see Divergence 3.

### Key design decisions (and divergences from claudy)

1. **Add `'plan'` to `ApprovalMode`, categorical not threshold.** New branch in `ApprovalGate.check()` *after* the yolo branch (`ApprovalGate.ts:164-167`): when `mode==='plan'`, deny/defer **every tool that is not read-only** regardless of risk score, keyed off **Track 02 tool metadata** (`isReadOnly`/`isDestructive`), not `RiskAssessment`. Read-only browser ops (DOM read, scrape, screenshot, non-mutating navigation) pass; form submit, downloads, destructive DOM actions, terminal writes, purchases (Track 23) freeze. **Divergence:** claudy enforces via `toolPermissionContext`; browserx's equivalent point is `ApprovalGate.check()` (where `ToolRegistry` already routes every call).
2. **`prePlanMode` + plan artifact.** `ApprovalGate` holds a flat `mode` with no restore slot — add `prePlanMode?: ApprovalMode` captured on entry, restored on exit (mirrors claudy's `toolPermissionContext.prePlanMode`). The plan is a **session-scoped artifact** persisted via the rollout/storage layer, surfaced to the model as a `context` InputItem (Track 13). **Divergence:** session store, not a `~/.claude` home-dir file.
3. **Enter/Exit as registered tools (Track 02/03); single exit gate via the platform's `ApprovalManager`; headless-trap guard ported in spirit.** `EnterPlanMode` → `approvalGate.setPlanMode()`; `ExitPlanMode` → one `ApprovalManager.requestApproval({type:'plan_approval',title:'Exit plan mode?',details:{plan}})`, then restore. **Refined divergence (corrects the first-pass draft):** the claim that `ApprovalManager` "solves claudy's `--channels` trap for free" is true *only when an approval-capable surface is reachable*. On Apple Pi Server with no connected operator and no managed-policy auto-resolution, the exit approval times out (`approval-manager.ts:114,121`) and plan mode **is** a trap. Therefore port claudy's `isEnabled()` guard *in spirit*: `EnterPlanMode.isEnabled()` returns **false** when `platformId==='server'` **and** the session has no reachable approver **and** no Track 20 managed-policy plan-resolution is configured. Where a policy *is* configured, the exit approval is resolved by policy (auto-approve plans matching an allowlist / auto-reject) instead of a human. Extension/desktop: always enabled (human present).
4. **`allowedPrompts` → scoped session-memory grants.** On plan approval, the plan declares scoped grants (e.g. "navigate within example.com", "submit checkout on shop.com"); seed them as pre-approved entries via existing `ApprovalGate.rememberDecision()` + risk-ceiling (`:275-291`) so execution does not re-prompt. **Reuse**, don't invent a grant system.
5. **Plan staleness re-validation (net-new vs claudy).** Page/DOM state changes between plan and execution. Critical mutating steps re-validate their precondition (element present, URL unchanged) before acting; on mismatch, re-ask. Claudy (filesystem, stable) doesn't need this; a browser agent does. On headless server this is *more* important — there is no human to notice a wrong page mid-execution.
6. **Teammate/coordinator approval maps to Track 04's sub-agent system.** Track 06 abandoned 2026-05-14; claudy's leader-mailbox path maps to Track 04's `SubAgentRegistry`, scoped per session. Do not design it here. See [[06_multi_agent_coordination_ABANDONED]].

## Implementation Plan (file-level, ordered)

Safety net: existing `ApprovalGate` tests; add plan-branch coverage. Track 02 metadata accuracy audit is a hard prerequisite.

**Phase 1 — categorical mode.**
- `core/approval/types.ts:152`: add `'plan'` to `ApprovalMode`.
- `core/approval/ApprovalGate.ts`: add `prePlanMode?: ApprovalMode` field (near `:33`); `setPlanMode()`/`exitPlanMode()` capturing/restoring it (circuit-breaker fallback to `'balanced'`); new categorical branch after `:164-167` keyed off Track 02 `isReadOnly`/`isDestructive` (not the assessor).
- **Forward-traced exhaustiveness (2026-05-15):** adding `'plan'` to the union (`types.ts:152`) breaks the two `switch(this.mode)` blocks in `getAskThreshold()` (`:311`) and the risk-ceiling switch (`:324`). Add `case 'plan'` to both returning an unreachable sentinel, **mirroring the existing `case 'yolo': return 100; // unreachable (yolo handled above)`** (`:314`) — plan, like yolo, is handled categorically *before* these are reached. This is the precedent that validates the "categorical, not threshold" design; the change is localized (~4 sites: union, branch, 2 switches, `prePlanMode`).
- Audit `browser_dom` action classification (read vs click/type/submit) — the gate is only as sound as this metadata (see Risks).

**Phase 2 — Enter/Exit tools + artifact.**
- `EnterPlanMode` tool (Track 02/03 registration): calls `setPlanMode()`, returns the injected read-only-exploration instruction (port claudy `:103-125`). `isEnabled()` per Divergence 3 — inject `IPlatformAdapter.platformId` + an "approver reachable?" probe (server: any connected exec-approval client / configured Track 20 policy).
- Plan artifact: persist session-scoped via the rollout/storage layer; surface as a `context` InputItem (Track 13).
- `ExitPlanMode` tool: `validateInput` rejects if not in plan mode (port claudy `:195-220`); one `ApprovalManager.requestApproval` (ext/desktop: `core/approval` manager; server: `src/server/exec/approval-manager.ts`); on approve restore `prePlanMode`; echo approved plan back to the model (port `:481-491`).

**Phase 3 — editable plan.**
- Carry a user-edited plan back through the `ApprovalManager` response payload (analog of claudy `updatedInput.plan`); re-persist + re-snapshot; label "(edited by user)".

**Phase 4 — scoped grants + staleness.**
- Plan-declared scoped grants seeded via `rememberDecision()` + risk ceiling on approval.
- Per-step precondition re-validation for critical mutating steps; mismatch → re-ask (or, headless with no approver, abort with a clear transcript note).

## Dependencies

- **Track 02** (Tool Metadata): `isReadOnly`/`isDestructive` is the gate signal — hard dependency.
- **Track 03** (Commands): `/plan` toggle; `EnterPlanMode`/`ExitPlanMode` registration.
- **Track 13** (Input Pipeline): plan artifact surfaced as a `context` InputItem.
- **Track 15** (Rewind): a rejected plan should be discardable (rewind special case).
- **Track 20** (Managed Settings): supplies headless plan-resolution policy (auto-approve allowlist / disable plan mode for unattended jobs) — the alternative to a connected approver on Apple Pi Server.
- **Track 04** (sub-agent system): coordinator/teammate plan-approval routing (Track 06 abandoned).
- Existing `ApprovalGate`/`ApprovalManager`/`PolicyRulesEngine`/`HookDispatcher`.

## Risks

- Read-only enforcement must be airtight: a mis-tagged "read" tool that mutates breaks the trust model — depends entirely on Track 02 metadata accuracy; **audit `browser_dom` action classification** (read vs click/type/submit) as a Phase 1 gate.
- Scoped grants must be tightly bounded (domain + action + tab) — reuse the risk-ceiling margin so an escalated action still re-prompts (`ApprovalGate.ts:169-181`).
- Plan staleness — browser DOM is not a stable filesystem; worse headless (no human safety net).
- `ApprovalGate.mode` is process-global today; multi-session/multi-agent (Track 04) needs plan mode scoped per session/agent — flag for the scoping design.
- **Headless trap:** without Divergence 3's `isEnabled()` guard + Track 20 policy, an unattended scheduled job that enters plan mode is unrecoverable (exit approval times out). The guard must land in the same phase as `EnterPlanMode`.

## Validation Notes (verified vs claudy + browserx source, 2026-05-14 / multi-platform pass 2026-05-15)

- claudy: `tools/EnterPlanModeTool/EnterPlanModeTool.ts` (`:55` shouldDefer, `:56` `isEnabled`/`--channels` trap guard, `:71` `isReadOnly`, `:83` `handlePlanModeTransition`, `:91` `prepareContextForPlanMode`, `:103` injected instruction); `tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts` (`:81` `allowedPrompts` schema, `:185` `requiresUserInteraction`, `:195` `validateInput` mode-reject, `:221` `checkPermissions`, `:246` `getPlanFilePath`, `:329` circuit-breaker fallback, `:361-400` prePlanMode/dangerous-perm restore); `utils/planModeV2.ts` (interview phase — excluded).
- browserx core: `core/approval/ApprovalGate.ts:28-63,102-270,164-167,169-181,204-228,232-269,275-291,310-317`; `core/approval/types.ts:39-45,152`.
- browserx platforms: shared `webfront` `ApprovalManager` (ext + desktop dialog); `src/server/exec/approval-manager.ts:25,29,42-43,71,114,118-127,140-156,161,167-177` (timeout/cancel semantics); `src/server/agent/ServerAgentBootstrap.ts:506-510` (`resolveApproval` WS wiring), `:262` (server `ApprovalManager` instantiation); `core/platform/IPlatformAdapter.ts:60` (`platformId` gate for `isEnabled`).

Corrections vs the first-pass draft:
1. Modes are *purely numeric thresholds* (`ApprovalGate.ts:310-317`) — plan mode must be a **categorical branch** keyed off Track 02 metadata (hard dependency the draft missed).
2. Plan artifact is a session-store record surfaced as a Track 13 `context` InputItem — not a `~/.claude` file.
3. `allowedPrompts` maps onto the **existing** `rememberDecision()`/risk-ceiling, not a new subsystem.
4. **Refined (2026-05-15):** the prior claim that browserx's `ApprovalManager` makes claudy's plan-mode trap a non-issue "for free" is **only half true**. It holds when an approval surface is *reachable* (connected sidepanel/desktop/operator). On Apple Pi Server with no connected approver, `approval-manager.ts:114,121` times the exit approval out and the trap is real — so claudy's `isEnabled()` guard **is** ported, keyed on `platformId==='server'` + approver-reachability + absence of Track 20 plan-resolution policy, rather than claudy's `--channels` boolean.
5. **Multi-platform (2026-05-15):** ext + desktop share one `webfront` approval dialog (single implementation); the server path is a distinct `ApprovalManager` with timeout/remote-resolve semantics that materially change plan-mode viability for unattended jobs.
