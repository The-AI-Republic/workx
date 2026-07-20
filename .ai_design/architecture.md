# WorkX Runtime Architecture

WorkX uses one shared agent core with extension, desktop-runtime, and headless-server
shells. Platform bootstraps own storage, authentication, browser capabilities, channels,
and graph assembly; the core owns session lifecycle and agent behavior.

## Session lifecycle

`SessionManager` is the only owner of live `RepublicAgent` graphs on every platform. It
coordinates durable thread metadata, graph construction, config/auth propagation,
capacity, submission ordering, event sequencing, attach/replay, suspension, and deletion.
`AgentRegistry` remains only as a deprecated export alias for external consumers during
the rename window.

```text
webfront / scheduler / API
           |
       service RPC
           |
     SessionManager
      |     |     |
      |     |     +-- per-session event gate + replay ring -> ChannelManager
      |     +-------- ThreadIndexStore + rollout snapshots
      +-------------- platform AgentAssembler -> complete disposable graph
```

Extension and desktop-runtime use client lifecycle mode. `session.open` creates only a
durable `thread_index` row; the first correlated `session.submit` hydrates the graph.
Idle eligible graphs are suspended by deterministic LRU when `maxLive` is reached, while
`hardMax` bounds parallel bursts. Headless server remains eager. Scheduled/API capacity
is independent from client-managed interactive capacity, and internal infrastructure
sessions retain their bypass.

Runtime states are `suspended`, `hydrating`, `idle`, `running`, `suspending`, and
`deleting`. Durable history and the thread index survive suspension; delete is
tombstone-first and hard purge removes the index row last.

## Construction and identity

`ExtensionAgentAssembler` and `ServerAgentAssembler` implement the shared
`AgentAssembler` contract. The manager reserves the authoritative session ID before any
await and rejects an assembled graph whose `Session.sessionId` differs. Each graph owns
its prompt loader, platform adapter, tool registry, plugin bindings, and cleanup stack.
Cleanup is reason-aware (`suspend`, `delete`, `shutdown`, or `assembly-failed`) and
idempotent.

Bootstraps own one `MutableAuthContext`. Model token closures read it at call time, while
the manager subscribes once for identity rebuilds. Likewise, the manager is the sole
`AgentConfig` subscriber and applies the exhaustive config-impact map with
`Promise.allSettled` isolation. Hydration captures auth/config generations and rebuilds
before publishing if either changed during assembly.

## Storage and attach

`ThreadIndexStore` is the bounded list/search source for the UI. IndexedDB and SQLite
both expose `thread_index`; startup and the first `session.list` reconcile legacy session
rows and rollout metadata. Rollout records remain the durable conversation source.

The UI acquires a surface lease, starts buffering live events, then calls
`session.attach`. Attach returns an immutable rollout snapshot plus a bounded replay batch
through one sequence boundary. The UI applies snapshot, replay, and the uncovered live
tail in that order. A truncated replay is refreshed from the committed snapshot when the
runtime reaches IDLE.

## Browser isolation

Core tools use `SessionBrowserResources`, never global Chrome tab state. Extension
sessions own a `TabGroupRegistry` allocation through `ExtensionPlatformAdapter`; desktop
bridge requests carry `sessionId` and keep per-session current-tab state. Background work
cannot focus a page. Foreground-required work emits `browser_attention_required` and
continues only after a matching viewed surface resolves the request.

## Platform overview

| Platform | Bootstrap | Lifecycle | Durable stores | Browser capability |
|---|---|---|---|---|
| Extension | `service-worker.ts` | client | IndexedDB | session-owned Chrome tab group |
| Desktop | `ServerAgentBootstrap` desktop-runtime profile | client | SQLite | session-scoped desktop bridge |
| Headless server | `ServerAgentBootstrap` server profile | eager | SQLite/files | server adapter / configured browser |

See [SESSION_LIFECYCLE_RPC.md](../docs/SESSION_LIFECYCLE_RPC.md) and
[SESSION_LIFECYCLE_SUPPORT.md](../docs/SESSION_LIFECYCLE_SUPPORT.md) for wire and
operational contracts.
