# Quickstart: ResponseItem Provider-Agnostic Architecture Audit

**Feature**: 026-provider-agnostic-audit
**Date**: 2026-02-17

## Prerequisites

- Node.js with npm
- Project dependencies installed (`npm install`)

## Quick Verification

Run existing tests to confirm baseline:

```bash
npm test -- --run
```

## What This Feature Produces

1. **Architectural guard-rail tests** at `src/core/models/__tests__/provider-agnostic.architecture.test.ts`
2. **Any code fixes** if violations are discovered during audit
3. **Documented findings** in `specs/026-provider-agnostic-audit/research.md`

## Key Files to Understand

| File | Purpose |
|------|---------|
| `src/core/protocol/types.ts` | ResponseItem type definition (must stay provider-agnostic) |
| `src/core/models/client/*.ts` | Client classes (provider-specific logic belongs here) |
| `src/core/models/ModelClient.ts` | Abstract base class defining the conversion boundary |
| `src/core/models/ModelClientFactory.ts` | Factory for creating provider-specific clients |
| `src/core/events/EventMapping.ts` | ResponseItem to UI events (must stay generic) |
| `src/core/models/PromptHelpers.ts` | Input formatting (must stay generic) |

## Running the New Tests

After implementation:

```bash
# Run only the architectural tests
npm test -- --run src/core/models/__tests__/provider-agnostic.architecture.test.ts

# Run all tests to confirm no regressions
npm test -- --run
```

## Architecture Boundary Rules

1. **ResponseItem** (`src/core/protocol/types.ts`) must NEVER import from provider SDKs
2. **Non-client files** must NEVER contain provider-specific branching logic
3. **Client classes** are the ONLY files allowed to import provider SDKs and contain provider-specific conversions
4. **EventMapping, PromptHelpers, CompactService, TurnManager** must work with generic ResponseItem only
