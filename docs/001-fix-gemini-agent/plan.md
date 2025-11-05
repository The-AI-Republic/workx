# Implementation Plan: Fix Gemini Agent Integration

**Branch**: `001-fix-gemini-agent` | **Date**: 2025-11-04 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/001-fix-gemini-agent/spec.md`

## Summary

Fix critical bugs in Gemini provider integration that prevent proper text responses and tool call execution. The current implementation prematurely terminates agent turns, showing "Task completed in 1 turn(s)" without displaying agent responses or completing function calls. Root cause is incorrect streaming response event conversion and completion signal handling in the OpenAI compatibility layer.

**Technical Approach**: Debug and fix the `convertChatCompletionEventToResponseEvent()` method in `OpenAIResponsesClient` to properly accumulate streaming deltas, emit text content events, and correctly signal completion only when assistant messages with content (and no pending tool calls) are received. Add comprehensive trace logging for Gemini-specific streaming paths.

## Technical Context

**Language/Version**: TypeScript 5.x with ES2020 target
**Primary Dependencies**:
- OpenAI SDK (official client for Chat Completions API)
- Vite (build tool)
- Vitest (testing framework)
- Svelte 3.x (UI components)

**Storage**: Chrome Extension local storage (chrome.storage.local), IndexedDB for conversation history
**Testing**: Vitest for unit and integration tests
**Target Platform**: Chrome Extension (Manifest V3), requires Chrome browser environment
**Project Type**: Browser extension with background service worker and sidepanel UI
**Performance Goals**:
- Text responses visible within 2 seconds (SC-001)
- Streaming text updates appear incrementally (SC-005)
- Tool call execution at 95% success rate (SC-003)

**Constraints**:
- Must maintain backward compatibility with OpenAI and Anthropic providers
- Isolated changes to Gemini-specific code paths only
- No modifications to TurnManager/TaskRunner core logic
- Trace logging must be gated to avoid production performance impact

**Scale/Scope**:
- Single provider integration fix
- ~4-6 files modified (OpenAIResponsesClient, ModelClientFactory, logging utilities)
- Affects streaming event pipeline and completion detection

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

**Note**: No project constitution file exists yet (template only). Proceeding with standard software engineering best practices:

- **Backward Compatibility**: ✅ Required - changes isolated to Gemini provider paths
- **Test Coverage**: ✅ Required - unit tests for streaming event conversion, integration tests for agent flows
- **Code Quality**: ✅ Required - TypeScript strict mode, existing ESLint rules
- **Documentation**: ✅ Required - inline comments for complex streaming logic, update existing Gemini notes

**Complexity Justification**: None required - this is a bug fix within existing architecture, not adding new complexity.

## Project Structure

### Documentation (this feature)

```text
specs/001-fix-gemini-agent/
├── plan.md              # This file
├── research.md          # Phase 0: Root cause analysis and streaming event flow
├── data-model.md        # Phase 1: Event state machines and data structures
├── quickstart.md        # Phase 1: Testing and validation guide
├── contracts/           # Phase 1: Event conversion contracts
│   └── streaming-events.yaml
└── checklists/
    └── requirements.md  # Quality validation checklist
```

### Source Code (repository root)

```text
src/
├── models/                       # Model client implementations
│   ├── OpenAIResponsesClient.ts  # PRIMARY FIX LOCATION - streaming event conversion
│   ├── ModelClientFactory.ts     # Gemini provider configuration
│   ├── ResponseStream.ts         # Stream processing utilities
│   ├── types/
│   │   └── ResponsesAPI.ts       # Event type definitions
│   └── SSEEventParser.ts         # Server-sent event parsing
│
├── core/                         # Agent execution logic
│   ├── TurnManager.ts            # Turn execution and event handling (READ ONLY)
│   ├── TaskRunner.ts             # Agent loop and completion logic (READ ONLY)
│   └── BrowserxAgent.ts          # Top-level orchestration (READ ONLY)
│
├── utils/                        # Utilities
│   └── logger.ts                 # Add trace-level Gemini logging
│
└── config/
    └── defaults.ts               # Gemini provider configuration (MAY UPDATE)

tests/
├── unit/
│   └── models/
│       └── OpenAIResponsesClient.test.ts  # NEW - streaming event tests
└── integration/
    └── gemini-agent-flow.test.ts          # NEW - end-to-end agent tests
```

**Structure Decision**: Chrome extension with TypeScript, following existing `src/` structure. Core fix is in `src/models/OpenAIResponsesClient.ts` where Gemini responses are converted to internal events. No new directories needed - working within established architecture.

## Complexity Tracking

> No violations - this is a bug fix within existing complexity budget.

---

## Phase 0: Research & Root Cause Analysis

### Objectives

1. Understand the exact streaming event flow for Gemini vs OpenAI/Anthropic
2. Identify where text content events are being dropped or not emitted
3. Determine why completion signals are sent prematurely
4. Document tool call accumulation behavior across streaming chunks
5. Establish best practices for OpenAI Chat Completions streaming

### Research Tasks

#### Task 0.1: Analyze Current Streaming Event Conversion

**Goal**: Understand how `convertChatCompletionEventToResponseEvent()` currently handles Gemini streaming chunks

**Investigation Areas**:
- Read lines 639-759 of `src/models/OpenAIResponsesClient.ts`
- Trace how `delta.content` is converted to `OutputTextDelta` events
- Identify when `OutputItemDone` events are emitted
- Check when `Completed` events are sent
- Document current tool call accumulation logic (lines 669-705)

**Expected Findings**:
- Text deltas may be accumulated but not emitted as events
- `OutputItemDone` might be emitted without message content
- Tool call accumulation waits for `finish_reason` but may not properly construct message items

#### Task 0.2: Compare Gemini vs OpenAI Streaming Response Formats

**Goal**: Document differences in streaming chunk structures between providers

**Investigation Areas**:
- Review OpenAI Chat Completions streaming documentation
- Review Gemini OpenAI compatibility documentation (already fetched)
- Compare actual streaming chunk payloads (enable debug logging and test)
- Identify any Gemini-specific quirks in chunk ordering or field presence

**Expected Findings**:
- Gemini may send tool call deltas differently than OpenAI
- `finish_reason` timing may differ
- Content chunks may be structured differently

#### Task 0.3: Trace Agent Loop Completion Logic

**Goal**: Understand how TurnManager and TaskRunner determine task completion

**Investigation Areas**:
- Read `src/core/TurnManager.ts` lines 165-278 (turn execution)
- Read `src/core/TaskRunner.ts` lines 542-619 (termination conditions)
- Identify what events trigger `taskComplete = true`
- Document how `OutputItemDone` events with empty content are handled

**Expected Findings**:
- Agent loop expects `OutputItemDone` with message content
- Missing text content causes immediate task completion
- Tool calls without subsequent turns cause premature exit

#### Task 0.4: Review OpenAI SDK Streaming Best Practices

**Goal**: Ensure we're using the OpenAI SDK correctly for streaming

**Investigation Areas**:
- Review OpenAI SDK documentation for `chat.completions.create({ stream: true })`
- Check how to properly iterate chunks and access deltas
- Understand when streaming is "complete" vs when response is "done"
- Identify any SDK-specific gotchas for tool calling in streams

**Expected Findings**:
- Proper iteration patterns for async streaming
- When to emit events vs when to accumulate
- How to detect end of tool call vs end of turn

### Research Deliverable

**File**: `specs/001-fix-gemini-agent/research.md`

**Structure**:
```markdown
# Research: Gemini Streaming Event Bug Root Cause

## Current Behavior Analysis

### Streaming Event Flow (Current)
[Detailed flow diagram of current implementation]

### Identified Issues
1. Issue: Text deltas not emitted
   - Location: Line X in file Y
   - Evidence: [code snippet]

2. Issue: Premature completion signals
   - Location: Line X in file Y
   - Evidence: [code snippet]

## Provider Comparison

### OpenAI Streaming Format
[Example chunks]

### Gemini Streaming Format
[Example chunks]

### Key Differences
[Table of differences]

## Root Cause Summary

### Bug 1: Missing Text Responses
- **Root Cause**: [specific code issue]
- **Why It Happens**: [explanation]
- **Fix Approach**: [solution]

### Bug 2: Incomplete Tool Calls
- **Root Cause**: [specific code issue]
- **Why It Happens**: [explanation]
- **Fix Approach**: [solution]

## Solution Strategy

### Decision 1: Text Event Emission
- **Chosen Approach**: [description]
- **Rationale**: [why this works]
- **Alternatives Rejected**: [what else was considered]

### Decision 2: Completion Detection
- **Chosen Approach**: [description]
- **Rationale**: [why this works]
- **Alternatives Rejected**: [what else was considered]

### Decision 3: Logging Strategy
- **Chosen Approach**: Trace-level logging gated by env var
- **Rationale**: Comprehensive debugging without production performance impact
- **Implementation**: Logger utility with GEMINI_DEBUG flag
```

---

## Phase 1: Design & Contracts

### Objectives

1. Define the corrected streaming event state machine
2. Specify event conversion contracts for all Gemini chunk types
3. Design trace logging structure
4. Create data models for enhanced tool call accumulation
5. Document testing approach

### Design Artifacts

#### Artifact 1.1: Data Model

**File**: `specs/001-fix-gemini-agent/data-model.md`

**Content**:
```markdown
# Data Model: Streaming Event Processing

## Event State Machine

### States
1. **Streaming**: Accumulating chunks
2. **ContentReady**: Text or tool calls accumulated
3. **TurnComplete**: All deltas processed
4. **TaskComplete**: Agent finished

### Transitions
[State diagram with trigger conditions]

## Entities

### ToolCallAccumulator (Enhanced)
- **Purpose**: Incrementally build tool calls from streaming chunks
- **Fields**:
  - `index: number` - Tool call position in array
  - `id: string | null` - Tool call ID (set on first chunk)
  - `function.name: string` - Accumulated function name
  - `function.arguments: string` - Accumulated JSON arguments
  - `isComplete: boolean` - Whether all chunks received
- **State**: Mutable map indexed by tool call index
- **Lifecycle**: Reset at start of turn, built during streaming, finalized at finish_reason

### StreamingTextBuffer (New)
- **Purpose**: Track emitted text to avoid duplicate events
- **Fields**:
  - `emittedLength: number` - Characters already sent as deltas
  - `totalContent: string` - Complete accumulated text
- **Operations**:
  - `appendDelta(text)` - Add new text and emit delta event
  - `reset()` - Clear for next turn

### GeminiStreamContext (New)
- **Purpose**: Track Gemini-specific streaming state
- **Fields**:
  - `hasContent: boolean` - Whether any text was emitted
  - `hasToolCalls: boolean` - Whether tool calls are present
  - `finishReason: string | null` - Completion reason
  - `turnNumber: number` - Current turn in conversation
- **Validation**:
  - Must have content OR tool calls before completion
  - Cannot complete with finish_reason='stop' and no content

## Validation Rules

### Pre-Completion Checks
1. If `finish_reason='stop'` → MUST have `hasContent=true` OR `hasToolCalls=true`
2. If `hasToolCalls=true` → MUST emit `OutputItemDone` with function_call type
3. If `hasContent=true` → MUST emit `OutputItemDone` with message type
4. Empty responses → ERROR (log warning, don't emit completion)

### Tool Call Validation
1. All tool calls MUST have non-empty `function.name`
2. Arguments MUST be valid JSON or empty string
3. ID MUST be present before emitting tool call item
```

#### Artifact 1.2: API Contracts

**File**: `specs/001-fix-gemini-agent/contracts/streaming-events.yaml`

**Content**: OpenAPI-style contract for event conversion
```yaml
# Contract: convertChatCompletionEventToResponseEvent()
#
# Input: OpenAI Chat Completion streaming chunk
# Output: ResponseEvent (internal format)

schemas:
  ChatCompletionChunk:
    type: object
    properties:
      id: string
      choices:
        type: array
        items:
          properties:
            index: number
            delta:
              oneOf:
                - type: object  # Text delta
                  properties:
                    content: string
                - type: object  # Tool call delta
                  properties:
                    tool_calls:
                      type: array
                      items:
                        properties:
                          index: number
                          id: string
                          function:
                            properties:
                              name: string
                              arguments: string
            finish_reason:
              enum: [stop, tool_calls, length, null]

  ResponseEvent:
    oneOf:
      - type: OutputTextDelta
        properties:
          type: "OutputTextDelta"
          delta: string

      - type: OutputItemDone
        properties:
          type: "OutputItemDone"
          item:
            oneOf:
              - type: message
                role: assistant
                content: string
              - type: function_call
                name: string
                arguments: object
                call_id: string

      - type: Completed
        properties:
          type: "Completed"
          tokenUsage: TokenUsage

conversions:
  text_delta_to_event:
    input: delta.content (non-empty string)
    output:
      type: OutputTextDelta
      delta: delta.content
    emit: IMMEDIATE (don't accumulate)

  tool_call_delta_to_accumulator:
    input: delta.tool_calls[]
    output: Update ToolCallAccumulator state
    emit: NONE (wait for finish_reason)

  finish_reason_to_events:
    input: finish_reason = "stop"
    conditions:
      - IF hasContent: emit OutputItemDone(message) then Completed
      - IF hasToolCalls: emit OutputItemDone(function_call[]) then Completed
      - IF neither: ERROR - log and skip completion

    input: finish_reason = "tool_calls"
    output: emit OutputItemDone(function_call[]) then continue
    note: DO NOT emit Completed - agent loop continues
```

#### Artifact 1.3: Quickstart Guide

**File**: `specs/001-fix-gemini-agent/quickstart.md`

**Content**: Testing and validation guide
```markdown
# Testing Guide: Gemini Agent Fix

## Prerequisites
- Chrome browser
- Valid Google AI Studio API key
- Extension loaded in developer mode

## Unit Testing

### Test Streaming Event Conversion
```bash
npm test -- OpenAIResponsesClient.test.ts
```

**Key Test Cases**:
1. Text delta emission (immediate, not accumulated)
2. Tool call accumulation across chunks
3. Completion with text content
4. Completion with tool calls
5. Empty response handling
6. Mixed content + tool calls

### Expected Results
- All tests pass
- Coverage > 90% for modified functions

## Integration Testing

### Test 1: Basic Text Response
1. Configure extension with Gemini provider
2. Send message: "hi"
3. **Expected**: Visible greeting response in < 2s
4. **Expected**: Streaming text appears incrementally
5. **Expected**: Turn completes with response content shown

### Test 2: Tool Call Execution
1. Send message: "click the login button"
2. **Expected**: Tool call emitted and executed
3. **Expected**: Agent processes tool result
4. **Expected**: Final response summarizing action

### Test 3: Multi-Turn Workflow
1. Send message: "navigate to example.com and click search"
2. **Expected**: Multiple turns execute
3. **Expected**: Context maintained across turns
4. **Expected**: Final completion only after all steps done

## Debug Logging

### Enable Trace Logging
```bash
export GEMINI_DEBUG=true
```

### Log Output Format
```
[Gemini] Stream chunk received: {"id":"...","choices":[...]}
[Gemini] Text delta emitted: "Hello"
[Gemini] Tool call accumulated: function=search, args={"query":"..."}
[Gemini] Finish reason: stop, hasContent=true, hasToolCalls=false
[Gemini] Emitting OutputItemDone: message
[Gemini] Emitting Completed
```

## Validation Checklist

- [ ] Text responses appear for simple messages
- [ ] No "Task completed in 1 turn(s)" without visible output
- [ ] Tool calls execute and return results
- [ ] Multi-turn workflows complete successfully
- [ ] Streaming text is progressive (not batched)
- [ ] Completion only occurs when appropriate
- [ ] Trace logs show correct event flow (when enabled)
```

### Phase 1 Execution Plan

1. **Generate research.md** (Phase 0 completion)
   - Launch research agent to analyze streaming bugs
   - Consolidate findings into research.md

2. **Generate data-model.md**
   - Extract state machines from research findings
   - Define enhanced data structures

3. **Generate contracts/streaming-events.yaml**
   - Formalize event conversion rules
   - Specify validation conditions

4. **Generate quickstart.md**
   - Document testing approach
   - Create validation checklist

5. **Update agent context**
   - Run `.specify/scripts/bash/update-agent-context.sh claude`
   - Add Gemini streaming knowledge to context

---

## Phase 2: Task Generation

**Note**: Phase 2 (tasks.md) is created by `/speckit.tasks` command, not `/speckit.plan`.

After this plan is complete, run `/speckit.tasks` to generate actionable implementation tasks.

---

## Success Criteria

### Plan Complete When:
- [x] Technical Context filled with accurate project details
- [x] Constitution Check evaluated (N/A - no project constitution, following standard best practices)
- [x] Phase 0 research.md generated with root cause analysis
- [x] Phase 1 data-model.md defines event state machines
- [x] Phase 1 contracts/ defines event conversion rules
- [x] Phase 1 quickstart.md provides testing guide
- [x] Agent context updated with Gemini streaming knowledge

### Ready for Implementation When:
- [x] All Phase 0 and Phase 1 artifacts generated
- [x] Root cause fully understood and documented
- [x] Event conversion contracts specified
- [x] Testing approach validated
- [x] `/speckit.tasks` ready to generate implementation tasks

---

## Planning Complete - Summary

### Generated Artifacts

✅ **Phase 0: Research**
- `research.md` - Comprehensive root cause analysis
  - Identified exact bug locations (OpenAIResponsesClient.ts lines 662-667, 708-755)
  - Documented architectural mismatch between Responses API vs Chat Completions
  - Proposed three-part solution strategy

✅ **Phase 1: Design**
- `data-model.md` - Event state machine and data structures
  - 4-state event processing model
  - Enhanced accumulator design (`chatCompletionTextContent`)
  - Validation rules for pre-completion checks

- `contracts/streaming-events.yaml` - Formal event conversion contracts
  - Text delta handling specification
  - Tool call accumulation pattern
  - Completion event sequencing
  - Edge case handling rules

- `quickstart.md` - Testing and validation guide
  - 7 unit/integration test cases with code examples
  - 4 manual testing procedures
  - Debug logging configuration and interpretation
  - Pre-deployment validation checklist

✅ **Agent Context**
- Updated `CLAUDE.md` with TypeScript and Chrome Extension context

### Constitution Check - Final Review

**Status**: ✅ PASSED (using standard best practices, no formal constitution exists)

**Compliance**:
- ✅ Backward Compatibility: All changes isolated to Gemini-specific code paths
- ✅ Test Coverage: Comprehensive test plan with >90% coverage target
- ✅ Code Quality: Following TypeScript strict mode and existing ESLint standards
- ✅ Documentation: Inline comments planned, research artifacts created

**Complexity Assessment**:
- ✅ No new complexity added - bug fix within existing architecture
- ✅ Following established patterns (mirroring tool call accumulation for text)
- ✅ Minimal scope: 4-6 file modifications, ~200 lines of code changes

### Next Steps

Run `/speckit.tasks` to generate actionable, dependency-ordered implementation tasks from this plan.
