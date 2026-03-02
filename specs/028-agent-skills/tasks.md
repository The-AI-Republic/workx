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

**Purpose**: Install dependencies and create project structure

- [ ] T001 Install `yaml` npm package for SKILL.md frontmatter parsing
- [ ] T002 Create core skills directory structure at src/core/skills/

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core types, parser, and provider interface that ALL user stories depend on

**CRITICAL**: No user story work can begin until this phase is complete

- [ ] T003 Define core types (Skill, SkillMeta, ParsedSkill, SkillFrontmatter, SkillWithReferences) in src/core/skills/types.ts
- [ ] T004 Define Zod validation schemas for Skill entity (name, description, body, trusted, source, metadata) in src/core/skills/types.ts
- [ ] T005 Implement SkillParser.parseSkillMd() — extract YAML frontmatter and markdown body from SKILL.md content — in src/core/skills/SkillParser.ts
- [ ] T006 Implement SkillParser.validateSkill() — validate parsed skill against Zod schemas — in src/core/skills/SkillParser.ts
- [ ] T007 Implement SkillParser.substituteVariables() — replace $ARGUMENTS, $1, $2 etc. in skill body — in src/core/skills/SkillParser.ts
- [ ] T008 Implement SkillParser.serializeToSkillMd() — convert Skill object back to SKILL.md format — in src/core/skills/SkillParser.ts
- [ ] T009 Define ISkillProvider interface (initialize, listMeta, load, loadReference, save, delete, exists, exportAsSkillMd) in src/core/skills/SkillProvider.ts
- [ ] T010 Create barrel export in src/core/skills/index.ts

**Checkpoint**: Foundation ready — types, parser, and provider interface are available for user story implementation

---

## Phase 3: User Story 1 — Create and Use a Custom Skill (Priority: P1) MVP

**Goal**: Users can create a skill (filesystem or UI) and the agent discovers and invokes it automatically or manually

**Independent Test**: Create a skill with name + description + instructions, verify agent discovers it at startup and follows the instructions when triggered

### Implementation for User Story 1

- [ ] T011 [P] [US1] Implement IndexedDBSkillProvider (listMeta, load, save, delete, exists, exportAsSkillMd) using existing StorageProvider with 'skills' collection in src/extension/storage/IndexedDBSkillProvider.ts
- [ ] T012 [P] [US1] Implement FilesystemSkillProvider (initialize creates ~/.airepublic-pi/skills/, listMeta scans directories, load reads SKILL.md + .skill-meta.json, save writes folder, delete removes folder) using Tauri invoke() in src/desktop/storage/FilesystemSkillProvider.ts
- [ ] T013 [US1] Implement SkillRegistry core — constructor, discover(), getSkillMetas(), getAutoInvocableSkills(), invoke(), refresh() — in src/core/skills/SkillRegistry.ts
- [ ] T014 [US1] Implement buildSkillsSystemPrompt() — generate system prompt block listing auto-invocable skills (trusted + not disabled) — in src/core/skills/SkillRegistry.ts
- [ ] T015 [US1] Add SKILLS_LIST, SKILLS_LOAD, SKILLS_SAVE, SKILLS_DELETE message types to MessageRouter in src/core/MessageRouter.ts
- [ ] T016 [US1] Add message handlers for SKILLS_LIST and SKILLS_SAVE in background/service worker to bridge UI ↔ SkillRegistry
- [ ] T017 [US1] Integrate SkillRegistry into BrowserxAgent — initialize registry at session start, inject skill metadata into system prompt via buildSkillsSystemPrompt() — in src/core/BrowserxAgent.ts
- [ ] T018 [US1] Create SkillsSettings.svelte — skill creation form with name, description, and markdown body fields, save button that sends SKILLS_SAVE message — in src/extension/sidepanel/settings/SkillsSettings.svelte
- [ ] T019 [US1] Add "Skills" entry to the settings menu in src/extension/sidepanel/Settings.svelte

**Checkpoint**: User Story 1 complete — users can create skills via UI (extension) or filesystem (desktop), and the agent discovers and invokes them

---

## Phase 4: User Story 2 — Manage Skills (Priority: P2)

**Goal**: Users can view, edit, and delete their skills from the sidepanel settings

**Independent Test**: Pre-populate several skills, verify the management UI lists them, allows editing, and persists changes

### Implementation for User Story 2

- [ ] T020 [US2] Add skill list view to SkillsSettings.svelte — display all skills with name, description, source, and trust status in src/extension/sidepanel/settings/SkillsSettings.svelte
- [ ] T021 [US2] Add skill detail/edit view to SkillsSettings.svelte — select a skill to view full body, edit name/description/body, save changes via SKILLS_SAVE message in src/extension/sidepanel/settings/SkillsSettings.svelte
- [ ] T022 [US2] Add delete skill functionality to SkillsSettings.svelte — confirmation prompt, sends SKILLS_DELETE message, refreshes list in src/extension/sidepanel/settings/SkillsSettings.svelte
- [ ] T023 [US2] Add message handler for SKILLS_DELETE in background/service worker to bridge UI → SkillRegistry.delete()

**Checkpoint**: User Stories 1 AND 2 complete — full CRUD for skills via the sidepanel UI

---

## Phase 5: User Story 3 — Import Skills from URL (Priority: P3)

**Goal**: Users can import a skill from a URL, with imported skills flagged as untrusted

**Independent Test**: Import a SKILL.md from a URL, verify it is saved locally, flagged untrusted, and invocable manually

### Implementation for User Story 3

- [ ] T024 [US3] Implement SkillRegistry.importFromUrl() — fetch URL, parse SKILL.md, validate, set source='imported' + trusted=false, save — in src/core/skills/SkillRegistry.ts
- [ ] T025 [US3] Implement SkillRegistry.trustSkill() — mark an imported skill as trusted, enabling auto-invocation — in src/core/skills/SkillRegistry.ts
- [ ] T026 [US3] Add SKILLS_IMPORT and SKILLS_TRUST message types and handlers in src/core/MessageRouter.ts and background/service worker
- [ ] T027 [US3] Add import dialog to SkillsSettings.svelte — URL input field, fetch preview, duplicate name check (overwrite/rename prompt), confirm button — in src/extension/sidepanel/settings/SkillsSettings.svelte
- [ ] T028 [US3] Add trust toggle to skill detail view — button to mark imported skill as trusted, sends SKILLS_TRUST message — in src/extension/sidepanel/settings/SkillsSettings.svelte
- [ ] T029 [US3] Handle import error cases — invalid YAML, missing name/description, network failure — display clear error messages in UI

**Checkpoint**: User Stories 1, 2, AND 3 complete — users can create, manage, and import skills

---

## Phase 6: User Story 4 — Export and Share Skills (Priority: P4)

**Goal**: Users can export a skill as a valid SKILL.md file for sharing

**Independent Test**: Create a skill, export it, re-import on a different instance, verify it works identically

### Implementation for User Story 4

- [ ] T030 [US4] Add SKILLS_EXPORT message type and handler — calls SkillRegistry.export() which delegates to provider.exportAsSkillMd() — in src/core/MessageRouter.ts and background/service worker
- [ ] T031 [US4] Add export button to skill detail view in SkillsSettings.svelte — triggers SKILLS_EXPORT, offers SKILL.md content as a downloadable file (Blob + anchor tag for extension, Tauri save dialog for desktop)

**Checkpoint**: All 4 user stories complete — full skills lifecycle (create, manage, import, export)

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Edge case handling, error resilience, and integration quality

- [ ] T032 [P] Handle invalid SKILL.md files gracefully in FilesystemSkillProvider — log warning, skip invalid skills, report in UI as "invalid" in src/desktop/storage/FilesystemSkillProvider.ts
- [ ] T033 [P] Handle skill name conflicts across sources on desktop — filesystem skills take precedence over IndexedDB skills — in src/core/skills/SkillRegistry.ts
- [ ] T034 [P] Add 50KB size limit check in SkillParser.validateSkill() — truncate with warning for oversized skills — in src/core/skills/SkillParser.ts
- [ ] T035 Handle missing skill references (Level 3) — report missing file to user, continue with available instructions — in src/core/skills/SkillRegistry.ts
- [ ] T036 Ensure ~/.airepublic-pi/skills/ directory is created on first desktop launch in FilesystemSkillProvider.initialize() in src/desktop/storage/FilesystemSkillProvider.ts
- [ ] T037 Run quickstart.md validation — verify manual testing steps on both Chrome extension and desktop

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion — BLOCKS all user stories
- **User Stories (Phase 3–6)**: All depend on Foundational phase completion
  - US1 (Phase 3): Can start after Foundational
  - US2 (Phase 4): Depends on US1 (extends the same SkillsSettings.svelte with list/edit/delete)
  - US3 (Phase 5): Depends on US1 (extends SkillRegistry with import, extends UI with import dialog)
  - US4 (Phase 6): Depends on US2 (export button in skill detail view which is built in US2)
- **Polish (Phase 7)**: Can start after US1, some tasks parallelizable

### User Story Dependencies

- **US1 (P1)**: Can start after Foundational — No dependencies on other stories
- **US2 (P2)**: Depends on US1 — extends the SkillsSettings.svelte component and SkillRegistry
- **US3 (P3)**: Depends on US1 — adds importFromUrl and trust methods to SkillRegistry
- **US4 (P4)**: Depends on US2 — adds export button to the skill detail view built in US2

### Within Each User Story

- Providers (T011, T012) before Registry (T013)
- Registry before Agent integration (T017)
- Message types (T015) before UI (T018)
- Core before UI for each story

### Parallel Opportunities

- T011 (IndexedDBSkillProvider) and T012 (FilesystemSkillProvider) can run in parallel — different files, same interface
- T003 and T004 (types + schemas) are in the same file but sequential within it
- T005, T006, T007, T008 (parser functions) are in the same file — sequential
- Phase 7 tasks marked [P] can run in parallel

---

## Parallel Example: User Story 1

```bash
# Launch both providers in parallel (different files, same interface):
Task: "T011 Implement IndexedDBSkillProvider in src/extension/storage/IndexedDBSkillProvider.ts"
Task: "T012 Implement FilesystemSkillProvider in src/desktop/storage/FilesystemSkillProvider.ts"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (T001–T002)
2. Complete Phase 2: Foundational (T003–T010)
3. Complete Phase 3: User Story 1 (T011–T019)
4. **STOP and VALIDATE**: Create a skill via UI and filesystem, verify agent discovers and uses it
5. Deploy/demo if ready

### Incremental Delivery

1. Setup + Foundational → Foundation ready
2. Add US1 → Test independently → Deploy/Demo (MVP!)
3. Add US2 → Test independently → Deploy/Demo (CRUD complete)
4. Add US3 → Test independently → Deploy/Demo (import + trust model)
5. Add US4 → Test independently → Deploy/Demo (full sharing loop)
6. Polish → Final validation

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- US2–US4 have sequential dependencies (each extends prior work) unlike typical independent stories — this is because they all build on the same UI component and registry
- Skills are NOT registered as tools in ToolRegistry — they are injected as system context into the LLM prompt (research decision R4)
- New npm dependency: `yaml` package (research decision R1)
- Desktop filesystem operations use Tauri invoke() commands (research decision R3)
