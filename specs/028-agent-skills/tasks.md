# Tasks: Agent Skills System

**Input**: Design documents from `/specs/028-agent-skills/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, contracts/

**Tests**: Not explicitly requested in the feature specification. Test tasks are omitted.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Install dependencies, create project structure, extend CommandRegistry

- [ ] T001 Install `yaml` npm package for SKILL.md frontmatter parsing
- [ ] T002 Create core skills directory structure at src/core/skills/
- [ ] T003 Add unregister(name) method to CommandRegistry — returns true if removed, false if not found — in src/extension/sidepanel/commands/CommandRegistry.ts

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core types, parser, and provider interface that ALL user stories depend on

**CRITICAL**: No user story work can begin until this phase is complete

- [ ] T004 Define core types (Skill with invocationMode field, SkillMeta with invocationMode, InvocationMode enum, ParsedSkill, SkillFrontmatter, SkillWithReferences) in src/core/skills/types.ts
- [ ] T005 Define ICommandRegistry interface (register, unregister, has) for dependency injection — SkillRegistry uses this instead of importing from extension — in src/core/skills/types.ts
- [ ] T006 Define Zod validation schemas — including invocationMode: z.enum(['manual', 'auto', 'hybrid']).default('manual'), name regex, description, body: z.string().min(1).max(51200), trusted, source, metadata — in src/core/skills/types.ts
- [ ] T007 Implement SkillParser.parseSkillMd() — extract YAML frontmatter (name, description, metadata, allowed-tools, compatibility) and markdown body from SKILL.md content — in src/core/skills/SkillParser.ts
- [ ] T008 Implement SkillParser.validateSkill() — validate parsed skill against Zod schemas, reject names that conflict with built-in commands by checking commandRegistry.has(name) — in src/core/skills/SkillParser.ts
- [ ] T009 Implement SkillParser.substituteVariables() — replace $ARGUMENTS, $1, $2 etc. in skill body — in src/core/skills/SkillParser.ts
- [ ] T010 Implement SkillParser.serializeToSkillMd() — convert Skill object back to standard-compliant SKILL.md format (no invocationMode in output) — in src/core/skills/SkillParser.ts
- [ ] T011 Define ISkillProvider interface (initialize, listMeta, load, loadReference, save, delete, exists, exportAsSkillMd) in src/core/skills/SkillProvider.ts
- [ ] T012 Create barrel export in src/core/skills/index.ts

**Checkpoint**: Foundation ready — types, parser, and provider interface are available for user story implementation

---

## Phase 3: User Story 1 — Create and Use a Custom Skill (Priority: P1) MVP

**Goal**: Users can create a skill (filesystem or UI) and invoke it via `/skill-name` in chat input. Skills default to manual mode but support auto/hybrid for LLM-driven invocation.

**Independent Test**: Create a skill with name + description + instructions, verify it appears in the `/` dropdown alongside built-in commands, type `/skill-name` and verify the agent follows the instructions

### Implementation for User Story 1

- [ ] T013 [P] [US1] Implement IndexedDBSkillProvider — listMeta returns SkillMeta with invocationMode, load/save persist full Skill including invocationMode, uses existing StorageProvider with 'skills' collection — in src/extension/storage/IndexedDBSkillProvider.ts
- [ ] T014 [P] [US1] Implement FilesystemSkillProvider — initialize creates ~/.airepublic-pi/skills/, listMeta scans directories and reads .skill-meta.json for invocationMode/trusted/source, load reads SKILL.md + .skill-meta.json, save writes SKILL.md + .skill-meta.json sidecar — using Tauri invoke() in src/desktop/storage/FilesystemSkillProvider.ts
- [ ] T015 [US1] Implement SkillRegistry core — constructor(provider, commandRegistry?: ICommandRegistry), discover(), getSkillMetas(), invoke(name, args), refresh() — accepts commandRegistry via dependency injection — in src/core/skills/SkillRegistry.ts
- [ ] T016 [US1] Implement SkillRegistry.registerCommands() — for each skill in manual/hybrid mode, call commandRegistry.register({ name, description, action }); skip skills in auto mode; skip skills whose name conflicts with existing commands — in src/core/skills/SkillRegistry.ts
- [ ] T017 [US1] Implement SkillRegistry.getAutoInvocableSkills() — return skills where invocationMode is 'auto' or 'hybrid' AND trusted === true — in src/core/skills/SkillRegistry.ts
- [ ] T018 [US1] Implement SkillRegistry.buildSkillsSystemPrompt() — generate system prompt listing only auto-invocable skills (auto/hybrid mode + trusted) with name and description — in src/core/skills/SkillRegistry.ts
- [ ] T019 [US1] Add SKILLS_LIST, SKILLS_LOAD, SKILLS_SAVE message types to MessageRouter in src/core/MessageRouter.ts
- [ ] T020 [US1] Add message handlers for SKILLS_LIST and SKILLS_SAVE in background/service worker to bridge UI ↔ SkillRegistry
- [ ] T021 [US1] Integrate SkillRegistry into BrowserxAgent — initialize registry with provider and commandRegistry (DI), call registerCommands() to populate CommandRegistry, inject auto-invocable skill metadata into system prompt via buildSkillsSystemPrompt() — in src/core/BrowserxAgent.ts
- [ ] T022 [US1] Create SkillsSettings.svelte — skill creation form with name, description, markdown body fields, invocation mode selector (manual/auto/hybrid, default manual), save button that sends SKILLS_SAVE message — in src/extension/sidepanel/settings/SkillsSettings.svelte
- [ ] T023 [US1] Add "Skills" entry to the settings menu in src/extension/sidepanel/Settings.svelte

**Checkpoint**: User Story 1 complete — users can create skills, they appear in `/` dropdown (manual/hybrid mode), agent auto-invokes them (auto/hybrid mode when trusted)

---

## Phase 4: User Story 2 — Manage Skills (Priority: P2)

**Goal**: Users can view, edit, delete, and change invocation mode for their skills from the sidepanel settings

**Independent Test**: Pre-populate several skills with different modes, verify the management UI lists them with correct mode/trust status, toggle a skill from manual to hybrid and verify it appears in both `/` dropdown AND system prompt

### Implementation for User Story 2

- [ ] T024 [US2] Add skill list view to SkillsSettings.svelte — display all skills with name, description, invocation mode (manual/auto/hybrid), source, and trust status — in src/extension/sidepanel/settings/SkillsSettings.svelte
- [ ] T025 [US2] Add skill detail/edit view to SkillsSettings.svelte — select a skill to view full body, edit name/description/body, save changes via SKILLS_SAVE message — in src/extension/sidepanel/settings/SkillsSettings.svelte
- [ ] T026 [US2] Add invocation mode toggle to skill detail view — dropdown or radio buttons (manual / auto / hybrid) per skill, sends SKILLS_UPDATE_MODE message on change — in src/extension/sidepanel/settings/SkillsSettings.svelte
- [ ] T027 [US2] Implement SkillRegistry.updateInvocationMode(name, mode) — update skill's invocationMode, use commandRegistry.unregister(name) when switching to auto, commandRegistry.register() when switching to manual/hybrid, rebuild system prompt — in src/core/skills/SkillRegistry.ts
- [ ] T028 [US2] Add SKILLS_DELETE and SKILLS_UPDATE_MODE message types and handlers in src/core/MessageRouter.ts and background/service worker
- [ ] T029 [US2] Add delete skill functionality to SkillsSettings.svelte — confirmation prompt, sends SKILLS_DELETE message, calls commandRegistry.unregister(name), refreshes list — in src/extension/sidepanel/settings/SkillsSettings.svelte

**Checkpoint**: User Stories 1 AND 2 complete — full CRUD for skills with live invocation mode switching

---

## Phase 5: User Story 3 — Import Skills from URL (Priority: P3)

**Goal**: Users can import a skill from a URL, with imported skills flagged as untrusted and defaulting to manual mode

**Independent Test**: Import a SKILL.md from a URL, verify it is saved with source='imported', trusted=false, invocationMode='manual', appears in `/` dropdown, but does NOT auto-invoke even if user changes mode to auto (until trusted)

### Implementation for User Story 3

- [ ] T030 [US3] Implement SkillRegistry.importFromUrl() — fetch URL, parse SKILL.md, validate (including reserved-name check), save with source='imported', trusted=false, invocationMode='manual', register in CommandRegistry — in src/core/skills/SkillRegistry.ts
- [ ] T031 [US3] Implement SkillRegistry.trustSkill() — mark an imported skill as trusted, enabling auto-invocation if mode is auto/hybrid, update system prompt — in src/core/skills/SkillRegistry.ts
- [ ] T032 [US3] Add SKILLS_IMPORT and SKILLS_TRUST message types and handlers in src/core/MessageRouter.ts and background/service worker
- [ ] T033 [US3] Add import dialog to SkillsSettings.svelte — URL input field, fetch preview, duplicate name check (overwrite/rename prompt), confirm button — in src/extension/sidepanel/settings/SkillsSettings.svelte
- [ ] T034 [US3] Add trust toggle to skill detail view — button to mark imported skill as trusted (shows warning about auto-invocation implications), sends SKILLS_TRUST message — in src/extension/sidepanel/settings/SkillsSettings.svelte
- [ ] T035 [US3] Handle import error cases — invalid YAML, missing name/description, network failure — display clear error messages in src/extension/sidepanel/settings/SkillsSettings.svelte

**Checkpoint**: User Stories 1, 2, AND 3 complete — users can create, manage, and import skills with full trust + invocation mode control

---

## Phase 6: User Story 4 — Export and Share Skills (Priority: P4)

**Goal**: Users can export a skill as a valid, standard-compliant SKILL.md file for sharing

**Independent Test**: Create a skill, export it, re-import on a different instance, verify it works identically. Exported file must NOT contain invocationMode or other non-standard fields.

### Implementation for User Story 4

- [ ] T036 [US4] Add SKILLS_EXPORT message type and handler — calls SkillRegistry.export() which delegates to provider.exportAsSkillMd() (standard-compliant, no invocationMode) — in src/core/MessageRouter.ts and background/service worker
- [ ] T037 [US4] Add export button to skill detail view in SkillsSettings.svelte — triggers SKILLS_EXPORT, offers SKILL.md content as a downloadable file (Blob + anchor tag for extension, Tauri save dialog for desktop) — in src/extension/sidepanel/settings/SkillsSettings.svelte

**Checkpoint**: All 4 user stories complete — full skills lifecycle (create, manage, import, export) with three invocation modes

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Edge case handling, error resilience, and integration quality

- [ ] T038 [P] Handle invalid SKILL.md files gracefully in FilesystemSkillProvider — log warning, skip invalid skills, report in UI as "invalid" — in src/desktop/storage/FilesystemSkillProvider.ts
- [ ] T039 [P] Handle skill name conflicts across sources on desktop — filesystem skills take precedence over IndexedDB skills — in src/core/skills/SkillRegistry.ts
- [ ] T040 [P] Add 50KB size limit check in SkillParser.validateSkill() — truncate with warning for oversized skills — in src/core/skills/SkillParser.ts
- [ ] T041 Handle missing skill references (Level 3) — report missing file to user, continue with available instructions — in src/core/skills/SkillRegistry.ts
- [ ] T042 Run quickstart.md validation — verify manual testing steps on both Chrome extension and desktop, including discovery performance check (< 500ms for 50 skills per SC-002)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion — BLOCKS all user stories
- **User Stories (Phase 3–6)**: All depend on Foundational phase completion
  - US1 (Phase 3): Can start after Foundational
  - US2 (Phase 4): Depends on US1 (extends SkillsSettings.svelte with list/edit/delete/mode toggle)
  - US3 (Phase 5): Depends on US1 (extends SkillRegistry with import, extends UI with import dialog)
  - US4 (Phase 6): Depends on US2 (export button in skill detail view which is built in US2)
- **Polish (Phase 7)**: Can start after US1, some tasks parallelizable

### User Story Dependencies

- **US1 (P1)**: Can start after Foundational — No dependencies on other stories
- **US2 (P2)**: Depends on US1 — extends SkillsSettings.svelte, adds updateInvocationMode to SkillRegistry
- **US3 (P3)**: Depends on US1 — adds importFromUrl and trustSkill methods to SkillRegistry
- **US4 (P4)**: Depends on US2 — adds export button to the skill detail view built in US2

### Within Each User Story

- Providers (T013, T014) before Registry (T015)
- Registry core (T015) before CommandRegistry integration (T016)
- CommandRegistry integration (T016) before Agent integration (T021)
- Message types (T019) before UI (T022)
- Core before UI for each story

### Parallel Opportunities

- T013 (IndexedDBSkillProvider) and T014 (FilesystemSkillProvider) can run in parallel — different files, same interface
- T004–T006 (types, DI interface, schemas) are in the same file — sequential
- T007–T010 (parser functions) are in the same file — sequential
- T016–T018 (registry methods) can be implemented together in same file — sequential
- Phase 7 tasks marked [P] can run in parallel
- US3 can run in parallel with US2 (they extend different parts: US2 extends UI management, US3 extends import)

---

## Parallel Example: User Story 1

```bash
# Launch both providers in parallel (different files, same interface):
Task: "T013 Implement IndexedDBSkillProvider in src/extension/storage/IndexedDBSkillProvider.ts"
Task: "T014 Implement FilesystemSkillProvider in src/desktop/storage/FilesystemSkillProvider.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (T001–T003)
2. Complete Phase 2: Foundational (T004–T012)
3. Complete Phase 3: User Story 1 (T013–T023)
4. **STOP and VALIDATE**: Create a skill via UI, verify it appears in `/` dropdown, type `/skill-name` and verify agent follows instructions. Test all three modes:
   - Manual: appears in dropdown, NOT in system prompt
   - Auto: NOT in dropdown, appears in system prompt (if trusted)
   - Hybrid: appears in BOTH dropdown and system prompt
5. Deploy/demo if ready

### Incremental Delivery

1. Setup + Foundational → Foundation ready
2. Add US1 → Test independently → Deploy/Demo (MVP! — create + invoke via `/`)
3. Add US2 → Test independently → Deploy/Demo (CRUD + invocation mode toggle)
4. Add US3 → Test independently → Deploy/Demo (import + trust model)
5. Add US4 → Test independently → Deploy/Demo (full sharing loop)
6. Polish → Final validation

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- US2–US4 have sequential dependencies (each extends prior work) unlike typical independent stories — this is because they all build on the same UI component and registry
- **CommandRegistry extension (F1 fix)**: T003 adds `unregister(name)` method to support invocation mode switching
- **Dependency injection (F5 fix)**: SkillRegistry accepts `ICommandRegistry` via constructor — core module does not import from extension
- **Reserved-name validation (F3 fix)**: T008 and T030 check for name collisions with built-in commands
- **CommandRegistry integration (R7)**: Skills register as commands alongside built-in `/new`, `/help`, `/settings` — zero UI changes needed for the dropdown
- **Invocation mode (R8)**: Stored on Skill entity as invocationMode enum. On desktop, stored in `.skill-meta.json` sidecar (not in SKILL.md) to keep portable format standard-compliant
- **Trust x Mode interaction**: Untrusted skills can NEVER auto-invoke regardless of mode. They can always be manually invoked via `/`
- New npm dependency: `yaml` package (research decision R1)
- Desktop filesystem operations use Tauri invoke() commands (research decision R3)
