# Track 42 Tasks: System Prompt Content Improvements

## Phase 0: Prompt Assembly Integrity

- [ ] Add focused tests for `get_full_instructions()` in `src/core/models/PromptHelpers.ts`.
- [ ] Verify `base_instructions_override` replaces model base instructions when present.
- [ ] Verify `user_instructions` are appended exactly once.
- [ ] Confirm provider request builders send one combined instruction string through their native system channel.
- [ ] Search references to `buildCompletionRequest()` and `convertPromptToMessages()` in `src/core/TurnManager.ts`.
- [ ] Remove unused legacy prompt-to-message code, or refactor it so it never reloads and duplicates the base prompt.
- [ ] Run relevant prompt/model unit tests before editing prompt content.

## Phase 1: New Fragments And Composer Order

- [ ] Add `src/prompts/fragments/system_semantics.md`.
- [ ] Add `src/prompts/fragments/action_risk_and_approval.md`.
- [ ] Add `src/prompts/fragments/work_loop.md`.
- [ ] Add `src/prompts/fragments/communication.md`.
- [ ] Update `src/prompts/PromptComposer.ts` imports.
- [ ] Replace `approval_policies.md` usage with `action_risk_and_approval.md`.
- [ ] Replace `task_execution_policies.md` usage with `work_loop.md` and `communication.md`.
- [ ] Set composer order to: intro, persona, runtime metadata, system semantics, safety, action risk, work loop, platform tools, communication, plan review.
- [ ] Preserve plan-review fragment inclusion only when `planReviewActive` is true.
- [ ] Preserve persona behavior so safety, action risk, and communication are never skipped.

## Phase 2: Existing Fragment Cleanup

- [ ] Tighten `src/prompts/fragments/safety.md` around ethics, privacy, credentials, and financial restrictions.
- [ ] Remove duplicated observe/act/verify guidance from `src/prompts/fragments/browserx_tools.md`.
- [ ] Keep BrowserX tool guidance focused on DOMTool, PageVisionTool, NavigationTool, StorageTool, SettingTool, and safe tool chaining.
- [ ] Fix BrowserX prompt typos: `imsage` and `parsed html`.
- [ ] Remove duplicated planning/work-loop prose from `src/prompts/fragments/pi_tools.md`.
- [ ] Keep Apple Pi guidance focused on TerminalTool, browser MCP tools, WebSearchTool, SettingTool, and safe tool chaining.
- [ ] Add Apple Pi file/code guidance: inspect first, preserve user work, keep edits scoped, verify when practical.

## Phase 3: Planning Tool Detail

- [ ] Update `TOOL_DESCRIPTION` in `src/tools/PlanningTool.ts` with concise status-discipline guidance.
- [ ] Keep planning command names and parameter schema unchanged.
- [ ] Ensure global prompt fragments no longer contain long planning schema/tutorial text.
- [ ] Update `src/tools/__tests__/PlanningTool.test.ts` only if tool-description assertions require it.

## Phase 4: Memory And Skills

- [ ] Update `src/core/memory/prompts/memory_instructions.md` to exclude derivable/current-task/trivial information.
- [ ] Add stale-memory verification guidance to memory instructions.
- [ ] Update `src/core/memory/__tests__/MemoryService.test.ts`.
- [ ] Update `src/core/skills/SkillRegistry.ts` with the skill anti-guessing rule.
- [ ] Add or update skill prompt tests to preserve no-skills behavior and listed-skill formatting.

## Phase 5: Fallback Prompts

- [ ] Update `src/prompts/default_browserx_agent_prompt.md` with the new section concepts.
- [ ] Update `src/prompts/default_applepi_agent_prompt.md` with the new section concepts.
- [ ] Ensure fallback prompts stay static and platform-specific.
- [ ] Update `src/core/__tests__/PromptLoader.test.ts` fallback assertions.

## Phase 6: Prompt Tests And Size Budget

- [ ] Update `src/prompts/__tests__/PromptComposer.test.ts` for new section labels and ordering.
- [ ] Test BrowserX composed prompt includes BrowserX tools and excludes Apple Pi-only guidance.
- [ ] Test Apple Pi composed prompt includes terminal/browser MCP guidance and excludes BrowserX-only tools.
- [ ] Test Apple Pi Server composed prompt includes server identity and server-appropriate guidance.
- [ ] Test persona `keepCodingInstructions: false` still retains system semantics, safety, action risk, communication, and active plan review.
- [ ] Test plan-review fragment appears only when active.
- [ ] Test memory and skills extensions appear after the base prompt when registered.
- [ ] Add prompt size measurement for static BrowserX and Apple Pi prompts.
- [ ] Confirm static prompt size is reduced by at least 20% for BrowserX and Apple Pi.

## Phase 7: Manual End-To-End Validation

- [ ] Browser observe/act/verify task completes without excessive narration.
- [ ] Hostile page-content task treats page instructions as untrusted data.
- [ ] Approval denial flow does not retry the same denied action unchanged.
- [ ] Apple Pi file/code task inspects before editing and verifies with an available command.
- [ ] Plan-review mode still appends prompt guidance and exits correctly after approval or rejection.
- [ ] Memory recall flow verifies stale/stateful memory before action.
- [ ] Skills flow invokes a listed skill and does not guess nonexistent skills.

## Final Checks

- [ ] Run targeted prompt/model/tool tests.
- [ ] Run broader test suite if prompt changes touch shared behavior.
- [ ] Run `git diff --check`.
- [ ] Review generated prompt output manually for BrowserX, Apple Pi, and Apple Pi Server.
- [ ] Confirm acceptance criteria in `design.md` are satisfied.
