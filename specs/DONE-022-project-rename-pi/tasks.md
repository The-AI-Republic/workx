# Tasks: Project Rename — Pi Naming Convention

**Input**: Design documents from `/specs/022-project-rename-pi/`
**Prerequisites**: plan.md (required), spec.md (required), research.md, data-model.md, quickstart.md

**Tests**: Not requested — no test tasks generated.

**Organization**: Tasks grouped by user story. The core class rename is foundational (blocks all stories due to import chain).

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup

**Purpose**: Baseline verification before any changes

- [ ] T001 Run `npm test` and `npm run build` to establish passing baseline before rename begins

---

## Phase 2: Foundational (Core Class Rename)

**Purpose**: Rename `BrowserxAgent` → `PiAgent` — the single highest-risk change that affects imports across both extension and desktop. MUST complete before user story work.

**CRITICAL**: This phase touches the import chain for both extension and desktop. All import updates must happen atomically with the file/class rename to keep the build working.

- [ ] T002 Rename file `src/core/BrowserxAgent.ts` → `src/core/PiAgent.ts` and rename class `BrowserxAgent` → `PiAgent` inside the file (FR-020, FR-030)
- [ ] T003 Update import and type references from `BrowserxAgent` to `PiAgent` in `src/extension/background/service-worker.ts` (FR-021)
- [ ] T004 Update import and type references from `BrowserxAgent` to `PiAgent` in `src/extension/background/index.ts` (FR-021)
- [ ] T005 Update import and type references from `BrowserxAgent` to `PiAgent` in `src/desktop/agent/DesktopAgentBootstrap.ts` (FR-021)
- [ ] T006 Search for any remaining `BrowserxAgent` references across the entire codebase with `grep -ri "BrowserxAgent" src/` and update all hits (FR-021)
- [ ] T007 Run `npm test` to verify the class rename has not broken anything

**Checkpoint**: Core agent class successfully renamed. Build and tests pass. User story implementation can begin.

---

## Phase 3: User Story 1 — Chrome Extension Branding Consistency (Priority: P1)

**Goal**: Ensure all user-facing Chrome extension surfaces display "BrowserX" consistently with correct capitalization.

**Independent Test**: Install the extension, open side panel, interact with agent — verify "BrowserX" appears in extension name, tooltip, command description, cursor label, and system prompt.

### Implementation for User Story 1

- [ ] T008 [US1] Fix cursor label capitalization: change `<div class="cursor-label">browserx</div>` to `<div class="cursor-label">BrowserX</div>` in `src/extension/content/ui_effect/CursorAnimator.svelte` (FR-010)
- [ ] T009 [US1] Verify extension manifest `default_title` is "BrowserX Agent" in `src/extension/manifest.json` and root `manifest.json` (FR-006) — confirm no changes needed
- [ ] T010 [US1] Verify extension manifest command description references "BrowserX side panel" in `src/extension/manifest.json` and root `manifest.json` (FR-007) — confirm no changes needed
- [ ] T011 [US1] Verify extension prompt `src/prompts/default_browserx_agent_prompt.md` identifies itself as "BrowserX" (FR-009) — confirm no changes needed
- [ ] T012 [US1] Verify that extension-specific code (`src/extension/`) retains all `browserx` naming: CSS vars `--browserx-*`, events `browserx:*`, event title `'browserx'` (FR-022, FR-023, FR-025) — confirm no accidental renames from Phase 2

**Checkpoint**: Chrome extension branding is consistent. "BrowserX" appears correctly everywhere users see it.

---

## Phase 4: User Story 2 — Desktop App Branding (Priority: P1)

**Goal**: User-facing desktop app surfaces display "Apple Pi" (window title, app name, system prompt). Config metadata stays "Pi".

**Independent Test**: Launch Tauri desktop app — verify window title reads "Apple Pi", app name in OS shows "Apple Pi", agent identifies as "Apple Pi".

### Implementation for User Story 2

- [ ] T013 [P] [US2] Update `productName` from "Pi" to "Apple Pi" in `tauri/tauri.conf.json` (FR-011)
- [ ] T014 [P] [US2] Update window `title` from "Pi" to "Apple Pi" in `tauri/tauri.conf.json` (FR-012)
- [ ] T015 [P] [US2] Update `<title>BrowserX Desktop</title>` to `<title>Apple Pi</title>` in `src/desktop/index.html` (FR-015)
- [ ] T016 [US2] Update desktop agent prompt `src/prompts/default_pi_agent_prompt.md` — change "You are Pi" to "You are Apple Pi" throughout (FR-016)
- [ ] T017 [US2] Verify `shortDescription` and `longDescription` in `tauri/tauri.conf.json` stay as "Pi" (FR-013, FR-014) — confirm no changes needed
- [ ] T018 [US2] Verify Tauri identifier remains `com.airepublic.pi`, Cargo name remains `pi`, deep-link remains `airepublic-pi` (FR-017, FR-018, FR-019) — confirm no changes needed

**Checkpoint**: Desktop app shows "Apple Pi" in all user-visible surfaces. Config metadata preserved as "Pi".

---

## Phase 5: User Story 3 — Project-Level Naming (Priority: P2)

**Goal**: Project identity is "Pi" in package.json, README, CHANGELOG, and clone URLs.

**Independent Test**: Read README heading, check package.json name, verify clone URL references `pi.git`.

### Implementation for User Story 3

- [ ] T019 [P] [US3] Update `"name": "browserx-chrome"` to `"name": "pi"` in `package.json` (FR-001)
- [ ] T020 [US3] Update `README.md`: change project heading to "Pi", add three-tier naming convention explanation, update clone URL from `browserx.git` to `pi.git`, update image reference from `browserx_UI.png` to `pi_UI.png` (FR-002, FR-003, FR-004b)
- [ ] T021 [P] [US3] Update `CHANGELOG.md`: change project name references from "BrowserX" to "Pi" (FR-004)
- [ ] T022 [P] [US3] Rename static asset `src/static/browserx_UI.png` → `src/static/pi_UI.png` (FR-029)

**Checkpoint**: Project identifies as "Pi" in all developer-facing materials.

---

## Phase 6: User Story 4 — Shared/Core Code Naming Modernization (Priority: P2)

**Goal**: Zero `browserx` references in shared code (`src/core/`, `src/tools/`, `src/desktop/`). Extension code retains `browserx`.

**Independent Test**: `grep -ri "browserx" src/core/ src/tools/ src/models/ src/desktop/ --include="*.ts"` returns zero results.

### Implementation for User Story 4

- [ ] T023 [P] [US4] Update `data-browserx-injected` to `data-pi-injected` in `src/tools/dom/plugins/GoogleDocPlugin.ts` (FR-024)
- [ ] T024 [P] [US4] Update `browserx` references in `src/tools/dom/DomService.ts` — replace shared code references with `pi`
- [ ] T025 [P] [US4] Update test references in `src/tools/dom/__tests__/actions.test.ts` — replace `browserx` with `pi` in test assertions
- [ ] T026 [P] [US4] Update `browserx` references in `src/tools/index.ts` — replace exports/comments with `pi`
- [ ] T027 [P] [US4] Update comments referencing "Browserx" or "BrowserxAgent" in `src/core/Session.ts`
- [ ] T028 [P] [US4] Update comments referencing "Browserx" or "BrowserxAgent" in `src/core/AgentTask.ts`
- [ ] T029 [P] [US4] Update comments referencing "Browserx" or "BrowserxAgent" in `src/core/PromptLoader.ts`
- [ ] T030 [P] [US4] Update comments referencing "Browserx" or "BrowserxAgent" in `src/core/mcp/MCPToolAdapter.ts`
- [ ] T031 [P] [US4] Update `browserx` references in `src/core/registry/AgentSession.ts`
- [ ] T032 [P] [US4] Update `browserx` references in `src/core/registry/types.ts`
- [ ] T033 [P] [US4] Update comments referencing "Browserx" in `src/desktop/channels/TauriChannel.ts`
- [ ] T034 [P] [US4] Update comments referencing "Browserx" in `src/desktop/channels/DesktopMessageRouter.ts`
- [ ] T035 [P] [US4] Update comments referencing "Browserx" in `src/desktop/polyfills/chromePolyfill.ts`
- [ ] T036 [P] [US4] Update comments referencing "Browserx" in `src/desktop/ui/main.ts`
- [ ] T037 [P] [US4] Update comments referencing "Browserx" in `src/desktop/storage/KeytarCredentialStore.ts`
- [ ] T038 [P] [US4] Update comments referencing "Browserx" in `src/desktop/platform/paths.ts`
- [ ] T039 [P] [US4] Update comments referencing "Browserx" in `src/desktop/hotkeys.ts`
- [ ] T040 [US4] Run `grep -ri "browserx" src/core/ src/tools/ src/models/ src/desktop/ --include="*.ts"` and fix any remaining references
- [ ] T041 [US4] Run `npm test` to verify all shared code changes pass

**Checkpoint**: Zero `browserx` references in shared code. Extension code still correctly uses `browserx`.

---

## Phase 7: User Story 5 — Localization Consistency (Priority: P3)

**Goal**: All 50+ locale files retain "BrowserX" as extension_name. Message keys keep `browserx` naming.

**Independent Test**: Check 3+ locale files — verify `extension_name` is "BrowserX" and message keys are unchanged.

### Implementation for User Story 5

- [ ] T042 [US5] Verify all `_locales/*/messages.json` files have `"extension_name"` with message value "BrowserX" (FR-008) — run a grep/validation across all 50+ files, confirm no changes needed
- [ ] T043 [US5] Verify locale message keys containing `browserx` are unchanged (FR-028) — spot-check `_locales/en/messages.json`, `_locales/fr_FR/messages.json`, `_locales/ja_JP/messages.json`

**Checkpoint**: Localization verified. All language files consistent.

---

## Phase 8: Polish & Cross-Cutting Concerns

**Purpose**: CI/CD, documentation, GitHub admin, and final verification

- [ ] T044 [P] Update `private-browserx.git` to `private-pi.git` in `.github/workflows/sync-to-private.yml` (FR-004c)
- [ ] T045 Update `CLAUDE.md` — replace shared/project-level `browserx` references with `pi`, preserve extension-specific `browserx` references (BrowserX product name)
- [ ] T046 Run full verification per `specs/022-project-rename-pi/quickstart.md`: `npm test`, `npm run lint`, `npm run build`
- [ ] T047 Final grep verification: confirm `grep -ri "browserx" src/core/ src/tools/ src/models/ src/desktop/ --include="*.ts"` returns zero results, and `grep -ri "BrowserX" src/extension/` returns results (correct)
- [ ] T048 GitHub admin: rename repository `The-AI-Republic/browserx` → `The-AI-Republic/pi` via GitHub Settings (FR-004a)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — start immediately
- **Foundational (Phase 2)**: Depends on Phase 1 baseline — BLOCKS all user stories
- **US1 (Phase 3)**: Depends on Phase 2 (import chain must be intact)
- **US2 (Phase 4)**: Depends on Phase 2 (import chain must be intact). Can run in parallel with US1.
- **US3 (Phase 5)**: Independent of other user stories. Can run in parallel with US1/US2.
- **US4 (Phase 6)**: Depends on Phase 2 (class already renamed). Can run in parallel with US1/US2/US3.
- **US5 (Phase 7)**: Independent — verification only. Can run at any time.
- **Polish (Phase 8)**: Depends on all user stories being complete

### User Story Dependencies

- **US1 (P1)**: Depends on Phase 2 only. No cross-story dependencies.
- **US2 (P1)**: Depends on Phase 2 only. No cross-story dependencies.
- **US3 (P2)**: Fully independent. No dependencies on other stories.
- **US4 (P2)**: Depends on Phase 2 (class rename done there). No cross-story dependencies.
- **US5 (P3)**: Fully independent. Verification only.

### Within Each User Story

- Parallel tasks (marked [P]) can run concurrently
- Verification tasks should run after implementation tasks
- Sequential tasks depend on prior tasks in the same story

### Parallel Opportunities

After Phase 2 completes, the following can run in parallel:

```
US1 (cursor label fix)     ──┐
US2 (desktop Apple Pi)     ──┤── All can run simultaneously
US3 (project config)       ──┤
US4 (shared code cleanup)  ──┤
US5 (locale verification)  ──┘
```

Within US4, all T023-T039 are marked [P] (different files, no dependencies).

---

## Implementation Strategy

### MVP First (US1 + US2 — both P1)

1. Complete Phase 1: Setup baseline
2. Complete Phase 2: Core class rename (CRITICAL)
3. Complete Phase 3: US1 — cursor label fix
4. Complete Phase 4: US2 — desktop "Apple Pi" branding
5. **STOP and VALIDATE**: Extension shows "BrowserX", desktop shows "Apple Pi"

### Full Delivery

6. Complete Phase 5: US3 — project config
7. Complete Phase 6: US4 — shared code cleanup
8. Complete Phase 7: US5 — locale verification
9. Complete Phase 8: Polish, CI/CD, GitHub rename

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story
- T002-T006 must execute atomically (class rename + all imports) to keep build working
- T048 (GitHub rename) should be the very last task — do after all code changes are committed and pushed
- Verification tasks (T009-T012, T017-T018, T042-T043) are "confirm no changes needed" — they validate preservation of existing correct naming
