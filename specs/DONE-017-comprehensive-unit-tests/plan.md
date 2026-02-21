# Implementation Plan: Comprehensive Unit Tests & CI Pipeline

**Branch**: `017-comprehensive-unit-tests` | **Date**: 2026-02-13 | **Spec**: [spec.md](spec.md)
**Input**: Feature specification from `/specs/017-comprehensive-unit-tests/spec.md`

## Summary

Add comprehensive unit test coverage to all BrowserX source modules
and set up a GitHub Actions CI pipeline that runs lint, type-check,
and the full test suite on every PR. This includes migrating 107
existing test files from the root `tests/` directory to co-located
`src/**/__tests__/` locations, writing new unit tests for 14 untested
modules and expanding coverage for 9 partially-tested modules, and
consolidating multiple vitest configs into one.

## Technical Context

**Language/Version**: TypeScript 5.9 (strict mode)
**Primary Dependencies**: Vitest 3.2, jsdom 27, chrome-mock, fake-indexeddb, Svelte 4
**Storage**: N/A (tests use in-memory mocks)
**Testing**: Vitest with jsdom environment, coverage via @vitest/coverage-v8
**Target Platform**: GitHub Actions (ubuntu-latest), Node.js 18
**Project Type**: Single project with co-located tests
**Performance Goals**: Full test suite completes in <10 minutes in CI
**Constraints**: All tests deterministic; zero external API/network/browser deps
**Scale/Scope**: ~258 source files, ~159 existing tests, target 70% line coverage

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| Principle | Status | Notes |
|-----------|--------|-------|
| I. Privacy-First | PASS | Tests use mocks only; no real user data or external API calls |
| II. Cross-Platform Parity | PASS | Shared modules tested via platform-agnostic mocks; platform-specific tests use platform mocks |
| III. Secure Agent Execution | PASS | Tests validate input validation and error handling in tools; no real system access |
| IV. Test-Verified Quality | PASS | This feature IS the implementation of Principle IV; establishes 70% coverage baseline and CI enforcement |
| V. Modular Tool Design | PASS | Each tool tested independently through its public interface; ToolRegistry tested for registration/discovery/execution |

**Post-Phase 1 Re-check**: All gates remain PASS. No constitution
violations introduced by the design.

## Project Structure

### Documentation (this feature)

```text
specs/017-comprehensive-unit-tests/
├── plan.md              # This file
├── research.md          # Phase 0 output
├── quickstart.md        # Phase 1 output
└── tasks.md             # Phase 2 output (/rr.tasks command)
```

### Source Code (repository root)

```text
src/
├── __test-utils__/              # NEW: shared test utilities
│   ├── setup.ts                 # Global test setup (Chrome mocks)
│   ├── chrome-storage-mock.ts   # Chrome storage mock
│   ├── mocks/                   # Shared mock components
│   │   ├── MockAgentStatus.svelte
│   │   ├── MockSettingsPanel.svelte
│   │   └── MockTaskDisplay.svelte
│   └── fixtures/                # Shared test fixtures
│       └── test-pages/
│           ├── infinite-scroll.html
│           ├── simple-click.html
│           └── simple-form.html
├── core/
│   ├── __tests__/               # NEW + migrated core tests
│   │   ├── BrowserxAgent.test.ts          # NEW
│   │   ├── Session.test.ts                # NEW
│   │   ├── DiffTracker.test.ts            # NEW
│   │   ├── StreamProcessor.test.ts        # NEW (expand existing)
│   │   ├── TaskRunner.test.ts             # NEW
│   │   ├── TurnManager.test.ts            # MIGRATED from tests/unit/
│   │   ├── MessageRouter.test.ts          # NEW (expand existing)
│   │   ├── TabContext.test.ts             # MIGRATED
│   │   ├── TabManager.test.ts             # MIGRATED
│   │   ├── TurnContext.test.ts            # MIGRATED
│   │   ├── *.integration.test.ts          # MIGRATED integration tests
│   │   └── *.contract.test.ts             # MIGRATED contract tests
│   ├── models/
│   │   └── __tests__/           # EXISTING + migrated + new
│   │       ├── ModelClientFactory.test.ts  # NEW (expand)
│   │       ├── RequestQueue.test.ts        # NEW
│   │       ├── GoogleCompletionClient.test.ts  # NEW
│   │       ├── setup.ts → MOVED to __test-utils__
│   │       └── (existing tests remain)
│   ├── mcp/
│   │   └── __tests__/           # EXISTING (10 files, already co-located)
│   ├── session/
│   │   └── state/__tests__/     # EXISTING + migrated
│   └── registry/
│       └── __tests__/           # MIGRATED from tests/unit/registry/
├── config/
│   └── __tests__/               # MIGRATED from tests/unit/config/
│       ├── AgentConfig.test.ts
│       ├── validators.test.ts
│       ├── events.test.ts
│       └── profiles.test.ts
├── storage/
│   ├── __tests__/               # MIGRATED from tests/unit/storage/
│   │   ├── SessionCacheManager.test.ts
│   │   ├── IndexedDBAdapter.test.ts
│   │   ├── ConfigStorage.test.ts
│   │   └── *.integration.test.ts
│   └── rollout/
│       └── __tests__/           # MIGRATED from tests/storage/rollout/
├── tools/
│   ├── __tests__/               # MIGRATED + NEW
│   │   ├── BaseTool.test.ts              # NEW
│   │   ├── FormAutomationTool.test.ts    # NEW
│   │   ├── NetworkInterceptTool.test.ts  # NEW
│   │   ├── DataExtractionTool.test.ts    # NEW
│   │   ├── WebScrapingTool.test.ts       # NEW
│   │   ├── NavigationTool.test.ts        # NEW
│   │   ├── StorageTool.test.ts           # MIGRATED
│   │   └── ToolRegistry.test.ts          # MIGRATED + expanded
│   └── dom/
│       └── __tests__/           # EXISTING (22 files, already co-located)
├── extension/
│   ├── sidepanel/
│   │   ├── __tests__/           # MIGRATED from tests/sidepanel/
│   │   └── components/__tests__/ # MIGRATED component tests
│   ├── storage/__tests__/       # MIGRATED from tests/contract/storage-*
│   └── content/__tests__/       # EXISTING (1 file)
├── utils/
│   └── __tests__/               # MIGRATED from tests/utils/
│       └── encryption.test.ts
└── (other dirs unchanged)

.github/
└── workflows/
    ├── sync-to-private.yml      # EXISTING
    └── ci.yml                   # NEW: test/lint/type-check pipeline
```

**Structure Decision**: Co-located test pattern with `__tests__/`
directories adjacent to source modules. Shared test utilities in
`src/__test-utils__/`. Single vitest config. The root `tests/`
directory is removed after migration.

### Configuration Changes

```text
vitest.config.mjs               # MODIFIED: simplified include, global setup
vitest.contract.config.ts        # DELETED (merged into main config)
vitest.config.dom.ts             # DELETED (duplicate)
vitest.dom.config.ts             # DELETED (duplicate)
package.json                     # MODIFIED: add coverage script
```

## Complexity Tracking

> No constitution violations. No complexity justifications needed.

## Migration Plan

### Phase 1: Infrastructure Setup

1. Create `src/__test-utils__/` and move shared utilities
2. Update `vitest.config.mjs`:
   - Set `setupFiles: ['src/__test-utils__/setup.ts']`
   - Simplify include to `['src/**/__tests__/**/*.{test,spec}.{js,ts,tsx}']`
   - Align path aliases with tsconfig.json (`@/*` pattern only)
   - Add coverage thresholds (non-blocking)
3. Delete redundant vitest configs
4. Verify existing co-located tests (52 files) still pass

### Phase 2: Test Migration (107 files)

Migrate in dependency order:
1. Shared helpers/mocks/fixtures → `src/__test-utils__/`
2. Unit tests (24 files) → corresponding `src/**/__tests__/`
3. Config tests (2 files) → `src/config/__tests__/`
4. Storage tests (7 files) → `src/storage/rollout/__tests__/`
5. Contract tests (13 files) → corresponding `src/**/__tests__/`
6. Integration tests (41 files) → corresponding `src/**/__tests__/`
7. Sidepanel tests (8 files) → `src/extension/sidepanel/__tests__/`
8. Performance tests (5 files) → corresponding `src/**/__tests__/`
9. Remaining tests (tools, prompts, validation, utils, models)
10. Remove root `tests/` directory
11. Run full suite to verify zero regressions

### Phase 3: New Unit Tests

Write new test files for untested modules (14 files):
- P1: BrowserxAgent, Session, DiffTracker, StreamProcessor, TaskRunner
- P2: BaseTool, FormAutomationTool, NetworkInterceptTool,
  DataExtractionTool, WebScrapingTool, NavigationTool
- P3: ConfigStorage (expand existing)
- P4: GoogleCompletionClient, RequestQueue

Expand partial coverage for 9 modules:
- TurnManager, ToolRegistry, AgentConfig, validators,
  SessionCacheManager, IndexedDBAdapter, ModelClientFactory,
  MCPManager, MessageRouter

### Phase 4: CI Pipeline

Create `.github/workflows/ci.yml`:
- Trigger: `pull_request` events (opened, synchronize, reopened)
  against `pi-dev` branch
- Jobs:
  1. **lint**: `npm run lint`
  2. **type-check**: `npm run type-check`
  3. **test**: `npm run test:all -- --coverage`
  4. **upload**: Upload coverage report as artifact
- Environment: `ubuntu-latest`, Node.js 18, `npm ci`
- Timeout: 15 minutes per job

### Phase 5: Verification

1. Run `npm run test:all -- --coverage` locally
2. Verify 70% line coverage target
3. Create test PR to verify CI pipeline triggers
4. Confirm pass/fail status check appears on PR
5. Confirm coverage artifact is downloadable

## Mocking Strategy

### Global Mocks (via setup.ts)

- `chrome.runtime` - messaging, events, getURL
- `chrome.storage` - local, sync, session
- `chrome.tabs` - query, get, update
- `globalThis.fetch` - HTTP request mock

### Per-Module Mock Patterns

| Module | Key Mocks Required |
|--------|--------------------|
| BrowserxAgent | AgentConfig, Session, ModelClientFactory, ToolRegistry, MessageRouter |
| Session | SessionState, RolloutRecorder, CompactService, TurnContext |
| TurnManager | Session, TurnContext, ToolRegistry, ModelClient |
| DiffTracker | EventEmitter (optional) |
| MessageRouter | chrome.runtime.sendMessage, chrome.tabs.sendMessage |
| StreamProcessor | ReadableStream, AsyncGenerator |
| TaskRunner | Session, TurnContext, TurnManager |
| ModelClientFactory | AgentConfig, fetch (HTTP responses) |
| RequestQueue | None (self-contained with timers) |
| MCPManager | fetch, WebSocket/SSE transport |
| Tool implementations | chrome.tabs, DOM APIs via jsdom |
| Storage modules | fake-indexeddb |
| Config modules | chrome.storage mock |

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Import path breakage during migration | Medium | High | Migrate one group at a time; run tests after each group |
| Flaky tests introduced by jsdom limitations | Low | Medium | Mock DOM APIs rather than relying on jsdom behavior |
| CI timeout due to large test suite | Low | Medium | 15-minute timeout; optimize slow tests if needed |
| Coverage target unreachable for complex modules | Medium | Low | 70% is achievable; hard-to-test code paths documented |
| Existing tests fail after migration | Low | High | Preserve all test logic; only change file paths and imports |
