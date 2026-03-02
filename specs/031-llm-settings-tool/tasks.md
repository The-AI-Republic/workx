# Tasks: LLM Settings Tool

**Input**: Design documents from `/specs/031-llm-settings-tool/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/

**Tests**: Included in Polish phase -- not explicitly requested but test files are listed in the implementation plan.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

## Phase 1: Foundational (Blocking Prerequisites)

**Purpose**: Create the allowlist security boundary, risk assessor, and type definitions that ALL user stories depend on

**CRITICAL**: No user story work can begin until this phase is complete

- [ ] T001 Create settingsAllowlist.ts with AllowlistEntry interface, SETTINGS_ALLOWLIST constant (~22 entries from data-model.md covering approval, tools, general, and model categories), and helper functions (getEntry, validateValue, isAllowlisted, getByCategory) in src/tools/settingsAllowlist.ts
- [ ] T002 [P] Create SettingToolRiskAssessor implementing IRiskAssessor with action-based scoring: get/list actions return score 0 (auto_approve), set action returns score 50 (ask_user) in src/core/approval/assessors/SettingToolRiskAssessor.ts
- [ ] T003 [P] Add `setting_tool?: boolean` field to IToolsConfig interface in src/config/types.ts

**Checkpoint**: Allowlist, risk assessor, and types ready -- user story implementation can begin

---

## Phase 2: User Story 1 - Read Current Settings via Chat (Priority: P1) MVP

**Goal**: Users can ask the agent about their current settings and receive accurate, human-readable responses. Supports reading individual settings by key and listing all available settings.

**Independent Test**: Send "What is my current approval mode?" in chat and verify the agent returns the correct current value from storage.

### Implementation for User Story 1

- [ ] T004 [US1] Create SettingTool class extending BaseTool in src/tools/SettingTool.ts: define toolDefinition using createToolDefinition() with name 'setting_tool', description explaining setting read/write capabilities, and parameters schema (action: enum get/set/list, key: optional string, value: optional any)
- [ ] T005 [US1] Implement executeImpl() with `get` action in src/tools/SettingTool.ts: validate key exists in allowlist via isAllowlisted(), read current value from storage using the entry's configPath and storageKey (chrome.storage.local get for agent_config or approval_config), return SettingToolResponse with key, label, value, and description
- [ ] T006 [US1] Implement `list` action in executeImpl() in src/tools/SettingTool.ts: iterate all SETTINGS_ALLOWLIST entries, read current values from storage for each, return categorized list of SettingListItem objects grouped by category with current values
- [ ] T007 [US1] Register SettingTool in registerTools() in src/tools/index.ts: always enabled (like PlanningTool), instantiate with SettingToolRiskAssessor, add import and export for SettingTool class

**Checkpoint**: User Story 1 functional -- agent can read any allowlisted setting and list all settings via chat

---

## Phase 3: User Story 2 - Update Settings via Chat (Priority: P1)

**Goal**: Users can change allowlisted settings through natural language commands. The agent validates the value, writes to storage, and confirms the change.

**Independent Test**: Send "Enable the DOM tool" in chat (with DOM tool currently disabled), verify it updates in storage and the agent confirms.

### Implementation for User Story 2

- [ ] T008 [US2] Implement `set` action in executeImpl() in src/tools/SettingTool.ts: validate key in allowlist, validate value against entry's type and allowedValues using validateValue(), read current value as previousValue, write updated value to storage using entry's configPath and storageKey (chrome.storage.local get → merge at path → set), return response with previousValue and new value
- [ ] T009 [US2] Add FR-009 YOLO transition warning in src/tools/SettingTool.ts: when set action targets 'approval.mode' with value 'yolo', append warning to response that SettingTool write access will be disabled once YOLO mode activates
- [ ] T010 [US2] Handle non-allowlisted key access in src/tools/SettingTool.ts: when get or set is called with a key not in the allowlist, return clear error message stating the setting can only be managed through the settings UI (FR-011)

**Checkpoint**: User Story 2 functional -- agent can update settings with validation and storage persistence

---

## Phase 4: User Story 3 - Setting Tool Read-Only in YOLO Mode (Priority: P1)

**Goal**: When YOLO mode is active, write operations are blocked while read operations continue to work normally.

**Independent Test**: Set system to YOLO mode, verify "What is my approval mode?" works but "Set approval mode to balanced" is blocked with a descriptive error.

### Implementation for User Story 3

- [ ] T011 [US3] Add YOLO mode write guard in executeImpl() in src/tools/SettingTool.ts: before executing set action, read current approval mode from approval_config storage, if mode is 'yolo' return error response with message "Settings cannot be modified in YOLO mode. Please switch to balanced or high-speed mode first via the approval mode indicator." (FR-003)
- [ ] T012 [US3] Ensure get and list actions pass through without YOLO check in src/tools/SettingTool.ts: verify the YOLO guard only applies to set action, reads remain unaffected (FR-004)

**Checkpoint**: User Story 3 functional -- YOLO mode blocks writes, allows reads

---

## Phase 5: User Story 4 - Confirmation Before Applying Changes (Priority: P2)

**Goal**: Write operations go through the approval flow so users can review and confirm before changes take effect.

**Independent Test**: Request "Switch approval mode to high speed", verify the approval UI prompts for confirmation before the change is applied.

### Implementation for User Story 4

- [ ] T013 [US4] Verify risk assessor integration in src/tools/SettingTool.ts: ensure SettingToolRiskAssessor (T002) is wired via registration (T007), confirm set action with score 50 triggers ask_user in ApprovalGate for balanced and high-speed modes. No code change needed if T002 and T007 are correct -- this is a validation/integration check.

**Checkpoint**: User Story 4 functional -- writes require user confirmation via approval UI

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Testing, validation, and code quality

- [ ] T014 [P] Create unit tests for settingsAllowlist: test isAllowlisted (valid/invalid keys), validateValue (correct/incorrect types, enum validation), getEntry (existing/missing), getByCategory (all categories) in src/tools/__tests__/settingsAllowlist.test.ts
- [ ] T015 [P] Create unit tests for SettingTool: test get action (valid key, invalid key), set action (valid change, invalid value, non-allowlisted key), list action (returns all entries), YOLO mode blocking (set blocked, get allowed), and FR-009 YOLO warning in src/tools/__tests__/SettingTool.test.ts
- [ ] T016 Run type-check (`npm run type-check`) and lint (`npm run lint`) to validate all new and modified files compile and pass style checks

---

## Dependencies & Execution Order

### Phase Dependencies

- **Foundational (Phase 1)**: No dependencies -- can start immediately. BLOCKS all user stories.
- **US1 Read (Phase 2)**: Depends on Phase 1 completion (needs allowlist + risk assessor)
- **US2 Write (Phase 3)**: Depends on Phase 2 (builds on SettingTool class and get/list from US1)
- **US3 YOLO (Phase 4)**: Depends on Phase 3 (adds guard to set action from US2)
- **US4 Confirmation (Phase 5)**: Depends on Phase 3 (verifies risk assessor integration with set action)
- **Polish (Phase 6)**: Depends on all user stories being complete

### User Story Dependencies

- **US1 (P1)**: After Phase 1 -- no dependencies on other stories
- **US2 (P1)**: After US1 -- extends SettingTool with set action
- **US3 (P1)**: After US2 -- adds YOLO guard to set action
- **US4 (P2)**: After US2 -- validates risk scoring for set action

### Within Each User Story

- Models/types before services/logic
- Core implementation before registration/wiring
- Story complete before moving to next priority

### Parallel Opportunities

**Phase 1 (Foundational)**:
```
T001 (settingsAllowlist.ts)  →  sequential (needed first)
T002 (RiskAssessor.ts)       →  [P] parallel with T001
T003 (types.ts)              →  [P] parallel with T001
```

**Phase 2 (US1) after Phase 1**:
```
T004 → T005 → T006 → T007   →  sequential (same file then registration)
```

**Phase 6 (Polish)**:
```
T014 (allowlist tests)       →  [P] parallel
T015 (SettingTool tests)     →  [P] parallel
T016 (type-check + lint)     →  after T014, T015
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Foundational (T001-T003)
2. Complete Phase 2: US1 Read Settings (T004-T007)
3. **STOP and VALIDATE**: Test `get` and `list` actions work via chat
4. Agent can now answer "What is my approval mode?" and "Show me my settings"

### Incremental Delivery

1. Phase 1: Foundational → Allowlist + risk assessor ready
2. Phase 2: US1 Read → Agent reads settings via chat (MVP!)
3. Phase 3: US2 Write → Agent modifies settings via chat
4. Phase 4: US3 YOLO → Write safety in YOLO mode
5. Phase 5: US4 Confirmation → Verification of approval flow
6. Phase 6: Polish → Tests + validation
7. Each phase adds value without breaking previous phases

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- SettingTool.ts is the main implementation file touched in Phases 2-5
- The allowlist in T001 is the security boundary -- all ~22 entries must be defined per data-model.md
- Storage access uses the same chrome.storage.local / Tauri mechanism as the settings UI
- No new UI components needed -- storage change events trigger existing reactive updates
