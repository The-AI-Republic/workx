# Feature Specification: Fix TypeScript Type-Check CI Failures

**Feature Branch**: `027-typecheck-fixes`
**Created**: 2026-02-17
**Status**: Draft
**Input**: User description: "currently in the ci, it seems has npm run type-check and it has lots of the failure, let's optimize our code to make it pass npm run type-check"

## User Scenarios & Testing *(mandatory)*

### User Story 1 - CI Pipeline Passes Type-Check (Priority: P1)

As a developer, I want `npm run type-check` to pass with zero errors so that the CI pipeline succeeds and the team can merge pull requests without type-check failures blocking the workflow.

**Why this priority**: A failing CI gate blocks all development progress. Every PR is currently blocked or forced to bypass type-checking, reducing code quality assurance.

**Independent Test**: Run `npm run type-check` from the project root. The command must exit with code 0 and produce no error output.

**Acceptance Scenarios**:

1. **Given** the current codebase on the main development branch, **When** a developer runs `npm run type-check`, **Then** the command completes successfully with zero errors.
2. **Given** a CI pipeline that runs `npm run type-check`, **When** a new PR is opened, **Then** the type-check step passes without manual intervention.

---

### User Story 2 - Test Files Type-Check Correctly (Priority: P1)

As a developer, I want test files to be properly type-checked so that test code benefits from the same type safety guarantees as production code, catching errors before they reach runtime.

**Why this priority**: Test files account for over 60% of the current type-check errors (142 of 223). Tests using Node.js globals (`global`, `require`, `process`, `__dirname`) currently fail type-checking because the TypeScript configuration does not recognize these identifiers.

**Independent Test**: Run `npm run type-check` and verify that no errors originate from files matching `**/__tests__/**` or `**/*.test.ts` patterns.

**Acceptance Scenarios**:

1. **Given** test files that reference Node.js globals such as `global`, `process`, `require`, and `__dirname`, **When** type-checking runs, **Then** these identifiers are recognized and no TS2304 or TS2591 errors are produced.
2. **Given** test utility files (e.g., setup files, mock utilities), **When** type-checking runs, **Then** they pass without errors.

---

### User Story 3 - Production Source Files Type-Check Correctly (Priority: P1)

As a developer, I want all production source files to pass type-checking so that the codebase maintains strong type safety guarantees and catches bugs at compile time rather than runtime.

**Why this priority**: Production files have errors related to missing module declarations, implicit `any` types, and null safety. These represent real type safety gaps that could lead to runtime bugs.

**Independent Test**: Run `npm run type-check` and verify that no errors originate from non-test source files.

**Acceptance Scenarios**:

1. **Given** source files that import from external packages (Tauri APIs, MCP SDK, A2A SDK, Google GenAI), **When** type-checking runs, **Then** module imports resolve without TS2307 errors.
2. **Given** callback parameters in production code that currently lack type annotations, **When** type-checking runs, **Then** no TS7006 implicit `any` errors are reported.
3. **Given** code that uses null-checked objects, **When** type-checking runs, **Then** no TS2531/TS2721 null safety errors are reported.

---

### Edge Cases

- What happens when external packages (e.g., Tauri APIs) are not installed as runtime dependencies? Type declarations must still be available for type-checking without requiring the actual packages.
- How does the fix handle the dual environment (browser for extension, Node.js for tests, Tauri for desktop)? The TypeScript configuration must support all three contexts without conflicts.
- What happens if a developer adds a new test file using Node.js globals? The configuration should automatically support this without per-file changes.
- What about `Error.captureStackTrace` which is a V8-specific API not part of standard TypeScript types?

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The `npm run type-check` command MUST complete with zero errors across all source and test files.
- **FR-002**: The TypeScript configuration MUST recognize Node.js global identifiers (`global`, `process`, `require`, `__dirname`) in test files and utility files that depend on them.
- **FR-003**: All external module imports MUST resolve during type-checking, either through installed type declarations or project-level type declaration files.
- **FR-004**: All callback parameters in production code MUST have explicit type annotations (no implicit `any`).
- **FR-005**: All null safety issues MUST be resolved with proper null checks or type assertions where the value is guaranteed to be non-null.
- **FR-006**: Fixes MUST NOT change runtime behavior of any existing code; changes should be limited to type annotations, type declarations, and TypeScript configuration.
- **FR-007**: Fixes MUST NOT disable or weaken existing strict type-checking rules (e.g., must not set `noImplicitAny: false` or `strict: false`).

### Key Entities

- **TypeScript Configuration**: The `tsconfig.json` file that controls which types are available and how type-checking behaves.
- **Type Declaration Files**: `.d.ts` files that provide type information for external modules that lack their own type declarations.
- **Error Categories**: The distinct groups of type errors (TS2304, TS2307, TS2591, TS7006, TS2347, TS2339, TS2531, TS2721, TS2345, TS2322) each requiring a specific resolution strategy.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: `npm run type-check` exits with code 0 and zero errors (down from 223 errors currently).
- **SC-002**: CI pipeline type-check step passes on the feature branch without any workarounds or skips.
- **SC-003**: All existing tests continue to pass (`npm test`) with no regressions introduced by type-related changes.
- **SC-004**: No strict TypeScript compiler options are weakened (the `strict: true` and `noImplicitAny: true` settings remain intact).

## Assumptions

- Node.js type definitions (`@types/node`) can be safely added to the project's development dependencies, as tests already run in a Node.js environment (Vitest/Jest).
- For external packages that are optional runtime dependencies (e.g., Tauri APIs used only in the desktop build), type-only declarations or ambient module declarations are an acceptable approach.
- The `Error.captureStackTrace` usage is intentional and should be supported via Node.js type definitions rather than removed.
- Adding `"node"` to the `types` array in `tsconfig.json` will not conflict with the existing `"chrome"`, `"vite/client"`, and `"svelte"` type definitions.
