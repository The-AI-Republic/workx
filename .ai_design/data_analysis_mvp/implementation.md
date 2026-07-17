# WorkX Data Analysis MVP Implementation

Status: Implemented on `agent/data-analysis-mvp`
Date: 2026-07-17

## Delivered scope

The desktop runtime now supports multiple saved PostgreSQL and MySQL data sources. Each source has independent connection metadata, a versioned keychain password, policy and allowlists, connection/schema lifecycle, and revisioned semantic context. Agent sessions share the runtime and native connection pools while every query remains serialized per source.

The model-facing surface is transport-neutral:

- `data_list_sources` selects an authorized configured source.
- `data_describe` discovers allowed schema and adds non-stale business context.
- `data_query` validates and runs one bounded, parameterized, read-only SQL statement.
- `data_get_context` returns current, schema-checked business meaning.
- `data_learn_context` uses a fact in the current turn and durably records exact user-provided evidence for later turns.

The same `DataSourceRegistry` and `DataSourceConnector` contracts can register future native or MCP connectors without changing these tools or the context store. MCP execution itself remains outside this MVP.

WorkX now also has a general on-demand managed component runtime under `~/.workx/components`, with DuckDB 1.5.4 as its first trusted component. It provides explicit installation consent, pinned platform artifacts, exact-size and SHA-256 verification, atomic install/repair, health checks, leases, bounded process execution, and ephemeral workspace lifecycle. This supplies the delivery foundation for future cross-source analysis; bounded staging and orchestration are still outside the SQL-query MVP.

## Implementation map

- Core contracts, validation, persistence, secrets, registry, runtime, SQL policy, limits, and learning: `src/core/data-sources/`
- PostgreSQL/MySQL drivers and shared pool/schema utilities: `src/desktop-runtime/data-sources/`
- Agent tools, risk checks, progress, and prompt guidance: `src/tools/data-sources/`
- Runtime management services and desktop bootstrap: `src/core/services/data-sources-services.ts` and `src/desktop-runtime/`
- Settings, context editor, query progress, notifications, View, and Undo: `src/webfront/settings/DataSourcesSettings.svelte` and `src/webfront/data-sources/`
- Sidecar package verification: `scripts/build-desktop-runtime-sidecar.mjs`
- Managed components, DuckDB catalog, runner, and workspaces: `src/core/components/`, `src/desktop-runtime/components/`, and `.ai_design/component_runtime/design.md`

## Safety properties

- Passwords are stored only in versioned OS-keychain entries and are absent from source DTOs, prompts, query arguments, audit records, and tool results. A private SQLite index tracks only source IDs and version numbers so startup cleanup never depends on unsupported OS-keychain enumeration.
- Only attended primary sessions owned by the local desktop runtime may use data tools or management services.
- SQL passes dialect-aware AST validation twice, uses typed parameters, executes inside a read-only transaction, and is wrapped with a row sentinel limit.
- Source allowlists are applied in policy validation, discovery SQL, and normalized discovery results.
- Per-source queues, wall/statement timeouts, cancellation, pool invalidation, and shutdown prevent stale or abandoned work from being reused.
- Results and all agent-visible catalog/context responses are capped below WorkX's oversized-result threshold.
- Context learning requires exact text from the immutable original user turn, enforces source/schema identity, preserves revisions, reports conflicts, and supports conflict-safe undo.

## Compatibility and accepted limits

- Supported databases: PostgreSQL 12+ and Oracle MySQL 8.0+ (MariaDB is rejected).
- Desktop native runtime only. Extension, server, scheduler, connector, remote, unattended, and sub-agent access fail closed.
- Read-only SQL only. No writes, generic SQL console, cross-source joins, notebooks, charting, or MCP data connector implementation.
- Results are bounded after driver decoding. One unusually large value can therefore allocate driver memory before truncation; cursor/streaming execution is a follow-up.
- Query results sent to the active model remain in local conversation history under the current WorkX rollout behavior.

## Verification

The committed suite covers configuration, validation, storage transactions, crash reconciliation, secret rotation/deletion, registry lifecycle, source concurrency, access/origin denial, SQL security corpora, parameter codecs, output limits, schema staleness, context learning and undo, PostgreSQL/MySQL driver behavior, runtime services, UI workflows, and sidecar packaging.

Local completion evidence:

- `npm run type-check` passes.
- `npx vitest run` passes 9,856 tests; 10 tests are skipped, including the two opt-in live database cases.
- `npm run lint` exits successfully with no errors; the new data-source paths have no lint warnings.
- `npm run test:rust` passes 33 tests.
- `npm run build:desktop` and `npm run build:server` pass.
- `npm run build:desktop-runtime-sidecar` passes the isolated driver/parser/native-addon checks.

Live PostgreSQL/MySQL, clean-install/upgrade, OS networking, and macOS/Windows package acceptance require their respective database and platform release environments. Those are verification gates, not unfinished runtime code.

Optional live connector acceptance tests use disposable databases when the following variables are present:

```bash
WORKX_TEST_POSTGRES_URL='postgresql://reader:password@127.0.0.1:5432/workx_test?workxTls=disable' \
WORKX_TEST_MYSQL_URL='mysql://reader:password@127.0.0.1:3306/workx_test?workxTls=disable' \
npx vitest run src/desktop-runtime/data-sources/native/__tests__/native-connectors.integration.test.ts
```

The test accounts must be dedicated least-privilege readers. The suite skips live cases when their URL is not configured; all deterministic connector contract tests still run.
