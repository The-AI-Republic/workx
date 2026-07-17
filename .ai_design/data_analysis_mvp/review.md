# WorkX Data Analysis MVP End-to-End Design Review

Status: Approved for implementation
Review date: 2026-07-16
Reviewed artifacts: `design.md`, `tasks.md`, and the current WorkX desktop/runtime integration code

## 1. Verdict

The design is implementable end to end without another architecture decision. It covers multiple native PostgreSQL/MySQL connections, safe agent querying, immediate and durable semantic context, desktop settings, lifecycle and crash recovery, packaging, and a stable connector boundary for future MCP/native hybrid support.

There are no open design blockers. The items explicitly deferred by design sections 3/31 and review section 7 are product limitations, not missing implementation decisions. Implementation is accepted only when the final acceptance scenarios in `tasks.md` pass for both PostgreSQL and MySQL.

## 2. Review Basis

The review traced the proposal through these existing seams:

- Desktop bootstrap and shutdown: `src/desktop-runtime/WorkXRuntimeBootstrap.ts` and `src/server/agent/ServerAgentBootstrap.ts`.
- Per-session platform/tool registration: `DesktopRuntimePlatformAdapter`, `registerDesktopTools.ts`, and `ToolRegistry`.
- User submission/turn flow: `RepublicAgent`, `EngineOp`, `RegularTask`, `TurnManager`, and `Session`.
- Runtime services and channel identity: `ServiceRegistry`, `registerAllServices`, `ChannelManager`, and `StdioRuntimeChannel`.
- Durable storage and credentials: `ServerStorageProvider`, `StorageProvider`, and `ControlFrameCredentialStore`.
- Desktop settings and event UI: `Settings.svelte`, `SettingsMenu.svelte`, `settingsSearchRegistry.ts`, `EventProcessor`, `SystemEvent.svelte`, and `ToolExecutionProgress`.
- Sidecar packaging: `vite.config.desktop-runtime.mts` and the isolated sidecar entry self-test.

The review also exercised the selected SQL parser against PostgreSQL `$1`, MySQL `?`, CTE, and union serialization shapes. Committed parser-corpus and packaged-build tests remain mandatory; the design-time check is not treated as a security guarantee.

## 3. Findings and Resolutions

| ID    | Area             | Finding in the current code/design seam                                                                                                   | Locked resolution                                                                                                                                                                                 | Status   |
| ----- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| DR-01 | Bootstrap        | The first agent session is created before general service registration, so late data-runtime setup would omit its tools.                  | Initialize the desktop data runtime after storage/credentials and before `AgentRegistry`/the initial session; expose a non-fatal runtime handle for services.                                     | Resolved |
| DR-02 | Shutdown         | Bootstrap does not close the global storage provider and active queries may outlive ordinary pool close.                                  | Mark the data runtime stopping, drain queues, destroy active checked-out connections, and dispose connectors before channel/session cleanup; do not depend on storage close.                      | Resolved |
| DR-03 | Turn evidence    | `Session.getCurrentTurnItems()` drains pending input and is not the immutable original user request.                                      | Snapshot original user text and origin in `RepublicAgent.submitOperation()` before funnel/hooks, then thread it through the task.                                                                 | Resolved |
| DR-04 | Provenance       | Tool calls currently receive generated per-call turn identifiers, which cannot group query and learned context reliably.                  | Reuse the engine submission ID as the stable turn ID for all tool calls in one task.                                                                                                              | Resolved |
| DR-05 | Tool metadata    | Generic `ToolContext` does not safely expose the origin/evidence needed by data policies.                                                 | Add a narrow immutable data-tool metadata seam; give current user text only to context learning and repeat checks in handlers.                                                                    | Resolved |
| DR-06 | Remote access    | A globally shared service registry and internal app-server sessions could otherwise reach desktop database capabilities.                  | Authorize only attended, local, non-internal primary sessions owned by `desktop-runtime-main`; deny app-server, scheduler, connector, synthetic, and sub-agent origins in assessor and handler.   | Resolved |
| DR-07 | Channel trust    | `StdioRuntimeChannel` currently allows untrusted frame context to overwrite adapter-owned identity fields.                                | Reverse merge precedence and regression-test spoofed `channelId`/`channelType`; guard every `dataSources.*` service.                                                                              | Resolved |
| DR-08 | Service envelope | `ChannelManager` already constructs `ServiceResponse`; another `{success,data}` layer would break UI contracts.                           | Data-source handlers return typed DTOs directly and throw typed errors.                                                                                                                           | Resolved |
| DR-09 | Storage          | The provider rejects unknown collections, transactions cannot list, and async savepoints can interleave.                                  | Add five allowlisted collections, maintain catalog/context/secret-version indexes, and serialize all data-source SQLite mutations with one process mutex.                                         | Resolved |
| DR-10 | Credentials      | Overwriting one keychain password cannot provide crash-safe metadata/secret atomicity, and native OS keychains cannot enumerate accounts. | Use versioned password accounts, track only account versions in a non-secret SQLite index, reconcile orphans from that index at startup, and use durable deletion tombstones.                     | Resolved |
| DR-11 | Stale state      | A successful test or least-privilege acknowledgement can become stale after connection/password edits.                                    | Separate `revision` from `connectionRevision`; bind tests, acknowledgements, pools, and schema caches to the connection revision. Save-time connection tests are mandatory and must be reachable. | Resolved |
| DR-12 | SQL execution    | An earlier flow could be read as executing the validated query and then its limiting wrapper.                                             | Execute exactly one analytical statement: the connector-owned wrapper around AST-serialized `safeSql`. Integration fixtures assert one statement.                                                 | Resolved |
| DR-13 | Cancellation     | Public driver contracts do not provide one uniform safe cancellation path, and uncertain transactions must not return to pools.           | On abort/client wall timeout, destroy the checked-out connection; restore MySQL session timeout state before healthy release.                                                                     | Resolved |
| DR-14 | Result shape     | Object rows silently lose duplicate column labels in joins.                                                                               | Use array rows aligned to column metadata for both native SQL connectors.                                                                                                                         | Resolved |
| DR-15 | Output size      | WorkX has an oversized-result persistence path and drivers decode values before a post-fetch limiter.                                     | Cap every agent data response below 40,000 serialized characters and disclose/test that one pathological cell can allocate before truncation. Streaming is deferred.                              | Resolved |
| DR-16 | UI events        | There is no separate learned-context protocol event or generic action model.                                                              | Reuse typed `ToolExecutionProgress`, correlate it in `EventProcessor`, and add conflict-safe View/Undo actions to processed system events.                                                        | Resolved |
| DR-17 | Packaging        | Drivers/parser must work from the isolated bundled sidecar and optional native PostgreSQL code must not leak into release artifacts.      | Bundle the pure-JS path, prohibit `pg.native`, and extend the packaged entry self-test for both drivers/dialects/placeholders.                                                                    | Resolved |
| DR-18 | Extensibility    | Native and MCP transports need different mechanics without changing agent behavior or stored business meaning.                            | Keep `DataSourceRegistry` as source/router state and `DataSourceConnector` as transport behavior; normalize all results through `DataSourceRuntime`.                                              | Resolved |

## 4. Requirement Traceability

| Product requirement       | Design contract                                                                                                        | Implementation/acceptance coverage                                 |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Multiple connections      | One persisted `DataSource` per logical source; one lazy pool per source and connection revision                        | Tasks phases 2, 3, 5, 6, 7; four-source final scenario             |
| PostgreSQL and MySQL      | Two native connectors behind the same connector interface                                                              | Tasks phases 6 and 7; shared integration and packaging suites      |
| Natural-language analysis | Generic list/describe/query tools plus prompt behavior and bounded normalized results                                  | Tasks phases 4, 9, 12; unambiguous/ambiguous query scenarios       |
| Immediate user context    | Original user statement remains in the active turn and informs schema/query generation                                 | Tasks phase 8 evidence seam and phase 9 behavioral tests           |
| Durable user context      | Per-source revisioned facts with exact user evidence, schema association, notification, and Undo                       | Tasks phases 8 and 11; new-session and conflict scenarios          |
| Read-only safety          | Least-privileged account, AST policy, allowlists, read-only transaction, timeout, limit, approval, and handler recheck | Tasks phases 3, 4, 6, 7, 9 and security acceptance corpus          |
| Secret safety             | OS keychain, secret-free DTOs, versioned replacement, redaction, and crash reconciliation                              | Tasks phases 2, 10, 13 and crash/seeded-secret scenarios           |
| Desktop-only MVP          | Profile-specific bootstrap/tools plus origin, owner, and service-channel authorization                                 | Tasks phases 3, 9, 10 and remote-origin denial scenario            |
| Future native/MCP hybrid  | Stable source, connector, capabilities, normalized-result, and MCP binding contracts                                   | Design section 17; intentionally no MCP implementation task in MVP |

## 5. Implementation Critical Path

Implement in the phase order in `tasks.md`. The critical dependency chain is:

```text
contracts/config
  -> storage + versioned secrets
  -> registry/runtime/access policy
  -> SQL policy + bounded result contract
  -> native pool infrastructure
  -> PostgreSQL/MySQL connectors
  -> context/evidence seam
  -> tools/risk/services/bootstrap
  -> settings/progress UI + prompt
  -> privacy, packaging, and full acceptance
```

Do not start the UI against ad hoc service shapes, and do not connect real databases before the SQL policy, parameter codec, access policy, and result limiter have executable tests. Connector integration should use the same semantic fixture data so result and context behavior can be compared across dialects.

## 6. Merge Gates

The feature is not ready to merge until all of these are true:

1. Typecheck and existing extension/server/desktop suites pass with the feature enabled and disabled.
2. The parser rejection corpus and one-statement assertions pass for both dialects.
3. Disposable PostgreSQL and MySQL suites pass query, timeout, cancellation, normalization, pooling, invalidation, and shutdown tests.
4. Failure-injection tests pass for secret replacement, source commit, deletion tombstones, and restart reconciliation.
5. Local/remote origin, app-server session, service-channel spoofing, and approval-`yolo` bypass tests all fail closed.
6. Seeded secrets are absent from SQLite, config, logs, telemetry, events, snapshots, and returned DTOs.
7. Query/context progress cards, new-session context reuse, and conflict-safe Undo pass UI/runtime integration tests.
8. Packaged sidecars on Linux, macOS, and Windows import both drivers/parser dialects, preserve placeholders, and contain no PostgreSQL native addon.
9. Every final acceptance scenario in `tasks.md` is checked off with evidence.

## 7. Accepted MVP Limitations

- PostgreSQL 12+ and MySQL 8.0+ only.
- Desktop native access only; app-server, extension, scheduled, connector, and sub-agent data access is denied.
- Read-only SQL only; no console, writes, cross-source joins, Python, notebooks, or charting.
- MCP data connectors are contract-ready but not implemented.
- Server CA TLS configuration is supported; client certificate and cloud/IAM auth are deferred.
- Bounded query tool output and assistant answers remain in local WorkX conversation history under current rollout behavior.
- Post-fetch limits cannot prevent a single pathological value from being decoded into driver memory; cursor/streaming execution is a required hardening follow-up.

These limitations must be disclosed in the alpha UI/release notes. None changes the MVP implementation path.

## 8. Sign-off

`design.md` is the normative architecture and contract document. `tasks.md` is the executable implementation and verification checklist. This review records why those contracts fit the existing WorkX code and which conditions constitute end-to-end completion.
