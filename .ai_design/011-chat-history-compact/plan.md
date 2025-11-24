# Implementation Plan: Chat History Compaction

**Branch**: `011-chat-history-compact` | **Date**: 2025-11-22 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/011-chat-history-compact/spec.md`

## Summary

Implement LLM-based chat history compaction for browserx to prevent context window overflow during long conversations. When token usage reaches 90% of model context window (or on manual trigger), the system will:
1. Generate an LLM summary of the conversation (progress, decisions, constraints, next steps)
2. Preserve recent user messages (up to 20k tokens)
3. Reconstruct history as: initial context + preserved user messages + summary
4. Notify user and log the compaction event

Approach follows Codex's compact.rs pattern: LLM-based summarization with summary prefix identification to prevent re-summarizing.

## Technical Context

**Language/Version**: TypeScript 5.9.2 (ES2020 target)
**Primary Dependencies**: Svelte 4.2.20, Vite 5.4.20, Chrome Extension APIs, OpenAI SDK, Zod 3.23.8
**Storage**: Chrome Storage API (chrome.storage.local) for session state; in-memory for conversation history
**Testing**: Vitest (existing test infrastructure in tests/)
**Target Platform**: Chrome Extension (Manifest V3)
**Project Type**: Single project (Chrome extension with service worker + sidepanel)
**Performance Goals**: Compaction completes within 30 seconds; summary generation uses same model as conversation
**Constraints**: Must work within Chrome extension service worker lifecycle; streaming API responses
**Scale/Scope**: Single user per extension instance; conversations up to model context window limit

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

The constitution file contains placeholder templates - no specific principles are defined. Proceeding with standard best practices:

- ✅ No new external dependencies required (uses existing OpenAI SDK)
- ✅ Feature is self-contained within existing architecture
- ✅ Test coverage will follow existing patterns in tests/
- ✅ No breaking changes to existing APIs

## Project Structure

### Documentation (this feature)

```text
specs/011-chat-history-compact/
├── plan.md              # This file
├── research.md          # Phase 0: Codex patterns, token counting, retry strategies
├── data-model.md        # Phase 1: CompactionConfig, CompactedHistory types
├── quickstart.md        # Phase 1: Integration guide
├── contracts/           # Phase 1: Internal interfaces
└── tasks.md             # Phase 2: Implementation tasks (created by /speckit.tasks)
```

### Source Code (repository root)

```text
src/
├── core/
│   ├── Session.ts                    # History management (existing)
│   ├── TaskRunner.ts                 # Turn execution, compaction trigger (existing)
│   ├── compact/                      # NEW: Compaction module
│   │   ├── CompactService.ts         # Main compaction orchestration
│   │   ├── SummaryGenerator.ts       # LLM summary generation
│   │   ├── HistoryReconstructor.ts   # Build compacted history
│   │   ├── types.ts                  # CompactionConfig, CompactedHistory
│   │   └── constants.ts              # Prompts, prefixes, defaults
│   └── session/
│       └── state/
│           └── SessionState.ts       # State container (existing, minor updates)
├── models/
│   └── client/
│       └── OpenAIResponsesClient.ts  # API client (existing, reuse for summary)
├── sidepanel/
│   └── App.svelte                    # UI notifications (existing, add compact trigger)
└── protocol/
    └── types.ts                      # Message types (existing)

tests/
├── unit/
│   └── compact/                      # NEW: Unit tests for compaction
│       ├── CompactService.test.ts
│       ├── SummaryGenerator.test.ts
│       └── HistoryReconstructor.test.ts
└── integration/
    └── compact.integration.test.ts   # NEW: End-to-end compaction test
```

**Structure Decision**: Follows existing browserx architecture. New compaction logic isolated in `src/core/compact/` module to maintain separation of concerns. Integrates with existing `Session`, `TaskRunner`, and `OpenAIResponsesClient` classes.

## Complexity Tracking

No constitution violations identified. Feature follows existing patterns:
- Reuses existing LLM client infrastructure
- Follows existing message/history types
- Integrates with existing session state management
