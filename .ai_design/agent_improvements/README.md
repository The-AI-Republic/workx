# BrowserX Agent Improvements: Learning from Claudy

Date: 2026-04-14 (tracks 01–11) · updated 2026-05-14 (second-pass tracks 12–24) · 2026-05-15 (tracks 12–25 made implementation-ready: per-platform behavior across BrowserX / Apple Pi / Apple Pi Server + file-level implementation plans folded into each design.md)

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
| 08 | [Centralized Message Queue](./08_centralized_message_queue_DONE/design.md) ✅ DONE — Phase 1 (PR #219, merged 2026-05-14) | P1 | Small | `CommandQueue<T>` replaces plain `submissionQueue` — adds priorities (`now`/`next`/`later`) so `Interrupt`/`ExecApproval`/`Shutdown` jump ahead of queued `Compact`/`AddToHistory`. Deletes dead `QueueProcessor.ts` (~350 LOC). 2026-05-14 implementation-readiness pass dropped `engineId` filter (per-engine isolation already covers it), `pendingNotifications` folding (different concern, kept as-is), batching, and `remove(uuid)` from v1. Earlier 08a primitives (Signal, Mailbox, ApprovalManager refactor) dropped. EventLog deferred to [#215](https://github.com/The-AI-Republic/browserx/issues/215); MessageBus stays deferred. |
| 09 | [Tool Result Persistence](./09_tool_result_persistence_DONE/design.md) ✅ DONE (PR #213, merged 2026-05-14) | P2 | Medium | Persist oversized tool results to disk instead of truncating; agent reads back via Read |
| 10 | [Plugin System](./10_plugin_system_DONE/design.md) ✅ DONE (PRs #222, #224, #226, #227, merged 2026-05-16) | P1 | Large | Claudy-compatible plugin packaging — manifest, marketplace, install, trust. Aggregates skills/hooks/MCP/subagents/commands into installable units. Phased 10a/10b/10c. |
| 11 | [Parallel Tool Calls](./11_parallel_tool_calls_DONE/design.md) ✅ DONE (PR #221, merged 2026-05-15) | P1 | Small | Config-driven `parallel_tool_calls` flag (default off, no allowlist — 2026-05-14 research confirms OpenAI/xAI/Groq/Fireworks/Together/Moonshot all support it; Gemini native) so Track 02's already-shipped orchestrator can run multi-tool responses in parallel. Buffers the OpenAI-Responses/xAI N-`function_call` shape into the orchestrator. ~50 LOC plumbing. Supersedes the obsolete pre-Track-02 `multiple_tools_call/` design. Pre-enablement: manual multi-provider QA still pending (flag dark by default). Streaming-tool-execution + batched-approval-UI deferred. |

### Second-Pass Research Tracks (added 2026-05-14)

Tracks 12–25 come from deeper claudy↔browserx comparison (2026-05-14) targeting subsystems the original 2026-04-07 `plan.md` analysis never turned into tracks. None overlap tracks 01–11. (Tracks 12–24: second-pass subsystem sweep. Track 25: a context-window-management follow-up — the two unattended-robustness gaps surfaced when comparing compaction head-to-head.) Each design.md was written after reading the actual claudy implementation **and** the real browserx integration seams end-to-end, with `file:line` citations, divergence rationale, phase plans, and "Validation Notes" (matching the shipped 06/09 quality bar). Two claudy subsystems were investigated and **dismissed**: `thinkback`/`thinkback-play` (a "Year in Review" marketing animation, not rewind — the real feature is `/rewind`, see Track 15) and `upstreamproxy` (container credential-isolation for a threat model browserx does not have — not a model gateway).

| # | Track | Priority | Effort | Value |
|---|-------|----------|--------|-------|
| 12 | [Rate-Limit Resilience](./12_rate_limit_resilience_DONE/design.md) ✅ DONE (PR #230, merged 2026-05-16) | **P0** | Medium | Unattended runs survive 429s (wait-until-reset), early-warning, model downgrade. Collapses 3 shallow retry loops into one; **deletes** the dead simulated `RequestQueue.ts`; fixes the live `Session.ts:1610` bug that discards parsed rate-limit snapshots. Correctness gap, not enhancement. Design is fully code-grounded (depth-bar reference). |
| 13 | [Input Pipeline & Browser-Native Mentions](./13_input_pipeline_mentions_DONE/design.md) ✅ DONE (PR #229, merged 2026-05-16) | **P0** | Large | Unified input funnel + `@tab`/`@page`/`@selection` + screenshot paste. Reuses the existing `UserPromptSubmit` hook (Track 01) — funnel precedes it; relocates parsing out of `MessageInput.svelte`. Code-grounded design. |
| 14 | [Plan Review](./14_plan_review_DONE/design.md) ✅ DONE (PR #233, merged 2026-05-16) | P1 | Medium | Propose-plan → freeze all mutations → single approval. Orthogonal gate state (NOT an `ApprovalMode` value — "mode" reserved by #223/#228) keyed off Track 02 metadata; classification audit completed; headless registration-gated off (no server core-manager round-trip). Was "Plan Mode". Code-grounded. |
| 15 | [Conversation Rewind & Fork](./15_conversation_rewind_DONE/design.md) ✅ DONE (PR #234, merged 2026-05-16) | P1 | **M** (→ M–L e2e) | Rewind/fork. Runtime end-to-end-correctness pass (2026-05-15): `forked` substrate **scaffolded but broken**; **P0 fixes** (each a prescribed line + test) gate the pure slice fn + selector UI + `summarize_up_to` + server RPC + scheduler resume. Runtime trace caught 3 defects "wired seams" miss — dangling tool_use on the scheduler checkpoint (D10/D11 `call_id` trim), silent model/approval reset (D12 resume-parity), stale live-rollout read (D13 flush) — all closed. Decisions D1–D13 resolved, continuation flow traced — **hand-off-ready, functionally complete e2e**. Effort **up** (S–M → M). Code-grounded design. |
| 16 | [Centralized Telemetry & Analytics](./16_telemetry_analytics_DONE/design.md) ✅ DONE (PR #239, merged 2026-05-18) | P1 | M–L | One no-op-by-default, privacy-typed contract subsuming browserx's 4 scattered surfaces. Real seam: a decorator on `RepublicAgent.emitEvent`'s per-session `eventDispatcher`; zero Track-01 change. Adds concrete allowlist, privacy model vs real `AgentConfig`, per-platform sinks, and end-to-end coverage. |
| 17 | [Operational Diagnostics](./17_operational_diagnostics_DONE/design.md) ✅ DONE (PR #232, merged 2026-05-16) | P1 | Small–Medium | Cross-platform `/doctor` + heapdump. Reuses/extends existing `HealthStatus`/`HealthMonitor` (status is binary `_agentReady` today); node-only heapdump. Code-grounded design. |
| 18 | [USD Cost Tracking](./18_usd_cost_tracking_DONE/design.md) ✅ DONE (PR #231, merged 2026-05-16) | P1 | Medium | Numeric `provider:model` cost table (NOT runtime prose-parsing) → per-turn cost on `TaskCompleteEvent`, folded once at `persistTokenUsage` (per-engine self-report, not claudy recursion) + cumulative in `SessionState` + `/cost` + server per-job cost & per-day budget cap. **Independently shippable** — decoupled from Track 12 (the `Session.ts:1614` `TokenCount` `cost` rider is optional coordination, not a dependency). MVP phases 1–4 shipped; telemetry export (3.7) is covered by Track 16 / PR #239, while the x402 seam (4.6, Track 23 absent) and mid-run abort (4.7, non-MVP) remain deliberately deferred — see `tasks.md`. |
| 19 | [Versioned Migration Framework](./19_migration_framework_DEFERRED/design.md) DEFERRED | P1 | Small | Version-gated registry; absorbs the un-versioned every-load `migrateApprovalConfig` (`AgentConfig.ts:77`) as migration #1; distinct from `IndexedDBAdapter` DB-version. Code-grounded design. |
| 20 | [Managed / Policy Settings Tier](./20_managed_policy_settings_DONE/design.md) ✅ DONE (PR #237, merged 2026-05-16) | P1 | Medium (full MDM P3/L) | Policy tier in **both** config systems + explicit `lockedKeys`; shared ETag/poll/fail-open remote fetcher (reused by Tracks 12/16). Code-grounded design. |
| 21 | [Remote Bridge & Relay](./21_remote_bridge_relay_DEFERRED/design.md) DEFERRED | P1 | Large | NAT-free relay + viewer/driver. Replay rides **existing** `nextSeq` + `HandshakeSnapshotProviders` (not new infra); relay gated on hosted infra; teleport P3. Code-grounded design. |
| 22 | [Feature Flags & Lazy Loading](./22_feature_flags_lazy_loading_DONE/design.md) ✅ DONE (PR #242, merged 2026-05-18) | P2 | Medium | Vite `define` `__FEATURE_*__` (same mechanism as `__BUILD_MODE__:vite.config.mjs:116`) + gated dynamic imports; pairs with existing `FeatureFlagRecorder`. Sequenced before 21/23. Code-grounded design. |
| 23 | [Agentic Payments (x402)](./23_agentic_payments_x402_DONE/design.md) ✅ DONE (PR #238, merged 2026-05-18) | P2 (strategic) | Large | HTTP 402 micropayments through an explicit `ResourceFetchTool`, never browser navigation auto-pay. Adds x402 config/caps/tracker, vetted signing surface, platform-specific custody, extension detect/surface behavior, desktop approval-gated signing, and server default-deny allowlist/budget policy. |
| 24 | [Minor UX & Hardening Follow-ups](./24_minor_ux_hardening_followups_DONE/design.md) ✅ DONE (PR #240, merged 2026-05-16) | P1–P2 (per item) | Small–Medium each | Bundle: Fuse ranking (P1/S), personas (P2/S), prompt suggestion NOT speculation (P2/M), server `execSync` hardening + `execFileSync` injection fix (P2/M), sync deferred (P2/L) + fail-closed secret scanner (P2/S). Code-grounded design. |
| 25 | [Autonomous & Reactive Context Compaction](./25_context_compaction_robustness_DONE/design.md) ✅ DONE | P1 | Small–Medium | Adds the RepublicAgent-level auto-compaction post-turn hook, reactive 413/context-overflow compact-and-retry on Track 12's model-call boundary, max-3 circuit breakers, canonical 0.8/model-provided threshold helpers, and token-pressure warning tiers. |

### Follow-up Tracks from DONE-track Audit (2026-05-15)

A design-vs-implementation audit of every DONE track (01, 02, 03, 04, 05, 05b, 07, 08, 09, 11)
verified the **shipped code on `agent-improvements`** against each track's design doc — not
trusting the design docs' own "Validation Notes"/checkboxes. Each gap below was independently
re-verified against on-disk source. Per process, original DONE design docs were **not**
edited; gaps are captured as new follow-up tracks that reference their origin track.

Audit outcome by track: **03 / 04 / 09 → Material gaps** · **01 / 02 / 05 / 05b → Minor gaps
with real items** · **07 → in-scope code correct (design doc stale only; README already
records the descope — no follow-up track)** · **08 → fully fulfilled (Phase 1; marked DONE
above)** · **11 → fully fulfilled (only a stale `ModelClient.ts` file reference in the
design, zero runtime impact — no follow-up track).**

| # | Follow-up Track | Origin | Severity | Headline gap |
|---|-----------------|--------|----------|--------------|
| 26 | [Hook System Completion](./26_track01_hook_system_completion_DONE/design.md) ✅ DONE (2026-05-18) | Track 01 | P1 | `TaskCompleted` now fires exactly once on success/failure/abort, tool hooks receive bounded browser/runtime context with per-tool snapshots, `HookResult` telemetry is emitted per hook, `Stop` fires from accepted abort paths without veto power, and config hook watchers are cleaned up on agent teardown. |
| 27 | [Tool Progress UX & Sibling Abort](./27_track02_progress_ux_sibling_abort_DONE/design.md) ✅ DONE (2026-05-18) | Track 02 | P1/P2 | Tool progress now emits through `TurnManager`/`ToolRegistry` into the sidepanel, Navigation/DOM/WebScraping/PageVision produce bounded checkpoints, safe parallel batches abort siblings on first failure/denial with synthetic cancelled results, and `data_extraction` uses the bound tab so it is concurrency-safe. |
| 28 | [Skill Security & Server Parity](./28_track03_skill_security_server_parity_DONE/design.md) ✅ DONE (2026-05-18) | Track 03 | **P1 (security)** | `allowed-tools` now gates model-visible tools and dispatch, forked sub-agents inherit the gate, server/extension use shared `use_skill` + `SkillRiskAssessor` wiring, `agent:` validates against known sub-agent types, ActiveTab updates are debounced, and the orphaned core command layer was removed while preserving plugin command storage. |
| 29 | [Background Task Delivery](./29_track04_background_task_delivery_DONE/design.md) ✅ DONE (2026-05-18) | Track 04 | **P1** | Background task lifecycle/output events now emit and route into the UI store without transcript pollution, the chat badge/polling path is mounted, extension quota pressure uses task-output-first tiered eviction, pending approvals unwind on abort, and task notifications carry durable output offsets. |
| 30 | [Session Memory Privacy UI](./30_track05_memory_privacy_ui_DONE/design.md) ✅ DONE (2026-05-18) | Track 05 | P2 | Memory settings now show a bounded current-memory snapshot via `memory.getSnapshot`, support confirmed `memory.clearAll`, hide when no memory service is available, and codify the intentional 8000-character core-memory v1 cap. |
| 31 | [Session Summary E2E Coverage](./31_track05b_session_summary_e2e_DONE/design.md) ✅ DONE (2026-05-18) | Track 05b | P2 | Added a deterministic Node integration harness for post-turn trigger → real `summary.md` write → compaction interlock wait → `<session_summary>` fold, and recorded `preferences.sessionSummaryEnabled` as the accepted v1 flag location. |
| 32 | [Tool Result Persistence Wiring](./32_track09_tool_result_persistence_wiring_DONE/design.md) ✅ DONE (2026-05-18) | Track 09 | **P1** | Production bootstraps now pass `SessionServices` into `RepublicAgent`/`Session`, extension/desktop use cache-backed stores, server uses `{dataDir}/sessions`, and integration coverage proves persist/read-back/tier-2/cleanup/resume paths with a real store. |
| 45 | [Apple Pi Runtime Integration Follow-ups](./45_track43_runtime_integration_followups/design.md) ✅ DONE (2026-05-20) | Track 43 | **P1** | Closed three Track 43 verification gaps: (1) spawned-sidecar protocol & lifecycle smoke test — boots the real Apple Pi sidecar, runs handshake + `ping`/`pong` + graceful shutdown; (2) Rust supervisor lifecycle suite — 9 process-level integration tests against a fake-child binary + inline unit tests for the backoff formula; (3) real `diagnostics.recentStderr` ring buffer (200 lines / 64 KiB FIFO, generation + `tsMs` tagged) replacing the stub. The deferred "full `PARITY_SCENARIOS`-vs-real-runtime" comparison (needs deterministic agent fixtures) and multi-OS packaged smoke (release-engineer at tag time) are documented in tasks.md as out of scope. |

> Note (Track 07): the narrowed shipped scope (reactive `modelStore` + `ApprovalPolicyChanged`)
> is fully and correctly implemented. The only inconsistency is that `07_*/design.md` and
> `tasks.md` still read as the full-substrate commitment; the README row (above) already
> records the descope, so this is doc-staleness, not an implementation gap — intentionally no
> follow-up track (editing the origin design is out of process).

### Cross-Track Integration Defects (audit 2026-05-15)

The tracks above were merged independently and never tested **together**. A cross-track
integration audit traced the seams where multiple DONE tracks touch the same code path
(tool-execution routes, the Session/sub-agent lifecycle, reactive config, shared
cache/quota/rollout). Each defect below was independently re-verified against on-disk source.
These are *interaction* bugs (one track's code breaks another's contract) — **distinct from
the single-track gaps in 26–32**. Filed as bug-report tracks (detail + fix in each `design.md`).

| # | Integration Track | Seam | Severity | Defect |
|---|-------------------|------|----------|--------|
| 33 | [Tool-Exec Route Consistency](./33_int_tool_exec_route_consistency_DONE/design.md) ✅ DONE (2026-05-18) | T09×11×02 | **P1** | Legacy flag-off `function_call` route now applies Track 09 tier-2 aggregate enforcement at `Completed`, preserving immediate execution while capping multi-result context growth. |
| 34 | [Extractor ↔ Task Seam](./34_int_extractor_task_seam_DONE/design.md) ✅ DONE (2026-05-18) | T04×05b×01 | **P0 (Critical)** | Track 41 already moved extraction to shadow runtime; final fix aborts active typed tasks during `Session.shutdown()` and clears the Track-04 eviction interval so teardown cannot leak timers/tasks. |
| 35 | [Reactive Config Staleness](./35_int_reactive_config_staleness_DONE/design.md) ✅ DONE (2026-05-18) | T07×11×01 | P1 | Model-client cache keys now include construction-time config (`parallelToolCalls`, provider/model signature), `tools`/`provider` changes invalidate/refresh clients, and tool executions use one hook snapshot across Pre/Permission/Post/failure. |
| 36 | [Concurrent Approval Serialization](./36_int_concurrent_approval_serialization_DONE/design.md) ✅ DONE (2026-05-18) | T02×01 | P2 | `ApprovalGate.check()` now serializes in-flight prompts per approval memory key, so concurrent same-key calls share one hook/prompt and remembered decisions apply to siblings while distinct keys stay independent. |
| 37 | [Persisted-Result Durability](./37_int_persisted_result_durability_DONE/design.md) ✅ DONE (2026-05-18) | T09×04×storage | P1 | Persisted tool-result blobs are protected from session auto-eviction and model delete/update, and extension quota pressure now evicts tier0 task output then tier1 ordinary cache items instead of rollout pointers or protected `tool_result` blobs. |

> Sequencing: **34 (Critical)** → **33 / 37 / 35 (P1)** → **36 (P2)**. Track 37 BUG-3's
> `TieredEvictor` ordering must be decided jointly with Track 29 G3 + Track 32 Phase 5 (one
> shared decision across all three — flagged in each doc).

### Additional Research Tracks (2026-05-16)

| # | Track | Priority | Effort | Value |
|---|-------|----------|--------|-------|
| 38 | [Keyboard Shortcut System](./38_keyboard_shortcut_system_DONE/design.md) ✅ DONE (PR #241, merged 2026-05-18) | P1 | Medium | Centralize BrowserX shortcuts around action IDs, active contexts, resolver/display helpers, validation, and platform-specific extension/desktop mappings; selectively adopts claudy's keybinding architecture without terminal-specific assumptions. |
| 39 | [Dynamic Tool Management](./39_dynamic_tool_management_DONE/design.md) ✅ DONE | P1 | Large | Provider-neutral adaptation of claudy's ToolSearch: full internal tool availability, deferred MCP/A2A/plugin schemas, always-loaded `tool_search`, selected-schema hydration on the next request, and unchanged approval/policy enforcement. |
| 40 | [Sub-Agent Runtime Optimization](./40_subagent_runtime_optimization_DONE/design.md) ✅ DONE | P1 | Medium–Large | PR #243 plus follow-ups completed typed sub-agent behavior, fork context mode, child history seams, skill integration, events, task-state coverage, and the final explicit fork-recursion/tag guard. |
| 41 | [Shadow Agent Runtime](./41_shadow_agent_runtime_DONE/design.md) ✅ DONE (PR #245, merged 2026-05-18) | P1 | Medium–Large | Runtime-only `ShadowAgentRunner`/scheduler for internal background jobs; session-summary extraction migrated off quiet sub-agents, with diagnostics/failure policies and compaction prep covered by tests. |
| 42 | [System Prompt Content Improvements](./42_system_prompt_content_improvements_DONE/design.md) ✅ DONE (PR #244, merged 2026-05-18) | P1 | Small–Medium | Compare claudy's prompt sections with BrowserX's composed prompt; add missing system semantics/action-risk/memory-staleness/skill anti-guessing guidance while trimming verbose duplicated planning/tool-loop prose. |
| 43 | [Apple Pi Runtime Decoupling](./43_apple_pi_runtime_decoupling_DONE/design.md) ✅ CUTOVER DONE (PRs #246 + #255, merged 2026-05-18 / 2026-05-20) | P1 | XL | Desktop now defaults to the Rust-supervised runtime sidecar relay; legacy WebView bootstrap removed from UI startup/shutdown/login flows. P1/P2/P3 + automatable P4 closed. Highest-value remaining code-side verification gaps (spawned-sidecar parity, Rust supervisor lifecycle `tokio::test`s, real `diagnostics.recentStderr` ring-buffer) are tracked in [Track 45](./45_track43_runtime_integration_followups/design.md); multi-OS packaged smoke remains release-engineer at tag time. |
| 44 | [Desktop Runtime State Ownership Contract](./44_desktop_runtime_state_ownership_DONE/design.md) ✅ DONE (PR #256, merged 2026-05-20) | P1 | Medium–Large | Runtime-owned desktop auth/access/profile state, startup snapshot, global access service, UI state derivation, generic deeplink delivery, shared URL resolution, and packaged Node/native-addon validation. |

### Cross-Track Consistency Track (added 2026-05-20)

| Track | Priority | Effort | Value |
|-------|----------|--------|-------|
| [improve_consistentcy0520](./improve_consistentcy0520/design.md) | P0/P1 | Medium-Large | Cross-track hardening pass for DONE-track integration drift: session-scoped prompt/runtime context, unified teardown, post-turn commit order, config generations, approval/tool lifecycle, storage lifetime, and track-status hygiene. |

## Dependency Graph

```
01_hook_event_system_DONE (shipped via PR #198) ──┬──> 03_command_skill_system_DONE (shipped via PR #204)
                                                  ├──> 04_typed_task_families_DONE (shipped via PR #205) ──> 06_multi_agent_coordination ❌ ABANDONED (sub-agents in Track 04 already cover this)
                                                  └──> 05_session_memory_DONE (shipped via PR #167) ──> 05b_auto_extraction_compaction_interlock_DONE (shipped via PR #206)

02_tool_metadata_concurrency_DONE (shipped via PR #197) ──> 11_parallel_tool_calls_DONE (shipped via PR #221; orchestrator was shipped by Track 02)

07_centralized_state_DONE (shipped narrow via PR #214) ──> (full substrate descoped; revisit if needed)

08_centralized_message_queue_DONE (shipped via PR #219) ──> CommandQueue<T> replaced submissionQueue + deleted dead QueueProcessor.ts (~150 LOC new / ~350 LOC deleted)
                                 ├──> pendingNotifications stays as-is (different concern, not a queue)
                                 ├──> EventLog deferred → issue #215 (no validated consumer)
                                 └──> MessageBus stays deferred (ChannelManager + ServiceRegistry + HookDispatcher + CommandQueue.subscribe already cover the surface)

10_plugin_system_DONE ──> (depends on shipped tracks: 01 hooks, 03 commands, sub-agents, MCP, skills)
                  ├──> Phase 1 (10a) — manifest + unified loader + /plugin UI
                  ├──> Phase 2 (10b) — git marketplace + install
                  └──> Phase 3 (10c) — autoupdate + trust/policy + options

--- Second-pass tracks (12–24, added 2026-05-14) ---

16_telemetry_DONE ──> 17_diagnostics, 19_migration (per-migration events), 18_cost (cost metric)
01_hooks/events ──> 12_rate_limit_DONE (warning/downgrade events), 13_input_pipeline_DONE (UserPromptSubmit hook),
                    15_rewind, 18_cost (cost on TaskCompleteEvent), 21_remote_bridge_relay_DEFERRED (snapshot/replay)
03_commands ──> 13_input_pipeline_DONE (slash routes through funnel), 14_plan_review_DONE (/plan), 15_rewind_DONE (/rewind),
                17_diagnostics (/doctor), 18_cost (/cost), 24.1 (Fuse ranking), 24.2 (personas)
04_typed_tasks ──> 12_rate_limit_DONE (unattended detection), 21_remote_bridge_relay_DEFERRED (relay = task family)
09_tool_result_persistence ──> 13_input_pipeline_DONE (disk-backed image/large-paste reuse)
12_rate_limit_DONE ··> 18_cost (coordination, non-blocking: a Track-12 downgrade/fallback model is exactly 18's `estimated` cost case; 18 ships independently)
12_rate_limit_DONE shares ETag/poll/fail-open pattern with 20_managed_settings_DONE
14_plan_review_DONE ──> 23_x402 (payment = destructive action through approval)
22_feature_flags_DONE ──> 21_remote_bridge_relay_DEFERRED & 23_x402 (ship dark, opt-in)
12_rate_limit_DONE ──> 25_context_compaction (shared TurnManager:224 model-call boundary + StreamAttemptError + circuit-breaker)
05b_session_summary (DONE) ──> 25_context_compaction (registerPostTurnHook seam + the compaction it triggers)

Recommended sequencing: 12 (P0, correctness) → 13 (P0, spine) → {14, 15, 16, 17, 18, 19, 25} (P1) → 20, 21 → {22, 23} (P2) → 24 (opportunistic)
  (25 pairs with 12 — same model-call boundary; land them together)

--- DONE-track audit follow-ups (26–32, added 2026-05-15) ---

01_hook_event_system_DONE        ──> 26_track01_hook_system_completion (TaskCompleted-on-abort, tool ctx, HookResult, Stop)
02_tool_metadata_concurrency_DONE──> 27_track02_progress_ux_sibling_abort (activate dead progress pipeline + AbortController)
03_command_skill_system_DONE     ──> 28_track03_skill_security_server_parity_DONE (allowed-tools enforcement [security] + server parity)
04_typed_task_families_DONE      ──> 29_track04_background_task_delivery (emit/route events + mount UI + TieredEvictor)
05_session_memory_DONE           ──> 30_track05_memory_privacy_ui (view/clear memory UI)
05b_..._interlock_DONE           ──> 31_track05b_session_summary_e2e (full-loop E2E + flag-location reconcile)
09_tool_result_persistence_DONE  ──> 32_track09_tool_result_persistence_wiring (inject SessionServices so the feature actually runs)

Priority order for follow-ups: 32 (feature dead in prod) ≈ 28 (security) ≈ 29 (undelivered) → 26, 27 → 30, 31
  (29 G3 + 32 Phase 5 must agree on the TieredEvictor tier ordering — coordinate)

--- Cross-track integration defects (33–37, added 2026-05-15) ---

T09 × T11 × T02  (tool-exec routes) ──> 33_int_tool_exec_route_consistency_DONE (tier-2 legacy-route gap resolved)
T04 × T05b × T01 (Session/sub-agent)──> 34_int_extractor_task_seam_DONE (phantom task + timer/engine leaks resolved)
T07 × T11 × T01  (reactive config)  ──> 35_int_reactive_config_staleness (stale client flag + mid-tool hook swap)
T02 × T01        (parallel+approval)──> 36_int_concurrent_approval_serialization (duplicate prompts)
T09 × T04 × store(persist+cache)    ──> 37_int_persisted_result_durability (blob vanishes under rollout pointer)
claudy keybindings comparison       ──> 38_keyboard_shortcut_system_DONE (action IDs + contexts + validation + platform global mapping)
claudy ToolSearch comparison        ──> 39_dynamic_tool_management_DONE (deferred model-facing schemas + provider-neutral tool_search hydration)
claudy AgentTool/forkSubagent       ──> 40_subagent_runtime_optimization (enum AgentType + isolated/forked subagent modes)
claudy runForkedAgent               ──> 41_shadow_agent_runtime_DONE (runtime-only shadow agents for internal background jobs)
claudy system prompt comparison     ──> 42_system_prompt_content_improvements_DONE (system semantics + action risk + prompt-size reduction)
43_apple_pi_runtime_decoupling_DONE ──> 44_desktop_runtime_state_ownership_DONE (runtime/UI/Tauri state boundary + auth/access/env parity)
43_apple_pi_runtime_decoupling_DONE ──> 45_track43_runtime_integration_followups (spawned-sidecar parity, supervisor tokio tests, diagnostics ring-buffer, schema consolidation)

Integration-fix order: 34 (Critical) → 33 / 37 / 35 (P1) → 36 (P2)
  (37 BUG-3 TieredEvictor ordering == 29 G3 == 32 P5 — ONE shared decision, no drift)
```

## Existing Work

- `plan.md` - Original comparison analysis (2026-04-07)
- `multiple_tools_call/` was superseded by Track 11 and removed (the 2026-04-07 design predated Track 02; most of its scope shipped with PR #197). See git history if the original is needed.
- Second-pass research (2026-05-14) — deep code-grounded claudy↔browserx comparison; produced tracks 12–24
- DONE-track audit (2026-05-15) — verified every DONE track's shipped code against its design doc; produced follow-up tracks 26–32 (see "Follow-up Tracks from DONE-track Audit" above)
- Cross-track integration audit (2026-05-15) — traced seams where multiple DONE tracks touch the same code path; produced integration-defect tracks 33–37 (see "Cross-Track Integration Defects" above)

## How to Use

Each track folder contains:
- `design.md` - Architecture design, claudy patterns to adopt, browserx mapping
- `tasks.md` - Concrete implementation tasks with ordering and dependencies
