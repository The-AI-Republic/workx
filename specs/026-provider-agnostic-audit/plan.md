# Implementation Plan: ResponseItem Provider-Agnostic Architecture Audit

**Branch**: `026-provider-agnostic-audit` | **Date**: 2026-02-17 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/026-provider-agnostic-audit/spec.md`

## Summary

Audit the ResponseItem architecture to verify it remains provider-agnostic, with all provider-specific conversion logic properly isolated in ModelClient subclasses. The audit covers all 48 files that reference ResponseItem, implements fixes for any violations found, and adds architectural guard-rail tests to prevent future regressions. Research confirms the architecture is currently clean - the primary deliverable is the guard-rail test suite.

## Technical Context

**Language/Version**: TypeScript 5.9.2
**Primary Dependencies**: Vitest 3.2.4, openai SDK, @google/genai SDK
**Storage**: N/A (audit feature)
**Testing**: Vitest with globals, jsdom environment, v8 coverage
**Target Platform**: Node.js / Browser extension
**Project Type**: Single project with browser extension
**Performance Goals**: N/A (audit feature)
**Constraints**: Tests must run in CI, no external API calls
**Scale/Scope**: 48 files reference ResponseItem, 7 client implementations, 30+ test files

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Constitution is unconfigured (template placeholders only). No gates to enforce. Proceeding.

## Project Structure

### Documentation (this feature)

```text
specs/026-provider-agnostic-audit/
├── plan.md              # This file
├── research.md          # Phase 0 output - audit findings
├── data-model.md        # Phase 1 output - entity model documentation
├── quickstart.md        # Phase 1 output - getting started guide
├── contracts/           # Phase 1 output - boundary rules
│   └── provider-agnostic-boundary.ts
└── tasks.md             # Phase 2 output (/rr.tasks command)
```

### Source Code (repository root)

```text
src/
├── core/
│   ├── protocol/
│   │   └── types.ts                    # ResponseItem definition (AUDIT TARGET)
│   ├── models/
│   │   ├── client/                     # Provider-specific clients (7 files)
│   │   │   ├── OpenAIResponsesClient.ts
│   │   │   ├── OpenAIChatCompletionClient.ts
│   │   │   ├── GoogleCompletionClient.ts
│   │   │   ├── GroqClient.ts
│   │   │   ├── FireworksClient.ts
│   │   │   ├── FireworksChatCompletionClient.ts
│   │   │   └── TogetherChatCompletionClient.ts
│   │   ├── __tests__/
│   │   │   └── provider-agnostic.architecture.test.ts  # NEW: guard-rail tests
│   │   ├── ModelClient.ts              # Abstract base class
│   │   ├── ModelClientFactory.ts       # Factory
│   │   └── PromptHelpers.ts            # Shared (AUDIT TARGET)
│   ├── events/
│   │   └── EventMapping.ts             # Shared (AUDIT TARGET)
│   ├── compact/
│   │   └── CompactService.ts           # Shared (AUDIT TARGET)
│   ├── TurnManager.ts                  # Shared (AUDIT TARGET)
│   ├── TaskRunner.ts                   # Shared (AUDIT TARGET)
│   ├── AgentTask.ts                    # Shared (AUDIT TARGET)
│   ├── Session.ts                      # Shared (AUDIT TARGET)
│   ├── session/state/
│   │   ├── SessionState.ts             # Shared (AUDIT TARGET)
│   │   └── SnapshotCompressor.ts       # Shared (AUDIT TARGET)
│   └── title/
│       └── TitleGenerator.ts           # Shared (AUDIT TARGET)
└── storage/
    └── rollout/                        # Shared (AUDIT TARGET)
```

**Structure Decision**: No new directories needed. The single new test file goes in the existing `src/core/models/__tests__/` directory following the `.architecture.test.ts` naming convention.

## Implementation Approach

### Phase 1: Audit Execution

Systematically verify each file category:

1. **ResponseItem type definition** (`types.ts`) - Verify zero provider SDK imports, all generic field names
2. **Shared components** (17 non-client files) - Verify zero provider-specific branching or imports
3. **Client classes** (7 files) - Verify all provider logic is self-contained, conversion patterns are consistent

### Phase 2: Fix Violations (if any)

Based on research, the architecture is currently clean. If violations are discovered during formal audit:
- Move provider-specific logic into the appropriate client class
- Replace provider-specific field names with generic alternatives
- Ensure opaque metadata fields remain passthrough-only

### Phase 3: Guard-Rail Tests

Create `src/core/models/__tests__/provider-agnostic.architecture.test.ts` with these test groups:

1. **ResponseItem Import Boundary** - Programmatically read `types.ts` and assert no provider SDK imports
2. **Shared Component Isolation** - For each non-client file importing ResponseItem, assert no provider SDK imports or provider name string checks
3. **Client Containment** - Assert provider SDK imports exist ONLY in `src/core/models/client/` directory
4. **Field Neutrality** - Assert ResponseItem field names contain no provider-specific prefixes/suffixes

### Test Patterns

Follow existing project conventions:
- Vitest with globals (describe/it/expect available without import)
- Use `fs.readFileSync` to read source files for static analysis tests
- Use path aliases (`@/*`) where applicable
- Follow `.architecture.test.ts` suffix convention (new, alongside existing `.contract.test.ts`)

## Complexity Tracking

No constitution violations to justify - constitution is unconfigured.
