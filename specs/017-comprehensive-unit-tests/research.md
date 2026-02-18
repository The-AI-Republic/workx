# Research: Comprehensive Unit Tests & CI Pipeline

**Date**: 2026-02-13
**Feature**: 017-comprehensive-unit-tests

## Decision 1: Test File Organization Strategy

**Decision**: All tests use co-located `src/**/__tests__/*.test.ts`
pattern. Existing 107 test files in `tests/` migrate to co-located
locations. 52 files already in `src/**/__tests__/` remain in place.

**Rationale**: Co-located tests are closer to the source they test,
making it easier to find and maintain tests. Vite/Rollup tree-shaking
ensures `__tests__/` directories never appear in production builds
since they are never imported by entry points.

**Alternatives considered**:
- Centralized `tests/unit/` with mirrored structure: Rejected because
  it duplicates the directory tree and requires longer relative imports.
- Mixed approach (shared in `tests/`, platform in `src/`): Rejected
  for inconsistency.

## Decision 2: Vitest Configuration Consolidation

**Decision**: Consolidate to a single `vitest.config.mjs` with the
include pattern `src/**/__tests__/**/*.{test,spec}.{js,ts,tsx}`.
Remove `vitest.contract.config.ts`, `vitest.config.dom.ts`, and
`vitest.dom.config.ts` (duplicates/stale).

**Rationale**: Multiple configs fragment test discovery and complicate
CI. A single config with the co-located pattern simplifies both local
development and CI pipeline. Contract tests, integration tests, and
unit tests are all co-located and distinguished by filename convention
(e.g., `*.integration.test.ts`, `*.contract.test.ts`).

**Alternatives considered**:
- Keep separate configs per test type: Rejected because all tests
  share the same jsdom environment and path aliases.

## Decision 3: Shared Test Utilities Location

**Decision**: Create `src/__test-utils__/` for shared mocks, helpers,
and fixtures used by multiple test suites.

**Rationale**: Co-located tests need a canonical location for shared
dependencies. The `__test-utils__` name follows the `__tests__` naming
convention and is clearly excluded from production by convention.

**Contents to migrate**:
- `tests/helpers/chrome-storage-mock.ts` → `src/__test-utils__/chrome-storage-mock.ts`
- `tests/mocks/*.svelte` → `src/__test-utils__/mocks/`
- `tests/fixtures/test-pages/` → `src/__test-utils__/fixtures/`
- `src/core/models/__tests__/setup.ts` → `src/__test-utils__/setup.ts` (global)

## Decision 4: Global Test Setup

**Decision**: Use `src/__test-utils__/setup.ts` as the global setup
file referenced in `vitest.config.mjs` `setupFiles`.

**Rationale**: Currently `setupFiles: []` is empty but a setup file
exists at `src/core/models/__tests__/setup.ts` with Chrome API mocks.
Centralizing this ensures all tests get consistent mock initialization
for Chrome APIs without duplicating setup logic.

**Alternatives considered**:
- Per-directory setup files: Rejected for duplication.
- No global setup: Rejected because Chrome API mocks are needed by
  most tests.

## Decision 5: CI Pipeline Technology

**Decision**: GitHub Actions workflow with Node.js 18, npm ci,
sequential jobs: lint → type-check → test with coverage.

**Rationale**: The project already uses npm and Node.js 18+. GitHub
Actions is the native CI for GitHub-hosted repos. Sequential jobs
ensure fast feedback on lint/type errors before running the full
test suite.

**Alternatives considered**:
- Parallel lint/type-check/test jobs: Rejected because the total
  time saved is minimal and sequential gives clearer failure signals.
- External CI (CircleCI, Jenkins): Rejected; GitHub Actions is free
  for public repos and already partially in use.

## Decision 6: Coverage Reporting

**Decision**: Generate HTML + JSON coverage reports, upload as GitHub
Actions artifact. Non-blocking (does not fail the check).

**Rationale**: The existing vitest config already has `coverage.reporter:
['text', 'json', 'html']`. Uploading as an artifact makes reports
accessible from the Actions run page without requiring external
services.

**Alternatives considered**:
- Codecov/Coveralls integration: Rejected as premature; can be added
  later. Artifact-based reporting has zero external dependencies.
- Blocking coverage threshold: Rejected per clarification; enforcement
  is informational only for now.

## Decision 7: Test Migration Order

**Decision**: Migrate in this order: (1) shared utils, (2) unit tests,
(3) config tests, (4) storage tests, (5) contract tests,
(6) integration tests, (7) component tests, (8) performance tests.

**Rationale**: Shared utils must move first since other tests depend on
them. Unit tests have the fewest interdependencies. Integration and
component tests are most complex due to multi-module dependencies.

## Decision 8: Path Alias Strategy

**Decision**: Standardize on `@/` prefix aliases matching tsconfig.json
(`@/*` → `src/*`). Remove shorthand aliases (`@core`, `@tools`, etc.)
from vitest config; use `@/core/`, `@/tools/` instead.

**Rationale**: tsconfig.json uses `@/*` pattern. Having vitest use
different aliases (`@core` vs `@/core`) creates confusion. Aligning
both configs ensures IDE navigation and test execution use identical
resolution.

**Alternatives considered**:
- Keep both alias styles: Rejected for inconsistency.
- Drop `@` aliases entirely and use relative paths: Rejected because
  deep nesting makes relative paths unwieldy.

## Decision 9: Modules Needing New Tests (Gap Analysis)

**Decision**: The following modules have NO existing test coverage and
MUST have new test files created:

| Module | File | Lines | Priority |
|--------|------|-------|----------|
| BrowserxAgent | src/core/BrowserxAgent.ts | 1,215 | P1 |
| Session | src/core/Session.ts | 1,823 | P1 |
| DiffTracker | src/core/DiffTracker.ts | 831 | P1 |
| StreamProcessor | src/core/StreamProcessor.ts | 606 | P1 |
| TaskRunner | src/core/TaskRunner.ts | 786 | P1 |
| FormAutomationTool | src/tools/FormAutomationTool.ts | 830 | P2 |
| NetworkInterceptTool | src/tools/NetworkInterceptTool.ts | 738 | P2 |
| DataExtractionTool | src/tools/DataExtractionTool.ts | 713 | P2 |
| WebScrapingTool | src/tools/WebScrapingTool.ts | 695 | P2 |
| NavigationTool | src/tools/NavigationTool.ts | 693 | P2 |
| BaseTool | src/tools/BaseTool.ts | 790 | P2 |
| ConfigStorage | src/storage/ConfigStorage.ts | ~200 | P3 |
| GoogleCompletionClient | src/core/models/client/GoogleCompletionClient.ts | 582 | P4 |
| RequestQueue | src/core/models/RequestQueue.ts | 650 | P4 |

Modules with PARTIAL coverage (existing tests need gaps filled):
- TurnManager: has 1 test file, needs more method coverage
- ToolRegistry: has config/init tests, needs execute/validate coverage
- AgentConfig: has 1 test file, needs more scenarios
- validators: has 1 test file, needs edge cases
- SessionCacheManager: has 1 test file, needs error paths
- IndexedDBAdapter: has 1 test file, needs batch operations
- ModelClientFactory: has config test, needs factory routing tests
- MCPManager: has tests, needs connection lifecycle coverage
- MessageRouter: has ResponseEvent test, needs full routing coverage
