# Track 39 — Tasks

Implements [Track 39](./design.md). This track is large; keep the phases narrow and avoid
changing execution approval semantics.

## Phase 1 — Exposure metadata and manager

- [x] 1.1 Add `src/tools/exposure/ToolExposureTypes.ts` with
      `ToolExposureMode`, `ToolExposureProfile`, exposure reasons, and build-result types.
- [x] 1.2 Extend `ToolRegistrationOptions` / `ToolRegistryEntry` with
      `exposure?: ToolExposureProfile`.
- [x] 1.3 Add exposure-aware registry read APIs (`entriesWithExposure`,
      `getToolExposureProfile`, or equivalent) without changing `execute()`.
- [x] 1.4 Implement `ToolExposureManager` that classifies tools as always/deferred/hidden
      after existing disabled/platform/policy gates.
- [x] 1.5 Tests: built-ins remain exposed, MCP/A2A/plugin tools default deferred, hidden tools
      are absent from exposure and search.

## Phase 2 — Source metadata wiring

- [x] 2.1 Update `MCPToolAdapter` to register MCP tools with `source:'mcp'`,
      `mode:'deferred'`, `serverName`, and `searchHint`.
- [x] 2.2 Update `A2AToolAdapter` to register A2A skills with `source:'a2a'`,
      `mode:'deferred'`, agent/server name, and `searchHint`.
- [x] 2.3 Update plugin tool registration to accept manifest exposure metadata
      (`always`, `deferred`, `hidden`, `searchHint`) while defaulting plugin tools to
      deferred.
- [x] 2.4 Deduplicate MCP model exposure so registry-backed exposure is the single schema
      source.

## Phase 3 — `tool_search` and selection store

- [x] 3.1 Implement `ToolSearchIndex` with deterministic exact-name, source/server,
      `+required`, `searchHint`, and description matching.
- [x] 3.2 Implement `ToolSelectionStore` keyed by session id + active task id, with clear
      hooks on session/task end.
- [x] 3.3 Implement `ToolSearchTool` as an always-loaded, read-only, concurrency-safe tool.
- [x] 3.4 Enforce active config/policy/skill allow-list while searching and selecting.
- [x] 3.5 Tests: exact `select`, keyword search, required terms, source/server query, and
      selected tools persisted for the next request.

## Phase 4 — TurnManager integration

- [x] 4.1 Replace direct all-tool schema emission in `TurnManager.buildToolsFromContext()`
      with `ToolExposureManager.buildExposure(...)`.
- [x] 4.2 Include always-loaded tools, `tool_search`, and selected deferred tool schemas in
      the model request.
- [x] 4.3 Add compact deferred-tool source/name reminder text without listing huge schemas.
- [x] 4.4 After `tool_search` executes, rebuild model-facing tools before the next model
      request in the same turn/task.
- [x] 4.5 Tests: many MCP tools initially send only core + `tool_search`; after search, the
      next OpenAI Responses and Gemini requests include the selected schema.

## Phase 5 — Auto mode, config, diagnostics

- [x] 5.1 Add `dynamicToolLoading`, `dynamicToolLoadingThresholdPercent`,
      `alwaysLoadTools`, `deferTools`, and `hiddenTools` to tools config.
- [x] 5.2 Implement `auto` threshold using deferred schema size estimate versus model
      context window; tests opt in explicitly.
- [x] 5.3 Add diagnostics counters/events for always/deferred/hidden/selected counts and
      estimated schema chars/tokens.
- [x] 5.4 Add tests: selected tool later disabled/hidden is not exposed or executable through
      search; approval still fires for dynamically selected tools.

## Exit criteria

- Large MCP/A2A/plugin installs no longer send every schema in the initial model request.
- Built-in browser workflows still work without a search round trip.
- The model can search/select a deferred tool and use it on the next model request.
- Dynamic exposure does not bypass approval, policy, plan review, or skill `allowed-tools`.
- Diagnostics explain why each tool was always-loaded, deferred, hidden, or selected.
