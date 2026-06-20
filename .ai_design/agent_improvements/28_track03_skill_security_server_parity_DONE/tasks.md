# Track 28 — Tasks

Follows up [Track 03](../03_command_skill_system_DONE/design.md). See `design.md` for gap evidence.

Ordering: G1 (security) → G2 → G5 → G4 → G3.

## Phase 1 — `allowed-tools` enforcement (G1, security-critical)

- [x] 1.1 Implement the locked scope: built-in + MCP + A2A + plugin + `tool_search` +
      `use_skill` + sub-agent tools. Missing `allowed-tools` means no skill-specific
      restriction; present `allowed-tools` means exact tool-name hard allow-list.
- [x] 1.2 Add a per-execution tool allow-list to the skill execution context (carried from
      `SkillExecutor` result `allowedTools`, `SkillExecutor.ts:50,149`).
- [x] 1.3 Consult the allow-list in the tool-dispatch path (`TurnManager`/`RepublicAgent`):
      reject non-listed tools with a structured `tool_error`; clear in `finally`.
- [x] 1.4 Filter `tool_search` results/selections by the active allow-list so dynamic loading
      cannot bypass skill containment.
- [x] 1.5 Apply the same allow-list to forked sub-agent registries.
- [x] 1.6 Tests: inline-skill allow-list blocks a disallowed tool, permits a listed one,
      clears after the skill, filters `tool_search`, and covers the forked-registry path.

## Phase 2 — Server + extension parity (G2)

- [x] 2.1 Extract a shared skill-wiring factory used by `DesktopAgentBootstrap`,
      `src/server/agent/ServerAgentBootstrap.ts`, and the extension service-worker agent
      factory (single construction site).
- [x] 2.2 Wire `SkillExecutor`, `SkillRiskAssessor`, `SkillDomainFilter`, and `use_skill`
      into `ServerAgentBootstrap` via the factory (server-appropriate ActiveTab source).
- [x] 2.3 Wire `use_skill` execution into the extension service-worker path. The extension
      already initializes skill discovery/domain filtering/prompt extension; the missing piece
      is registering the executable tool with `SkillExecutor` + `SkillRiskAssessor`.
- [x] 2.4 Test: server and extension bootstraps expose `use_skill` and use
      `SkillRiskAssessor` (not `StaticRiskAssessor(0)`).

## Phase 3 — Parse-time `agent:` validation (G5)

- [x] 3.1 Validate `agent:` in the skill zod schema (`src/core/skills/types.ts:178` /
      `SkillParser.ts`) against registered sub-agent types; fail parse with a clear message.
- [x] 3.2 Parser test: unknown `agent:` value fails parse.

## Phase 4 — ActiveTab debounce (G4)

- [x] 4.1 Add a 500ms trailing debounce to the ActiveTab subscriber at the extension
      `service-worker.ts` subscribe site and the desktop bootstrap equivalent.
- [x] 4.2 Test: N rapid tab switches → exactly 1 callback after 500ms.

## Phase 5 — Delete orphaned command layer (G3)

- [x] 5.1 Remove `src/core/commands/` and its tests.
- [x] 5.2 Verify `src/webfront/commands/` remains untouched and still owns the visible
      slash-command/typeahead surface.
- [x] 5.3 Run type-check and command-related tests; confirm no dangling runtime imports.

## Exit criteria

- An inline skill with `allowed-tools` cannot invoke tools outside its list (verified test).
- Server and extension agents execute skills through `SkillExecutor` + `SkillRiskAssessor`
  like desktop.
- Unknown `agent:` fails at parse time.
- ActiveTab callback debounced to 500ms.
- `src/core/commands/` is deleted; the webfront command surface remains intact.
