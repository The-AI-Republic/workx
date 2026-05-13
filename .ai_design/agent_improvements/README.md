# BrowserX Agent Improvements: Learning from Claudy

Date: 2026-04-14

## Context

BrowserX and Claudy (Claude Code) are both AI agents with significant overlap in core capabilities: tool execution, permission management, conversation handling, and extensibility. This directory contains implementation plans organized as **improvement tracks**, each targeting a specific area where Claudy's design offers concrete advantages BrowserX can adopt.

## Guiding Principle

BrowserX is a multi-platform browser automation agent. Claudy is a terminal-native coding agent. We are NOT cloning Claudy. We are selectively importing architectural patterns that improve BrowserX's extensibility, operability, and runtime quality without breaking its product identity.

## Improvement Tracks

| # | Track | Priority | Effort | Value |
|---|-------|----------|--------|-------|
| 01 | [Hook & Event System](./01_hook_event_system_DONE/design.md) ✅ DONE (PR #198, merged 2026-05-13) | P0 | Large | Unlocks extensibility for all other tracks |
| 02 | [Tool Metadata & Concurrency](./02_tool_metadata_concurrency_DONE/design.md) ✅ DONE (PR #197, merged 2026-05-13) | P0 | Medium | Enables parallel tool execution, progress UX |
| 03 | [Command & Skill System](./03_command_skill_system/design.md) | P1 | Medium | User-facing extensibility, plugin ecosystem |
| 04 | [Typed Task Families](./04_typed_task_families/design.md) | P1 | Large | Background agents, disk persistence, progress |
| 05 | [Session Memory](./05_session_memory_DONE/design.md) ✅ DONE (PR #167, merged 2026-05-12) | P2 | Medium | Cross-session context, automatic summarization |
| 05b | [Auto-Extraction & Compaction Interlock](./05b_auto_extraction_compaction_interlock/design.md) | P2 | Medium | Background session summarization with compaction-safe interlock; layers on PR #167 |
| 06 | [Multi-Agent Coordination](./06_multi_agent_coordination/design.md) | P2 | Large | Coordinator mode, worker delegation |
| 07 | [Centralized State](./07_centralized_state/design.md) | P1 | Medium | Unified state, selectors, side-effect handlers |
| 08 | [Centralized Message Queue](./08_centralized_message_queue/design.md) | P1 | Medium | Unified event bus, semantic command queue, replay |

## Dependency Graph

```
01_hook_event_system_DONE (shipped via PR #198) ──┬──> 03_command_skill_system
                                                  ├──> 04_typed_task_families ──> 06_multi_agent_coordination
                                                  └──> 05_session_memory_DONE (shipped via PR #167) ──> 05b_auto_extraction_compaction_interlock (requires main → agent-improvements merge)

02_tool_metadata_concurrency_DONE (shipped via PR #197) ──> multiple_tools_call (existing)

07_centralized_state ──> (independent, can proceed in parallel)

08_centralized_message_queue ──> (independent, enhances 01, 04, 06, 07)
```

## Existing Work

- `plan.md` - Original comparison analysis (2026-04-07)
- `multiple_tools_call/` - Parallel tool execution design (builds on Track 02)

## How to Use

Each track folder contains:
- `design.md` - Architecture design, claudy patterns to adopt, browserx mapping
- `tasks.md` - Concrete implementation tasks with ordering and dependencies
