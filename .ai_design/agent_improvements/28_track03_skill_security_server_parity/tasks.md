# Track 28 — Tasks

Follows up [Track 03](../03_command_skill_system_DONE/design.md). See `design.md` for gap evidence.

Ordering: G1 (security) → G2 → G5 → G4 → G3 (decision-gated).

## Phase 1 — `allowed-tools` enforcement (G1, security-critical)

- [ ] 1.1 Decide allow-list scope (built-in + MCP + sub-agent tools). Record decision.
- [ ] 1.2 Add a per-execution tool allow-list to the skill execution context (carried from
      `SkillExecutor` result `allowedTools`, `SkillExecutor.ts:50,149`).
- [ ] 1.3 Consult the allow-list in the tool-dispatch path (`TurnManager`/`RepublicAgent`):
      reject non-listed tools with a structured `tool_error`; clear in `finally`.
- [ ] 1.4 Apply the same allow-list to forked sub-agent registries.
- [ ] 1.5 Tests: inline-skill allow-list blocks a disallowed tool, permits a listed one,
      clears after the skill, and covers the forked-registry path.

## Phase 2 — Server + extension parity (G2)

- [ ] 2.1 Extract a shared skill-wiring factory used by `DesktopAgentBootstrap`,
      `src/server/agent/ServerAgentBootstrap.ts`, and the extension service-worker agent
      factory (single construction site).
- [ ] 2.2 Wire `SkillExecutor`, `SkillRiskAssessor`, `SkillDomainFilter`, and `use_skill`
      into `ServerAgentBootstrap` via the factory (server-appropriate ActiveTab source).
- [ ] 2.3 Wire `use_skill` execution into the extension service-worker path. The extension
      already initializes skill discovery/domain filtering/prompt extension; the missing piece
      is registering the executable tool with `SkillExecutor` + `SkillRiskAssessor`.
- [ ] 2.4 Test: server and extension bootstraps expose `use_skill` and use
      `SkillRiskAssessor` (not `StaticRiskAssessor(0)`).

## Phase 3 — Parse-time `agent:` validation (G5)

- [ ] 3.1 Validate `agent:` in the skill zod schema (`src/core/skills/types.ts:178` /
      `SkillParser.ts`) against registered sub-agent types; fail parse with a clear message.
- [ ] 3.2 Parser test: unknown `agent:` value fails parse.

## Phase 4 — ActiveTab debounce (G4)

- [ ] 4.1 Add a 500ms trailing debounce to the ActiveTab subscriber at the extension
      `service-worker.ts` subscribe site and the desktop bootstrap equivalent.
- [ ] 4.2 Test: N rapid tab switches → exactly 1 callback after 500ms.

## Phase 5 — Resolve orphaned command layer (G3, decision-gated)

- [ ] 5.1 Product decision: wire `src/core/commands/` into the slash/model surface, or delete.
- [ ] 5.2a If delete: remove `src/core/commands/` + its tests; `type-check` + full suite green.
- [ ] 5.2b If wire: connect `CommandLoader` to the typeahead/model surface with a test.

## Exit criteria

- An inline skill with `allowed-tools` cannot invoke tools outside its list (verified test).
- Server and extension agents execute skills through `SkillExecutor` + `SkillRiskAssessor`
  like desktop.
- Unknown `agent:` fails at parse time.
- ActiveTab callback debounced to 500ms.
- `src/core/commands/` is either wired (with a consumer + test) or deleted.
