# Apple Pi Agent Modes

**Status**: Draft
**Branch**: `feat/044-applepi-agent-modes`
**Date**: 2026-05-14
**Scope**: Apple Pi (desktop) and Apple Pi Server. Browserx (Chrome extension) is explicitly **out of scope** — the composer ignores mode for `agentType === 'browserx'`.

---

## 1. Overview

Introduce **agent modes** for Apple Pi: a single product that can act as a general-purpose desktop assistant *or* as a professional coding agent (claudy-quality), switchable per conversation without losing context.

The design is deliberately **N-mode** (a registry of mode descriptors), not a binary general/code switch — a third mode (e.g. "research") must be purely additive: one registry entry plus authored content, no structural change.

Three things differ by mode; everything else is shared:

1. **System prompt** — the primary lever (~90% of behavioral difference the model sees).
2. **Approval friction** — a secondary runtime lever (changes whether *the user* gets interrupted).
3. **UI presentation** — a per-session indicator/selector; not a behavioral difference.

Tool **availability** does *not* differ by mode. Infrastructure (terminal, filesystem, browser-via-MCP, planning, scheduler, skills, memory) is shared.

---

## 2. Problem Statement

Apple Pi is framed as a "desktop automation agent" — broad identity, generalist tooling. It can already write code via `TerminalTool` + filesystem, but under-delivers vs a dedicated coding agent (Claude Code / "claudy") for three reasons:

1. **Weak identity anchor.** `applepi_intro.md` anchors on desktop automation, pulling generalist priors instead of software-engineering ones (type discipline, test-first, security awareness, no-gold-plating, default-no-comments, faithful reporting).
2. **No dedicated code-shaped tools.** Every file op routes through `TerminalTool` (`cat`, `sed -i`, heredocs). Noisier output, harder-to-review diffs, weaker tool-use behavior.
3. **No code-specific guardrails.** Task-execution policies are tuned for generalist desktop work, not coding discipline.

The ask: **one product, multiple personas.** General by default. Toggle into a coding-first persona per conversation. Flip mid-session without losing history.

---

## 3. Goals / Non-Goals

### Goals

- One Apple Pi product covers general desktop tasks and professional coding tasks.
- Mode is **per-session** (per-tab), explicitly user-chosen, hot-switchable, history-preserving.
- Code mode reaches claudy parity for basics: dedicated file tools, code guardrails, software-engineering identity.
- General mode is **unchanged** (zero regression).
- The mode mechanism is **N-mode from day one** — adding a third mode is additive only.
- Applies symmetrically to `applepi` and `applepi-server`.

### Non-Goals

- **Browserx gets no modes.** Extension sandbox has no filesystem; composer ignores mode for `browserx`.
- **No new `AgentType` for coder.** Mode is orthogonal to `AgentType`.
- **No auto-detection** of mode from message content. Explicit toggle only.
- **No mid-turn flip.** Mode resolves once per user submission; in-flight tasks complete under their original identity.
- **No mode-conditional model selection.**
- **No tool-registry mutation on mode change.** Availability is universal; mode changes prompt guidance + approval friction only.
- **No runtime user-defined modes, no mode plugin system, no per-mode tool registries.** Static descriptor table is the ceiling (YAGNI line).

---

## 4. User Model (UX first)

### 4.1 Mode is per-session, because the desktop app presents sessions as tabs

The desktop UI already renders sessions as visible tabs (`ThreadBar` → `ThreadTab`, `threadStore.activeSessionId`, new/close/select, `maxSessionsReached`). Users create, close, and switch conversation tabs like browser tabs.

When something is presented as tabs, users expect each tab to be an **independent context**. "Mode" is a per-context property ("what is this conversation about"), not an app preference (like theme). A user with a coding tab and a general-automation tab open simultaneously must not have one tab's mode leak into the other.

**Decisive argument — asymmetric failure:**

- Per-session mode for a single-tab user → behaves exactly like global to them. No downside.
- Global mode for a multi-tab user → actively breaks them (can't mix personas; toggling disrupts every conversation).

Per-session degrades gracefully to "feels global" for simple users; global hard-breaks the multi-tab workflow the tab UI invites.

**Confirming evidence — scheduled jobs:** the scheduler spawns its own sessions. A scheduled "summarize my GitHub notifications" (general) must not run in Code mode just because the user's active tab is Code. Mode is a property *of a session*, captured at job-creation time, independent of whatever is active when it fires.

### 4.2 Default mode for new sessions

`preferences.defaultMode` (global preference, default `'general'`) sets the mode new tabs start in. Each tab can override. This is the *only* global mode-related preference; it is **not** the active mode.

### 4.3 What the user sees

| Surface | Behavior |
|---|---|
| Per-tab mode selector (chat header or tab) | Shows current mode; user changes it per session. |
| Thread tab marker (icon/tint) | At-a-glance "tab 1 = Code, tab 2 = General" without clicking in. |
| Inline transcript marker | "— switched to Code mode —" inline, so the user understands why behavior changed mid-thread. Also a record. |
| Scheduler "create job" form | Creation-time mode picker (jobs capture mode at creation). |
| Settings → "default mode for new conversations" | Static global default (4.2). Not reactive to a live switch. |
| Approval dialog | **No mode-awareness.** It already renders whatever the policy engine decided; mode feeds the engine upstream. |

### 4.4 Switching while a task runs

If a task is in flight, the switch **defers** until the next user submission (mirrors the existing `pendingModelKey` deferral in `handleModelConfigChange`). The UI must show a **pending** state, not optimistically flip — see §8.3.

---

## 5. Conceptual Model

### 5.1 Two orthogonal axes

- **`AgentType`** — platform/runtime. Chosen at build time (`browserx` | `applepi` | `applepi-server`). Fixed for process lifetime.
- **`AgentMode`** — persona within a platform. Chosen at runtime, per-session, hot-switchable.

`applepi × code` and `applepi-server × code` are real. `browserx × <anything>` ignores mode. Collapsing these into one axis would force a quadratic `{browserx, applepi, applepi-coder, applepi-server, applepi-server-coder, …}` cross-product — rejected.

### 5.2 The mode registry (N-mode)

Mode is a **descriptor table**, never a hardcoded union or `if (mode === 'code')` branching:

```typescript
type ModeId = string; // 'general' | 'code' | 'research' | ...

interface AgentModeSpec {
  id: ModeId;
  label: string;                 // UI display name
  agentTypes?: AgentType[];      // platforms offering this mode; omitted = all non-browserx
  approvalProfile: ApprovalProfileId; // fed to PolicyRulesEngine (§7)
  // Fragment membership is expressed on the fragments themselves (§6.2),
  // not duplicated here — this keeps a single source of truth.
}

const MODES: Record<ModeId, AgentModeSpec> = {
  general: { id: 'general', label: 'General', approvalProfile: 'standard' },
  code:    { id: 'code',    label: 'Code',    approvalProfile: 'developer' },
};
```

Adding a mode = one `MODES` entry + authored fragments + (optionally) a new approval profile. No composer/UI/event change.

### 5.3 The three levers

| Lever | Varies by mode? | Mechanism |
|---|---|---|
| Tool **availability** | **No** | All tools registered in all modes. Never hide/unregister. |
| **Prompt guidance** | **Yes** (primary) | Per-mode prompt fragments (§6). |
| **Approval friction** | **Yes** (secondary) | Per-mode `approvalProfile` → `PolicyRulesEngine` (§7). |

Hard safety is **mode-independent**: `SensitivePathEnhancer`, `DomainSensitivityEnhancer`, the financial-operations restriction in `safety.md`, and the global approval mode (YOLO/normal/strict) apply identically in every mode. Mode lowers friction on *routine operations within the chosen approval mode*; it is never a bypass. This matters because mode is per-session and hot-switchable — a switch (or a prompt-injected page requesting one) must not be an escalation path.

---

## 6. Prompt Composition

### 6.1 Slot structure

The composed prompt is a fixed ordered sequence of slots. Only some slots vary by mode:

| # | Slot | General | Code | Kind |
|---|---|---|---|---|
| 1 | Identity intro | `applepi_intro.md` / `applepi_server_intro.md` | `coder_intro.md` | mode-owned |
| 2 | Runtime metadata | *(generated)* | *(generated)* | shared |
| 3 | Safety | `safety.md` | `safety.md` | shared |
| 4 | Tool guidance | `pi_tools.md` | `coder_tools.md` | mode-owned |
| 5 | Task execution policies | `task_execution_policies.md` | `task_execution_policies.md` | shared |
| 6 | Approval policies | `approval_policies.md` | `approval_policies.md` | shared |
| 7 | Mode appends | *(none)* | `code_guardrails.md` | mode-owned (0..N) |

The entire mode difference is: mode-owned slots (1, 4) swap, and mode-owned appends (7) are included only for owning modes. Slots 2/3/5/6 are invariant.

### 6.2 Fragment manifest (N-mode labeling)

Each fragment declares which modes it belongs to via an optional `modes` list. **Absent `modes` = universal (shared).** This is N-ary by construction and supports "fragment in code *and* research but not general":

```typescript
type FragmentScope =
  | { kind: 'shared' }                              // modes omitted
  | { kind: 'mode'; modes: ModeId[] };              // explicit ownership

interface FragmentSpec {
  id: string;                 // logical slot id ('intro', 'tools', 'guardrails', ...)
  order: number;              // composition order (slot #)
  agentTypes?: AgentType[];   // platform restriction; omitted = all
  modes?: ModeId[];           // omitted = shared/universal
  content: string;            // ?raw import
}

const FRAGMENTS: FragmentSpec[] = [
  { id: 'intro',      order: 1, agentTypes: ['applepi'],        modes: ['general'], content: piIntro },
  { id: 'intro',      order: 1, agentTypes: ['applepi-server'], modes: ['general'], content: piServerIntro },
  { id: 'intro',      order: 1,                                 modes: ['code'],    content: coderIntro },
  { id: 'safety',     order: 3,                                                     content: safety },
  { id: 'tools',      order: 4, agentTypes: ['applepi','applepi-server'], modes: ['general'], content: piTools },
  { id: 'tools',      order: 4,                                 modes: ['code'],    content: coderTools },
  { id: 'task_policy',order: 5,                                                     content: taskPolicies },
  { id: 'approval',   order: 6,                                                     content: approvalPolicies },
  { id: 'guardrails', order: 7,                                 modes: ['code'],    content: codeGuardrails },
];
```

`code_guardrails.md` stops being a special-cased conditional append — it is simply a fragment owned by `['code']`. A future "research" mode's citation guardrails are a fragment owned by `['research']` with `order: 7`.

### 6.3 Composer

```typescript
composeMainInstruction(agentType: AgentType, mode: ModeId, ctx?: RuntimeContext): string {
  const effectiveMode: ModeId = agentType === 'browserx' ? 'general' : mode;
  return FRAGMENTS
    .filter(f => !f.agentTypes || f.agentTypes.includes(agentType))
    .filter(f => !f.modes || f.modes.includes(effectiveMode))   // omitted modes = shared
    .sort((a, b) => a.order - b.order)
    .map(f => f.id === 'runtime' ? this.buildRuntimeMetadata(agentType, ctx) : f.content)
    .filter(Boolean)
    .join('\n\n');
}
```

The filter `!f.modes || f.modes.includes(effectiveMode)` is inherently N-ary — it never needs to change as modes are added. New prompt fragments:

| File | Owner modes | Purpose |
|---|---|---|
| `coder_intro.md` *(new)* | `code` | Software-engineering identity. Shared across `applepi` & `applepi-server`. |
| `coder_tools.md` *(new)* | `code` | Foregrounds dedicated file tools; terminal/browser as fallback. |
| `code_guardrails.md` *(new)* | `code` | No gold-plating, default-no-comments, verify-before-done, OWASP, faithful reporting. |

Existing fragments unchanged.

---

## 7. Approval-Friction Integration

Mode feeds `PolicyRulesEngine` via an `approvalProfile` (from the mode descriptor), not a boolean `isCodeMode`:

- `standard` profile (general): higher friction on filesystem/terminal mutation — a less-technical user is less likely to expect them.
- `developer` profile (code): routine dev ops (`edit_file` within project root, `npm test`, read-only `git`) run with reduced friction so the coding loop isn't destroyed.

Constraints:

- The profile adjusts default rules **within** the user's chosen global approval mode (YOLO/normal/strict). It never overrides it.
- `SensitivePathEnhancer`, `DomainSensitivityEnhancer`, and the financial-operations restriction apply in all profiles.
- Profiles are declared per-mode in the registry; a new mode declares its own profile id. New profiles are added to the policy engine's profile table, not via mode-specific branches.

This is the only non-prompt behavioral difference. It is **separable** — v1 may ship prompt-only and add profiles in a later phase (see §13).

---

## 8. Architecture

### 8.1 Mode state ownership — the `PromptLoader` refactor

**Today**, `PromptLoader` is a module-level singleton: `configuredAgentType`, `staticContext`, and a free `loadPrompt()` function. This only works if mode is global. **Per-session mode breaks that assumption.**

Change: the **active mode is owned by `Session`** (the per-session source of truth). Prompt composition becomes session-scoped:

- `loadPrompt(mode: ModeId)` takes mode as an argument (the agent passes its session's mode), **or** prompt composition moves onto `RepublicAgent`/`Session` which owns its `PromptComposer` usage.
- The module singleton retains only truly global config (`agentType`, static platform context). It no longer holds mode.
- `preferences.mode` (global) → renamed `preferences.defaultMode`. It seeds new sessions only; it is never the active mode.

Recommended: pass `mode` into `loadPrompt(mode)` — smaller blast radius than relocating composition ownership, and the agent already calls `loadPrompt()` every turn (`PromptLoader.ts:78`).

### 8.2 Hot-swap pipeline

```
User changes mode on a tab (chat header / slash command)
        │
        ▼
UI dispatches a SetSessionMode op (sessionId, modeId)   ◄── no optimistic local flip
        │
        ▼
RepublicAgent for that session:
   ├─ task running?  → set pendingModeSwitch; emit ModeChanged{deferred}
   └─ idle?          → session.setMode(modeId)
                        base = await loadPrompt(modeId)
                        turnContext.setBaseInstructions(base)
                        approvalGate.setProfile(MODES[modeId].approvalProfile)
                        emit ModeChanged{applied}
        │
        ▼
ModeChanged event → channel → threadStore.setThreadMode(sessionId, modeId)
        │
        ▼
Reactive re-render: tab badge, tab marker, inline transcript marker
Next user turn for that session uses the new prompt; history preserved
```

Reuses three existing patterns:

1. `loadPrompt()` already runs fresh every user message — no invalidation needed.
2. Deferral mirrors `pendingModelKey` / `handleModelConfigChange` (`RepublicAgent.ts:265–300`), drained at the same site before the next turn.
3. `ModeChanged` event propagation. **Correction (was a wrong assumption):** the original design said to mirror track 07's `ApprovalPolicyChanged` event + reactive `modelStore`. That pattern is **agent-improvements-only — it does not exist on `main`** (no `modelStore.ts`, no `*Changed` per-agent events). As implemented on `main`, `ModeChanged` is a **channel-scoped** event (`event-scope.ts`) handled in `Main.svelte`'s existing `threadRouter.onChannel` handler — the same place `StateUpdate` is handled — which routes by the event's own `sessionId` to `threadStore.setThreadMode` / `setThreadPendingMode`. No `modelStore` and no track-07 infrastructure is required; the existing `StateUpdate → onChannel → store` path is the model.

Hot-swap **per session**: only the targeted session refreshes. (Contrast the earlier global draft, which iterated all sessions — that is now explicitly wrong.)

### 8.3 The honesty constraint

Because a switch may defer, the UI must **not** optimistically flip the badge on click:

- Click → **pending** state ("switching after current task…").
- Commit to the new mode only when `ModeChanged{applied:true}` arrives.
- Idle session → near-instant. Busy session → honest pending state.

Same submit-op-then-event-back discipline used everywhere else; mode is not special-cased with optimistic local state. Backend `Session` is the single source of truth.

### 8.4 Component changes (file-level)

| File | Change |
|---|---|
| `src/config/types.ts` | `IUserPreferences.defaultMode?: ModeId` (was the proposed `mode`). |
| `src/config/defaults.ts` | `defaultMode: 'general'`. |
| `src/config/configSchema.ts` + validators test | Validate `defaultMode ∈ Object.keys(MODES)`; unknown → coerce `'general'`. |
| `src/prompts/PromptComposer.ts` | Add `ModeId`, `MODES` registry, `FragmentSpec[]` manifest; `composeMainInstruction(agentType, mode, ctx)`. |
| `src/prompts/fragments/coder_intro.md`, `coder_tools.md`, `code_guardrails.md` | New (own mode `code`). |
| `src/core/PromptLoader.ts` | `loadPrompt(mode: ModeId)`; remove mode from singleton; keep agentType/static context. |
| `src/core/Session.ts` | Owns active `mode`; `getMode()` / `setMode()`. Seeded from `defaultMode` at creation. |
| `src/core/RepublicAgent.ts` | `setSessionMode(modeId)`: defer-if-running, else recompose prompt + set approval profile + emit `ModeChanged`. Drain `pendingModeSwitch` alongside `pendingModelKey`. |
| `src/core/protocol/events.ts` | `ModeChanged` event + `ModeChangedEvent` payload. `src/core/protocol/event-scope.ts` classifies it `channel`-scoped (modeled on `StateUpdate`, since track-07's `ApprovalPolicyChanged` is not on `main`). |
| `src/core/protocol/types.ts` (op) | `SetSessionMode` op (sessionId, modeId). |
| `src/core/approval/PolicyRulesEngine.ts` + profiles | Per-mode approval profiles; `approvalGate.setProfile(...)`. |
| `src/webfront/stores/threadStore.ts` | `mode` on `SidePanelThread`; `setThreadMode(sessionId, mode)`. |
| `src/webfront/components/threads/ThreadTab.svelte` | Mode marker (icon/tint). |
| `src/webfront/components/chat/*` (header) | Per-tab mode selector + pending state; inline transcript marker on `ModeChanged`. |
| `src/webfront/settings/*` | "Default mode for new conversations" (writes `preferences.defaultMode`). |
| Scheduler create-job UI + `ScheduleEvent` storage | Capture mode at creation; job session starts in captured mode. |
| `src/desktop/agent/DesktopAgentBootstrap.ts` | Seed new-session mode from `defaultMode`; route `SetSessionMode` to the target session only (not all sessions). |
| `src/server/agent/ServerAgentBootstrap.ts` | Same. |
| `src/tools/*` + platform adapters | New dedicated file tools, registered **always** (§9). |
| Slash commands (feature 021) | Generate `/<modeId>` commands from `MODES`. |

---

## 9. Tool Surface

Per the three-lever model (§5.3):

- **Availability: universal.** `read_file`, `edit_file`, `write_file`, `grep`, `glob` are registered for `applepi`/`applepi-server` in **all** modes, alongside `TerminalTool`, browser-via-MCP, planning, web search, setting, memory. No mode hides or adds tools. Cross-mode tasks ("coding but need to open docs in a browser") stay possible; no hot-swap registry races.
- **Behavior shift: prompt guidance.** `coder_tools.md` says prefer dedicated file tools; reach for `TerminalTool` only for shell-only ops. `pi_tools.md` mentions them incidentally.
- **Behavior shift: approval friction** via the mode's approval profile (§7).

Dedicated file tools backing — open question (§12): native Rust commands via Tauri (faster, typed, atomic edits, capable) vs TS wrappers over existing infra. Recommendation: **Rust** — claudy's edge over a TerminalTool agent comes precisely from these being first-class.

If General-mode context bloat from carrying file tools ever measurably hurts tool selection, the escape hatch is deferred/lazy tool loading (claudy's ToolSearch pattern), **not** mode-based hiding.

---

## 10. Apple Pi Server Symmetry

Same model. `ServerAgentBootstrap` seeds session mode from `defaultMode`; `SetSessionMode` ops route to the target session. Server uses the **same** `coder_intro.md` (no obvious server-specific coding framing yet). Dedicated file tools backed by Node `fs` instead of Tauri Rust. Fork `coder_server_intro.md` only if concrete server-specific framing emerges.

---

## 11. Edge Cases

| Case | Behavior |
|---|---|
| `preferences.defaultMode` undefined (existing config) | Treated as `'general'`. No migration. |
| Unrecognized `defaultMode` or persisted session mode (downgrade) | Coerce to `'general'`. Warn, don't throw. |
| Mode changed mid-streaming | Stream completes under old prompt; new prompt applies next user turn. |
| Multi-tab: tab A busy, tab B idle, user switches B | Only B refreshes (per-session). A unaffected. |
| User switches busy tab A | Deferred; pending UI; applies on A's next submission. |
| Browserx with synced `defaultMode='code'` | Composer ignores mode for `browserx`; prompt identical to today. |
| Scheduled job fires while user's active tab is Code | Job runs in the mode captured at job creation, not the active tab's mode. |
| Two switch surfaces near-simultaneously (header + slash) | Both emit `SetSessionMode`; last applied wins; redundant `ModeChanged` is a no-op if mode unchanged. |
| Prompt-cache | Per-switch invalidation for that session only. One-time re-process. Documented, not optimized. |
| Mixed-identity transcript after switch | Expected; the inline transcript marker explains it. Users wanting a clean break start a new tab. |

---

## 12. Adding a Future Mode (worked example)

Mode #3 = "research" (deep web research / report writing):

1. Author `research_intro.md` (research-analyst identity), `research_tools.md` (foreground web search + browser + memory), `research_guardrails.md` (citation/source discipline). Add to `FRAGMENTS` with `modes: ['research']`.
2. Add `research: { id:'research', label:'Research', approvalProfile:'standard' }` to `MODES`.
3. (Optional) add a `research` approval profile if friction should differ.

No change to: composer logic, `loadPrompt`, hot-swap pipeline, `ModeChanged`, `threadStore`, UI selector (renders from `MODES`), slash-command generation. **Purely additive.** This is the test the architecture is designed to pass.

---

## 13. Implementation Phasing

| Phase | Scope | Ships |
|---|---|---|
| **1 — Per-session plumbing** | `ModeId`/`MODES`/`FragmentSpec` manifest; `PromptLoader` refactor (`loadPrompt(mode)`); mode on `Session`; `SetSessionMode` op; `ModeChanged` event; deferral; `defaultMode` config; route to target session only. Coder fragments are **placeholders duplicating general**. | Per-session hot-swap proven end-to-end with no behavioral change between modes. |
| **2 — Coder identity** | Real `coder_intro.md` / `coder_tools.md` / `code_guardrails.md`. Per-tab selector + pending state + inline transcript marker + tab marker. | Code mode visibly different with claudy-style guardrails. |
| **3 — Dedicated file tools** | `read_file`/`edit_file`/`write_file`/`grep`/`glob`, registered always, desktop (Rust) + server (Node). | Claudy parity for routine file ops in Code mode. |
| **4 — Approval profiles** | Per-mode approval profiles in `PolicyRulesEngine`; `developer` profile for Code. | Coding loop friction reduced without weakening hard safety. |
| **5 — Polish** | Scheduler creation-time mode capture; slash commands from registry; Settings default-mode; telemetry. | Complete, ergonomic, measurable. |

Each phase is independently mergeable. Phase 1 alone is a valuable internal change before users see anything different.

---

## 14. Success Criteria

| ID | Criterion |
|---|---|
| SC-001 | Existing users (no `defaultMode`) see Apple Pi behaving identically to pre-feature. Zero regression in General. |
| SC-002 | Switching an idle tab to Code uses the new prompt on the next turn; full history preserved. |
| SC-003 | Switching a busy tab defers; in-flight task uninterrupted; next submission uses new mode; UI shows pending. |
| SC-004 | Per-session isolation: switching tab B never alters tab A's mode or behavior. |
| SC-005 | Code mode: dedicated file tools account for >90% of file read/edit/write ops on a small-coding-task benchmark. |
| SC-006 | Code mode: behavior reflects code guardrails — no unsolicited comments, no scope creep, completion claimed only after verification. |
| SC-007 | A switch never escalates privilege: hard-safety enhancers and global approval mode behave identically across modes. |
| SC-008 | `applepi-server` honors per-session mode symmetrically. |
| SC-009 | Browserx unaffected — prompt composes identically regardless of mode. |
| SC-010 | Adding a mock third mode requires only a `MODES` entry + fragments — no composer/UI/event change (architectural test). |

---

## 15. Open Questions

1. **Dedicated file tools — Rust-via-Tauri vs TS wrappers?** Recommend **Rust** (parity is the point; ~1wk vs ~1day).
2. **`loadPrompt(mode)` arg vs moving composition onto the agent?** Recommend the **arg** (smaller blast radius).
3. **`coder_server_intro.md` fork vs share?** Recommend **share** initially.
4. **Mode marker visual language** (icon set / color tint per mode) — needs design input; must scale to N modes, not be a 2-state toggle.
5. **Persist per-session mode across app restart** (with session/thread restore) or reset to `defaultMode` on restore? Leaning **persist** (least surprise) — confirm.
6. **Telemetry**: track mode usage + switch frequency. Recommend **yes** (informs whether Code mode + multi-mode is worth maintaining).
7. **Skill filtering by mode** (e.g., hide `/security-review` in General) — out of scope; future work via the track-03 skill domain filter.

---

## 16. Settled Decisions (discussion log)

For reviewers — these were debated and closed during design:

- **Mode is per-session, not global.** Driven by the desktop tab mental model + asymmetric-failure argument + scheduled-job evidence (§4.1).
- **Not a new `AgentType`.** Orthogonal axes (§5.1).
- **Tool availability is universal across modes.** Behavior differs via prompt guidance + approval friction only (§5.3, §9).
- **Hard safety is mode-independent.** A switch is never a privilege-escalation path (§5.3, §7).
- **N-mode registry, not binary.** A third mode must be additive only (§5.2, §12). YAGNI line: static table, no runtime/user-defined modes.
- **`PromptLoader` singleton must be refactored.** Per-session mode is incompatible with module-global mode state (§8.1).
- **No optimistic UI.** Deferral makes optimistic flips dishonest; backend `Session` is source of truth (§8.3).
