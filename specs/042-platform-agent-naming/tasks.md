# Tasks: Platform-Specific Agent Naming

**Input**: Design documents from `/specs/042-platform-agent-naming/`
**Prerequisites**: plan.md (required), spec.md (required for user stories)

**Tests**: Not explicitly requested. Test tasks are omitted.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story. US1 and US2 are both P1 priority and can proceed in parallel after foundational work.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: No new project setup needed. All changes are within the existing codebase.

*(No tasks -- existing project structure is sufficient)*

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Add the `agentDisplayName` utility and extend the `AgentType` union that both user stories depend on.

- [x] T001 Add `agentDisplayName` export to `src/webfront/stores/platformStore.ts` that maps `__BUILD_MODE__` to display name: `'extension'` -> `'BrowserX'`, `'desktop'` -> `'Apple Pi'`, `'server'` -> `'Apple Pi Server'`, default -> `'BrowserX'`
- [x] T002 [P] Extend `AgentType` union in `src/prompts/PromptComposer.ts` from `'browserx' | 'applepi'` to `'browserx' | 'applepi' | 'applepi-server'` (FR-006)

**Checkpoint**: Foundation ready -- user story implementation can now begin in parallel

---

## Phase 3: User Story 1 - Agent Chat Label Reflects Platform (Priority: P1)

**Goal**: Agent response messages display "BrowserX:", "Apple Pi:", or "Apple Pi Server:" based on platform.

**Independent Test**: Send a message on extension/desktop/server build and verify the sender label matches.

### Implementation for User Story 1

- [x] T003 [US1] Update `src/webfront/components/event_display/EventProcessor.ts` line 236: replace `title: t('browserx')` with `title: agentDisplayName` imported from `src/webfront/stores/platformStore.ts` (FR-009)
- [x] T004 [US1] Update `src/webfront/components/event_display/EventDisplay.svelte` line 167: replace `t('BrowserX')` with `agentDisplayName` imported from `src/webfront/stores/platformStore.ts` (FR-010)

**Checkpoint**: Chat labels now show platform-specific agent names

---

## Phase 4: User Story 2 - System Prompt Uses Correct Agent Name (Priority: P1)

**Goal**: The LLM system prompt identifies the agent as "BrowserX", "Apple Pi", or "Apple Pi Server" per platform.

**Independent Test**: Inspect composed system prompt output on each platform build.

### Implementation for User Story 2

- [x] T005 [P] [US2] Fix `src/prompts/fragments/applepi_intro.md`: change "You are ApplePi" to "You are Apple Pi" (with space) throughout the file (FR-004)
- [x] T006 [P] [US2] Create `src/prompts/fragments/applepi_server_intro.md` modeled after `applepi_intro.md` but with "You are Apple Pi Server" identity and server-specific description (headless mode, API-driven, no direct browser tab access) (FR-005)
- [x] T007 [US2] Update `src/prompts/PromptComposer.ts`: import new `applepi_server_intro.md` fragment, update `composeMainInstruction()` to select it for `'applepi-server'` type, update `buildRuntimeMetadata()` to include OS details for `'applepi-server'` (FR-008)

**Checkpoint**: System prompts now use correct agent names per platform

---

## Phase 5: User Story 3 - Server Gets Distinct Agent Identity (Priority: P2)

**Goal**: Server bootstrap uses `'applepi-server'` agent type instead of `'applepi'`, giving it a distinct prompt identity.

**Independent Test**: Boot server agent, verify composed prompt begins with "You are Apple Pi Server".

### Implementation for User Story 3

- [x] T008 [US3] Update `src/server/agent/ServerAgentBootstrap.ts` line 387: change `configurePromptComposer('applepi', staticContext)` to `configurePromptComposer('applepi-server', staticContext)` (FR-007)
- [x] T009 [US3] Update `src/core/PromptLoader.ts` fallback logic (lines 85-88): add `__BUILD_MODE__ === 'server'` case to fall back to server-appropriate default prompt (FR-007)

**Checkpoint**: Server agent now has its own distinct identity, separate from desktop

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Verify no stale "ApplePi" (without space) references remain.

- [x] T010 Run project-wide search for "ApplePi" (without space) in user-facing text and system prompts; fix any remaining occurrences (SC-004). Note: internal identifiers like `'applepi'` agent type, import paths, and variable names are fine -- only fix user-facing/prompt text.
- [x] T011 Run `npm test && npm run lint` to verify no regressions

---

## Dependencies & Execution Order

### Phase Dependencies

- **Foundational (Phase 2)**: No dependencies -- can start immediately
- **US1 (Phase 3)**: Depends on T001 (agentDisplayName utility)
- **US2 (Phase 4)**: Depends on T002 (AgentType extension)
- **US3 (Phase 5)**: Depends on T007 (PromptComposer updated to handle `'applepi-server'`)
- **Polish (Phase 6)**: Depends on all user stories complete

### User Story Dependencies

- **User Story 1 (P1)**: Depends on T001 only. Independent of US2 and US3.
- **User Story 2 (P1)**: Depends on T002 only. Independent of US1 and US3.
- **User Story 3 (P2)**: Depends on US2 completion (needs PromptComposer to handle `'applepi-server'`).

### Parallel Opportunities

- T001 and T002 can run in parallel (different files)
- T003 and T004 can run in parallel (different files, both depend on T001)
- T005 and T006 can run in parallel (different files)
- US1 and US2 can run in parallel after foundational phase

---

## Parallel Example: Foundational Phase

```bash
# Both foundational tasks in parallel (different files):
Task T001: "Add agentDisplayName to src/webfront/stores/platformStore.ts"
Task T002: "Extend AgentType in src/prompts/PromptComposer.ts"
```

## Parallel Example: User Story 2

```bash
# Prompt fragment tasks in parallel (different files):
Task T005: "Fix applepi_intro.md"
Task T006: "Create applepi_server_intro.md"
# Then sequentially:
Task T007: "Update PromptComposer.ts to use new fragments"
```

---

## Implementation Strategy

### MVP First (User Stories 1 + 2)

1. Complete Phase 2: Foundational (T001, T002 in parallel)
2. Complete Phase 3: US1 (T003, T004) -- chat labels fixed
3. Complete Phase 4: US2 (T005, T006 in parallel, then T007) -- system prompts fixed
4. **STOP and VALIDATE**: Verify extension build shows "BrowserX", desktop build shows "Apple Pi"

### Full Delivery

5. Complete Phase 5: US3 (T008, T009) -- server gets distinct identity
6. Complete Phase 6: Polish (T010, T011) -- verify no stale references

---

## Notes

- Product names ("BrowserX", "Apple Pi", "Apple Pi Server") are proper nouns -- use raw strings, not i18n translation
- Internal identifiers (`'applepi'`, `'browserx'`) remain unchanged -- only user-facing text changes
- `__BUILD_MODE__` is injected at build time by Vite config, no runtime detection needed
- Total: 11 tasks across 6 phases
