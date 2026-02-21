# Feature Specification: Comprehensive Unit Tests & CI Pipeline

**Feature Branch**: `017-comprehensive-unit-tests`
**Created**: 2026-02-13
**Status**: Draft
**Input**: User description: "Add comprehensive unit test cases for all existing code and configure GitHub Actions CI to auto-run tests on PR creation and commits"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Unit Tests for Core Agent Logic (Priority: P1)

As a developer, I want comprehensive unit tests covering the core
agent modules (BrowserxAgent, Session, TurnManager, DiffTracker,
MessageRouter, StreamProcessor, TaskRunner) so that I can refactor
and extend core agent behavior with confidence that regressions are
caught immediately.

**Why this priority**: The core agent modules represent the most
critical business logic (Session at 1,823 lines, BrowserxAgent at
1,215 lines, TurnManager at 1,036 lines). These files have minimal
or no dedicated unit tests despite being the foundation of the
entire product. Bugs here affect every user interaction.

**Independent Test**: Can be verified by running the unit test suite
for core modules in isolation. A passing suite confirms that session
lifecycle, turn execution, message routing, and diff tracking all
behave correctly under expected and edge-case conditions.

**Acceptance Scenarios**:

1. **Given** the core agent modules exist without unit tests,
   **When** a developer runs the test suite for core modules,
   **Then** all core module public methods and critical code paths
   have corresponding test cases that pass.

2. **Given** a developer modifies Session state management logic,
   **When** they run the test suite,
   **Then** regressions are caught by failing unit tests that
   pinpoint the exact broken behavior.

3. **Given** the agent handles an LLM streaming response,
   **When** the stream is interrupted or malformed,
   **Then** unit tests verify the error is handled gracefully
   without crashing or corrupting session state.

---

### User Story 2 - Unit Tests for Tool Implementations (Priority: P2)

As a developer, I want unit tests for all agent tools
(FormAutomation, Storage, NetworkIntercept, DataExtraction,
WebScraping, Navigation, ToolRegistry, DOM tools) so that tool
behavior is verified in isolation from the LLM and browser runtime.

**Why this priority**: Tools are the primary interface between the
AI agent and the user's environment. With 3,000+ lines of tool
implementation code and almost no unit tests, there is high risk of
silent failures during autonomous task execution. Tools are also the
most frequently extended area of the codebase.

**Independent Test**: Can be verified by running the tool test suite.
Each tool's core logic (parameter validation, data transformation,
result formatting) is tested without requiring a live browser or
LLM connection.

**Acceptance Scenarios**:

1. **Given** tool implementations exist with minimal test coverage,
   **When** a developer runs the tool unit test suite,
   **Then** every tool's parameter validation, core logic, and
   error handling are tested.

2. **Given** the ToolRegistry manages tool discovery and lookup,
   **When** a new tool is registered or a tool name is queried,
   **Then** unit tests verify correct registration, retrieval,
   and handling of unknown tool names.

3. **Given** a tool receives invalid or missing parameters,
   **When** the tool is executed,
   **Then** unit tests verify that a descriptive error is returned
   without side effects.

---

### User Story 3 - Unit Tests for Configuration & Storage (Priority: P3)

As a developer, I want unit tests for the configuration system
(AgentConfig, validators, defaults) and storage layer
(SessionCacheManager, IndexedDBAdapter, ConfigStorage, rollout
recording) so that configuration loading, validation, and data
persistence are verified independently.

**Why this priority**: Configuration and storage are foundational
infrastructure used by every module. Incorrect config merging or
storage corruption has cascading effects. These modules (1,700+
lines combined) have limited test coverage and contain complex
validation and caching logic.

**Independent Test**: Can be verified by running config and storage
test suites. Config tests validate loading, merging, and validation
behavior. Storage tests verify CRUD operations, cache eviction, and
error recovery using in-memory storage stubs.

**Acceptance Scenarios**:

1. **Given** multiple configuration sources (defaults, user config,
   environment),
   **When** the configuration system merges them,
   **Then** unit tests verify the correct precedence order and
   validate all required fields.

2. **Given** the session cache has reached its capacity limit,
   **When** a new session is cached,
   **Then** unit tests verify that the oldest session is evicted
   and the new session is stored correctly.

3. **Given** the storage adapter encounters a corrupted entry,
   **When** a read operation is performed,
   **Then** unit tests verify graceful error handling and
   appropriate fallback behavior.

---

### User Story 4 - Unit Tests for Model Clients & MCP (Priority: P4)

As a developer, I want unit tests for all LLM provider clients
(OpenAI Responses, OpenAI ChatCompletion, Google Completion,
ModelClientFactory, RequestQueue) and MCP integration (MCPManager,
MCPClient, MCPToolAdapter) so that provider switching, request
queuing, and protocol handling are verified.

**Why this priority**: The model client layer (3,000+ lines) is the
interface to external LLM providers. The MCP layer (670+ lines)
enables extensibility via external tool servers. Both are critical
for core functionality but are difficult to test in production.
Mocked unit tests enable safe verification of retry logic, error
handling, and protocol compliance.

**Independent Test**: Can be verified by running model and MCP test
suites using mock HTTP responses. Tests validate request formatting,
response parsing, error handling, retry behavior, and provider
factory routing.

**Acceptance Scenarios**:

1. **Given** a model client sends a request to an LLM provider,
   **When** the provider returns a rate-limit error,
   **Then** unit tests verify the client retries with appropriate
   backoff and eventually surfaces the error if retries are
   exhausted.

2. **Given** ModelClientFactory receives a provider configuration,
   **When** the factory creates a client,
   **Then** unit tests verify the correct client type is
   instantiated with the expected settings.

3. **Given** an MCP server connection is established,
   **When** a tool call is routed through MCPToolAdapter,
   **Then** unit tests verify the request is formatted per the
   MCP protocol and the response is correctly mapped back to the
   agent's tool result format.

---

### User Story 5 - GitHub Actions CI Pipeline (Priority: P5)

As a developer, I want an automated CI pipeline that runs the full
unit test suite on every pull request creation and on every commit
pushed to an open PR, so that broken code is never merged into the
main branch without test verification.

**Why this priority**: Without automated CI, test discipline depends
entirely on individual developers remembering to run tests locally.
A CI pipeline provides a mandatory quality gate that scales with
team size and prevents regressions from reaching the main branch.
This story depends on having tests to run (US1-US4) but delivers
independent value as infrastructure.

**Independent Test**: Can be verified by creating a test PR and
confirming that the CI workflow triggers, runs the test suite, and
reports pass/fail status as a GitHub check on the PR.

**Acceptance Scenarios**:

1. **Given** a developer creates a new pull request,
   **When** the PR is opened against the main development branch,
   **Then** the CI pipeline automatically triggers and runs the
   full test suite, reporting results as a GitHub status check.

2. **Given** an open pull request exists,
   **When** a new commit is pushed to the PR branch,
   **Then** the CI pipeline re-runs the full test suite on the
   updated code.

3. **Given** the test suite contains a failing test,
   **When** the CI pipeline completes,
   **Then** the PR is marked with a failing status check and the
   failure details are visible in the workflow log.

4. **Given** the CI pipeline runs successfully,
   **When** a reviewer views the PR,
   **Then** a green check mark confirms all tests passed,
   providing confidence to approve the merge.

---

### Edge Cases

- What happens when tests depend on browser APIs not available in
  the test environment? Tests MUST use appropriate mocks or stubs
  (e.g., jsdom, chrome-mock) and MUST NOT require a running browser.
- What happens when the CI runner has different Node.js versions?
  The workflow MUST specify the exact Node.js version to ensure
  reproducibility.
- How does the system handle flaky tests? Tests MUST be
  deterministic. Any test that depends on timing, network, or
  random state MUST be refactored to eliminate flakiness.
- What happens when the test suite takes too long to run in CI?
  The CI pipeline MUST complete within a reasonable time. Tests
  MUST avoid unnecessary setup and teardown overhead.
- How are platform-specific modules (extension vs desktop) tested?
  Platform-specific code MUST use platform mocks. Shared code MUST
  be testable without platform dependencies.
- What happens when migrating existing tests breaks import paths?
  All import paths MUST be updated to reflect the new co-located
  locations. The Vitest config MUST be updated to match the
  simplified test discovery pattern. All migrated tests MUST pass
  after migration before any new tests are added.

## Clarifications

### Session 2026-02-13

- Q: What is the minimum line coverage target for the test suite? → A: 70% line coverage minimum across all tested modules.
- Q: Should the CI pipeline generate and publish a code coverage report? → A: Yes, generate coverage report as a CI artifact visible in GitHub Actions logs (non-blocking).
- Q: Where should new unit test files be placed? → A: Co-located as `src/**/__tests__/*.test.ts` next to source files. Existing tests in `tests/` MUST also be refactored to follow this co-located pattern.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The project MUST have unit tests for all core agent
  modules: BrowserxAgent, Session, TurnManager, DiffTracker,
  MessageRouter, StreamProcessor, and TaskRunner.
- **FR-002**: The project MUST have unit tests for all tool
  implementations: FormAutomationTool, StorageTool,
  NetworkInterceptTool, DataExtractionTool, WebScrapingTool,
  NavigationTool, ToolRegistry, and BaseTool.
- **FR-003**: The project MUST have unit tests for the DOM service
  layer: DomService, DomSnapshot, and the serialization pipeline.
- **FR-004**: The project MUST have unit tests for the configuration
  system: AgentConfig, validators, defaults, and type checking.
- **FR-005**: The project MUST have unit tests for the storage layer:
  SessionCacheManager, IndexedDBAdapter, ConfigStorage, and rollout
  recording modules.
- **FR-006**: The project MUST have unit tests for all model client
  implementations: OpenAIResponsesClient, OpenAIChatCompletionClient,
  GoogleCompletionClient, ModelClientFactory, and RequestQueue.
- **FR-007**: The project MUST have unit tests for MCP integration:
  MCPManager, MCPClient, and MCPToolAdapter.
- **FR-008**: All unit tests MUST be deterministic and MUST NOT
  depend on external API availability, network connectivity, or
  browser runtime.
- **FR-009**: All unit tests MUST use mocks or stubs for external
  dependencies (LLM APIs, Chrome APIs, file system, IndexedDB).
- **FR-010**: A GitHub Actions workflow MUST trigger on pull request
  creation (opened, synchronize, reopened events) against the main
  development branch.
- **FR-011**: The GitHub Actions workflow MUST run the full test
  suite and report results as a GitHub status check on the PR.
- **FR-012**: The GitHub Actions workflow MUST also run linting and
  type checking as part of the CI pipeline.
- **FR-016**: The GitHub Actions workflow MUST generate a code
  coverage report and upload it as a CI artifact accessible from
  the GitHub Actions run page. Coverage enforcement is non-blocking
  (informational only; does not fail the check).
- **FR-013**: All unit tests (new and existing) MUST be co-located
  with their source modules as `src/**/__tests__/*.test.ts`.
- **FR-014**: Unit tests MUST cover both success paths and error/
  edge-case paths for each module.
- **FR-015**: The test suite MUST achieve a minimum of 70% line
  coverage across all tested modules.
- **FR-017**: All existing test files currently in `tests/` MUST be
  refactored to the co-located `src/**/__tests__/` pattern. After
  migration, the `tests/` directory at the repository root MUST be
  removed.

### Key Entities

- **Test Suite**: A collection of related test cases organized by
  module. Each suite covers one source module and lives alongside
  or in the corresponding test directory.
- **CI Pipeline**: An automated workflow that runs on GitHub Actions,
  triggered by PR events, executing linting, type checking, and the
  full test suite.
- **Test Mock**: A substitute for an external dependency (LLM API,
  Chrome runtime, IndexedDB) that simulates expected behavior for
  deterministic testing.

### Assumptions

- The existing Vitest configuration and test infrastructure
  (vitest.config.mjs, jsdom, chrome-mock, fake-indexeddb) are
  sufficient and do not need replacement.
- All test files (new and migrated) will use the co-located pattern:
  `src/**/__tests__/*.test.ts` adjacent to the modules they test.
- The GitHub Actions runner environment provides Node.js 18+ and
  npm. No additional system dependencies (Rust, WebKit) are
  required for unit tests.
- The CI workflow targets the `pi-dev` branch as the primary
  protected branch for PR checks.
- Existing 168 test files will be migrated from `tests/` to their
  corresponding `src/**/__tests__/` locations. Test logic and
  assertions are preserved; only file paths and imports change.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: All core agent modules (BrowserxAgent, Session,
  TurnManager, DiffTracker, MessageRouter, StreamProcessor,
  TaskRunner) have dedicated unit test files with at least one
  test per public method.
- **SC-002**: All tool implementations have dedicated unit test
  files covering parameter validation, core logic, and error
  handling paths.
- **SC-003**: Configuration and storage modules have unit tests
  covering loading, merging, validation, CRUD operations, and
  error recovery.
- **SC-004**: Model client and MCP modules have unit tests
  covering request formatting, response parsing, error handling,
  and factory routing.
- **SC-005**: The full test suite passes with zero failures when
  run in an environment without browser, network, or API access.
- **SC-006**: A GitHub Actions CI pipeline triggers automatically
  on every PR and every push to a PR, completing within 10 minutes.
- **SC-007**: The CI pipeline reports pass/fail status as a visible
  GitHub check on the pull request.
- **SC-008**: The CI pipeline runs linting, type checking, and the
  full test suite as part of the quality gate.
- **SC-009**: The test suite achieves at least 70% line coverage
  across all tested modules when measured by the coverage tool.
- **SC-010**: Each CI run produces a downloadable coverage report
  artifact accessible from the GitHub Actions run summary page.
