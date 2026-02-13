# Tasks: Terminal Sandbox Mode

**Input**: Design documents from `/specs/016-terminal-sandbox-mode/`
**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/tauri-commands.md, contracts/tool-schema.md, quickstart.md

**Tests**: Not explicitly requested in the feature specification. Test tasks are omitted.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2)
- Include exact file paths in descriptions

## Path Conventions

- **Rust backend**: `tauri/src/` (Tauri 2.x backend)
- **TypeScript frontend**: `src/desktop/` (desktop tools), `src/extension/sidepanel/` (settings UI)
- **Config**: `tauri/Cargo.toml` (Rust deps)

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Add dependencies and create module structure for the sandbox feature

- [X] T001 Add `which = "7"` and `tempfile = "3"` dependencies to `tauri/Cargo.toml`; add `windows` and `win32job` under `[target.'cfg(windows)'.dependencies]`
- [X] T002 [P] Create sandbox module directory and `tauri/src/sandbox/mod.rs` with sub-module declarations (`pub mod linux; pub mod macos; pub mod windows; pub mod status;`) and placeholder files for each sub-module

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Define core types, traits, status detection, and extend the existing Tauri command — MUST be complete before ANY user story implementation

**CRITICAL**: No user story work can begin until this phase is complete

- [X] T003 Define `SandboxExecutor` trait (async `execute(command, profile) -> Result<Output>`), `SandboxProfile` struct (workspace_dir, workspace_access, standard_writable, bind_mounts, network_mode, timeout), `WorkspaceAccess` enum (Rw/Ro/None), `NetworkMode` enum (Host/Sandbox), `BindMount` struct (host_path, access) in `tauri/src/sandbox/mod.rs`
- [X] T004 [P] Define TypeScript types and interfaces: `ExecutionMode` (`safe`|`power`|`auto`), `WorkspaceAccess` (`rw`|`ro`|`none`), `NetworkMode` (`host`|`sandbox`), `BindMount` ({hostPath, access}), `SandboxStatus` (`available`|`unavailable`|`needs-installation`|`installing`), `SandboxStatusResult` ({status, runtime, os, version?, message?}), `TerminalResult` (add `sandboxed` boolean) in `src/desktop/tools/terminal/SandboxManager.ts`
- [X] T005 Implement sandbox runtime status detection — on Linux: check `which bwrap`, on macOS: check `which sandbox-exec`, on Windows: check AppContainer API availability — return SandboxStatusResult in `tauri/src/sandbox/status.rs`
- [X] T006 Add `sandbox_check_status` Tauri command (no parameters, returns `SandboxStatusResult`) in `tauri/src/sandbox/status.rs`
- [X] T007 Register `sandbox_check_status` and `sandbox_install_runtime` Tauri commands in the command builder in `tauri/src/main.rs`
- [X] T008 Extend `terminal_execute` Tauri command with new parameters: `sandboxed: Option<bool>`, `workspace_access: Option<String>`, `network_mode: Option<String>`, `bind_mounts: Option<Vec<BindMount>>`; add `sandboxed: bool` field to `TerminalResult` response struct in `tauri/src/terminal_commands.rs`

**Checkpoint**: Foundation ready — all types defined, status detection working, terminal_execute accepts sandbox parameters. User story implementation can now begin.

---

## Phase 3: User Story 1 — Safe Mode + User Story 2 — Auto Mode (Priority: P1) MVP

**Goal**: Commands can run inside an OS-native sandbox on Linux (bubblewrap). Safe mode always sandboxes, auto mode lets the LLM decide per-command. The LLM receives sandbox-aware tool descriptions.

**Independent Test**: Enable safe mode in config, run `echo "test" > /etc/test` — should fail with EROFS/EPERM. Run `ls -la` — should succeed. Switch to auto mode, verify LLM tool description includes `sandboxed` parameter and sandbox restriction guidance.

### Implementation for User Story 1 — Safe Mode

- [X] T009 [P] [US1] Implement `LinuxSandbox` struct implementing `SandboxExecutor` trait — construct bwrap command: `--ro-bind /usr /usr`, `--ro-bind /lib /lib`, `--ro-bind /lib64 /lib64`, `--ro-bind /bin /bin`, `--ro-bind /sbin /sbin`, `--ro-bind /etc /etc`, `--proc /proc`, `--dev /dev`, `--tmpfs /tmp`, `--bind <workspace_dir> <workspace_dir>`, bind standard writable paths (`~/.cache`, `~/.npm`, `~/.yarn`, `~/.cache/pip`, `~/.cargo`, `~/.local`), `--unshare-pid`, `--unshare-ipc`, `--new-session`, execute via `tokio::process::Command` in `tauri/src/sandbox/linux.rs`
- [X] T010 [US1] Implement sandbox dispatch in `terminal_execute` — when `sandboxed=true`, build `SandboxProfile` from parameters (workspace_dir from cwd defaulting to home dir, workspace_access, network_mode, bind_mounts, standard_writable paths), call platform-specific `SandboxExecutor::execute()`, set `sandboxed=true` in response in `tauri/src/terminal_commands.rs`
- [X] T011 [US1] Implement graceful degradation — when sandbox is unavailable and `sandboxed=true`, execute command unsandboxed, set `sandboxed=false` in response, prepend warning to stderr: `"WARNING: Sandbox unavailable, executing without sandbox protection"` in `tauri/src/terminal_commands.rs`
- [X] T012 [US1] Implement execution mode resolution logic: `safe` → always set `sandboxed=true`, `power` → always set `sandboxed=false`, `auto` → use LLM's `sandboxed` parameter value (default false). Read mode from `terminal.executionMode` config key in `src/desktop/tools/terminal/SandboxManager.ts`
- [X] T013 [US1] Integrate SandboxManager into `TerminalTool.execute()` — call `SandboxManager.resolveMode()` to determine sandboxed boolean, read sandbox config (workspaceAccess, networkMode, bindMounts), pass all sandbox parameters to `invoke('terminal_execute', {...})`, parse `sandboxed` from response in `src/desktop/tools/terminal/TerminalTool.ts`

### Implementation for User Story 2 — Auto Mode

- [X] T014 [US2] Update `getToolDefinition()` — add `sandboxed` boolean to inputSchema properties with description per contracts/tool-schema.md; generate dynamic tool description based on execution mode (auto/safe/power templates with sandbox restriction details, when-to-sandbox guidance, workspace access level) in `src/desktop/tools/terminal/TerminalTool.ts`
- [X] T015 [US2] Fetch sandbox status via `invoke('sandbox_check_status')` at tool registration time, pass status and config to TerminalTool for dynamic description generation (runtime name, availability, workspace access level) in `src/desktop/tools/registerDesktopTools.ts`
- [X] T016 [US2] Export SandboxManager class and all sandbox types from `src/desktop/tools/terminal/index.ts`

**Checkpoint**: Safe mode enforces sandboxing on Linux via bubblewrap. Auto mode provides LLM with sandbox-aware tool descriptions and `sandboxed` parameter. Graceful degradation works when sandbox is unavailable. This is the MVP — fully functional and testable independently.

---

## Phase 4: User Story 3 — Power Mode + User Story 4 — Settings + User Story 6 — Access Controls (Priority: P2)

**Goal**: Users can configure execution mode and sandbox access controls through the settings UI. Power mode executes directly. Access controls (workspace access, bind mounts, network mode) are configurable and enforced.

**Independent Test**: Open settings, change execution mode to power — commands run directly. Change workspace access to `ro` — sandboxed write commands fail. Add a bind mount for `~/.ssh` — git SSH operations succeed in sandbox. Change network mode to `sandbox` — localhost connections fail in sandbox.

**Note**: User Story 3 (Power Mode) requires no additional implementation — power mode is handled by the mode resolution logic in T012 (power → never sandbox). The SecurityFilter blocklist continues to apply regardless of mode (existing behavior, no changes needed).

### Implementation for User Story 4 — Settings

- [X] T017 [US4] Implement config persistence for `terminal.executionMode` — add `getExecutionMode()` and `setExecutionMode()` methods that read/write via TauriConfigStorage, default to `auto` in `src/desktop/tools/terminal/SandboxManager.ts`
- [X] T018 [US4] Add execution mode selector to terminal settings UI — dropdown with three options (Safe, Power, Auto with "default" label), persists on change, takes effect on next command execution in `src/extension/sidepanel/ToolsSettings.svelte`

### Implementation for User Story 6 — Access Controls

- [X] T019 [US6] Implement config persistence for sandbox access controls — add get/set methods for `terminal.sandbox.workspaceAccess` (default: `rw`), `terminal.sandbox.networkMode` (default: `host`), `terminal.sandbox.bindMounts` (default: `[]`) via TauriConfigStorage in `src/desktop/tools/terminal/SandboxManager.ts`
- [X] T020 [US6] Add sandbox access control settings UI — workspace access dropdown (rw/ro/none), network mode toggle (host/sandbox), bind mount list editor (add/remove entries with host path input and rw/ro access selector) in `src/extension/sidepanel/ToolsSettings.svelte`
- [X] T021 [US6] Read sandbox access control config from SandboxManager and pass `workspaceAccess`, `networkMode`, `bindMounts` parameters through to `invoke('terminal_execute', {...})` in `src/desktop/tools/terminal/TerminalTool.ts`
- [X] T022 [US6] Apply configurable access controls in LinuxSandbox bwrap command generation — workspace access: `rw` → `--bind`, `ro` → `--ro-bind`, `none` → omit workspace mount; network mode: `host` → default (no flag), `sandbox` → `--unshare-net`; bind mounts: additional `--bind`/`--ro-bind` per entry in `tauri/src/sandbox/linux.rs`

**Checkpoint**: Users can configure execution mode and all sandbox access controls through settings. Settings persist across sessions. Power mode works with SecurityFilter still enforced. Workspace access, bind mounts, and network mode are applied in the Linux sandbox.

---

## Phase 5: User Story 5 — Platform-Specific Sandbox Availability (Priority: P3)

**Goal**: Sandbox works on all three platforms using native sandbox technology. Missing runtimes (bwrap on Linux) are auto-installed.

**Independent Test**: On macOS, enable safe mode and run a write command outside workspace — should fail via Seatbelt. On Windows, enable safe mode — AppContainer restricts writes. On Linux without bwrap, trigger auto-install — bwrap installed via package manager.

### Implementation for User Story 5

- [X] T023 [P] [US5] Implement `MacSandbox` struct implementing `SandboxExecutor` — dynamically generate SBPL profile string: `(version 1)`, `(deny default)`, `(allow process*)`, `(allow file-read*)`, workspace access via `(allow file-write* (subpath "..."))`, standard writable paths, bind mounts as `(allow file-write* (subpath "..."))` or `(allow file-read* (subpath "..."))`, network mode via `(allow network*)` or `(deny network*)`, write profile to tempfile, invoke `sandbox-exec -f <profile_path> zsh -c "<command>"` in `tauri/src/sandbox/macos.rs`
- [X] T024 [P] [US5] Implement `WindowsSandbox` struct implementing `SandboxExecutor` — call `CreateAppContainerProfile()`, set DACLs on workspace dir (rw: full access, ro: read-only, none: no ACL), set DACLs on standard writable paths and bind mounts, configure network capability (`internetClient` for host/sandbox mode, omit for no network), call `CreateProcessW()` with `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES`, assign to Job Object via `AssignProcessToJobObject()`, capture output in `tauri/src/sandbox/windows.rs`
- [X] T025 [US5] Implement bwrap auto-install — detect Linux distro from `/etc/os-release` (ID field), map to package manager command: `apt-get install -y bubblewrap` / `dnf install -y bubblewrap` / `pacman -S --noconfirm bubblewrap`, execute via `tokio::process::Command`, return success/failure with message in `tauri/src/sandbox/status.rs`
- [X] T026 [US5] Add `sandbox_install_runtime` Tauri command — call auto-install function, return `SandboxInstallResult` ({success, message}), return error for non-Linux platforms ("Runtime ships with OS") in `tauri/src/sandbox/status.rs`
- [X] T027 [US5] Add platform-specific conditional compilation — use `#[cfg(target_os = "linux")]`, `#[cfg(target_os = "macos")]`, `#[cfg(target_os = "windows")]` to select the correct `SandboxExecutor` implementation in the dispatch function in `tauri/src/sandbox/mod.rs`

**Checkpoint**: All three platforms have working sandbox implementations. Linux auto-installs bwrap when missing. Platform dispatch is handled via conditional compilation.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Logging, validation, edge case handling, and verification across all user stories

- [ ] T028 [P] Add sandbox event logging using `log` crate — INFO: execution mode per command, runtime status at startup; WARN: sandbox unavailable fallback, sandbox violation blocks (from stderr); ERROR: installation failures — across `tauri/src/sandbox/mod.rs`, `tauri/src/sandbox/linux.rs`, `tauri/src/sandbox/status.rs`
- [ ] T029 [P] Add path canonicalization — call `std::fs::canonicalize()` on workspace_dir and all bind_mount host_paths before passing to sandbox executor to prevent symlink escapes in `tauri/src/sandbox/mod.rs`
- [ ] T030 [P] Add bind mount validation — verify each bind mount path exists and is absolute, warn if path overlaps with workspace directory (most specific mount wins), reject relative paths with error in `src/desktop/tools/terminal/SandboxManager.ts`
- [ ] T031 Add bwrap functional smoke test — beyond `which bwrap`, run `bwrap --ro-bind /usr /usr -- /usr/bin/true` as a functional check during status detection; if smoke test fails (e.g., user namespaces disabled), report status as `unavailable` with kernel restriction message in `tauri/src/sandbox/status.rs`
- [ ] T032 Validate all new and modified files match the quickstart.md file map — verify `tauri/src/sandbox/` module structure, all TypeScript files, and settings UI components exist and are wired correctly

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion — BLOCKS all user stories
- **US1 + US2 (Phase 3)**: Depends on Foundational (Phase 2) — this is the MVP
- **US3 + US4 + US6 (Phase 4)**: Depends on Phase 3 (mode resolution and TerminalTool integration must exist)
- **US5 (Phase 5)**: Depends on Phase 2 (SandboxExecutor trait must exist); can run in parallel with Phase 4
- **Polish (Phase 6)**: Depends on Phases 3-5 completion

### User Story Dependencies

- **US1 Safe Mode (P1)**: Can start after Phase 2 — no dependencies on other stories
- **US2 Auto Mode (P1)**: Can start after T012-T013 (needs mode resolution from US1) — tightly coupled with US1
- **US3 Power Mode (P2)**: No additional implementation needed — covered by T012 mode resolution
- **US4 Settings (P2)**: Can start after Phase 3 — needs SandboxManager to exist
- **US5 Platform-Specific (P3)**: Can start after Phase 2 — independent of other stories (different files: macos.rs, windows.rs, status.rs)
- **US6 Access Controls (P2)**: Depends on US1 (LinuxSandbox must exist to apply controls) and US4 (settings infrastructure)

### Within Phase Task Dependencies

**Phase 3**:
- T009 (LinuxSandbox) is independent — can run in parallel with Phase 2 completion
- T010 (dispatch) depends on T009 (needs LinuxSandbox to call)
- T011 (graceful degradation) depends on T010 (extends dispatch logic)
- T012 (mode resolution) depends on T004 (needs TS types)
- T013 (TerminalTool integration) depends on T012 + T010
- T014 (tool definition) depends on T012 (needs mode resolution for dynamic description)
- T015 (registration) depends on T014

**Phase 4**:
- T017 (execution mode config) → T018 (execution mode UI)
- T019 (access control config) depends on T017 (same file, extends SandboxManager)
- T020 (access control UI) depends on T018 (same file) + T019
- T021 (pass config through) depends on T019
- T022 (apply in LinuxSandbox) depends on T021

**Phase 5**:
- T023 (MacSandbox) and T024 (WindowsSandbox) can run in parallel — different files
- T025 (auto-install) and T026 (install command) are sequential
- T027 (conditional compilation) depends on T023 + T024

### Parallel Opportunities

**Phase 2**: T003 (Rust types) and T004 (TS types) can run in parallel
**Phase 3**: T009 (LinuxSandbox) can start as soon as T003 is done, parallel with T012
**Phase 5**: T023 (MacSandbox) and T024 (WindowsSandbox) can run in parallel
**Phase 6**: T028, T029, T030 can all run in parallel (different files)
**Cross-phase**: Phase 5 (US5) can run in parallel with Phase 4 (US4+US6)

---

## Parallel Example: Phase 3 (MVP)

```bash
# After Phase 2 completes, launch these in parallel:
Task: "Implement LinuxSandbox in tauri/src/sandbox/linux.rs" (T009)
Task: "Implement mode resolution in src/desktop/tools/terminal/SandboxManager.ts" (T012)

# After T009 + T012 complete:
Task: "Implement sandbox dispatch in tauri/src/terminal_commands.rs" (T010)
Task: "Integrate SandboxManager into TerminalTool.ts" (T013)

# After T013:
Task: "Update getToolDefinition() with sandboxed param" (T014)
```

## Parallel Example: Phase 5 (Platform-Specific)

```bash
# After Phase 2 completes, launch these in parallel:
Task: "Implement MacSandbox in tauri/src/sandbox/macos.rs" (T023)
Task: "Implement WindowsSandbox in tauri/src/sandbox/windows.rs" (T024)
Task: "Implement bwrap auto-install in tauri/src/sandbox/status.rs" (T025)
```

---

## Implementation Strategy

### MVP First (Phase 1-3: US1 Safe Mode + US2 Auto Mode)

1. Complete Phase 1: Setup (add deps, create module structure)
2. Complete Phase 2: Foundational (types, traits, status detection, terminal_execute params)
3. Complete Phase 3: US1 + US2 (Linux sandbox, mode resolution, tool schema)
4. **STOP and VALIDATE**: Test safe mode on Linux — write outside workspace should fail. Test auto mode — LLM sees sandbox-aware description.
5. This is a deployable MVP on Linux

### Incremental Delivery

1. Setup + Foundational → Foundation ready
2. Add US1 + US2 → Test on Linux → Deploy (MVP!)
3. Add US4 + US6 → Settings UI + access controls → Deploy
4. Add US5 → macOS + Windows support + auto-install → Deploy
5. Add Polish → Logging, validation, edge cases → Deploy (feature complete)
6. Each increment adds value without breaking previous functionality

### Parallel Team Strategy

With multiple developers:

1. Team completes Setup + Foundational together
2. Once Foundational is done:
   - Developer A: Phase 3 (US1 + US2 — Linux sandbox + mode resolution + tool schema)
   - Developer B: Phase 5 T023-T024 (macOS + Windows sandbox implementations — independent files)
3. After Phase 3 complete:
   - Developer A: Phase 4 (US4 + US6 — settings + access controls)
   - Developer B: Phase 5 T025-T027 (auto-install + conditional compilation)
4. Team completes Phase 6 (Polish) together

---

## Notes

- [P] tasks = different files, no dependencies within the phase
- [Story] label maps task to specific user story for traceability
- US3 (Power Mode) requires no dedicated tasks — handled by mode resolution in T012
- SecurityFilter.ts requires NO changes — blocklist applies in all modes (existing behavior)
- Sandbox overhead target: < 500ms added startup latency per command
- Default timeout: 2 minutes (120,000ms) covering sandbox setup + execution
- Network allowed by default (no `--unshare-net` unless network mode = `sandbox`)
- Workspace directory = `cwd` parameter, defaults to `~/` (`%USERPROFILE%` on Windows)
- Standard writable paths auto-included: `/tmp`, `~/.cache`, `~/.npm`, `~/.yarn`, `~/.cache/pip`, `~/.cargo`, `~/.local`
- Graceful degradation: if sandbox unavailable, execute unsandboxed with warning (never block execution)
- Commit after each task or logical group
- Stop at any checkpoint to validate independently
