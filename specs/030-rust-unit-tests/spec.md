# Feature Specification: Rust Unit Tests & CI/CD Integration

**Feature Branch**: `030-rust-unit-tests`
**Created**: 2026-02-20
**Status**: Draft
**Input**: User description: "let's create rust unit test cases and integrate into npm test command and ci cd as well"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Developer Runs Rust Tests Locally (Priority: P1)

As a developer working on the Rust backend (Tauri), I want to run unit tests for the Rust codebase so that I can verify my changes don't break existing functionality before pushing code.

**Why this priority**: Without the ability to run Rust tests locally, developers have no safety net when modifying the backend. This is the foundational capability that all other stories depend on.

**Independent Test**: Can be fully tested by running the Rust test suite from the terminal and observing pass/fail results. Delivers immediate confidence in code correctness.

**Acceptance Scenarios**:

1. **Given** a developer has the Rust toolchain installed, **When** they run the Rust test command from the project root, **Then** all Rust unit tests execute and report pass/fail results with clear output.
2. **Given** a developer modifies a Rust source file, **When** they run the test suite, **Then** only relevant tests are re-compiled and executed, providing fast feedback.
3. **Given** a developer introduces a bug in a Rust module, **When** they run the test suite, **Then** at least one test fails with a descriptive error message indicating the failing module and expected vs. actual behavior.

---

### User Story 2 - Unified Test Command (Priority: P2)

As a developer, I want to run both TypeScript and Rust tests through a single `npm test` command so that I don't have to remember or switch between different test runners.

**Why this priority**: A unified test command reduces friction and ensures developers always run both test suites. This prevents scenarios where TypeScript tests pass but Rust tests are unknowingly broken (or vice versa).

**Independent Test**: Can be fully tested by running `npm test` and verifying both TypeScript (Vitest) and Rust (cargo test) output appears in the results.

**Acceptance Scenarios**:

1. **Given** a developer runs `npm test` locally, **When** the command starts, **Then** Rust tests (`cargo test`) run first to completion, followed by Vitest starting in watch mode — both outputs are visible in the terminal.
2. **Given** a Rust test fails during `npm test`, **When** the Rust test phase completes, **Then** the failure is reported immediately and Vitest does not start (command exits with non-zero status).
3. **Given** all Rust tests pass during `npm test` locally, **When** the Rust phase completes, **Then** Vitest starts in watch mode as usual and the developer can iterate on TypeScript changes.
4. **Given** `npm test` runs in a CI environment (where Vitest auto-detects CI and uses single-run mode), **When** the command completes, **Then** Rust tests run first followed by TypeScript tests in single-run mode. If Rust tests fail, TypeScript tests are skipped (fail-fast).

---

### User Story 3 - CI/CD Pipeline Runs Rust Tests (Priority: P3)

As a team lead, I want the CI/CD pipeline to automatically run Rust tests on every pull request so that broken Rust code cannot be merged without detection.

**Why this priority**: Automated testing in CI/CD is the last line of defense. While local testing (P1) catches most issues, CI/CD ensures nothing slips through even if a developer forgets to run tests.

**Independent Test**: Can be fully tested by opening a pull request with a failing Rust test and verifying the CI pipeline reports failure and blocks the merge.

**Acceptance Scenarios**:

1. **Given** a pull request is opened, **When** the CI pipeline runs, **Then** Rust unit tests are executed as part of the test job.
2. **Given** a pull request contains a failing Rust test, **When** the CI pipeline completes, **Then** the pipeline reports failure with clear Rust test output visible in the CI logs.
3. **Given** a pull request passes all tests (TypeScript and Rust), **When** the CI pipeline completes, **Then** the pipeline reports success.
4. **Given** the CI environment does not have Rust pre-installed, **When** the pipeline runs, **Then** the Rust toolchain is installed and cached for subsequent runs.

---

### User Story 4 - Comprehensive Rust Module Coverage (Priority: P4)

As a developer, I want unit tests covering the core Rust modules (storage, commands, HTTP, terminal, MCP manager, keychain, and browser commands) so that each module's logic is independently verified.

**Why this priority**: Having tests for individual modules builds confidence in the correctness of each component. This is lower priority than the infrastructure stories because the testing framework must exist before meaningful tests can be written.

**Independent Test**: Can be tested by verifying each Rust module has at least one test that exercises its core functionality and that the test suite covers the key modules.

**Acceptance Scenarios**:

1. **Given** the storage commands module exists, **When** tests run, **Then** tests verify configuration read/write/delete operations behave correctly.
2. **Given** the commands module exists, **When** tests run, **Then** tests verify platform info and project root commands return expected values.
3. **Given** the HTTP commands module exists, **When** tests run, **Then** tests verify request construction and response handling logic.
4. **Given** the terminal commands module exists, **When** tests run, **Then** tests verify command execution and output processing logic.
5. **Given** the MCP manager module exists, **When** tests run, **Then** tests verify server configuration parsing and lifecycle management logic.

---

### Edge Cases

- What happens when the Rust toolchain is not installed on a developer's machine but they run `npm test`? The command should provide a clear error message explaining the missing dependency rather than a cryptic failure.
- What happens when Rust tests pass but the compilation step fails? Build errors should be clearly distinguished from test failures in the output.
- What happens when the CI runner has a different Rust version than what the project requires? The pipeline should pin a specific Rust toolchain version to ensure consistency.
- What happens when a Rust test has a runtime panic? The test runner should catch the panic, report the failing test, and continue running remaining tests.
- What happens when `cargo test` is run outside the `tauri/` directory? The test command should handle working directory resolution automatically.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The project MUST include Rust unit test modules (using `#[cfg(test)]`) within each testable Rust source file.
- **FR-002**: The project MUST provide a way to run all Rust tests from the project root directory without requiring the developer to navigate to the `tauri/` subdirectory.
- **FR-003**: The `npm test` command MUST run Rust tests (`cargo test`) first to completion, then start Vitest. If Rust tests fail, Vitest MUST NOT start and the command MUST exit with a non-zero status code (fail-fast). Locally, Vitest runs in watch mode; in CI environments, Vitest auto-detects CI and runs in single-run mode.
- **FR-004**: The `npm run test:all` command MUST be removed. The `npm test` command is the single unified entry point for all tests, adapting its behavior based on the environment (local vs CI).
- **FR-005**: The CI/CD pipeline MUST install the Rust toolchain and run `cargo test` as part of the pull request checks.
- **FR-006**: The CI/CD pipeline MUST cache Rust compilation artifacts to avoid re-downloading and re-compiling dependencies on every run.
- **FR-007**: Rust tests MUST be runnable independently via a dedicated command (e.g., `npm run test:rust`) for developers who only want to run Rust tests.
- **FR-008**: Rust unit tests MUST cover the following modules at minimum: storage commands, platform commands, HTTP commands, terminal commands, and MCP manager.
- **FR-009**: Rust test output MUST clearly distinguish between compilation errors and test failures.
- **FR-010**: The `npm test` command MUST report an overall success/failure status that reflects the combined result of both test suites.
- **FR-011**: The CI pipeline MUST measure and report Rust code coverage percentages (lines/branches) as part of the test job output.
- **FR-012**: Rust test coverage results MUST be visible in the CI logs so that developers can assess coverage from the pull request checks.

### Key Entities

- **Test Module**: A Rust `#[cfg(test)]` module co-located within its corresponding source file, containing unit test functions annotated with `#[test]`.
- **Test Suite**: A collection of all test modules within the Rust codebase, executed together via `cargo test`.
- **CI Job**: A discrete step in the CI/CD pipeline responsible for installing the Rust toolchain, compiling the project, and running the Rust test suite.

## Assumptions

- The Rust standard test framework (`#[test]`, `#[cfg(test)]`, `assert!` macros) is sufficient for unit testing needs; no external Rust test frameworks are required.
- Tests will focus on pure logic and data transformation functions; Tauri IPC integration tests are out of scope for this feature.
- Platform-specific sandbox code may require conditional compilation attributes (`#[cfg(target_os = ...)]`) in tests, which is handled natively by Rust's test framework.
- The existing CI runner environments (Ubuntu for Linux, macOS, Windows) support Rust toolchain installation.
- Functions that depend on external state (filesystem, network, OS keychain) will use test doubles or will test the logic portions that can be isolated from side effects.

## Clarifications

### Session 2026-02-20

- Q: How should `npm test` (watch mode) handle Rust tests given `cargo test` has no native watch mode? → A: Option A — `npm test` runs `cargo test` once up-front to completion, then starts Vitest in watch mode. If Rust tests fail, Vitest does not start. One command handles everything.
- Q: Should there be a separate `npm run test:all` command for CI, or should `npm test` be the single unified command? → A: Single command only — `npm test` handles everything. It runs Rust tests first (fail-fast), then Vitest which auto-detects CI mode. The `test:all` command is removed.
- Q: Should Rust test coverage metrics be measured and reported? → A: Yes — include coverage reporting in CI pipeline output so developers can see coverage percentages in pull request checks.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: All core Rust modules (storage, commands, HTTP, terminal, MCP manager) have at least one passing unit test each.
- **SC-002**: Running `npm test` executes both TypeScript and Rust tests and completes successfully when all tests pass.
- **SC-003**: A pull request with a deliberately failing Rust test is blocked by the CI pipeline (pipeline reports failure).
- **SC-004**: CI pipeline Rust test execution adds no more than 3 minutes to the overall pipeline duration (after initial cache warm-up).
- **SC-005**: Developers can run Rust tests independently via a single command from the project root in under 30 seconds (for incremental builds).
- **SC-006**: The Rust test suite achieves test coverage across at least 5 distinct modules.
- **SC-007**: Rust code coverage percentages are reported in CI pipeline output for every pull request.
