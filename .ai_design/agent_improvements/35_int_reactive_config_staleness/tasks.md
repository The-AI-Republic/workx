# Track 35 — Tasks

Cross-track integration bug. See `design.md` for evidence (file:line).

## Phase 1 — BUG-1 (High): config change invalidates the model-client cache

- [ ] 1.1 Choose fix: (a) fold construction-time-resolved inputs (incl.
      `parallelToolCalls`) into `ModelClientFactory` `cacheKey` (`:184`), or (b)
      `RepublicAgent` subscribes to `section:'tools'` (and other client-feeding sections)
      and calls `modelClientFactory.clearCache()` before re-create.
- [ ] 1.2 Implement chosen fix.
- [ ] 1.3 Test: toggle `parallelToolCalls` mid-session → next turn's payload reflects it;
      model A→B→A returns a current-config client, not the stale cached one.

## Phase 2 — BUG-2 (Med): per-turn/per-tool hook snapshot

- [ ] 2.1 Snapshot the matching hook set once per turn (or per tool execution); PreToolUse
      and PostToolUse for one tool use the same generation.
- [ ] 2.2 Ensure a `section:'hooks'` reload still applies from the next turn boundary.
- [ ] 2.3 Test: hooks change between Pre and Post of one tool execution → both phases use
      one generation; new hooks active next turn.

## Exit criteria

- A mid-session `parallelToolCalls` (or model) change is reflected on the next turn's model
  client (no stale cached client).
- A single tool execution always uses one consistent hook generation across Pre/Post.
