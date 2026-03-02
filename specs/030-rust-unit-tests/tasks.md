# Tasks: Rust Unit Tests & CI/CD Integration

**Input**: Design documents from `/specs/030-rust-unit-tests/`
**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/

**Tests**: This feature IS about creating tests. Test tasks are included as core implementation work.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Create the Rust test runner script and directory structure needed by all stories

- [ ] T001 Create scripts directory at `tauri/scripts/`
- [ ] T002 Create test runner script at `tauri/scripts/test-rust.sh` — check for cargo binary (exit 127 with helpful message if missing), run `cargo test --manifest-path tauri/Cargo.toml`, exit with cargo's exit code
- [ ] T003 Make `tauri/scripts/test-rust.sh` executable (`chmod +x`)

**Checkpoint**: `bash tauri/scripts/test-rust.sh` runs successfully from project root (even with zero tests)

---

## Phase 2: User Story 1 - Developer Runs Rust Tests Locally (Priority: P1) MVP

**Goal**: Developers can run Rust unit tests locally via `cargo test` from the project root and get clear pass/fail results

**Independent Test**: Run `bash tauri/scripts/test-rust.sh` from project root and verify all tests pass with clear output

### Implementation for User Story 1

- [ ] T004 [P] [US1] Add `#[cfg(test)] mod tests` with initial test for `greet()` formatting in `tauri/src/commands.rs`
- [ ] T005 [P] [US1] Add `#[cfg(test)] mod tests` with initial test for `get_platform_info()` field population in `tauri/src/commands.rs` (same file as T004 — combine if parallel not possible)
- [ ] T006 [P] [US1] Add `#[cfg(test)] mod tests` with initial test for `ConfigStorage::get()` returning None for missing key in `tauri/src/storage_commands.rs`
- [ ] T007 [P] [US1] Add `#[cfg(test)] mod tests` with initial test for `WorkspaceAccess::from_str_opt()` and `NetworkMode::from_str_opt()` in `tauri/src/sandbox/mod.rs`
- [ ] T008 [P] [US1] Add `#[cfg(test)] mod tests` with initial test for `WindowsSandbox::is_available()` returning false in `tauri/src/sandbox/windows.rs`
- [ ] T009 [P] [US1] Add `#[cfg(test)] mod tests` with initial test for `escape_sbpl_path()` in `tauri/src/sandbox/macos.rs`
- [ ] T010 [P] [US1] Add `#[cfg(test)] mod tests` with initial test for `LinuxSandbox::build_command()` basic args in `tauri/src/sandbox/linux.rs`
- [ ] T011 [P] [US1] Add `#[cfg(test)] mod tests` with initial test for command allowlist validation (extract `validate_command_allowlist()` helper) in `tauri/src/mcp_manager.rs`
- [ ] T012 [P] [US1] Add `#[cfg(test)] mod tests` with initial test for HTTP method parsing (extract `parse_http_method()` helper) in `tauri/src/http_commands.rs`
- [ ] T013 [P] [US1] Add `#[cfg(test)] mod tests` with initial test for ANSI stripping (extract `strip_ansi_and_decode()` helper) in `tauri/src/terminal_commands.rs`
- [ ] T014 [P] [US1] Add `#[cfg(test)] mod tests` with initial test for distro ID parsing (extract `parse_distro_id()` helper) in `tauri/src/sandbox/status.rs`
- [ ] T015 [P] [US1] Add `#[cfg(test)] mod tests` with initial test for `load_png_image()` with invalid data in `tauri/src/main.rs`
- [ ] T016 [US1] Verify `bash tauri/scripts/test-rust.sh` passes all initial tests from project root — fix any compilation or test failures

**Checkpoint**: `bash tauri/scripts/test-rust.sh` runs from project root, all initial tests pass, clear output visible. SC-001 partially met (at least 1 test per core module).

---

## Phase 3: User Story 2 - Unified Test Command (Priority: P2)

**Goal**: `npm test` runs Rust tests first (fail-fast), then Vitest. `test:all` is removed.

**Independent Test**: Run `npm test` and verify Rust test output appears first, followed by Vitest output

### Implementation for User Story 2

- [ ] T017 [US2] Update `"test"` script in `package.json` to `"bash tauri/scripts/test-rust.sh && vitest"` — replacing the existing `"vitest"` value
- [ ] T018 [US2] Add `"test:rust"` script in `package.json` with value `"bash tauri/scripts/test-rust.sh"` for running Rust tests independently
- [ ] T019 [US2] Remove `"test:all"` script from `package.json` — no longer needed since `npm test` is the unified entry point
- [ ] T020 [US2] Verify `npm test` runs Rust tests first, then Vitest — confirm fail-fast behavior by temporarily breaking a Rust test and verifying Vitest does not start
- [ ] T021 [US2] Verify `npm run test:rust` runs only Rust tests and exits cleanly

**Checkpoint**: `npm test` executes both test suites with fail-fast. `npm run test:rust` runs Rust only. SC-002 and SC-005 met.

---

## Phase 4: User Story 3 - CI/CD Pipeline Runs Rust Tests (Priority: P3)

**Goal**: CI pipeline installs Rust, caches dependencies, runs `npm test` (which includes Rust tests), and reports coverage

**Independent Test**: Open a PR with a failing Rust test and verify CI reports failure

### Implementation for User Story 3

- [ ] T022 [US3] Add `dtolnay/rust-toolchain@stable` step to test job in `.github/workflows/ci.yml` — insert after `actions/setup-node` and before `npm ci`
- [ ] T023 [US3] Add `actions/cache@v4` step for Rust artifacts in `.github/workflows/ci.yml` — cache `~/.cargo/registry`, `~/.cargo/git`, `tauri/target` keyed by `runner.os`-cargo-`hashFiles('tauri/Cargo.lock')`
- [ ] T024 [US3] Add Linux system dependencies step in `.github/workflows/ci.yml` — `sudo apt-get update && sudo apt-get install -y libwebkit2gtk-4.1-dev librsvg2-dev libayatana-appindicator3-dev` (required for Tauri compilation)
- [ ] T025 [US3] Change test step in `.github/workflows/ci.yml` from `npm run test:all` to `npm test`
- [ ] T026 [US3] Add Rust coverage step in `.github/workflows/ci.yml` — `cargo install cargo-tarpaulin --locked && cargo tarpaulin --manifest-path tauri/Cargo.toml --out stdout` as a separate step after the test step

**Checkpoint**: CI pipeline installs Rust, runs tests, reports coverage. SC-003, SC-004, SC-007 met.

---

## Phase 5: User Story 4 - Comprehensive Rust Module Coverage (Priority: P4)

**Goal**: Unit tests cover core Rust modules with meaningful test cases for pure logic, extracted helpers, and state-dependent operations

**Independent Test**: Run `cargo test --manifest-path tauri/Cargo.toml` and verify tests pass for all 5+ modules (storage, commands, HTTP, terminal, MCP manager, sandbox)

### Tier 1: Pure Logic Tests (no mocking needed)

- [ ] T027 [P] [US4] Add comprehensive tests for `WindowsSandbox::build_command()` in `tauri/src/sandbox/windows.rs` — workspace RW/RO/None, env provided/None, args/program validation, held_resources empty (5-8 tests)
- [ ] T028 [P] [US4] Add comprehensive tests for `escape_sbpl_path()` in `tauri/src/sandbox/macos.rs` — valid path, path with spaces, path with double quote (returns error) (3 tests)
- [ ] T029 [P] [US4] Add comprehensive tests for `generate_sbpl()` in `tauri/src/sandbox/macos.rs` — basic structure (version, deny default), workspace RW/RO/None rules, standard writable paths, macOS temp paths, bind mount RW/RO, network Host/Sandbox (10-12 tests)
- [ ] T030 [P] [US4] Add comprehensive tests for `LinuxSandbox::build_command()` in `tauri/src/sandbox/linux.rs` — system mounts, workspace RW/RO/None, standard writable paths, bind mounts RW/RO, network sandbox/host (--unshare-net), process isolation flags, final args format, program is "bwrap" (10-14 tests)
- [ ] T031 [P] [US4] Add comprehensive tests for `greet()` and `get_platform_info()` in `tauri/src/commands.rs` — greet format with various names, PlatformInfo fields non-empty (3-4 tests)
- [ ] T032 [P] [US4] Add comprehensive tests for `WorkspaceAccess::from_str_opt()` and `NetworkMode::from_str_opt()` in `tauri/src/sandbox/mod.rs` — all enum variants, None input, unexpected strings default correctly (6-8 tests)
- [ ] T033 [P] [US4] Add comprehensive tests for `build_profile()` in `tauri/src/sandbox/mod.rs` — with/without cwd, standard writable paths include expected entries, bind mount canonicalization, workspace access and network mode passed through (4-6 tests)

### Tier 2: Extractable Logic Tests (extract helper, test pure part)

- [ ] T034 [P] [US4] Extract and test `validate_command_allowlist()` in `tauri/src/mcp_manager.rs` — valid commands (npx, node, deno, uvx, docker, python3), invalid commands, full path extraction ("/usr/bin/npx" → "npx"), empty string (6-8 tests)
- [ ] T035 [P] [US4] Extract and test content block transformation functions in `tauri/src/mcp_manager.rs` — Text, Image, Audio, Unknown RawContent variants → McpContentBlock (4-5 tests)
- [ ] T036 [P] [US4] Extract and test resource transformation functions in `tauri/src/mcp_manager.rs` — resource list transform, Text/Blob ResourceContents → McpResourceContent (3-4 tests)
- [ ] T037 [P] [US4] Extract and test `parse_http_method()`, status text mapping, header conversion, and base64 encoding in `tauri/src/http_commands.rs` — valid methods (GET/POST/PUT/DELETE), invalid method, known status codes, unknown status, header map conversion, base64 encoding with known bytes (5-6 tests)
- [ ] T038 [P] [US4] Extract and test `strip_ansi_and_decode()` and shell detection in `tauri/src/terminal_commands.rs` — input with ANSI codes stripped, clean input unchanged, invalid UTF-8 lossy conversion, platform shell detection (bash/zsh/powershell) (5-7 tests)
- [ ] T039 [P] [US4] Extract and test `parse_distro_id()` and package manager selection in `tauri/src/sandbox/status.rs` — ubuntu/debian/fedora/arch/opensuse distro parsing, package manager mapping (apt-get/dnf/pacman/zypper), unsupported distro, missing ID line (8-10 tests)
- [ ] T040 [P] [US4] Add tests for `load_png_image()` and dark theme string parsing in `tauri/src/main.rs` — valid PNG bytes with RGB→RGBA conversion, invalid PNG returns None, dark theme string matching (3-5 tests)

### Tier 3: State-Dependent Tests (needs test setup)

- [ ] T041 [P] [US4] Add tests for `ConfigStorage` operations in `tauri/src/storage_commands.rs` — construct ConfigStorage with temp directory, test get/set/remove/get_all/clear with in-memory data, test JSON parsing in set (string value vs JSON object), test missing key returns None (7-9 tests)
- [ ] T042 [P] [US4] Add tests for `file_exists()` in `tauri/src/browser_commands.rs` — create temp file and verify true, non-existent path returns false, empty path returns false (3 tests)
- [ ] T043 [P] [US4] Add tests for keychain error mapping in `tauri/src/keychain_commands.rs` — test `keychain_list_accounts()` returns not-supported error, verify error message format (2-3 tests)

### Verification

- [ ] T044 [US4] Run full test suite `cargo test --manifest-path tauri/Cargo.toml` and verify all tests pass — fix any failures, confirm test count matches expected (~80-95 tests across 13 files)

**Checkpoint**: All core modules have comprehensive tests. SC-001, SC-006 fully met. `cargo test` passes cleanly.

---

## Phase 6: Polish & Cross-Cutting Concerns

**Purpose**: Final validation and documentation

- [ ] T045 Run `npm test` end-to-end locally — verify Rust tests run first (fail-fast), then Vitest starts in watch mode, all pass
- [ ] T046 Run `npm run test:rust` independently — verify clean output and exit code
- [ ] T047 Validate CI workflow syntax in `.github/workflows/ci.yml` — ensure YAML is valid and all steps reference correct paths
- [ ] T048 Run quickstart.md validation — verify all commands documented in `specs/030-rust-unit-tests/quickstart.md` work as described

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies — can start immediately
- **US1 (Phase 2)**: Depends on Setup (T001-T003) — needs test-rust.sh to exist
- **US2 (Phase 3)**: Depends on US1 — npm test relies on Rust tests existing and passing
- **US3 (Phase 4)**: Depends on US2 — CI runs `npm test` which must be configured
- **US4 (Phase 5)**: Depends on US1 — test modules must be scaffolded before adding comprehensive tests
- **Polish (Phase 6)**: Depends on all prior phases

### User Story Dependencies

- **User Story 1 (P1)**: Depends on Setup only — foundational, no other story dependencies
- **User Story 2 (P2)**: Depends on US1 — needs Rust tests to exist for `npm test` integration
- **User Story 3 (P3)**: Depends on US2 — CI runs `npm test` which must include Rust tests
- **User Story 4 (P4)**: Depends on US1 — builds on initial test modules with comprehensive test cases

### Within Each User Story

- US1: All T004-T015 are parallel (different files), T016 is serial (verification)
- US2: T017-T019 are serial (same file: package.json), T020-T021 are serial (verification)
- US3: T022-T026 are serial (same file: ci.yml — order matters for step sequencing)
- US4: All Tier 1 tasks (T027-T033) are parallel; all Tier 2 tasks (T034-T040) are parallel; all Tier 3 tasks (T041-T043) are parallel; T044 is serial (verification)

### Parallel Opportunities

- **Within US1**: T004-T015 — all 12 tasks modify different files, fully parallelizable
- **Within US4 Tier 1**: T027-T033 — all 7 tasks modify different files
- **Within US4 Tier 2**: T034-T040 — all 7 tasks modify different files
- **Within US4 Tier 3**: T041-T043 — all 3 tasks modify different files
- **US4 Tiers**: Tier 2 can start in parallel with Tier 1 (different files); Tier 3 can start in parallel with Tier 1 and 2

---

## Parallel Example: User Story 1

```bash
# Launch all initial test module tasks in parallel (each modifies a different file):
Task: "Add #[cfg(test)] module with initial test in tauri/src/commands.rs"
Task: "Add #[cfg(test)] module with initial test in tauri/src/storage_commands.rs"
Task: "Add #[cfg(test)] module with initial test in tauri/src/sandbox/mod.rs"
Task: "Add #[cfg(test)] module with initial test in tauri/src/sandbox/windows.rs"
Task: "Add #[cfg(test)] module with initial test in tauri/src/sandbox/macos.rs"
Task: "Add #[cfg(test)] module with initial test in tauri/src/sandbox/linux.rs"
Task: "Add #[cfg(test)] module with initial test in tauri/src/mcp_manager.rs"
Task: "Add #[cfg(test)] module with initial test in tauri/src/http_commands.rs"
Task: "Add #[cfg(test)] module with initial test in tauri/src/terminal_commands.rs"
Task: "Add #[cfg(test)] module with initial test in tauri/src/sandbox/status.rs"
Task: "Add #[cfg(test)] module with initial test in tauri/src/main.rs"
```

## Parallel Example: User Story 4 Tier 1

```bash
# Launch all pure-logic comprehensive test tasks in parallel:
Task: "Comprehensive tests for WindowsSandbox::build_command() in tauri/src/sandbox/windows.rs"
Task: "Comprehensive tests for escape_sbpl_path() + generate_sbpl() in tauri/src/sandbox/macos.rs"
Task: "Comprehensive tests for LinuxSandbox::build_command() in tauri/src/sandbox/linux.rs"
Task: "Comprehensive tests for greet() + get_platform_info() in tauri/src/commands.rs"
Task: "Comprehensive tests for WorkspaceAccess/NetworkMode + build_profile() in tauri/src/sandbox/mod.rs"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Phase 1: Setup (T001-T003)
2. Complete Phase 2: US1 — initial test modules (T004-T016)
3. **STOP and VALIDATE**: Run `bash tauri/scripts/test-rust.sh` — all tests pass
4. Rust tests are now runnable locally

### Incremental Delivery

1. Setup + US1 → Rust tests runnable locally (MVP!)
2. Add US2 → `npm test` runs both suites → Test end-to-end
3. Add US3 → CI pipeline runs Rust tests + coverage → Verify via PR
4. Add US4 → Comprehensive coverage → Verify test count and module coverage
5. Polish → Final validation

### Parallel Team Strategy

With multiple developers:

1. Team completes Setup together (3 tasks, fast)
2. Once Setup is done:
   - Developer A: US1 (initial test modules — 12 parallel tasks)
   - (After US1): Developer A: US2 (npm integration)
3. Once US2 is done:
   - Developer B: US3 (CI/CD)
   - Developer A: US4 Tier 1-3 (comprehensive tests — all parallel within tiers)
4. Final: Anyone does Polish

---

## Notes

- [P] tasks = different files, no dependencies
- [Story] label maps task to specific user story for traceability
- T004 and T005 target the same file (commands.rs) — combine into one task during execution
- US4 comprehensive tests (Phase 5) build ON TOP of the initial test modules created in US1 (Phase 2) — they expand the existing `#[cfg(test)]` modules, not replace them
- Tier 2 tasks require minor refactoring (extract helper functions) before writing tests — the extraction and tests should happen in the same task
- Commit after each phase checkpoint for clean git history
