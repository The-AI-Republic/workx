# Implementation Plan: Visual Effect Clearing Communication Debug

**Branch**: `009-debug-visual-effect-clear` | **Date**: 2025-11-12 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/009-debug-visual-effect-clear/spec.md`

**Note**: This template is filled in by the `/speckit.plan` command. See `.specify/templates/commands/plan.md` for the execution workflow.

## Summary

Debug and fix the message delivery system preventing visual effects from clearing when BrowserAgent tasks complete. The system needs to successfully deliver TaskComplete, TaskFailed, and TurnAborted events from the service worker background script to VisualEffectController content scripts running in tabs, triggering the handleAgentStop() cleanup function. The technical approach involves comprehensive diagnostic logging throughout the message chain, verification of content script lifecycle, and analysis of the Chrome extension messaging API behavior.

## Technical Context

**Language/Version**: TypeScript 5.9.2 (ES2020 target), Svelte 4.2.20
**Primary Dependencies**: Chrome Extension APIs (chrome.runtime, chrome.tabs), Vite 5.4.20
**Storage**: N/A (in-memory message passing only)
**Testing**: Manual testing with Chrome DevTools console, existing test suite (npm test)
**Target Platform**: Chrome Extension Manifest V3 (service worker + content scripts)
**Project Type**: Chrome extension (background service worker + content script architecture)
**Performance Goals**: <500ms visual effect clearing after task completion, <100ms message delivery latency
**Constraints**: Chrome extension messaging limitations (no direct tab-to-tab communication, content scripts must be injectable), CSP-restricted pages may block content script injection
**Scale/Scope**: Support 10+ simultaneous tabs with active content scripts, handle rapid task completion events without message queue overflow

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

**Status**: PASS (No constitution file found - proceeding with general best practices)

This is a debugging/diagnostic feature that:
- Does not introduce new architecture patterns
- Enhances existing message delivery system with logging
- Follows existing Chrome extension messaging conventions
- No new dependencies or storage requirements
- Aligns with existing codebase structure (src/core/, src/content/)

## Project Structure

### Documentation (this feature)

```text
specs/[###-feature]/
├── plan.md              # This file (/speckit.plan command output)
├── research.md          # Phase 0 output (/speckit.plan command)
├── data-model.md        # Phase 1 output (/speckit.plan command)
├── quickstart.md        # Phase 1 output (/speckit.plan command)
├── contracts/           # Phase 1 output (/speckit.plan command)
└── tasks.md             # Phase 2 output (/speckit.tasks command - NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
src/
├── background/
│   └── service-worker.ts           # EVENT message broadcast logic (lines 197-230)
├── core/
│   ├── BrowserxAgent.ts             # Event emission source (lines 639-661)
│   └── MessageRouter.ts             # Message routing infrastructure (lines 119-641)
├── content/
│   └── ui_effect/
│       └── VisualEffectController.svelte  # Message receiver + visual effects (lines 296-364)
└── protocol/
    ├── types.ts                     # Event and message type definitions
    └── events.ts                    # EventMsg type definitions

tests/
└── (existing test structure - no new tests required for debugging)
```

**Structure Decision**: Chrome extension architecture with service worker background script and content scripts. This debugging feature enhances existing files without adding new modules. All changes are in-place modifications to add diagnostic logging and fix message delivery bugs.

## Complexity Tracking

> **Fill ONLY if Constitution Check has violations that must be justified**

N/A - No violations detected. This is a debugging enhancement to existing code.

---

## Phase 0: Research (COMPLETE)

**Status**: ✅ COMPLETE
**Output**: [research.md](./research.md)

### Key Findings

1. **Root Cause Identified**: Race condition in listener registration
   - `chrome.runtime.onMessage.addListener()` registered inside Svelte `onMount()`
   - Messages arriving before component mounts are lost
   - **Solution**: Hoist listener to top-level content script code

2. **Tab Filtering Required**: Broadcasting to restricted pages generates errors
   - chrome:// and chrome-extension:// pages cannot receive content script messages
   - **Solution**: Filter tabs by URL before sending

3. **Bridge Pattern Recommended**: Decouple message handling from visual effects
   - Content script receives chrome.runtime messages (always available)
   - Content script dispatches DOM custom events (fire-and-forget)
   - VisualEffectController listens to DOM events (lazy initialization)
   - **Benefit**: No race conditions, clean separation of concerns

4. **Diagnostic Logging Strategy**: Structured logging with context tags
   - Use `[Context] $$$` pattern for easy filtering in DevTools
   - Log at each stage: emission → receipt → broadcast → delivery → handler
   - Include timestamp, tabId, eventType for correlation

### Research Topics Covered

- Chrome Extension Messaging Patterns (ping-pong verification, error handling)
- Service Worker to Content Script Communication (broadcasting, tab filtering)
- Content Script Lifecycle (listener registration timing, race conditions)
- Diagnostic Logging Best Practices (structured logging, console filtering)

---

## Phase 1: Design (COMPLETE)

**Status**: ✅ COMPLETE
**Outputs**:
- [data-model.md](./data-model.md) - Message structure definitions
- [contracts/message-contracts.md](./contracts/message-contracts.md) - API contracts
- [quickstart.md](./quickstart.md) - Developer guide and testing instructions
- CLAUDE.md updated with new technologies

### Design Decisions

1. **Message Structure** (data-model.md):
   - TaskLifecycleEvent: Ephemeral events (TaskComplete, TaskFailed, TurnAborted)
   - ExtensionMessage: EVENT wrapper for chrome.tabs.sendMessage
   - MessageDeliveryLog: Diagnostic logging structure
   - No persistent storage - all in-memory message passing

2. **API Contracts** (contracts/message-contracts.md):
   - EVENT Message: Service Worker → Content Script via chrome.tabs.sendMessage
   - PING/PONG: Bidirectional verification for readiness checks
   - DOM Custom Event: Content Script → VisualEffectController via document.dispatchEvent
   - Versioning policy for breaking changes (add version field)

3. **Implementation Strategy** (quickstart.md):
   - Phase 1: Hoist listener registration (CRITICAL - fixes race condition)
   - Phase 2: Tab filtering (IMPORTANT - reduces console errors)
   - Phase 3: Verification (OPTIONAL - ping-pong readiness checks)

### Files Modified (In Implementation Phase)

- `src/content/content-script.ts` - NEW FILE (top-level listener registration)
- `src/content/ui_effect/VisualEffectController.svelte` - MODIFIED (DOM event listener)
- `src/background/service-worker.ts` - MODIFIED (tab filtering)

### Constitution Re-Check

**Status**: PASS

- No new architecture patterns introduced
- No new dependencies added
- Follows existing Chrome extension messaging conventions
- Enhances existing codebase with debugging features
- All changes are in-place modifications or single new file

---

## Phase 2: Tasks (PENDING)

**Status**: ⏳ NOT STARTED
**Command**: Run `/speckit.tasks` to generate tasks.md

This phase will generate actionable, dependency-ordered tasks based on the design artifacts created in Phase 0 and Phase 1.

---

## Completion Summary

### Artifacts Generated

✅ **spec.md** - Feature specification with user stories and success criteria
✅ **plan.md** - This file (implementation plan with technical context)
✅ **research.md** - Chrome extension messaging research and root cause analysis
✅ **data-model.md** - Message structure definitions and relationships
✅ **contracts/message-contracts.md** - API contracts for message passing
✅ **quickstart.md** - Developer guide and testing instructions
✅ **CLAUDE.md** - Updated with new technologies (TypeScript, Chrome APIs, Svelte)

### Ready for Implementation

The planning phase is complete. All design decisions are documented and ready for `/speckit.tasks` command to generate the task breakdown.

**Next Step**: Run `/speckit.tasks` to generate dependency-ordered implementation tasks.
