# Track 35 — Tasks

Cross-track integration bug. See `design.md` for evidence (file:line).

## Phase 1 — BUG-1 (High): config change invalidates the model-client cache

- [x] 1.1 Add a construction-signature to `ModelClientFactory` `cacheKey` (`:184`) including
      `parallelToolCalls` and any other config read during client construction.
- [x] 1.2 Subscribe in `RepublicAgent` to every config section that feeds client construction
      (`model`, `tools`, and provider/routing/auth-affecting sections if present), clear the
      factory cache, and refresh the turn context's model client for the next turn.
- [x] 1.3 Audit every config mutation path and implement the chosen fix so tools-derived
      client config invalidates/rebuilds consistently, not only through desktop/server
      `agent.configUpdate` hot-swap or extension session re-create flows.
- [x] 1.4 Test: toggle `parallelToolCalls` mid-session → next turn's payload reflects it;
      model A→B→A returns a current-config client, not the stale cached one.

## Phase 2 — BUG-2 (Med): per-turn/per-tool hook snapshot

- [x] 2.1 Snapshot the matching hook set once per tool execution; PreToolUse,
      PermissionRequest, PostToolUse, and PostToolUseFailure for one tool use the same
      generation.
- [x] 2.2 Ensure a `section:'hooks'` reload still applies from the next tool execution
      boundary.
- [x] 2.3 Test: hooks change between Pre and Post of one tool execution → both phases use
      one generation; new hooks active next turn.

## Exit criteria

- A mid-session `parallelToolCalls` (or model) change is reflected on the next turn's model
  client (no stale cached client).
- A single tool execution always uses one consistent hook generation across Pre/Post.
