# Track 14: Plan Mode

**Priority: P1** · **Effort: M** · **Status: NOT STARTED**

> Source: second-pass claudy↔browserx research (2026-05-14). Grounded in a full read of claudy's plan-mode tools and browserx's approval pipeline — see "Validation Notes" for exact `file:line` citations.

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

`validateInput()` (`:195-220`) **rejects before the dialog** if `getAppState().toolPermissionContext.mode !== 'plan'`. `checkPermissions()` (`:221-239`) returns `{behavior:'ask', message:'Exit plan mode?'}` for non-teammates (teammates bypass → leader mailbox). `requiresUserInteraction()` (`:185-194`) true for non-teammates. The plan is a **disk artifact**: `getPlanFilePath(agentId)` / `getPlan(agentId)` (`utils/plans.ts`); a user-edited plan arrives via `permissionResult.updatedInput.plan`, is re-written to disk and re-snapshotted (`:251-261`). On approval, `call()` (`:357-403`) restores `prePlanMode` (with a circuit-breaker fallback to `'default'`) and **restores stripped dangerous permissions** (`restoreDangerousPermissions`). `allowedPrompts` (`:64-75`) lets the plan request **semantic grants** (`{tool:'Bash', prompt:'run tests'}`) carried out of plan mode. The result echoes the full approved plan back to the model (`:481-491`, labeled "(edited by user)" when changed).

`planModeV2.ts` adds an "interview phase" and multi-agent explore counts — **coding-agent specific, not relevant to browserx**.

## BrowserX Mapping

### The real seam

| Concern | BrowserX location | State |
|---|---|---|
| Approval interception | `ApprovalGate.check(toolName, params, assessor?, ctx?)` (`core/approval/ApprovalGate.ts:102-270`), injected into `ToolRegistry` | Pipeline: domain → assess → enhance → policy → **mode threshold** → hook → `ApprovalManager` |
| Mode | `ApprovalMode = 'balanced'\|'high_speed'\|'yolo'` (`types.ts:152`); `ApprovalGate.mode` (`:33`), `setMode/getMode` (`:54/61`) | Mode only changes the numeric `getAskThreshold()` (balanced 30 / high_speed 60) (`:310-317`) — **no categorical gating** |
| Decision | `ApprovalDecision = 'auto_approve'\|'ask_user'\|'deny'`; `ApprovalCheckResult` can carry denial `reason` (`types.ts:39-45`) | |
| User interaction | `ApprovalManager.requestApproval(ApprovalRequest)` → `{decision,reason?}` (`ApprovalGate.ts:232-269`) | Already abstracts sidepanel/desktop/channel surfaces |
| Session trust | `rememberDecision()` + risk-ceiling margin (`:169-181, 275-291`) | Reuse for plan-approved scoped grants |
| Hook seam | `PermissionRequest` fired before `ApprovalManager` (`:204-228`) (Track 01) | |
| Tool nature | Track 02 tool metadata `isReadOnly`/`isDestructive` | The correct signal for "what to freeze in plan mode" — **not** the risk assessor |

### Key design decisions (and divergences from claudy)

1. **Add `'plan'` to `ApprovalMode`, but it behaves categorically, not as a threshold.** Insert a new branch in `ApprovalGate.check()` *after* the yolo branch (`ApprovalGate.ts:164-167`): when `mode === 'plan'`, deny/defer **every tool that is not read-only** regardless of risk score, keyed off **Track 02 tool metadata** (`isReadOnly`/`isDestructive`), not `RiskAssessment`. Read-only browser ops (DOM read, scrape, screenshot, non-mutating navigation) pass; form submit, downloads, destructive DOM actions, terminal writes, purchases (Track 23) are frozen. **Divergence:** claudy enforces this via its `toolPermissionContext` permission layer; browserx's equivalent enforcement point is `ApprovalGate.check()` because that is where `ToolRegistry` already routes every call.

2. **`prePlanMode` + plan artifact.** `ApprovalGate` holds a flat `mode` field with no restore slot — add `prePlanMode?: ApprovalMode` captured on entry and restored on exit (mirrors claudy's `toolPermissionContext.prePlanMode`). The plan itself is a **session-scoped artifact** persisted via the rollout/storage layer and surfaced to the model as a `context` InputItem (Track 13) — browserx has no `~/.claude` plan file; **divergence:** use the session store, not a home-dir file.

3. **Enter/Exit as registered tools (Track 02/03), single exit gate via existing `ApprovalManager`.** `EnterPlanMode` handler → `approvalGate.setPlanMode()` (captures `prePlanMode`, strips trusted/destructive session memory); `ExitPlanMode` handler → one `ApprovalManager.requestApproval({type:'plan_approval', title:'Exit plan mode?', details:{plan}})`, then restore. Reuse the `ApprovalManager` surface — **this solves claudy's `--channels` "plan mode is a trap" problem for free**: browserx's `ApprovalManager` already abstracts non-terminal interaction surfaces, so plan mode is *not* a trap on sidepanel/channel/server (a browserx advantage worth stating; do **not** port claudy's `isEnabled()===false`-on-channels guard).

4. **`allowedPrompts` → scoped session-memory grants.** On plan approval, the plan declares scoped grants (e.g. "navigate within example.com", "submit the checkout form on shop.com"); seed them as pre-approved entries via the existing `ApprovalGate.rememberDecision()` + risk-ceiling mechanism (`:275-291`) so execution does not re-prompt for the already-approved steps. **Reuse**, don't invent a grant system.

5. **Plan staleness re-validation (net-new vs claudy).** Page/DOM state changes between plan and execution. Critical mutating steps re-validate their precondition (element still present, URL unchanged) before acting; on mismatch, re-ask. Claudy (filesystem, more stable) doesn't need this; a browser agent does — this is a browserx-specific addition.

6. **Teammate/coordinator approval maps to Track 04's sub-agent system.** Track 06 (Multi-Agent Coordination) was abandoned 2026-05-14 — claudy's coordinator/worker primitives are provided by Track 04's `SubAgentRegistry` (`sub_agent`/`send_message`/`cancel_sub_agent`/`list_sub_agents`), scoped per session. Claudy's leader-mailbox path maps there; do not design it here. See [[06_multi_agent_coordination_ABANDONED]].

### Phase plan

- **Phase 1:** `'plan'` mode + `prePlanMode` restore slot; categorical read-only gate in `ApprovalGate.check()` keyed off Track 02 metadata; `EnterPlanMode` tool + injected exploration instruction.
- **Phase 2:** plan artifact in session store + surfaced as `context` InputItem (Track 13); `ExitPlanMode` tool → single `ApprovalManager` "Exit plan mode?" gate → restore `prePlanMode`.
- **Phase 3:** user-editable plan before approval (via `ApprovalManager` response payload, analogous to claudy's `updatedInput.plan`).
- **Phase 4:** `allowedPrompts`-style scoped grants seeded into session memory on approval; staleness re-validation for critical steps.

## Dependencies

- **Track 02** (Tool Metadata): `isReadOnly`/`isDestructive` is the gate signal — hard dependency
- **Track 03** (Commands): `/plan` toggle; `EnterPlanMode`/`ExitPlanMode` tool registration
- **Track 13** (Input Pipeline): plan artifact surfaced as a `context` InputItem
- **Track 15** (Rewind): a rejected plan should be discardable (rewind special case)
- **Track 04** (sub-agent system): coordinator/teammate plan-approval routing (Track 06 abandoned 2026-05-14 — primitives live in Track 04's `SubAgentRegistry`)
- Existing `ApprovalGate` / `ApprovalManager` / `PolicyRulesEngine` / `HookDispatcher`

## Risks

- Read-only enforcement must be airtight: a mis-tagged "read" tool that mutates breaks the trust model — depends entirely on Track 02 metadata accuracy; audit `browser_dom` action classification (read vs click/type/submit).
- Scoped grants must be tightly bounded (domain + action + tab) — reuse the risk-ceiling margin so an escalated action still re-prompts (`ApprovalGate.ts:169-181`).
- Plan staleness (above) — browser DOM is not a stable filesystem.
- `ApprovalGate.mode` is process-global today; multi-session/multi-agent (Track 04 sub-agent system) needs plan mode scoped per session/agent, not on the shared gate — flag for the scoping design.

## Validation Notes (verified vs claudy + browserx source, 2026-05-14)

- claudy: `tools/EnterPlanModeTool/EnterPlanModeTool.ts:36-126` (tool def, `:56-67` channels-trap guard, `:77-102` mode transition, `:103-125` injected instruction); `tools/ExitPlanModeTool/ExitPlanModeV2Tool.ts:64-75` (`allowedPrompts`), `:185-194` (`requiresUserInteraction`), `:195-220` (`validateInput` mode!=='plan' reject), `:221-239` (`checkPermissions` ask gate), `:243-418` (`call`: edited-plan disk write, prePlanMode restore, dangerous-perm restore), `:481-491` (approved-plan echo); `utils/planModeV2.ts:50-62` (interview phase — coding-specific, excluded).
- browserx: `core/approval/ApprovalGate.ts:28-63` (gate + flat `mode`), `:102-270` (`check()` pipeline — insertion point for the plan branch at `:164-167`), `:169-181,275-291` (session memory + risk ceiling for scoped grants), `:204-228` (`PermissionRequest` hook), `:232-269` (`ApprovalManager` interaction surface), `:310-317` (`getAskThreshold` — proof mode is threshold-only); `core/approval/types.ts:39-45` (`ApprovalDecision`/`ApprovalCheckResult`), `:152` (`ApprovalMode` — add `'plan'`).

Corrections vs the first-pass draft:
1. First draft said "reuse `ApprovalMode` machinery; add a `plan` mode" implying a threshold tweak. Reading `ApprovalGate.ts:310-317` showed modes are *purely numeric thresholds* — plan mode must be a **categorical branch** keyed off Track 02 tool metadata, a hard new dependency the draft missed.
2. claudy's `--channels` "plan mode is a trap" guard does **not** need porting — browserx's `ApprovalManager` already abstracts non-terminal surfaces, making plan mode safe on channels (a browserx advantage, not a gap).
3. Plan artifact is a session-store record surfaced as a Track 13 `context` InputItem — not a `~/.claude`-style file (browserx has no such path).
4. `allowedPrompts` maps onto the **existing** `rememberDecision()`/risk-ceiling session memory, not a new grant subsystem.
