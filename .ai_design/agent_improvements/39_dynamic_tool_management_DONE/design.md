# Track 39: Dynamic Tool Management

**Date**: 2026-05-16
**Status**: DONE — implemented 2026-05-18
**Scope**: Browserx tool exposure, MCP/A2A/plugin tool scaling, skill discoverability, prompt-size control
**Reference**: `/home/rich/dev/study/claudy/src/utils/toolSearch.ts`, `/home/rich/dev/study/claudy/src/tools/ToolSearchTool`, `/home/rich/dev/study/claudy/src/services/api/claude.ts`

**Implementation note**: BrowserX now has a provider-neutral exposure layer under
`src/tools/exposure/`. `ToolRegistry` stores exposure metadata, MCP/A2A registrations
default to deferred, `tool_search` persists selected tool names, and `TurnManager`
rebuilds model-facing schemas from `ToolExposureManager`. Diagnostics are emitted as
`ToolExposureUpdated`.

## Summary

Browserx currently sends every enabled registered tool schema to the model at the start of a turn. That is manageable for the built-in browser tools, but it does not scale once users install many MCP servers, A2A agents, plugin tools, and skills.

Claudy's useful pattern is dynamic tool loading: keep a full internal tool pool, expose only the small always-needed tool surface to the model, and let the model search for additional deferred tools when it needs them.

Browserx should adopt the pattern, but not Claudy's wire format. Claudy can rely on Anthropic `tool_reference` / `defer_loading` beta behavior. Browserx supports OpenAI Responses, OpenAI-compatible providers, Gemini, and local/custom clients, so the Browserx design should be provider-neutral:

- register every tool internally;
- classify tools as `always`, `deferred`, or `hidden`;
- expose a compact `tool_search` function plus always-loaded tools;
- when `tool_search` selects deferred tools, persist those tool names in turn/session state;
- rebuild the next model request with the selected tool schemas included.

The goal is to reduce prompt/tool-schema bloat without weakening execution-time approval, risk assessment, or tool registry ownership.

## Current Browserx Behavior

### Tool registry is execution-oriented

`ToolRegistry` stores each tool definition, handler, risk assessor, and runtime metadata in one private map (`src/tools/ToolRegistry.ts:47`). It exposes all registered definitions through `listTools()` (`src/tools/ToolRegistry.ts:704`) and only supports limited name-pattern discovery (`src/tools/ToolRegistry.ts:258`). The existing `ToolRuntimeMetadata` covers concurrency, UI, and result budget concerns, but not model-exposure concerns (`src/tools/runtimeMetadata.ts:1`).

This is a good execution substrate. It is not yet a good model-exposure substrate.

### TurnManager exposes nearly everything

`TurnManager.buildToolsFromContext()` gathers every registered registry tool, filters only `tools.disabled`, and pushes the definitions into the prompt (`src/core/TurnManager.ts:504`). It then optionally adds MCP tools from the session (`src/core/TurnManager.ts:579`) and custom tools (`src/core/TurnManager.ts:600`).

The final model request receives `prompt.tools` directly. The OpenAI Responses client maps every function tool to a wire schema (`src/core/models/client/OpenAIResponsesClient.ts:354`, `src/core/models/client/OpenAIResponsesClient.ts:1115`). Gemini similarly maps all function tools into `functionDeclarations` (`src/core/models/client/GoogleCompletionClient.ts:451`).

This means Browserx's model-facing tool surface grows linearly with installed capability count.

### MCP tools are already registered dynamically, but not deferred

`MCPToolAdapter.adaptTool()` prefixes MCP tools as `${serverName}__${tool.name}` and places the full MCP input schema into the `ToolDefinition` (`src/core/mcp/MCPToolAdapter.ts:28`). `registerMCPTools()` registers every discovered MCP tool into the registry and uses MCP annotations for concurrency/risk-adjacent metadata (`src/core/mcp/MCPToolAdapter.ts:190`).

That is the right registration behavior. The missing piece is a separate exposure policy saying "this registered tool should not be in the initial model schema list."

### Skills already use a better split

Skills are closer to the right shape. `SkillRegistry.discover()` loads lightweight metadata (`src/core/skills/SkillRegistry.ts:37`), while `SkillRegistry.invoke()` loads the full body on demand (`src/core/skills/SkillRegistry.ts:82`). `SkillCommandLoader` also defers full skill body loading until invocation (`src/core/commands/loaders/SkillCommandLoader.ts:17`).

Desktop registers one `use_skill` tool instead of one tool per skill (`src/desktop/agent/DesktopAgentBootstrap.ts:474`). This is the right model: many user skills behind one small model-facing gateway. The tool-management design should keep that shape and avoid exploding skills into separate function schemas.

### A2A skills currently become direct tools

`A2AToolAdapter.adaptSkill()` converts each remote A2A skill into an individual function tool with a generic `message` parameter (`src/core/a2a/A2AToolAdapter.ts:95`). `registerA2ASkills()` registers every remote skill into the registry (`src/core/a2a/A2AToolAdapter.ts:233`).

That is the same scaling risk as MCP: useful for execution, too large for always-on model exposure.

## Claudy Findings

Claudy controls tool overwhelm in layers.

1. It builds a full internal tool pool, then filters by feature flags, permissions, mode, and `isEnabled()`.
2. It marks MCP tools and `shouldDefer` tools as deferred, unless a tool explicitly opts out with `alwaysLoad` (`/home/rich/dev/study/claudy/src/tools/ToolSearchTool/prompt.ts:62`).
3. It exposes only non-deferred tools, `ToolSearch`, and previously discovered deferred tools (`/home/rich/dev/study/claudy/src/services/api/claude.ts:1154`).
4. `ToolSearch` searches deferred tool names, descriptions, and `searchHint` (`/home/rich/dev/study/claudy/src/tools/ToolSearchTool/ToolSearchTool.ts:178`).
5. It remembers discovered tool names from message history so selected tools stay available across later requests (`/home/rich/dev/study/claudy/src/utils/toolSearch.ts:545`).
6. It has an auto mode that only enables dynamic loading when deferred tool definitions exceed a percentage of the model context window (`/home/rich/dev/study/claudy/src/utils/toolSearch.ts:712`).

The design lesson is not the Anthropic-specific beta API. The design lesson is the split between:

- internal availability: what the agent may execute;
- model exposure: what schemas the LLM receives now;
- discovery: how the LLM asks for more schemas.

## Design Principles

1. Tool registration and tool exposure must be separate concepts.
2. Permission and policy filtering must run before a tool can be exposed or discovered.
3. Execution approval remains enforced by `ToolRegistry.execute()`, even for dynamically exposed tools.
4. MCP, A2A, and plugin-contributed function tools should default to deferred.
5. Core tools needed for normal operation should stay always-loaded.
6. Skills should stay behind `use_skill` plus metadata, not become one schema per installed skill.
7. The design must work without Anthropic `tool_reference`.
8. Diagnostics must show why a tool was exposed, deferred, hidden, or unavailable.

## Implementation decisions locked 2026-05-18

1. **Provider-neutral only.** Do not add Anthropic `tool_reference`/`defer_loading` support
   in v1. Hydration happens by selecting tool names in BrowserX state and rebuilding the next
   normal model request with those schemas.
2. **Registry remains the execution authority.** Exposure controls what schemas the model
   sees; execution still goes through `ToolRegistry.execute()`, approval, pre-execute gates,
   plan review, skill allow-lists, and policy.
3. **MVP defaults:** built-in/core tools and `tool_search` are always; MCP/A2A/plugin
   function tools are deferred; disabled/admin-hidden tools are hidden; `use_skill` stays
   always when skills exist.
4. **Dynamic loading mode defaults to `auto`, but tests opt in explicitly.** In `auto`, turn
   it on only when deferred schema size exceeds the configured threshold.
5. **Hydration scope is session + active task.** Selected tools persist within the session
   and current task, are recomputed against current policy every request, and are dropped
   from exposure if disabled/hidden later.
6. **Duplicate MCP exposure is removed in this track.** The registry-backed path becomes the
   single model-exposure source for MCP schemas; any existing session `getMcpTools()` path
   must dedupe or stop adding duplicate schemas.

## Proposed Architecture

Add a model-facing exposure layer above `ToolRegistry`.

```text
src/tools/exposure/
|-- ToolExposureTypes.ts       # exposure policy, searchable metadata, selected names
|-- ToolExposureManager.ts     # classifies and filters model-facing tools
|-- ToolSearchTool.ts          # provider-neutral function tool
|-- ToolSearchIndex.ts         # name/description/searchHint matching
|-- ToolSelectionStore.ts      # per-session/turn selected deferred tools
|-- toolExposureConfig.ts      # defaults + config/env parsing
`-- __tests__/
```

`ToolRegistry` remains the source of truth for execution. `ToolExposureManager` decides which registered definitions are sent to a model request.

## Tool Exposure Metadata

Extend registration options with exposure metadata:

```ts
export type ToolExposureMode = 'always' | 'deferred' | 'hidden';

export interface ToolExposureProfile {
  mode?: ToolExposureMode;
  source?: 'builtin' | 'mcp' | 'a2a' | 'skill' | 'plugin' | 'custom';
  searchHint?: string;
  displayName?: string;
  serverName?: string;
  alwaysLoadReason?: string;
}
```

This should live alongside runtime metadata in `ToolRegistryEntry`, but should not be serialized into model-facing schemas unless deliberately needed. Existing tools can default safely:

| Source | Default exposure |
| --- | --- |
| `tool_search` | `always` |
| core planning / settings / web search / memory / browser essentials | `always` initially, then tighten per tool |
| MCP tools | `deferred` |
| A2A tools | `deferred` |
| plugin-contributed function tools | `deferred` |
| `use_skill` | `always` when skills exist |
| dangerous/admin-only tools disabled by policy | `hidden` |

For MCP, `MCPToolAdapter.adaptTool()` should carry `source: 'mcp'`, `serverName`, and a `searchHint` if the MCP `_meta` equivalent exists. If Browserx later supports an `alwaysLoad` MCP annotation, it maps to `mode: 'always'`.

## Provider-Neutral Tool Search Flow

### Initial request

At model-call build time:

1. `ToolExposureManager` reads all registered tools from `ToolRegistry`.
2. It applies existing config gates: `enable_all_tools`, `disabled`, `mcpTools`, `customTools`, platform availability, and future managed policy.
3. It classifies the allowed pool into always-loaded and deferred.
4. It includes:
   - always-loaded tools;
   - `tool_search`;
   - deferred tools already selected for this session/turn.
5. It adds a compact system reminder listing deferred tool names and short descriptions, grouped by source/server.

The model does not receive full schemas for unselected deferred tools.

### Search request

`tool_search` is a normal Browserx function tool:

```json
{
  "name": "tool_search",
  "description": "Search available deferred tools and make selected tools available for the next model request.",
  "parameters": {
    "type": "object",
    "properties": {
      "query": { "type": "string" },
      "max_results": { "type": "integer" },
      "select": {
        "type": "array",
        "items": { "type": "string" }
      }
    },
    "required": ["query"]
  }
}
```

Supported query forms should mirror Claudy:

- exact select: `select:github__create_issue,slack__send_message`;
- keyword search: `github issue`;
- required term search: `+github issue`;
- source/server search: `mcp:github`, `a2a:research`.

The handler returns a compact result:

```json
{
  "matches": [
    {
      "name": "github__create_issue",
      "displayName": "GitHub: create issue",
      "description": "Create a GitHub issue",
      "source": "mcp",
      "selected": true
    }
  ],
  "selected": ["github__create_issue"],
  "totalDeferredTools": 42
}
```

### Hydration

When `tool_search` selects tools, `ToolSelectionStore` records those tool names. On the next model request in the same task/session, `ToolExposureManager` includes the selected schemas in `prompt.tools`.

This is the provider-neutral replacement for Claudy's `tool_reference` blocks. It costs one model/tool round trip when a deferred tool is first needed, but it works across OpenAI Responses, OpenAI-compatible clients, Gemini, and future providers.

## Integration Points

### TurnManager

Replace direct `buildToolsFromContext()` schema construction with:

```ts
const exposure = await toolExposureManager.buildExposure({
  registry: this.toolRegistry,
  toolsConfig,
  sessionId: this.session.sessionId,
  model: this.turnContext.getModel(),
  provider: this.turnContext.getModelClient().getProvider(),
});

const prompt: ModelPrompt = {
  input: exposure.inputWithDeferredToolReminder(input),
  tools: exposure.tools,
  base_instructions_override: baseInstructions,
  user_instructions: this.turnContext.getUserInstructions(),
};
```

`tool_search` execution must update the same selection store before the next model request is built. If the current engine only builds tools once per user turn, this track must adjust the model/tool loop so tool schemas are rebuilt after `tool_search` results.

### ToolRegistry

Add exposure metadata without changing execution semantics:

- store `exposure?: ToolExposureProfile` in `ToolRegistryEntry`;
- expose `entries()` with exposure metadata;
- add `getToolExposureProfile(name)`;
- keep `execute()`, approval, pre-execute gates, and runtime metadata unchanged.

### MCPToolAdapter

Register MCP tools with:

```ts
exposure: {
  mode: 'deferred',
  source: 'mcp',
  serverName,
  searchHint: tool.description,
}
```

Preserve current concurrency/result metadata from MCP annotations.

### A2AToolAdapter

Register remote A2A skills with:

```ts
exposure: {
  mode: 'deferred',
  source: 'a2a',
  serverName: agentName,
  searchHint: skill.description,
}
```

Longer-term, consider replacing many A2A skill schemas with one `use_a2a_skill` gateway, similar to `use_skill`. That should be a phase 3 cleanup, not the MVP.

### Skills

Keep the current split:

- lightweight skill metadata in prompts/typeahead;
- full skill body loaded only via `use_skill`;
- no per-skill function schema explosion.

This track should only improve skill prompt scaling by applying the same compact/delta idea to `buildSkillsSystemPrompt()` if the auto-invocable skill list becomes large.

## Configuration

Add conservative config:

```ts
interface IToolsConfig {
  dynamicToolLoading?: boolean | 'auto';
  dynamicToolLoadingThresholdPercent?: number; // default 10
  alwaysLoadTools?: string[];
  deferTools?: string[];
  hiddenTools?: string[];
}
```

Defaults:

- extension: `auto`;
- desktop: `auto`;
- server: `auto`;
- tests: explicit off unless test opts in.

`auto` should enable dynamic loading when estimated deferred schema size exceeds 10% of the model context window, matching Claudy's threshold idea. Use exact token estimation if available; otherwise use a stable character heuristic.

## Search Ranking

`ToolSearchIndex` should be deterministic and cheap:

1. exact selected names first;
2. exact server/source/name-part matches;
3. required `+term` filter;
4. `searchHint` matches;
5. description matches;
6. stable tie-break by tool name.

No embeddings in v1. The index should be rebuilt only when tool registry generation changes.

## Prompt Shape

Add a compact reminder only when deferred tools exist:

```text
<available-deferred-tools>
Some tools are available through tool_search. Search or select them when needed.
- github__create_issue: [mcp/github] Create a GitHub issue
- slack__send_message: [mcp/slack] Send a Slack message
</available-deferred-tools>
```

For large installs, cap the list by source:

```text
<available-deferred-tool-sources>
- mcp/github: 18 tools. Search with "mcp:github issue".
- mcp/slack: 12 tools. Search with "mcp:slack send".
- a2a/research: 5 tools. Search with "a2a:research".
</available-deferred-tool-sources>
```

This avoids moving the bloat from schemas into prose.

## Phased Plan

### Phase 1: Exposure metadata and filtering

- Add `ToolExposureProfile`.
- Add exposure metadata to MCP and A2A registration.
- Add `ToolExposureManager`.
- Add tests proving built-in tools remain visible and MCP/A2A tools can be deferred.

### Phase 2: `tool_search` and selection store

- Register `tool_search` as always-loaded, read-only, concurrency-safe.
- Implement deterministic search and exact select.
- Store selected tool names per session/task.
- Rebuild model-facing tools after `tool_search` runs.

### Phase 3: Auto mode and diagnostics

- Estimate deferred tool schema size.
- Enable dynamic loading only above threshold.
- Emit diagnostics for exposed/deferred/hidden/selected counts.
- Add `/doctor` or settings visibility for tool exposure state.

### Phase 4: Prompt compaction and plugin polish

- Replace long deferred-tool name lists with source summaries for very large installs.
- Let plugin manifests declare `alwaysLoad`, `deferred`, `hidden`, and `searchHint`.
- Add user override UI for always-load/defer/hidden policy.

## File-level implementation plan

1. Add `src/tools/exposure/` with `ToolExposureTypes.ts`,
   `ToolExposureManager.ts`, `ToolSearchIndex.ts`, `ToolSelectionStore.ts`,
   `ToolSearchTool.ts`, and tests.
2. Extend `ToolRegistrationOptions` / `ToolRegistryEntry` with
   `exposure?: ToolExposureProfile`; add read APIs for exposure-aware entries without
   changing execution semantics.
3. Update MCP, A2A, and plugin tool registration to set exposure metadata.
4. Register `tool_search` in all bootstraps that register model-facing tools.
5. Replace `TurnManager.buildToolsFromContext()`'s direct "all tools" behavior with
   `ToolExposureManager.buildExposure(...)`.
6. After a `tool_search` call, update `ToolSelectionStore` and rebuild model-facing tools
   before the next model request in the same turn/task.
7. Add diagnostics counters/events for always/deferred/hidden/selected tools and prompt
   schema size estimates.

## Validation

Unit tests:

- `ToolExposureManager` filters disabled and hidden tools before search.
- MCP/A2A/plugin tools default to deferred.
- `alwaysLoadTools` overrides default deferral.
- exact `select:` search returns selected tools even with low `max_results`.
- required `+term` search filters correctly.
- selected deferred tools are included in the next model-facing tool list.
- selected tools are not executable if later disabled by config/policy.

Integration tests:

- a turn with many MCP tools initially sends only core tools plus `tool_search`;
- after a `tool_search` call, the next model request includes the selected schema;
- OpenAI Responses and Gemini clients receive the same selected tool set;
- approval still fires for dynamically selected tools;
- sub-agent cloned registries preserve exposure metadata but respect child allow/deny constraints.

Performance checks:

- tool schema count and estimated chars before/after dynamic loading;
- search latency for 1k deferred tools;
- prompt cache stability when no tools are added or removed.

## Risks

### One extra round trip

Provider-neutral hydration requires a search call before first use. That is acceptable for large installs because it trades occasional latency for dramatically lower baseline context and schema cost.

Mitigation: keep common core tools always-loaded and allow users/plugins to mark high-frequency tools as `always`.

### Model may not search when needed

If the reminder is too terse, the model may say a capability is unavailable.

Mitigation: keep `tool_search` description explicit, group deferred sources clearly, and add evals where the correct behavior is to search before refusing.

### Config and policy drift

A tool selected earlier may become disabled later.

Mitigation: selected tool names are only hints. Every request recomputes allowed tools from current config and policy before exposure.

### Duplicate MCP paths

Browserx currently has registry-registered MCP tools and a session `getMcpTools()` path. This track should collapse model exposure to one deduped path, preferably registry-first, so the same MCP tool is not emitted twice.

## Out Of Scope

- Replacing `ToolRegistry`.
- Changing approval semantics.
- Embedding-based semantic tool search.
- Anthropic-specific `tool_reference` support.
- Turning every skill into a function tool.

## Success Criteria

1. Installing many MCP/A2A/plugin tools no longer linearly increases the initial model tool schema payload.
2. Built-in browser workflows still work without a search round trip.
3. The model can discover and use deferred tools in the same task.
4. Execution approval and policy enforcement are unchanged.
5. Diagnostics explain tool exposure decisions clearly enough to debug "why can't the model see this tool?"
