# Tasks: Comprehensive Unit Tests & CI Pipeline

**Input**: Design documents from `/specs/017-comprehensive-unit-tests/`
**Prerequisites**: plan.md (required), spec.md (required), research.md

**Tests**: This feature IS about writing tests. All user story tasks produce test files.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Create shared test utilities, consolidate vitest config, prepare for migration

- [ ] T001 Create shared test utilities directory at src/__test-utils__/
- [ ] T002 Move tests/helpers/chrome-storage-mock.ts to src/__test-utils__/chrome-storage-mock.ts and update all imports
- [ ] T003 Move src/core/models/__tests__/setup.ts to src/__test-utils__/setup.ts as global test setup with Chrome API mocks (chrome.runtime, chrome.storage, chrome.tabs, globalThis.fetch)
- [ ] T004 [P] Move tests/mocks/MockAgentStatus.svelte, MockSettingsPanel.svelte, MockTaskDisplay.svelte to src/__test-utils__/mocks/
- [ ] T005 [P] Move tests/fixtures/test-pages/ (infinite-scroll.html, simple-click.html, simple-form.html) to src/__test-utils__/fixtures/test-pages/
- [ ] T006 Update vitest.config.mjs: set setupFiles to ['src/__test-utils__/setup.ts'], change include to ['src/**/__tests__/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'], align path aliases with tsconfig.json (@/* pattern only), add coverage config with reporters ['text', 'json', 'html']
- [ ] T007 [P] Delete vitest.contract.config.ts (merged into main config)
- [ ] T008 [P] Delete vitest.config.dom.ts (duplicate)
- [ ] T009 [P] Delete vitest.dom.config.ts (duplicate)
- [ ] T010 Run existing co-located tests (52 files in src/**/__tests__/) to verify they pass with updated vitest.config.mjs

---

## Phase 2: Foundational - Test Migration (Blocking Prerequisites)

**Purpose**: Migrate all 107 test files from root tests/ to co-located src/**/__tests__/ locations

**⚠️ CRITICAL**: No new unit test writing (US1-US4) can begin until migration is complete and all migrated tests pass

### Unit Test Migration (24 files)

- [ ] T011 [P] Migrate tests/unit/config/AgentConfig.test.ts to src/config/__tests__/AgentConfig.test.ts, update imports
- [ ] T012 [P] Migrate tests/unit/config/events.test.ts to src/config/__tests__/events.test.ts, update imports
- [ ] T013 [P] Migrate tests/unit/config/profiles.test.ts to src/config/__tests__/profiles.test.ts, update imports
- [ ] T014 [P] Migrate tests/unit/config/validators.test.ts to src/config/__tests__/validators.test.ts, update imports
- [ ] T015 [P] Migrate tests/unit/core/TurnManager.test.ts to src/core/__tests__/TurnManager.test.ts, update imports
- [ ] T016 [P] Migrate tests/unit/core/session/SnapshotCompressor.test.ts to src/core/session/__tests__/SnapshotCompressor.test.ts, update imports
- [ ] T017 [P] Migrate tests/unit/storage/SessionCacheManager.test.ts, CacheManager-IndexedDB.test.ts, ConfigStorage.test.ts, ConfigStorage-IndexedDB.test.ts, IndexedDBAdapter.test.ts to src/storage/__tests__/, update imports
- [ ] T018 [P] Migrate tests/unit/registry/AgentRegistry.test.ts and AgentSession.test.ts to src/core/registry/__tests__/, update imports
- [ ] T019 [P] Migrate tests/unit/TabContext.test.ts, TabManager.test.ts, TurnContext.test.ts to src/core/__tests__/, update imports
- [ ] T020 [P] Migrate tests/unit/calculateBackoff.test.ts, convertTokenUsage.test.ts, parseRateLimitSnapshot.test.ts to src/core/models/__tests__/, update imports
- [ ] T021 [P] Migrate tests/unit/models/OpenAIChatCompletionClient.test.ts to src/core/models/__tests__/, update imports
- [ ] T022 [P] Migrate tests/unit/EventProcessor.contract.test.ts, formatters.contract.test.ts to src/core/__tests__/, update imports
- [ ] T023 [P] Migrate tests/unit/protocol/config-messages.test.ts to src/core/protocol/__tests__/, update imports
- [ ] T024 [P] Migrate tests/unit/tools/StorageTool.test.ts to src/tools/__tests__/StorageTool.test.ts, update imports

### Contract Test Migration (13 files)

- [ ] T025 [P] Migrate tests/contract/ModelClient.test.ts, ResponseEvent.test.ts, StreamAttemptError.test.ts to src/core/models/__tests__/, update imports
- [ ] T026 [P] Migrate tests/contract/storage-api.test.js, storage-api-save.test.js, storage-api-delete.test.js to src/extension/storage/__tests__/, update imports
- [ ] T027 [P] Migrate tests/contract/BrowserAdaptations.test.ts, content-script-initialization.test.ts to src/extension/__tests__/, update imports
- [ ] T028 [P] Migrate tests/contract/dom-tool-file-path.test.ts to src/tools/dom/__tests__/, update imports
- [ ] T029 [P] Migrate tests/contract/captureRequest.contract.test.ts, pageModel.contract.test.ts, tab-binding.contract.test.ts to src/core/__tests__/, update imports
- [ ] T030 [P] Migrate tests/contract/ui-events-modal.test.js to src/extension/content/ui_effect/__tests__/, update imports

### Integration Test Migration (41 files)

- [ ] T031 [P] Migrate tests/integration/dom-operations/ (5 files: action_sequence, error_retry, form_automation, iframe_access, wait_for_element) to src/tools/dom/__tests__/, rename with .integration.test.ts suffix, update imports
- [ ] T032 [P] Migrate tests/integration/dom-tool-error-handling.test.ts, dom-tool-injection.test.ts, dynamicContent.integration.test.ts, ecommerce.integration.test.ts, loginPage.integration.test.ts, nestedRegions.integration.test.ts, privacyRedaction.integration.test.ts to src/tools/dom/__tests__/, update imports
- [ ] T033 [P] Migrate tests/integration/edge-cases/ (5 files: azure-workaround, invalid-api-key, missing-headers, response-failed, stream-timeout) to src/core/__tests__/, rename with .integration.test.ts suffix, update imports
- [ ] T034 [P] Migrate tests/integration/session-* tests (session-cleanup, session-persistence, session-tab-lifecycle) to src/core/__tests__/, rename with .integration.test.ts suffix, update imports
- [ ] T035 [P] Migrate tests/integration/tab-* tests (tab-binding, tab-closure-detection, tab-context-display) to src/core/__tests__/, update imports
- [ ] T036 [P] Migrate tests/integration/config-* tests (config-events, config-flow, config-injection) to src/core/__tests__/, update imports
- [ ] T037 [P] Migrate tests/integration/message-communication.test.ts, cross-context.test.ts, backward-compat.test.ts, error-recovery.test.ts, parallel-execution.test.ts, unknown-tool.test.ts, concurrent-binding.test.ts, multi-session.test.ts, gemini-agent-flow.test.ts to src/core/__tests__/, update imports
- [ ] T038 [P] Migrate tests/integration/snapshot-compression.test.ts to src/core/session/__tests__/, update imports
- [ ] T039 [P] Migrate tests/integration/registry-persistence.test.ts to src/core/registry/__tests__/, update imports
- [ ] T040 [P] Migrate tests/integration/rollout-integration.test.ts, cache-rollout-compatibility.test.ts, storage-tool-cache.test.ts to src/storage/__tests__/, update imports
- [ ] T041 [P] Migrate tests/integration/settings-gear.test.ts to src/extension/sidepanel/__tests__/, update imports

### Sidepanel & Component Test Migration (8 files)

- [ ] T042 [P] Migrate tests/sidepanel/App.test.ts, styles.test.ts to src/extension/sidepanel/__tests__/, update imports
- [ ] T043 [P] Migrate tests/sidepanel/MessageInput.test.ts, TerminalInput.test.ts, TerminalMessage.test.ts to src/extension/sidepanel/components/__tests__/, update imports
- [ ] T044 [P] Migrate tests/sidepanel/integration/userInput.test.ts to src/extension/sidepanel/__tests__/userInput.integration.test.ts, update imports
- [ ] T045 [P] Migrate tests/sidepanel/visual/inputOutline.visual.test.ts, userMessages.visual.test.ts to src/extension/sidepanel/__tests__/, update imports

### Storage, Performance, & Remaining Test Migration

- [ ] T046 [P] Migrate tests/storage/rollout/ (7 files: cleanup, helpers, listing, policy, RolloutRecorder, RolloutWriter, types) to src/storage/rollout/__tests__/, update imports
- [ ] T047 [P] Migrate tests/performance/ (5 files: cache-performance, rollout-performance, session-overhead, sse-processing.perf, stream-init.perf) to corresponding src/**/__tests__/ locations, update imports
- [ ] T048 [P] Migrate tests/tools/ToolRegistry.config.test.ts, ToolRegistry.initialize.test.ts to src/tools/__tests__/, update imports
- [ ] T049 [P] Migrate tests/tools/dom/LayoutSimplifier-empty-divs.test.ts to src/tools/dom/__tests__/, update imports
- [ ] T050 [P] Migrate tests/prompts/loader.test.ts to src/core/__tests__/PromptLoader.test.ts, update imports
- [ ] T051 [P] Migrate tests/validation/token-reduction-validation.test.ts to src/config/__tests__/, update imports
- [ ] T052 [P] Migrate tests/utils/encryption.test.ts to src/utils/__tests__/encryption.test.ts, update imports
- [ ] T053 [P] Migrate tests/models/ModelClientFactory.config.test.ts to src/core/models/__tests__/, update imports
- [ ] T054 [P] Migrate tests/core/ApprovalManager.config.test.ts, Session.config.test.ts to src/core/__tests__/, update imports

### Migration Cleanup

- [ ] T055 Remove the root tests/ directory after verifying all tests have been migrated
- [ ] T056 Run full test suite (npm run test:all) to verify zero regressions after migration

**Checkpoint**: All existing tests now co-located in src/**/__tests__/. Full suite passes.

---

## Phase 3: User Story 1 - Unit Tests for Core Agent Logic (Priority: P1) 🎯 MVP

**Goal**: Comprehensive unit tests for BrowserxAgent, Session, TurnManager, DiffTracker, MessageRouter, StreamProcessor, TaskRunner

**Independent Test**: Run `npx vitest run src/core/__tests__/BrowserxAgent.test.ts src/core/__tests__/Session.test.ts src/core/__tests__/TurnManager.test.ts src/core/__tests__/DiffTracker.test.ts src/core/__tests__/MessageRouter.test.ts src/core/__tests__/StreamProcessor.test.ts src/core/__tests__/TaskRunner.test.ts`

### New Tests for Core Agent

- [ ] T057 [P] [US1] Create unit tests for BrowserxAgent in src/core/__tests__/BrowserxAgent.test.ts: test initialize(), submitOperation(), getNextEvent(), cancelTask(), cleanup(), isReady(), interrupt(); mock AgentConfig, Session, ModelClientFactory, ToolRegistry, MessageRouter
- [ ] T058 [P] [US1] Create unit tests for Session in src/core/__tests__/Session.test.ts: test constructor, initialize(), addToHistory(), getConversationHistory(), clearHistory(), export()/import(), startTurn()/endTurn(), requestInterrupt()/isInterruptRequested(), compact()/shouldCompact(), spawnTask()/cancelTask(), addTokenUsage(), buildTurnInputWithHistory(); mock SessionState, RolloutRecorder, CompactService, TurnContext
- [ ] T059 [P] [US1] Create unit tests for DiffTracker in src/core/__tests__/DiffTracker.test.ts: test addChange(), getChanges(), rollbackChanges(), createSnapshot()/restoreSnapshot()/deleteSnapshot(), clearChanges(), destroy(); minimal mocking needed (mostly self-contained)
- [ ] T060 [P] [US1] Create unit tests for StreamProcessor in src/core/__tests__/StreamProcessor.test.ts: test start(), processResponsesStream(), pause()/resume()/abort(), getStatus()/getMetrics(), onUpdate()/onResponseEvent(), flushPendingUpdates(); mock ReadableStream, AsyncGenerator
- [ ] T061 [P] [US1] Create unit tests for TaskRunner in src/core/__tests__/TaskRunner.test.ts: test run_task(), cancel()/isCancelled(), getTaskStatus(), getCurrentTurnIndex(), getTokenUsage(); mock Session, TurnContext, TurnManager

### Expanded Tests for Partially-Covered Core Modules

- [ ] T062 [P] [US1] Expand TurnManager tests in src/core/__tests__/TurnManager.test.ts: add tests for runTurn() with retry logic, cancel()/isCancelled(), error handling for malformed responses, max retry exhaustion
- [ ] T063 [P] [US1] Expand MessageRouter tests in src/core/__tests__/MessageRouter.test.ts: add tests for on()/send()/broadcast(), sendSubmission(), sendEvent(), executeTabCommand(), storageGet()/storageSet(), requestApproval(), sendResponseEvent variants, isConnected(), cleanup(); mock chrome.runtime.sendMessage, chrome.tabs.sendMessage

**Checkpoint**: All 7 core agent modules have unit tests. Run `npx vitest run src/core/__tests__/{BrowserxAgent,Session,TurnManager,DiffTracker,MessageRouter,StreamProcessor,TaskRunner}.test.ts` to verify.

---

## Phase 4: User Story 2 - Unit Tests for Tool Implementations (Priority: P2)

**Goal**: Unit tests for BaseTool, FormAutomation, NetworkIntercept, DataExtraction, WebScraping, Navigation, ToolRegistry, StorageTool

**Independent Test**: Run `npx vitest run src/tools/__tests__/`

### New Tests for Tools

- [ ] T064 [P] [US2] Create unit tests for BaseTool in src/tools/__tests__/BaseTool.test.ts: test getDefinition(), execute(), validateParameters(), applyDefaults(), formatError(), createError(), executeWithRetry(), executeWithTimeout(); mock chrome.tabs for tab validation methods
- [ ] T065 [P] [US2] Create unit tests for FormAutomationTool in src/tools/__tests__/FormAutomationTool.test.ts: test parameter validation, form field detection, input type handling, submit behavior, error on invalid selectors; mock DOM via jsdom
- [ ] T066 [P] [US2] Create unit tests for NetworkInterceptTool in src/tools/__tests__/NetworkInterceptTool.test.ts: test parameter validation, request interception setup, response modification, filter patterns, cleanup; mock chrome.webRequest
- [ ] T067 [P] [US2] Create unit tests for DataExtractionTool in src/tools/__tests__/DataExtractionTool.test.ts: test parameter validation, selector-based extraction, structured data output, empty result handling, nested element extraction; mock DOM via jsdom
- [ ] T068 [P] [US2] Create unit tests for WebScrapingTool in src/tools/__tests__/WebScrapingTool.test.ts: test parameter validation, page content extraction, pagination handling, rate limiting, error recovery; mock fetch and DOM
- [ ] T069 [P] [US2] Create unit tests for NavigationTool in src/tools/__tests__/NavigationTool.test.ts: test parameter validation, URL navigation, wait conditions, back/forward/reload, timeout handling; mock chrome.tabs
- [ ] T070 [P] [US2] Expand ToolRegistry tests in src/tools/__tests__/ToolRegistry.test.ts: add tests for register()/unregister(), discover(), validate(), execute(), getTool()/listTools(), getStats(), clear()/cleanup(); cover unknown tool name, duplicate registration, invalid parameters

**Checkpoint**: All tool implementations have unit tests. Run `npx vitest run src/tools/__tests__/` to verify.

---

## Phase 5: User Story 3 - Unit Tests for Configuration & Storage (Priority: P3)

**Goal**: Unit tests for AgentConfig, validators, ConfigStorage, SessionCacheManager, IndexedDBAdapter, rollout modules

**Independent Test**: Run `npx vitest run src/config/__tests__/ src/storage/__tests__/`

### Expanded Tests for Config & Storage

- [ ] T071 [P] [US3] Expand AgentConfig tests in src/config/__tests__/AgentConfig.test.ts: add tests for getInstance(), initialize(), reload(), getConfig(), updateConfig(), resetConfig(), setSelectedModel(); test config merging precedence, validation errors, default values; mock chrome.storage
- [ ] T072 [P] [US3] Expand validators tests in src/config/__tests__/validators.test.ts: add tests for validateConfig(), validateModelConfig(), validateProviderConfig(), validateProfileConfig(), validateUserPreferences(), detectProviderFromKey(), isValidModelId(), validateModelKeyUniqueness(); cover edge cases (empty config, invalid API keys, duplicate model keys)
- [ ] T073 [P] [US3] Create unit tests for ConfigStorage in src/storage/__tests__/ConfigStorage.test.ts: expand existing tests to cover full CRUD operations, config persistence, migration handling, error recovery on corrupted data; mock fake-indexeddb
- [ ] T074 [P] [US3] Expand SessionCacheManager tests in src/storage/__tests__/SessionCacheManager.test.ts: add tests for write()/read()/update()/delete(), list(), getStats()/getGlobalStats(), checkGlobalQuota(), clearSession(), cleanupOrphans()/cleanupOutdated(), getConfig()/setConfig(); test QuotaExceededError, DataTooLargeError, CorruptedDataError paths
- [ ] T075 [P] [US3] Expand IndexedDBAdapter tests in src/storage/__tests__/IndexedDBAdapter.test.ts: add tests for put()/get()/delete()/getAll(), queryByIndex(), batchDelete(), close(); test StorageUnavailableError, concurrent access, large data sets; mock fake-indexeddb

**Checkpoint**: Config and storage modules fully covered. Run `npx vitest run src/config/__tests__/ src/storage/__tests__/` to verify.

---

## Phase 6: User Story 4 - Unit Tests for Model Clients & MCP (Priority: P4)

**Goal**: Unit tests for GoogleCompletionClient, ModelClientFactory, RequestQueue, MCPManager expansion

**Independent Test**: Run `npx vitest run src/core/models/__tests__/ src/core/mcp/__tests__/`

### New & Expanded Tests for Model Clients

- [ ] T076 [P] [US4] Create unit tests for GoogleCompletionClient in src/core/models/__tests__/GoogleCompletionClient.test.ts: test request formatting, streaming response parsing, error handling (rate limits, auth errors, malformed responses), retry logic; mock fetch
- [ ] T077 [P] [US4] Create unit tests for RequestQueue in src/core/models/__tests__/RequestQueue.test.ts: test enqueue()/dequeue(), priority ordering, getStatus(), clear(), pause()/resume(), getAnalytics(); test rate limiting, queue overflow, concurrent processing; self-contained with timer mocks
- [ ] T078 [P] [US4] Expand ModelClientFactory tests in src/core/models/__tests__/ModelClientFactory.test.ts: add tests for initialize(), createClientForCurrentModel(), createClient() for each provider type (OpenAI, Google, Groq, Together, Fireworks), getClientCacheKey(), setAuthManager(); verify correct client type instantiation per provider config; mock AgentConfig

### Expanded Tests for MCP

- [ ] T079 [P] [US4] Expand MCPManager tests in src/core/mcp/__tests__/MCPManager.test.ts: add tests for addServer()/updateServer()/removeServer(), connect()/disconnect() lifecycle, getAllTools()/getAllResources(), executeTool(), readResource(), event handling; test connection failure recovery, server removal while connected

**Checkpoint**: Model clients and MCP fully covered. Run `npx vitest run src/core/models/__tests__/ src/core/mcp/__tests__/` to verify.

---

## Phase 7: User Story 5 - GitHub Actions CI Pipeline (Priority: P5)

**Goal**: Automated CI pipeline that runs lint, type-check, and full test suite with coverage on every PR

**Independent Test**: Create a test PR against pi-dev branch and verify CI triggers, runs, and reports status

- [ ] T080 [US5] Create GitHub Actions workflow file at .github/workflows/ci.yml with: trigger on pull_request (opened, synchronize, reopened) against pi-dev branch; ubuntu-latest runner; Node.js 18; steps: checkout, npm ci, npm run lint, npm run type-check, npm run test:all -- --coverage; upload coverage/ directory as artifact; 15-minute job timeout
- [ ] T081 [US5] Add coverage script to package.json: add "test:coverage": "vitest run --coverage" script
- [ ] T082 [US5] Verify CI pipeline by creating a test branch, pushing a commit, and opening a PR against pi-dev to confirm the workflow triggers and reports status

**Checkpoint**: CI pipeline operational. Every PR triggers automated lint + type-check + test + coverage.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: Final verification, coverage validation, cleanup

- [ ] T083 Run full test suite with coverage (npm run test:all -- --coverage) and verify 70% line coverage minimum across all tested modules
- [ ] T084 Review coverage report (coverage/index.html) and identify any critical uncovered paths; add targeted tests if below 70% threshold
- [ ] T085 [P] Verify all tests are deterministic by running suite 3 times consecutively with no failures
- [ ] T086 [P] Run quickstart.md validation: follow all steps in specs/017-comprehensive-unit-tests/quickstart.md and verify they work correctly

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately
- **Foundational/Migration (Phase 2)**: Depends on Phase 1 completion - BLOCKS all user stories
- **US1-US4 (Phases 3-6)**: All depend on Phase 2 completion
  - US1-US4 can proceed in parallel (different source directories)
  - Or sequentially in priority order (P1 → P2 → P3 → P4)
- **US5 (Phase 7)**: Can start after Phase 2 (needs tests to run); benefits from US1-US4 being done
- **Polish (Phase 8)**: Depends on all user stories being complete

### User Story Dependencies

- **US1 (P1)**: Can start after Phase 2 - No dependencies on other stories
- **US2 (P2)**: Can start after Phase 2 - No dependencies on US1
- **US3 (P3)**: Can start after Phase 2 - No dependencies on US1/US2
- **US4 (P4)**: Can start after Phase 2 - No dependencies on US1/US2/US3
- **US5 (P5)**: Can start after Phase 2 - Independent of US1-US4 (runs whatever tests exist)

### Within Each User Story

- Each test file is independent and can be written in parallel (marked [P])
- Expanded tests for partially-covered modules can be done alongside new tests
- Story complete when all tasks checked and tests pass

### Parallel Opportunities

- All Phase 1 tasks T004-T005 (fixture/mock moves) can run in parallel
- All Phase 1 tasks T007-T009 (config deletions) can run in parallel
- All Phase 2 migration tasks (T011-T054) can run in parallel (different files)
- All US1 tasks (T057-T063) can run in parallel (different test files)
- All US2 tasks (T064-T070) can run in parallel (different test files)
- All US3 tasks (T071-T075) can run in parallel (different test files)
- All US4 tasks (T076-T079) can run in parallel (different test files)
- US1-US4 phases can run in parallel with each other

---

## Parallel Example: User Story 1 (Core Agent Tests)

```bash
# Launch all new core test files in parallel:
Task: "Create unit tests for BrowserxAgent in src/core/__tests__/BrowserxAgent.test.ts"
Task: "Create unit tests for Session in src/core/__tests__/Session.test.ts"
Task: "Create unit tests for DiffTracker in src/core/__tests__/DiffTracker.test.ts"
Task: "Create unit tests for StreamProcessor in src/core/__tests__/StreamProcessor.test.ts"
Task: "Create unit tests for TaskRunner in src/core/__tests__/TaskRunner.test.ts"
Task: "Expand TurnManager tests in src/core/__tests__/TurnManager.test.ts"
Task: "Expand MessageRouter tests in src/core/__tests__/MessageRouter.test.ts"
```

---

## Implementation Strategy

### MVP First (Setup + Migration + US1)

1. Complete Phase 1: Setup (shared utils, vitest config)
2. Complete Phase 2: Migration (all 107 files moved)
3. Complete Phase 3: US1 - Core Agent Tests
4. **STOP and VALIDATE**: Run core tests, check coverage
5. Core modules now have regression safety

### Incremental Delivery

1. Setup + Migration → Test infrastructure ready
2. Add US1 (Core) → Core agent covered → Validate
3. Add US2 (Tools) → Tool layer covered → Validate
4. Add US3 (Config/Storage) → Infrastructure covered → Validate
5. Add US4 (Models/MCP) → External integrations covered → Validate
6. Add US5 (CI) → Automated enforcement → Validate
7. Polish → 70% coverage confirmed

### Parallel Strategy

With multiple developers:
1. Team completes Setup + Migration together
2. Once migration done:
   - Developer A: US1 (Core Agent Tests)
   - Developer B: US2 (Tool Tests)
   - Developer C: US3 (Config/Storage Tests)
   - Developer D: US4 (Model/MCP Tests)
3. Any developer: US5 (CI Pipeline) - quick, can be done early
4. All verify Polish phase together

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- Each user story targets different source directories - truly parallelizable
- Migration tasks preserve all test logic; only file paths and imports change
- All new tests must use mocks for external dependencies (Chrome APIs, fetch, IndexedDB)
- Commit after each migration group and after each new test file
- Stop at any checkpoint to validate independently
