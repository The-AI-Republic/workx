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
| 03 | [Command & Skill System](./03_command_skill_system_DONE/design.md) ✅ DONE (PR #204, merged 2026-05-14) | P1 | Medium | User-facing extensibility, plugin ecosystem |
| 04 | [Typed Task Families](./04_typed_task_families_DONE/design.md) ✅ DONE (PR #205, merged 2026-05-13) | P1 | Large | Background agents, disk persistence, progress |
| 05 | [Session Memory](./05_session_memory_DONE/design.md) ✅ DONE (PR #167, merged 2026-05-12) | P2 | Medium | Cross-session context, automatic summarization |
| 05b | [Auto-Extraction & Compaction Interlock](./05b_auto_extraction_compaction_interlock_DONE/design.md) ✅ DONE (PR #206, merged 2026-05-14) | P2 | Medium | Background session summarization with compaction-safe interlock; layers on PR #167 |
| 06 | [Multi-Agent Coordination](./06_multi_agent_coordination_ABANDONED/design.md) ❌ ABANDONED (2026-05-14) — Track 04's sub-agent system (`SubAgentRegistry`, `sub_agent`/`send_message`/`cancel_sub_agent`/`list_sub_agents`) already provides claudy's coordinator/worker primitives, correctly scoped to a single session. Cross-session ("tab") coordination is explicitly disallowed: tabs are independent by design — coupling them would be a bug. Residual items (coordinator-mode prompt, role-based tool allowlists, shared scratchpad) are not coordination problems and don't justify a track. | P2 | Large | Coordinator mode, worker delegation |
| 07 | [Centralized State](./07_centralized_state_DONE/design.md) ✅ DONE — narrow alternative shipped (PR #214, merged 2026-05-14). Full AgentState substrate descoped after audit found 5 of 7 fields had clean ownership; landed reactive `modelStore` + `ApprovalPolicyChanged` event instead. Revisit if future tracks justify the substrate. | P1 | Small | Reactive model store + approval-policy event |
| 08 | [Centralized Message Queue](./08_centralized_message_queue/design.md) | P1 | Small | `CommandQueue<T>` replaces plain `submissionQueue` — adds priorities (`now`/`next`/`later`) so `Interrupt`/`ExecApproval`/`Shutdown` jump ahead of queued `Compact`/`AddToHistory`. Deletes dead `QueueProcessor.ts` (~350 LOC). 2026-05-14 implementation-readiness pass dropped `engineId` filter (per-engine isolation already covers it), `pendingNotifications` folding (different concern, kept as-is), batching, and `remove(uuid)` from v1. Earlier 08a primitives (Signal, Mailbox, ApprovalManager refactor) dropped. EventLog deferred to [#215](https://github.com/The-AI-Republic/browserx/issues/215); MessageBus stays deferred. |
| 09 | [Tool Result Persistence](./09_tool_result_persistence_DONE/design.md) ✅ DONE (PR #213, merged 2026-05-14) | P2 | Medium | Persist oversized tool results to disk instead of truncating; agent reads back via Read |
| 10 | [Plugin System](./10_plugin_system/design.md) | P1 | Large | Claudy-compatible plugin packaging — manifest, marketplace, install, trust. Aggregates skills/hooks/MCP/subagents/commands into installable units. Phased 10a/10b/10c. |
| 11 | [Parallel Tool Calls](./11_parallel_tool_calls/design.md) | P1 | Small | Config-driven `parallel_tool_calls` flag (default off, allowlist-gated per provider) so Track 02's already-shipped orchestrator can run multi-tool responses in parallel for OpenAI/xAI/Groq (Gemini already does). ~50 LOC plumbing. Supersedes the obsolete pre-Track-02 `multiple_tools_call/` design. Streaming-tool-execution + batched-approval-UI deferred. |

## Dependency Graph

```
01_hook_event_system_DONE (shipped via PR #198) ──┬──> 03_command_skill_system_DONE (shipped via PR #204)
                                                  ├──> 04_typed_task_families_DONE (shipped via PR #205) ──> 06_multi_agent_coordination ❌ ABANDONED (sub-agents in Track 04 already cover this)
                                                  └──> 05_session_memory_DONE (shipped via PR #167) ──> 05b_auto_extraction_compaction_interlock_DONE (shipped via PR #206)

02_tool_metadata_concurrency_DONE (shipped via PR #197) ──> 11_parallel_tool_calls (flip parallel_tool_calls flag; orchestrator already shipped by Track 02)

07_centralized_state_DONE (shipped narrow via PR #214) ──> (full substrate descoped; revisit if needed)

08_centralized_message_queue ──> CommandQueue<T> replaces submissionQueue + deletes dead QueueProcessor.ts (single PR, ~150 LOC new / ~350 LOC deleted)
                                 ├──> pendingNotifications stays as-is (different concern, not a queue)
                                 ├──> EventLog deferred → issue #215 (no validated consumer)
                                 └──> MessageBus stays deferred (ChannelManager + ServiceRegistry + HookDispatcher + CommandQueue.subscribe already cover the surface)

10_plugin_system ──> (depends on shipped tracks: 01 hooks, 03 commands, sub-agents, MCP, skills)
                  ├──> Phase 1 (10a) — manifest + unified loader + /plugin UI
                  ├──> Phase 2 (10b) — git marketplace + install
                  └──> Phase 3 (10c) — autoupdate + trust/policy + options
```

## Existing Work

- `plan.md` - Original comparison analysis (2026-04-07)
- `multiple_tools_call/` was superseded by Track 11 and removed (the 2026-04-07 design predated Track 02; most of its scope shipped with PR #197). See git history if the original is needed.

## How to Use

Each track folder contains:
- `design.md` - Architecture design, claudy patterns to adopt, browserx mapping
- `tasks.md` - Concrete implementation tasks with ordering and dependencies
