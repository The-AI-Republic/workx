## Summary

- **Platform-specific agent names**: Chat label and system prompt now display "BrowserX" (extension), "Apple Pi" (desktop), or "Apple Pi Server" (server) based on `__BUILD_MODE__`
- **Fix "ApplePi" -> "Apple Pi"**: Corrected the missing space in the desktop agent's identity across prompt fragments and user-facing text
- **Server agent identity**: Created distinct `applepi-server` agent type with its own intro fragment for headless server mode

## Completed Tasks (T001-T011)

| Phase | Tasks | Description |
|-------|-------|-------------|
| Phase 2: Foundational | T001-T002 | Add `agentDisplayName` to platformStore, extend `AgentType` union |
| Phase 3: US1 - Chat Labels | T003-T004 | Update EventProcessor and EventDisplay to use platform-aware name |
| Phase 4: US2 - System Prompts | T005-T007 | Fix applepi_intro.md, create server intro, update PromptComposer |
| Phase 5: US3 - Server Identity | T008-T009 | Update ServerAgentBootstrap and PromptLoader fallback |
| Phase 6: Polish | T010-T011 | Fix remaining "ApplePi" in user-facing text, all tests pass |

## Files Changed (15 files)

- `src/webfront/stores/platformStore.ts` — New `agentDisplayName` export
- `src/prompts/PromptComposer.ts` — Extended AgentType, server intro selection
- `src/prompts/fragments/applepi_intro.md` — "ApplePi" -> "Apple Pi"
- `src/prompts/fragments/applepi_server_intro.md` — NEW server intro
- `src/webfront/components/event_display/EventProcessor.ts` — Platform-aware label
- `src/webfront/components/event_display/EventDisplay.svelte` — Platform-aware label
- `src/server/agent/ServerAgentBootstrap.ts` — Use 'applepi-server' type
- `src/core/PromptLoader.ts` — Server fallback handling
- `src/core/protocol/types.ts` — "Apple Pi" in user message prefix
- `src/core/models/ModelClientFactory.ts` — "Apple Pi" in Gemini prompt

## Test plan

- [x] All 245 test files pass (7279 tests)
- [x] No "ApplePi" (without space) in user-facing text or system prompts
- [ ] Manual: Extension build shows "BrowserX:" in chat
- [ ] Manual: Desktop build shows "Apple Pi:" in chat
- [ ] Manual: Server system prompt begins with "You are Apple Pi Server"

🤖 Generated with [Claude Code](https://claude.com/claude-code)
