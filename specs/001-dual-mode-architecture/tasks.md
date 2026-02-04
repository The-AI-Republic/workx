# Tasks: Dual-Mode Architecture (BrowserX Extension + PI Desktop Agent)

**Input**: Design documents from `/specs/001-dual-mode-architecture/`
**Prerequisites**: plan.md, spec.md, data-model.md, contracts/

**Tests**: Not explicitly requested - test tasks omitted. Add as needed.

**Organization**: Tasks grouped by user story to enable independent implementation and testing.

## Format: `[ID] [P?] [Story?] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (US1-US10)
- Exact file paths included in descriptions

---

## Phase 1: Setup

**Purpose**: Project initialization and tooling configuration

- [x] T001 Create new directory structure: `src/core/`, `src/extension/`, `src/desktop/`, `tauri/`
- [x] T002 [P] Configure TypeScript path aliases for `@/core/`, `@/extension/`, `@/desktop/`
- [x] T003 [P] Add `__BUILD_MODE__` type declaration to `src/types/globals.d.ts`
- [x] T004 [P] Install Tauri CLI and initialize Tauri project in `tauri/`
- [x] T005 [P] Add new npm scripts: `dev:desktop`, `build:desktop`, `test:all`

---

## Phase 2: Foundational (Code Restructuring)

**Purpose**: Reorganize codebase without breaking existing extension. BLOCKS all user stories.

**⚠️ CRITICAL**: Extension must continue working after this phase

### US1 & US2: Extension Preservation + Dual Build Structure

- [x] T006 [US1] Audit existing `src/` and categorize files as core/extension/desktop
- [x] T007 [US1] Move shared agent code to `src/core/` (BrowserxAgent, Session, TurnManager already there)
- [x] T008 [US1] Move shared protocol types to `src/core/protocol/`
- [x] T009 [US1] Move shared model abstractions to `src/core/models/`
- [x] T010 [US1] Move existing MCP code from `src/mcp/` to `src/core/mcp/`
- [x] T011 [US1] Move background scripts to `src/extension/background/`
- [x] T012 [US1] Move content scripts to `src/extension/content/`
- [x] T013 [US1] Move sidepanel UI to `src/extension/sidepanel/`
- [x] T014 [US1] Move manifest.json to `src/extension/`
- [x] T015 [US1] Update all import paths across moved files
- [x] T016 [US2] Create `vite.config.extension.mts` with `__BUILD_MODE__: 'extension'`
- [x] T017 [US2] Create `vite.config.desktop.mts` with `__BUILD_MODE__: 'desktop'`
- [x] T018 [US1] Verify extension builds: `npm run build` produces valid extension
- [x] T019 [US1] Verify all existing tests pass after restructuring (pre-existing failures unrelated to restructuring)

**Checkpoint**: Extension works exactly as before. Dual build configs ready.

---

## Phase 3: User Story 3 - Browser Control Abstraction (Priority: P1)

**Goal**: Unified interface for browser automation across extension and native modes

**Independent Test**: Instantiate both controller implementations, verify same operations produce equivalent results

### Interface Definitions

- [x] T020 [P] [US3] Create `BrowserController` interface in `src/core/tools/browser/BrowserController.ts`
- [x] T021 [P] [US3] Create `DebuggerClient` interface in `src/core/tools/browser/DebuggerClient.ts`
- [x] T022 [P] [US3] Create types: `SerializedDOM`, `NavigateOptions`, `ClickOptions`, `ScreenshotOptions` in `src/core/tools/browser/types.ts`
- [x] T023 [US3] Create browser controller factory in `src/core/tools/browser/index.ts`

### Extension Implementation

- [ ] T024 [US3] Implement `ChromeDebuggerClient` in `src/extension/tools/browser/ChromeDebuggerClient.ts`
- [ ] T025 [US3] Implement `ExtensionBrowserController` in `src/extension/tools/browser/ExtensionBrowserController.ts`
- [ ] T026 [US3] Refactor existing `DomService` to use `DebuggerClient` interface

**Checkpoint**: Extension browser tools work through new abstraction layer

---

## Phase 4: User Story 5 - Channel Adapter Architecture (Priority: P1)

**Goal**: Unified interface for UI channels (side panel, tab page, Tauri, WebSocket)

**Independent Test**: Register mock channel, send submission, verify event routing

### Interface Definitions

- [x] T027 [P] [US5] Create `ChannelAdapter` interface in `src/core/channels/ChannelAdapter.ts`
- [x] T028 [P] [US5] Create `ChannelManager` class in `src/core/channels/ChannelManager.ts`
- [x] T029 [P] [US5] Create channel types and `SubmissionContext` in `src/core/channels/types.ts`
- [x] T030 [US5] Create channel factory in `src/core/channels/index.ts`

### Extension Implementation

- [ ] T031 [US5] Implement `SidePanelChannel` in `src/extension/channels/SidePanelChannel.ts`
- [ ] T032 [US5] Implement `TabPageChannel` in `src/extension/channels/TabPageChannel.ts`
- [ ] T033 [US5] Refactor existing `MessageRouter` to use `ChannelManager`

**Checkpoint**: Extension channels work through new architecture

---

## Phase 5: User Story 6 - Storage Provider Abstraction (Priority: P1)

**Goal**: Unified storage interface - IndexedDB for extension, SQLite for desktop

**Independent Test**: Run same CRUD operations against both providers, verify identical behavior

### Interface Definitions

- [x] T034 [P] [US6] Create `StorageProvider` interface in `src/core/storage/StorageProvider.ts`
- [x] T035 [P] [US6] Create `CredentialStore` interface in `src/core/storage/CredentialStore.ts`
- [x] T036 [P] [US6] Create storage types (`ListOptions`, `QueryFilter`, `Transaction`) in `src/core/storage/types.ts`
- [x] T037 [US6] Create storage factory in `src/core/storage/index.ts`

### Extension Implementation

- [ ] T038 [US6] Implement `IndexedDBStorageProvider` in `src/extension/storage/IndexedDBStorageProvider.ts`
- [ ] T039 [US6] Implement `ChromeCredentialStore` using `chrome.storage.local` in `src/extension/storage/ChromeCredentialStore.ts`
- [ ] T040 [US6] Refactor existing storage usage to use `StorageProvider` interface

**Checkpoint**: Extension storage works through new abstraction

---

## Phase 6: User Story 4 - Native App Entry Point with Tauri (Priority: P1)

**Goal**: Desktop app shell with system tray and basic UI

**Independent Test**: Launch app, verify tray icon appears, click to open window

### Tauri Backend (Rust)

- [ ] T041 [P] [US4] Configure `tauri/tauri.conf.json` with app metadata and permissions
- [ ] T042 [P] [US4] Implement basic Tauri commands in `tauri/src/commands.rs`
- [ ] T043 [US4] Implement main entry point in `tauri/src/main.rs`

### Desktop Frontend (TypeScript)

- [ ] T044 [US4] Create desktop entry point in `src/desktop/main.ts`
- [ ] T045 [US4] Implement system tray logic in `src/desktop/tray.ts`
- [ ] T046 [US4] Implement global hotkey support in `src/desktop/hotkeys.ts`
- [ ] T047 [US4] Implement `TauriChannel` adapter in `src/desktop/channels/TauriChannel.ts`
- [ ] T048 [US4] Create desktop UI shell in `src/desktop/ui/` (reuse Svelte components)

### Platform Paths

- [ ] T049 [US4] Create platform paths module in `src/desktop/platform/paths.ts`

**Checkpoint**: Desktop app launches, shows tray icon, opens window with basic UI

---

## Phase 7: User Story 8 - Native Browser Control with Session Preservation (Priority: P2)

**Goal**: CDP browser control with fallback chain: auto-connect → debug port → profile-copy → degraded

**Independent Test**: Launch PI, navigate to logged-in site, verify session preserved

### Browser Detection & Connection

- [ ] T050 [P] [US8] Implement `BrowserDetector` in `src/desktop/tools/browser/BrowserDetector.ts`
- [ ] T051 [P] [US8] Implement `ProfileManager` in `src/desktop/tools/browser/ProfileManager.ts`
- [ ] T052 [P] [US8] Implement `ChromeLauncher` in `src/desktop/tools/browser/ChromeLauncher.ts`

### CDP Implementation

- [ ] T053 [US8] Implement `CDPDebuggerClient` using puppeteer-core in `src/desktop/tools/browser/CDPDebuggerClient.ts`
- [ ] T054 [US8] Implement `CDPBrowserController` in `src/desktop/tools/browser/CDPBrowserController.ts`
- [ ] T055 [US8] Implement connection fallback chain logic in `src/desktop/tools/browser/ConnectionManager.ts`
- [ ] T056 [US8] Implement graceful degradation mode (browser tools disabled)

**Checkpoint**: Desktop can control browser with user's sessions preserved

---

## Phase 8: User Story 6 (Desktop) - SQLite Storage (Priority: P2)

**Goal**: Native storage implementation using SQLite

**Independent Test**: Run CRUD operations, verify data persisted to `~/.pi/data/pi.db`

- [ ] T057 [US6] Implement `SQLiteStorageProvider` in `src/desktop/storage/SQLiteStorageProvider.ts`
- [ ] T058 [US6] Create SQLite schema migrations in `src/desktop/storage/migrations/`
- [ ] T059 [US6] Implement `KeytarCredentialStore` in `src/desktop/storage/KeytarCredentialStore.ts`

**Checkpoint**: Desktop app persists data to SQLite

---

## Phase 9: User Story 7 - Native Terminal Tool (Priority: P2)

**Goal**: Terminal command execution with security filters

**Independent Test**: Ask agent to run `ls`, verify output returned; try `rm -rf /`, verify blocked

- [ ] T060 [P] [US7] Implement `SecurityFilter` with blocklist patterns in `src/desktop/tools/terminal/SecurityFilter.ts`
- [ ] T061 [US7] Implement `TerminalTool` in `src/desktop/tools/terminal/TerminalTool.ts`
- [ ] T062 [US7] Register terminal tool with agent tool registry
- [ ] T063 [US7] Add terminal security config to `PIConfig` type

**Checkpoint**: Terminal tool works with security protection

---

## Phase 10: User Story 9 - WebSocket Remote Control API (Priority: P2)

**Goal**: Remote control via WebSocket at `ws://localhost:8765`

**Independent Test**: Connect WebSocket client, send UserTurn, receive streaming events

- [ ] T064 [P] [US9] Create WebSocket message types in `src/desktop/channels/websocket/types.ts`
- [ ] T065 [US9] Implement `WebSocketServer` in `src/desktop/channels/websocket/WebSocketServer.ts`
- [ ] T066 [US9] Implement `WebSocketChannel` adapter in `src/desktop/channels/WebSocketChannel.ts`
- [ ] T067 [US9] Implement localhost detection and API key auth logic
- [ ] T068 [US9] Register WebSocket channel with `ChannelManager`

**Checkpoint**: External clients can control PI via WebSocket

---

## Phase 11: User Story 10 - MCP Server Integration (Priority: P3)

**Goal**: MCP stdio transport for local servers (SSE already works)

**Independent Test**: Configure filesystem MCP server, ask agent to read file

**Note**: MCP client already exists at `src/core/mcp/`. Work is reduced scope.

- [ ] T069 [P] [US10] Create transport factory in `src/core/mcp/transports/index.ts`
- [ ] T070 [US10] Implement `TauriStdioTransport` in `src/core/mcp/transports/TauriStdioTransport.ts`
- [ ] T071 [US10] Implement MCP process commands in `tauri/src/mcp_commands.rs`
- [ ] T072 [US10] Add MCP server config parsing from `~/.pi/config.yaml`

**Checkpoint**: Local MCP servers work via stdio transport

---

## Phase 12: Polish & Cross-Cutting Concerns

**Purpose**: Integration, testing, and documentation

- [ ] T073 [P] Update existing contract tests for new interfaces
- [ ] T074 [P] Add integration tests for dual-mode builds
- [ ] T075 Configure CI for cross-platform builds (Windows/macOS/Linux)
- [ ] T076 [P] Update quickstart.md with actual working commands
- [ ] T077 Performance validation: auto-connect <3s, profile-copy <20s
- [ ] T078 Bundle size validation: extension <5MB, desktop <30MB
- [ ] T079 Final E2E test: both modes working end-to-end

---

## Dependencies & Execution Order

### Phase Dependencies

```
Phase 1 (Setup)
    ↓
Phase 2 (Foundational - US1/US2)  ← BLOCKS ALL
    ↓
┌───┴───┬───────┬───────┐
↓       ↓       ↓       ↓
Phase 3 Phase 4 Phase 5 Phase 6
(US3)   (US5)   (US6)   (US4)
    ↓       ↓       ↓       ↓
    └───────┴───┬───┴───────┘
                ↓
    ┌───────────┼───────────┐
    ↓           ↓           ↓
Phase 7     Phase 8     Phase 9
(US8)       (US6-Desktop) (US7)
                ↓
            Phase 10 (US9)
                ↓
            Phase 11 (US10)
                ↓
            Phase 12 (Polish)
```

### User Story Dependencies

| Story | Priority | Dependencies | Can Parallelize With |
|-------|----------|--------------|---------------------|
| US1 | P0 | None | - |
| US2 | P0 | US1 | - |
| US3 | P1 | US1, US2 | US4, US5, US6 |
| US4 | P1 | US1, US2 | US3, US5, US6 |
| US5 | P1 | US1, US2 | US3, US4, US6 |
| US6 | P1 | US1, US2 | US3, US4, US5 |
| US7 | P2 | US4 | US8, US9 |
| US8 | P2 | US3, US4 | US7, US9 |
| US9 | P2 | US4, US5 | US7, US8 |
| US10 | P3 | US4 | - |

### Parallel Opportunities

**Within Phase 2 (Foundational):**
- T006-T010 can run sequentially (auditing/moving)
- T016-T017 (Vite configs) can run in parallel

**Within Phase 3-6 (P1 Stories):**
- All interface definitions (T020-T022, T027-T029, T034-T036, T041-T042) can run in parallel
- Different stories can be worked on by different developers

**Within Phase 7-10 (P2 Stories):**
- T050-T052 (browser detection) in parallel
- T060 (SecurityFilter) independent of other P2 work

---

## Implementation Strategy

### MVP First (Extension Preservation Only)

1. Complete Phase 1: Setup
2. Complete Phase 2: Foundational (US1, US2)
3. **STOP and VALIDATE**: Extension works exactly as before
4. Ship if only extension stability needed

### MVP + Desktop Shell

1. Complete Phases 1-2 (Setup + Foundational)
2. Complete Phase 6 (US4 - Tauri shell)
3. **STOP and VALIDATE**: Desktop app launches and shows UI
4. Demo-ready desktop skeleton

### Full P1 Milestone

1. Complete Phases 1-6 (all P0 + P1 stories)
2. **STOP and VALIDATE**:
   - Extension works with new abstractions
   - Desktop app has working UI, channels, storage
3. Both modes functional but desktop has no browser/terminal tools

### Full Feature (P0 + P1 + P2)

1. Complete all phases through Phase 11
2. Full functionality for both modes
3. All user stories complete

---

## Task Summary

| Phase | Story | Task Count | Parallelizable |
|-------|-------|------------|----------------|
| 1 | Setup | 5 | 4 |
| 2 | US1, US2 | 14 | 2 |
| 3 | US3 | 7 | 3 |
| 4 | US5 | 7 | 3 |
| 5 | US6 (Interface) | 7 | 3 |
| 6 | US4 | 9 | 3 |
| 7 | US8 | 7 | 3 |
| 8 | US6 (Desktop) | 3 | 0 |
| 9 | US7 | 4 | 1 |
| 10 | US9 | 5 | 1 |
| 11 | US10 | 4 | 1 |
| 12 | Polish | 7 | 4 |
| **Total** | | **79** | **28** |

---

## Notes

- Extension must pass all existing tests after each phase
- Each user story should be independently testable at its checkpoint
- Desktop features (US7-US10) require Tauri shell (US4) first
- MCP work (US10) is reduced scope - client already exists
- Commit after each task or logical group
