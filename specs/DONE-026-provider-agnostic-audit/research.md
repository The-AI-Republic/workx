# Research: ResponseItem Provider-Agnostic Architecture Audit

**Date**: 2026-02-17
**Feature**: 026-provider-agnostic-audit

## Decision 1: Audit Scope - File Coverage

**Decision**: Audit ALL 48 files that reference ResponseItem, categorized by role.

**Rationale**: The clarification explicitly requires auditing all importers including client subclasses. A comprehensive grep found 48 files referencing ResponseItem across 7 categories: client classes (7), type definitions (4), session/state management (6), event processing (6), compaction services (5), core processing (5), storage/rollout (5), and 30+ test files.

**Alternatives Considered**:
- Audit only the 4 originally listed shared components → Rejected: too narrow, could miss violations
- Audit only non-client files → Rejected: clarification requires client consistency checks too

## Decision 2: Architectural Guard-Rail Test Approach

**Decision**: Create a dedicated architectural test file at `src/core/models/__tests__/provider-agnostic.architecture.test.ts` that programmatically verifies provider-agnostic boundaries.

**Rationale**: The project already has a `src/tests/contracts/` directory for architectural/contract tests AND a `src/core/models/__tests__/` directory with existing `.contract.test.ts` files. The models `__tests__` directory is the most relevant location since the boundary being tested is between ResponseItem (protocol) and ModelClient subclasses (models). Using `.architecture.test.ts` suffix distinguishes from existing `.contract.test.ts` files which validate Rust compliance.

**Alternatives Considered**:
- Place in `src/tests/contracts/` → Viable but less discoverable alongside the code being tested
- Add checks to existing test files → Rejected: architectural tests are a distinct concern
- Use a linter rule → Rejected: too rigid, can't capture nuanced patterns like opaque metadata

## Decision 3: Test Strategy for Client Consistency

**Decision**: Add conversion pattern consistency tests that verify each client subclass handles the same set of ResponseItem variants.

**Rationale**: With 7 client implementations across 2 inheritance chains (OpenAIResponsesClient tree and GoogleCompletionClient), there's risk of inconsistent handling. Tests should verify that each client either converts or explicitly skips each ResponseItem variant type rather than silently dropping data.

**Alternatives Considered**:
- Manual code review only → Rejected: doesn't prevent future regressions
- Abstract method enforcement → Rejected: over-engineering; the base class already defines the contract

## Decision 4: Test Framework & Patterns

**Decision**: Use Vitest 3.2.4 with existing project patterns.

**Rationale**: The project already uses Vitest with globals enabled, jsdom environment, and path aliases (`@/*`). Existing test patterns include fixtures in `fixtures/index.ts`, utilities in `utils.ts`, and the `vi.hoisted()`/`vi.mock()` pattern for module mocking. New tests should follow these established conventions.

**Alternatives Considered**:
- Jest → Rejected: project already standardized on Vitest
- Custom test runner → Rejected: unnecessary complexity

## Decision 5: Findings Documentation Format

**Decision**: Document audit findings as inline comments in the architectural test file plus a summary in `research.md` (this file).

**Rationale**: The tests themselves serve as living documentation of the architectural boundaries. Each test case documents what was checked and whether it passes, making the audit findings executable and verifiable on every CI run. This file captures the one-time research context.

**Alternatives Considered**:
- Separate audit-report.md → Rejected: would become stale; tests are the living report
- Inline comments in source files → Rejected: pollutes production code

## Audit Findings Summary

### ResponseItem Type Definition (`src/core/protocol/types.ts`)

**Status: CLEAN** - Zero provider-specific imports. All field names are generic. The `thoughtSignature` field on tool_calls is opaque metadata (string type, no provider logic).

### Non-Client Files Importing ResponseItem (27 files)

**Status: CLEAN** - All shared components, session management, event processing, compaction, and storage files operate on generic ResponseItem types without provider-specific branching. No provider SDK imports found outside of client classes.

Key files verified:
- `PromptHelpers.ts` - Generic input formatting only
- `EventMapping.ts` - Handles all ResponseItem variants generically
- `CompactService.ts` - Generic history compaction
- `TurnManager.ts` - Generic turn processing
- `SessionState.ts` - Generic state storage
- `SnapshotCompressor.ts` - Generic compression
- `TaskRunner.ts` - Generic task execution
- `AgentTask.ts` - Uses `getResponseItemContent()` helper (generic)
- `TitleGenerator.ts` - Generic title extraction
- `storage/rollout/*` - Generic persistence

### Client Classes (7 files)

**Status: PROPERLY ISOLATED** - All provider-specific logic is contained within client boundaries.

| Client | Provider SDK | Conversion Contained? | Notes |
|--------|-------------|----------------------|-------|
| OpenAIResponsesClient | `openai` | Yes | Base for OpenAI-compatible providers. Azure/xAI detection in-class |
| OpenAIChatCompletionClient | `openai` | Yes | Chat Completions format conversion in-class |
| GoogleCompletionClient | `@google/genai` | Yes | Gemini format conversion + thoughtSignature in-class |
| GroqClient | (inherits `openai`) | Yes | Omits unsupported params, custom reasoning format in-class |
| FireworksClient | (inherits `openai`) | Yes | Similar to Groq pattern |
| FireworksChatCompletionClient | (inherits `openai`) | Yes | Extends Chat Completions |
| TogetherChatCompletionClient | (inherits `openai`) | Yes | Handles `delta.reasoning` + special token parsing in-class |

### Potential Improvement Areas

1. **No existing architectural tests** - The provider-agnostic boundary is not enforced by tests. This is the primary gap this spec addresses.
2. **Client conversion consistency** - No tests verify that all clients handle the same ResponseItem variants. Some clients may silently drop unsupported variants.
3. **`thoughtSignature` documentation** - While acceptable as opaque metadata, the field lacks a code comment explaining its cross-provider nature.
