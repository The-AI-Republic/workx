# Track 28 — Command/Skill Security & Server Parity (follow-up to Track 03)

Date: 2026-05-15
Status: OPEN — P1 (one item security-critical)
Follows up: [Track 03 — Command & Skill System](../03_command_skill_system_DONE/design.md) (shipped PR #204)
Audit source: design-vs-implementation audit 2026-05-15 (independently verified against source on `agent-improvements`)

> This is a **follow-up track**. It does not modify Track 03's design doc. It captures the
> commitments Track 03's design made that the shipped PR #204 code does **not** fulfill, as
> verified against on-disk source (not the design doc's own "Validation Notes" / checkboxes).

## Why this track exists

Track 03 shipped a real, well-tested frontmatter schema, domain filter, skill executor, and
risk assessor (100+ passing tests). But three commitments the Track 03 design itself flagged
as required did not actually land, and one Phase-1 subsystem shipped as orphaned dead code.

## Verified gaps

### G1 — `allowed-tools` enforcement is absent (SECURITY-CRITICAL)

Track 03 design's *Risks* section states the per-skill tool allow-list gate must land
"before any skill that touches sensitive tools ships." The frontmatter is parsed and the
field is threaded all the way to the executor result — then **dropped**.

- Parsed: `src/core/skills/SkillParser.ts:174-175` (`fm['allowed-tools'].split(...)`)
- Stored on the skill: `src/core/skills/types.ts:41,178`, `SkillRegistry.ts:203`
- Returned by executor: `src/core/skills/SkillExecutor.ts:50,149` (`allowedTools: skill.allowedTools`)
- Self-documented as not-enforced: `SkillExecutor.ts:9` — *"allowed-tools enforcement: returned in the inline result for the tool"* (i.e. returned, not enforced)
- **No consumer**: grep across `TurnManager.ts`, `RepublicAgent.ts`, desktop bootstrap, and
  `src/server/agent/ServerAgentBootstrap.ts` finds no per-turn allow-list applied during tool
  dispatch. `DesktopAgentBootstrap.ts` discards the executor's `allowedTools` (returns only
  `result.body`).

**Impact:** an inline skill declaring `allowed-tools: read_dom` still runs with the agent's
full tool set. The advertised containment guarantee does not exist.

### G2 — Server agents have no skill execution / risk assessor / domain filter

Track 03 Phases 3 & 4 required `ServerAgentBootstrap` to mirror the desktop wiring
(`use_skill`, `SkillExecutor`, `SkillRiskAssessor`, `SkillDomainFilter`). The desktop path
(`src/desktop/...DesktopAgentBootstrap`) wires these; the server path
(`src/server/agent/ServerAgentBootstrap.ts`) builds only a bare `SkillRegistry` for service
lookups — no executor, no assessor, no domain filter, no `use_skill` parity. Server-mode
skills therefore run unassessed or not at all.

### G3 — `src/core/commands/` typed-command layer is orphaned dead code

Track 03 Phase 1's stated goal was a typed command hierarchy shared by the slash typeahead
and the model surface. The library shipped (`src/core/commands/CommandLoader.ts`,
`SkillCommandLoader.ts`, `BuiltinCommandLoader.ts`, `precedence.ts`, `types.ts`) **but is
referenced nowhere outside its own directory and its tests** (grep confirms zero runtime
imports). The user-visible `/help` typeahead path is satisfied via the separate
`src/webfront/commands/` extension, leaving `src/core/commands/` as maintenance rot.

### G4 — 500ms ActiveTab debounce missing (recorded decision)

Track 03 Phase 3 has an explicit "Decision recorded": debounce the active-tab subscriber by
500ms to avoid prompt-cache thrash on rapid tab switches. No debounce exists at the
subscribe sites (`service-worker.ts` ActiveTab subscription; desktop bootstrap equivalent) —
each tab change fires synchronously.

### G5 — Parse-time `agent:` validation missing

Track 03 Phase 2 required fork-skill `agent:` values to be validated against known sub-agent
types at parse time. `SkillParser.ts` / `types.ts` accept any string; an unknown agent fails
only at invocation.

## Goals

1. Enforce `allowed-tools` as a real per-turn tool allow-list during skill execution (G1).
2. Bring `ServerAgentBootstrap` to skill parity with the desktop bootstrap (G2).
3. Resolve `src/core/commands/`: wire it into the slash/model surface **or** delete it (G3).
4. Add the recorded 500ms ActiveTab debounce (G4).
5. Validate `agent:` at parse time against registered sub-agent types (G5).

## Non-goals

- Re-designing the skill model — Track 03's schema/executor/assessor stand as-is.
- Protocol `SkillInvoked/Completed/Failed` events — Track 03 explicitly made these optional.
- `DesktopActiveTabAdapter` real implementation — Track 03 tasks.md explicitly permits a stub.

## Approach

### G1 — allowed-tools enforcement (do this first; security-critical)

`SkillExecutor` already computes `allowedTools` for inline skills. Introduce a per-execution
tool gate consumed by the dispatch path:

- Inline skills: when an inline skill is active, the executor sets an allow-list on the turn
  context (or returns it to the caller which sets it). `TurnManager`/`RepublicAgent` consults
  it in the tool-dispatch path and rejects (with a structured `tool_error`) any tool not in
  the list, restoring it in a `finally`.
- Honor the existing `ApprovalManager`/risk path — the gate is *additional* containment, not
  a replacement for risk assessment.
- Fork skills already get an isolated sub-agent registry; verify the allow-list is applied to
  the forked registry too.

### G2 — server parity

Mirror the desktop wiring in `src/server/agent/ServerAgentBootstrap.ts`: construct
`SkillExecutor`, `SkillRiskAssessor`, `SkillDomainFilter` (server-appropriate `ActiveTab`
source — likely a no-op/headless adapter), and register `use_skill` with the same options
object the desktop bootstrap uses. Factor the shared construction so the two bootstraps
cannot drift again.

### G3 — commands layer

Decision required (see Open Questions). Recommended: **delete** `src/core/commands/` unless a
near-term consumer is identified — the webfront command path already satisfies the
user-visible Phase 1 goal, and Track 10 (Plugin System) is the only plausible future
consumer; it can introduce its own surface when scoped.

### G4 — debounce

Wrap the ActiveTab subscriber callback in a 500ms trailing debounce at the subscribe sites
(extension `service-worker.ts`, desktop bootstrap). ~15 LOC.

### G5 — agent validation

In `SkillParser`/`types.ts` zod refine, validate `agent:` against the registered sub-agent
type list (the same list Track 04's `SubAgentRegistry` exposes) and fail parse with a clear
message.

## Risks

- **G1 false-positives**: an over-tight allow-list could break legitimate skills. Mitigate
  with a structured, actionable error and an integration test per skill shape.
- **G2 drift**: shared factory must be the single construction site for both bootstraps.
- **G3**: deleting code that a future track wants — mitigated by Track 10 being able to
  reintroduce a purpose-built surface; git history preserves the orphaned layer.

## Validation

- G1: integration test — inline skill with `allowed-tools: read_dom` attempts a write tool →
  rejected with `tool_error`; allowed tool succeeds; allow-list cleared after skill ends;
  forked-registry variant covered.
- G2: server bootstrap test asserting `use_skill` present and `SkillRiskAssessor` is the
  active assessor (not `StaticRiskAssessor(0)`).
- G3: if deleted — `npm run type-check` + full suite green, no dangling imports. If wired —
  typeahead/model test exercising `CommandLoader`.
- G4: unit test — N rapid tab switches → 1 callback after 500ms.
- G5: parser test — unknown `agent:` value fails parse with explicit message.

## Open questions

1. **G3**: wire or delete `src/core/commands/`? Needs a product call (does Track 10 want it
   now, or later on its own terms?).
2. **G1**: does the allow-list apply to MCP tools and sub-agent tools too, or only the
   built-in tool registry? (Recommend: all tools the skill could invoke.)
