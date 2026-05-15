# BrowserX Agent Improvements: Learning from Claudy

Date: 2026-04-14 (tracks 01–11) · updated 2026-05-14 (second-pass tracks 12–24)

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
| 11 | [Parallel Tool Calls](./11_parallel_tool_calls/design.md) | P1 | Small | Config-driven `parallel_tool_calls` flag (default off, no allowlist — 2026-05-14 research confirms OpenAI/xAI/Groq/Fireworks/Together/Moonshot all support it; Gemini native) so Track 02's already-shipped orchestrator can run multi-tool responses in parallel. ~50 LOC plumbing. Supersedes the obsolete pre-Track-02 `multiple_tools_call/` design. Streaming-tool-execution + batched-approval-UI deferred. |

### Second-Pass Research Tracks (added 2026-05-14)

Tracks 12–24 come from a second, deeper claudy↔browserx comparison (2026-05-14) that targeted subsystems the original 2026-04-07 `plan.md` analysis never turned into tracks. None overlap tracks 01–11. Each design.md was written after reading the actual claudy implementation **and** the real browserx integration seams end-to-end, with `file:line` citations, divergence rationale, phase plans, and "Validation Notes" (matching the shipped 06/09 quality bar). Two claudy subsystems were investigated and **dismissed**: `thinkback`/`thinkback-play` (a "Year in Review" marketing animation, not rewind — the real feature is `/rewind`, see Track 15) and `upstreamproxy` (container credential-isolation for a threat model browserx does not have — not a model gateway).

| # | Track | Priority | Effort | Value |
|---|-------|----------|--------|-------|
| 12 | [Rate-Limit Resilience](./12_rate_limit_resilience/design.md) | **P0** | Medium | Unattended runs survive 429s (wait-until-reset), early-warning, model downgrade. Collapses 3 shallow retry loops into one; **deletes** the dead simulated `RequestQueue.ts`; fixes the live `Session.ts:1610` bug that discards parsed rate-limit snapshots. Correctness gap, not enhancement. Design is fully code-grounded (depth-bar reference). |
| 13 | [Input Pipeline & Browser-Native Mentions](./13_input_pipeline_mentions/design.md) | **P0** | Large | Unified input funnel + `@tab`/`@page`/`@selection` + screenshot paste. Reuses the existing `UserPromptSubmit` hook (Track 01) — funnel precedes it; relocates parsing out of `MessageInput.svelte`. Code-grounded design. |
| 14 | [Plan Mode](./14_plan_mode/design.md) | P1 | Medium | Propose-plan → gate all mutations → single approval. Categorical gate keyed off Track 02 metadata (hard dep); `ApprovalManager` makes it channel-safe (vs claudy's terminal-only). Code-grounded design. |
| 15 | [Conversation Rewind & Fork](./15_conversation_rewind/design.md) | P1 | **S–M** | Rewind/fork. The `forked` `InitialHistory` substrate is **already wired** (`Session.ts:248`) — net-new work is the slice fn + selector UI + `summarize_up_to`. Effort revised down. Code-grounded design. |
| 16 | [Telemetry & Analytics](./16_telemetry_analytics/design.md) | P1 | Medium | No-op-by-default, privacy-typed event sink. **Bridges the Track 01 event bus** instead of re-instrumenting call sites (browserx advantage over claudy). Code-grounded design. |
| 17 | [Operational Diagnostics](./17_operational_diagnostics/design.md) | P1 | Small–Medium | Cross-platform `/doctor` + heapdump. Reuses/extends existing `HealthStatus`/`HealthMonitor` (status is binary `_agentReady` today); node-only heapdump. Code-grounded design. |
| 18 | [USD Cost Tracking](./18_usd_cost_tracking/design.md) | P1 | Medium | Numeric cost table (NOT runtime prose-parsing) + USD accumulator + `/cost`; folds sub-agent cost; shares the `Session.ts:1610` fix with Track 12. Code-grounded design. |
| 19 | [Versioned Migration Framework](./19_migration_framework/design.md) | P1 | Small | Version-gated registry; absorbs the un-versioned every-load `migrateApprovalConfig` (`AgentConfig.ts:77`) as migration #1; distinct from `IndexedDBAdapter` DB-version. Code-grounded design. |
| 20 | [Managed / Policy Settings Tier](./20_managed_policy_settings/design.md) | P1 | Medium (full MDM P3/L) | Policy tier in **both** config systems + explicit `lockedKeys`; shared ETag/poll/fail-open remote fetcher (reused by Tracks 12/16). Code-grounded design. |
| 21 | [Remote Bridge & Relay](./21_remote_bridge_relay/design.md) | P1 | Large | NAT-free relay + viewer/driver. Replay rides **existing** `nextSeq` + `HandshakeSnapshotProviders` (not new infra); relay gated on hosted infra; teleport P3. Code-grounded design. |
| 22 | [Feature Flags & Lazy Loading](./22_feature_flags_lazy_loading/design.md) | P2 | Medium | Vite `define` `__FEATURE_*__` (same mechanism as `__BUILD_MODE__:vite.config.mjs:116`) + gated dynamic imports; pairs with existing `FeatureFlagRecorder`. Sequenced before 21/23. Code-grounded design. |
| 23 | [Agentic Payments (x402)](./23_agentic_payments_x402/design.md) | P2 (strategic) | Medium | HTTP 402 micropayments. **No global fetch chokepoint in browserx** → opt-in capability for resource tools, never auto-pay on navigation; flag-gated, vetted crypto. Code-grounded design. |
| 24 | [Minor UX & Hardening Follow-ups](./24_minor_ux_hardening_followups/design.md) | P1–P2 (per item) | Small–Medium each | Bundle: Fuse ranking (P1/S), personas (P2/S), prompt suggestion NOT speculation (P2/M), server `execSync` hardening + `execFileSync` injection fix (P2/M), sync deferred (P2/L) + fail-closed secret scanner (P2/S). Code-grounded design. |

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

--- Second-pass tracks (12–24, added 2026-05-14) ---

16_telemetry ──> 17_diagnostics, 19_migration (per-migration events), 18_cost (cost metric)
01_hooks/events ──> 12_rate_limit (warning/downgrade events), 13_input_pipeline (UserPromptSubmit hook),
                    15_rewind, 18_cost (CostUpdatedEvent), 21_remote_bridge (snapshot/replay)
03_commands ──> 13_input_pipeline (slash routes through funnel), 14_plan (/plan), 15_rewind (/rewind),
                17_diagnostics (/doctor), 18_cost (/cost), 24.1 (Fuse ranking), 24.2 (personas)
04_typed_tasks ──> 12_rate_limit (unattended detection), 21_remote_bridge (relay = task family)
09_tool_result_persistence ──> 13_input_pipeline (disk-backed image/large-paste reuse)
12_rate_limit ──> 18_cost (downgrade factors cost); shares ETag/poll/fail-open pattern with 20_managed_settings
14_plan_mode ──> 23_x402 (payment = destructive action through approval)
22_feature_flags ──> 21_remote_bridge & 23_x402 (ship dark, opt-in)

Recommended sequencing: 12 (P0, correctness) → 13 (P0, spine) → {14, 15, 16, 17, 18, 19} (P1) → 20, 21 → {22, 23} (P2) → 24 (opportunistic)
```

## Existing Work

- `plan.md` - Original comparison analysis (2026-04-07)
- `multiple_tools_call/` was superseded by Track 11 and removed (the 2026-04-07 design predated Track 02; most of its scope shipped with PR #197). See git history if the original is needed.
- Second-pass research (2026-05-14) — deep code-grounded claudy↔browserx comparison; produced tracks 12–24

## How to Use

Each track folder contains:
- `design.md` - Architecture design, claudy patterns to adopt, browserx mapping
- `tasks.md` - Concrete implementation tasks with ordering and dependencies
