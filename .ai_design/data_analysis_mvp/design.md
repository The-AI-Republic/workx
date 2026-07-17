# WorkX Data Analysis MVP Design

Status: Implemented; local verification complete, disposable-database and cross-platform release acceptance remain environment gates
Date: 2026-07-16
Target: WorkX Desktop (`desktop-runtime` profile)
Review: End-to-end implementation review completed; see `review.md`

## 1. Executive Summary

Add a built-in, read-only data-analysis capability to WorkX Desktop. A user can configure multiple remote PostgreSQL and MySQL data sources, ask a natural-language question, and let the agent discover the schema, generate SQL, execute it safely, and analyze the bounded result.

The MVP is designed around generic data-source abstractions so later releases can add other SQL databases, NoSQL databases, warehouses, lakehouses, APIs, and MCP-backed sources without replacing the agent tools or semantic-context system.

The key architectural decisions are:

1. Use `DataSource` as the persisted logical connection model.
2. Use `DataSourceConnector` as the technology/transport adapter.
3. Use `DataSourceRegistry` as the runtime catalog and connector router.
4. Use `DataSourceRuntime` as the policy-enforcing facade called by tools and UI services.
5. Implement `PostgresNativeConnector` and `MySqlNativeConnector` for the MVP.
6. Keep one runtime-scoped connector registry and pool set, shared by every agent session.
7. Store connection metadata in the desktop SQLite-backed `StorageProvider` and passwords in the OS keychain.
8. Expose stable generic agent tools: `data_list_sources`, `data_describe`, `data_query`, `data_get_context`, and `data_learn_context`.
9. Execute only read-only, single-statement queries with least-privileged database credentials, dialect-aware validation, read-only transactions, timeouts, row limits, result limits, and per-source concurrency limits.
10. Treat user-provided business meaning as both immediate turn context and durable per-source semantic context. Clear durable facts are learned automatically by default through the normal model tool loop, with visible notification and conflict-safe undo.
11. Keep semantic context attached to the logical data source, independent of whether access is native or through MCP.
12. Make data-sharing behavior explicit: bounded query results are sent to the active model and, under the current WorkX rollout behavior, stored in local session history.

The MVP is complete when one desktop installation can configure and use multiple PostgreSQL/MySQL sources concurrently, answer read-only analytical questions, retain user-provided semantic meaning, and enforce the safety and privacy rules in this document.

## 2. Goals

- Configure multiple PostgreSQL and MySQL sources from WorkX Desktop settings.
- Connect directly from the Node desktop runtime sidecar to remote databases over TCP/TLS.
- Keep credentials out of agent prompts, tool arguments, logs, config files, and tool results.
- Let the agent select a source, inspect its schema and semantic context, generate SQL, execute it, and explain the result.
- Support ambiguous schemas through user-managed and automatically learned business context.
- Use user-provided context in the current request and save durable facts for future sessions.
- Keep native connection pools shared across all live agent sessions.
- Provide stable abstractions for future native and MCP-backed connectors.
- Provide understandable query provenance in the UI: source, SQL, duration, returned rows, and truncation status.
- Fail closed when SQL cannot be validated or source policy cannot be enforced.
- Restrict source management and agent querying to authorized local desktop turns in the MVP; app-server, scheduler, connector, and sub-agent turns do not inherit database access.

## 3. Non-goals

- Database writes, DDL, stored-procedure execution, administrative commands, or a generic SQL console.
- A user-approved escape hatch for write queries. The MVP has no write execution path.
- Cross-server SQL joins.
- Downloading entire tables or using WorkX as an ETL system.
- Python, pandas, notebook execution, chart creation, or local statistical runtimes.
- SSH tunnels, bastion hosts, VPN management, cloud IAM database authentication, OAuth database authentication, or rotating cloud tokens.
- Client certificate authentication. Server CA configuration is supported; client cert/key authentication is deferred.
- SQLite, SQL Server, Oracle, MongoDB, Elasticsearch, Snowflake, BigQuery, Redshift, Databricks, or other connectors in the MVP.
- MCP data connectors in the MVP. The abstraction and binding contract are defined now; implementation is deferred.
- Extension and headless-server support. The first release is desktop-runtime only.
- Automatically inferring and persisting business meanings from observed data values without a user statement.
- Proving that an arbitrary database function or future MCP tool has no external side effects.
- Ephemeral/non-persisted tool-output support in the core rollout system. The privacy implications and follow-up are documented explicitly.
- A strict transport-level byte cap on data read from the database before driver decoding. The MVP strictly caps rows sent to the model and serialized tool output, but a single unusually large database value can still consume driver memory before post-fetch truncation; streaming/cursor execution is a required follow-up.

## 4. Terminology

### DataSource

A persisted logical source that the user can select, for example `Production Sales`. It contains non-secret connection metadata, access policy, business description, and a reference to semantic context.

Multiple `DataSource` records may use the same connector.

### DataSourceConnector

A runtime adapter that knows how to communicate with a technology and transport. Examples:

- `PostgresNativeConnector`
- `MySqlNativeConnector`
- Future `SnowflakeMcpConnector`

A connector owns technology-specific connection lifecycle, schema discovery, query validation/execution, type normalization, cancellation, and safe error mapping.

### DataSourceRegistry

The runtime catalog and router. It knows which sources and connector implementations exist. Given a source ID, it resolves the `DataSource` and the correct connector.

The registry is not a database pool and does not implement SQL dialect behavior.

### DataSourceRuntime

The application-facing facade used by agent tools and UI service handlers. It composes the registry, persistent stores, credential resolver, semantic-context service, common policy checks, result limiter, and audit sink.

### Semantic context

Durable business meaning not reliably available from a physical schema: table meanings, enum mappings, units, metric definitions, joins, exclusions, timezones, and caveats.

## 5. Current WorkX Integration Points

WorkX already has the required runtime seams:

- The desktop agent runs in a Node sidecar through `src/desktop-runtime/WorkXRuntimeBootstrap.ts`.
- Desktop-runtime sessions use `DesktopRuntimePlatformAdapter`, which inherits desktop tool registration.
- Desktop tools are registered from `src/desktop/tools/registerDesktopTools.ts` into each session's `ToolRegistry`.
- The desktop runtime owns the real credential store through `ControlFrameCredentialStore` and Rust `keychain.*` control frames.
- Non-secret durable data can use the existing desktop SQLite-backed `StorageProvider`.
- Runtime UI operations use shared `ServiceRegistry` handlers registered by `registerAllServices`.
- `ToolRegistry` already supports risk assessors, read-only/concurrency metadata, dynamic exposure, progress, and result-size thresholds.
- `MCPManager` already owns MCP server lifecycle and invocation, providing the future transport seam.

The implementation must follow the post-cutover architecture: the Svelte WebView is a UI client; it must not open database sockets, construct database pools, or read stored database passwords.

## 6. Target Architecture

```text
Svelte Data Sources settings
        |
        | dataSources.* runtime services
        v
Desktop runtime sidecar (one process)
  |
  +-- DataSourceRuntime -----------------------------------------------+
  |     |                                                              |
  |     +-- DataSourceStore -------- desktop storage.db                 |
  |     +-- DataContextStore ------- desktop storage.db                 |
  |     +-- DataSourceSecretStore -- OS keychain via Rust control frame |
  |     +-- DataSourceRegistry                                         |
  |     |     +-- postgres-native -> PostgresNativeConnector -> pg pools
  |     |     +-- mysql-native ----> MySqlNativeConnector ----> mysql2 pools
  |     |     +-- future MCP ------> McpDataSourceConnector ---> MCPManager
  |     +-- QueryPolicy / ResultLimiter / AuditSink                     |
  |
  +-- per-session ToolRegistry
        +-- data_list_sources
        +-- data_describe
        +-- data_query
        +-- data_get_context
        +-- data_learn_context
```

One `DataSourceRuntime` instance is created for the desktop sidecar. Every agent session registers tool handlers that reference that shared instance. Consequently, five chat sessions querying the same source share the same connector and pool rather than creating five pools.

## 7. Locked Architecture Decisions

### 7.1 Generic internally, native first

The physical folder and type names use `data-source`, not `database`, even though the first connectors are SQL databases. The model-facing tools use `data_*` names. Do not register duplicate `db_*` aliases in the MVP; duplicate schemas make tool selection less reliable. User-facing copy may say “database connection” where that is clearer.

### 7.2 The runtime owns all data access

The WebView manages sources only through runtime services. Agent tools and connector code run in the Node sidecar. Rust/Tauri remains the OS-keychain boundary but does not execute SQL.

### 7.3 One runtime, multiple sources and pools

The registry supports any number of saved sources. Each native connector lazily creates at most one pool per source ID. Pools are not created during app startup or source listing.

### 7.4 Read-only is categorical

The MVP never accepts or executes a write query, even after approval. If a user asks WorkX to change data, the agent explains that the connection is read-only.

### 7.5 Semantic context is source-owned

Context is keyed by logical `sourceId`, not connector ID. Changing transport later does not discard accumulated knowledge.

### 7.6 Clear user facts are learned automatically

The default learning mode is `automatic`. Clear, durable, connection-scoped facts stated by the user are used immediately, then saved after schema resolution/query execution and shown with an Undo action. Temporary report instructions are not promoted.

“Automatic” here is an agent behavior implemented by prompt + tool contracts in the same model loop, not a deterministic background classifier. The model is required to call `data_learn_context`; no second LLM call is introduced. Acceptance tests use a deterministic model fixture to verify the two-call query/learn behavior, and product telemetry may count safe success/error codes but never inspect fact text.

### 7.7 No special intent-classification service

The normal model tool-selection loop decides when to use data tools. Tool descriptions and a prompt fragment define the expected behavior. Do not add a separate LLM call solely to classify “data analysis intent.”

## 8. Core Contracts

Create platform-neutral types under `src/core/data-sources/`.

### 8.1 DataSource

```ts
export type DataSourceCategory = 'sql' | 'nosql' | 'warehouse' | 'lakehouse' | 'api';

export type DataSourceTransport =
  | { type: 'native' }
  | {
      type: 'mcp';
      serverId: string;
      bindingId: string;
    };

export type DataLearningMode = 'automatic' | 'ask' | 'off';
export type DataQueryApprovalMode = 'auto_read' | 'ask_each_query';

export interface DataSourcePolicy {
  agentAccessEnabled: boolean;
  readOnly: true;
  maxRows: number; // persisted range 1..1000, default 200
  timeoutMs: number; // persisted range 1000..60000, default 15000
  maxConcurrentQueries: 1; // fixed to 1 in MVP
  allowedNamespaces: string[]; // PostgreSQL schemas; MySQL database/schema
  allowedObjects: string[]; // qualified table/view names; [] means all visible
  queryApproval: DataQueryApprovalMode;
  learningMode: DataLearningMode;
  leastPrivilegeAcknowledgement?: {
    connectionRevision: number;
    acknowledgedAt: string;
  };
}

export interface DataSourceTlsConfig {
  mode: 'disable' | 'require' | 'verify-full';
  caPem?: string;
}

export interface NativeSqlConnectionConfig {
  host: string;
  port: number;
  database: string;
  username: string;
  tls: DataSourceTlsConfig;
}

export interface DataSource {
  version: 1;
  revision: number; // starts at 1; incremented on every persisted update
  connectionRevision: number; // changes only when connection/secret changes
  id: string; // UUID
  name: string;
  description: string;
  category: 'sql'; // MVP
  connectorId: 'postgres-native' | 'mysql-native';
  transport: { type: 'native' };
  connection: NativeSqlConnectionConfig;
  businessTimezone: string; // validated IANA timezone
  isDefault: boolean;
  enabled: boolean;
  lifecycleState: 'active' | 'deleting';
  secretVersion: number; // keychain reference, not secret material
  policy: DataSourcePolicy;
  createdAt: string;
  updatedAt: string;
  lastTest?: DataSourceTestSummary;
}
```

Passwords are intentionally absent. Reject host strings containing a URL scheme, username, password, path, or query string. The runtime may accept an advanced connection URI in a future UI, but it must parse and strip secrets before persistence.

`revision` is the optimistic-concurrency token for every management edit. `connectionRevision` is the pool/schema-cache identity and increments only when connector, transport, host, port, database, username, TLS configuration, or password changes. `lastTest` is usable for agent access only when its `connectionRevision` equals the source's current value. `lifecycleState='deleting'` is a durable tombstone: it is never agent-visible and is resumed during startup cleanup.

### 8.2 Connector capabilities

```ts
export interface DataSourceCapabilities {
  queryLanguages: Array<'sql' | 'mongodb-pipeline' | 'elasticsearch-dsl' | 'graphql'>;
  schemaDiscovery: 'full' | 'partial' | 'none';
  supportsParameters: boolean;
  supportsPagination: boolean;
  supportsCancellation: boolean;
  readOnlyGuarantee: 'database' | 'connector' | 'declared' | 'unknown';
  resultShapes: Array<'tabular' | 'documents' | 'scalar'>;
}
```

For both MVP connectors, `queryLanguages=['sql']`, schema discovery is `full`, parameters and cancellation are supported, and results are tabular. `readOnlyGuarantee` is calculated per source test rather than hard-coded.

### 8.3 Connector

```ts
export interface DataSourceConnector {
  readonly id: string;

  getCapabilities(source: DataSource): DataSourceCapabilities;

  testConnection(
    source: DataSource,
    secret: DataSourceSecret,
    signal?: AbortSignal
  ): Promise<DataSourceTestResult>;

  describe(
    source: DataSource,
    secret: DataSourceSecret,
    request: DataDescribeRequest,
    signal?: AbortSignal
  ): Promise<DataSourceDescription>;

  validateQuery(source: DataSource, request: DataQueryRequest): DataQueryValidation;

  query(
    source: DataSource,
    secret: DataSourceSecret,
    request: DataQueryRequest,
    signal?: AbortSignal
  ): Promise<DataResult>;

  invalidateSource(sourceId: string): Promise<void>;
  dispose(): Promise<void>;
}
```

`invalidateSource` closes the source pool and clears connector-local cache after update/delete/password replacement. `dispose` closes every pool during sidecar shutdown.

### 8.4 Registry

```ts
export class DataSourceRegistry {
  registerConnector(connector: DataSourceConnector): void;
  unregisterConnector(connectorId: string): Promise<void>;

  upsertSource(source: DataSource): void;
  removeSource(sourceId: string): Promise<void>;
  listSources(): DataSource[];
  getSource(sourceId: string): DataSource;
  getConnector(sourceId: string): DataSourceConnector;

  dispose(): Promise<void>;
}
```

The registry loads source records from `DataSourceStore` during runtime initialization. Persistence remains the store's responsibility; connector resolution remains the registry's responsibility.

### 8.5 Runtime facade

```ts
export interface DataSourceRuntime {
  listSources(
    options: { agentVisibleOnly?: boolean; search?: string; cursor?: string },
    access: { kind: 'management' } | { kind: 'agent'; principal: DataAccessPrincipal }
  ): Promise<DataSourceSummaryPage>;
  listManagementSources(): Promise<DataSourcePublicView[]>;
  getSource(sourceId: string): Promise<DataSourcePublicView>;
  createSource(input: CreateDataSourceInput): Promise<DataSourcePublicView>;
  updateSource(sourceId: string, input: UpdateDataSourceInput): Promise<DataSourcePublicView>;
  deleteSource(sourceId: string, expectedRevision: number): Promise<void>;
  testSource(
    sourceId: string,
    expectedRevision: number,
    signal?: AbortSignal
  ): Promise<SavedDataSourceTestResult>;
  testCandidate(
    input: TestDataSourceCandidateInput,
    signal?: AbortSignal
  ): Promise<DataSourceTestResult>;

  describe(
    request: DataDescribeRequest,
    principal: DataAccessPrincipal,
    signal?: AbortSignal
  ): Promise<DataSourceDescription>;
  query(
    request: DataQueryRequest,
    principal: DataAccessPrincipal,
    signal?: AbortSignal
  ): Promise<DataResult>;

  getContext(
    sourceId: string,
    access: { kind: 'management' } | { kind: 'agent'; principal: DataAccessPrincipal }
  ): Promise<DataSourceContext>;
  learnContext(
    request: LearnDataContextRequest,
    turn: DataLearningTurn
  ): Promise<LearnContextResult>;
  updateContext(sourceId: string, input: ManualContextUpdate): Promise<DataSourceContext>;
  listContextRevisions(sourceId: string): Promise<DataContextRevisionSummary[]>;
  revertContext(
    sourceId: string,
    targetRevision: number,
    expectedCurrentRevision: number
  ): Promise<DataSourceContext>;

  dispose(): Promise<void>;
}
```

Agent tools receive only the analytical/context subset. UI services receive management methods. The model is never given create/update/delete/test-candidate operations.

### 8.6 Supporting DTOs

The following shapes are part of the implementation contract; implementations may split them across files but must preserve the secret/public boundaries.

```ts
export interface DataSourceSecret {
  password: string;
}

export interface DataAccessPrincipal {
  sessionId: string;
  turnId: string;
  origin: InputOrigin;
  attended: boolean;
  desktopUiSession: boolean;
}

export interface DataSourceSummary {
  id: string;
  name: string;
  description: string;
  category: DataSourceCategory;
  connectorId: string;
  transport: 'native' | 'mcp';
  businessTimezone: string;
  isDefault: boolean;
  capabilities: Pick<DataSourceCapabilities, 'queryLanguages' | 'schemaDiscovery' | 'resultShapes'>;
}

export interface DataSourceSummaryPage {
  sources: DataSourceSummary[];
  nextCursor?: string;
}

export interface DataSourcePublicView {
  source: Omit<DataSource, 'secretVersion'>; // management UI only
  passwordConfigured: boolean;
}

export interface DataSourceReadOnlyAssessment {
  level: 'verified' | 'warning' | 'unknown';
  reasons: string[];
  userAcknowledgementRequired: boolean;
}

export interface DataSourceTestSummary {
  status: 'reachable' | 'error';
  testedAt: string;
  connectionRevision: number;
  latencyMs: number;
  tlsActive?: boolean;
  readOnlyAssessment: DataSourceReadOnlyAssessment;
  errorCode?: DataSourceErrorCode;
}

export interface DataSourceTestResult extends DataSourceTestSummary {
  connectorId: string;
  databaseProduct?: string; // unavailable for failures before server identity is known
  databaseVersionFamily?: string;
  currentDatabase?: string;
  visibleNamespaceCount?: number;
  warnings: string[];
}

export interface SavedDataSourceTestResult {
  test: DataSourceTestResult;
  source: DataSourcePublicView;
}

export type EditableDataSourcePolicy = Omit<DataSourcePolicy, 'leastPrivilegeAcknowledgement'>;

export type CreateDataSourceFields = Omit<
  DataSource,
  | 'id'
  | 'version'
  | 'revision'
  | 'connectionRevision'
  | 'lifecycleState'
  | 'secretVersion'
  | 'createdAt'
  | 'updatedAt'
  | 'lastTest'
  | 'policy'
> & {
  policy: EditableDataSourcePolicy;
};

export interface CreateDataSourceInput {
  source: CreateDataSourceFields;
  password: string;
  leastPrivilegeAcknowledged: boolean;
}

export interface UpdateDataSourceInput {
  expectedRevision: number;
  patch: Partial<CreateDataSourceFields>;
  passwordAction: 'keep' | 'replace';
  password?: string;
  leastPrivilegeAcknowledged?: boolean;
}

export interface TestDataSourceCandidateInput {
  source: CreateDataSourceFields;
  password: string;
}
```

Validation limits are locked for the MVP: at most 100 sources; source name 1..100 characters after trim; description 0..2,000; host 1..253; database and username 1..128; password 1..4,096 without trimming; CA PEM at most 64 KiB; 100 allowed namespaces; 1,000 allowed objects. Normalize unique names with trim, Unicode NFKC, and locale-independent lowercase comparison. A default source must be active, enabled, and agent-accessible; disabling or hiding the current default clears it transactionally.

Create and connection-affecting update operations always repeat the connection test at save time. A prior `testCandidate` result is preview-only and is never trusted as proof for a later save. The save succeeds only when this fresh test is reachable; the MVP has no “save offline and enable later” path. Warning/unknown read-only assessments require the explicit acknowledgement in that same save request. The runtime creates the acknowledgement record and timestamp—the client cannot submit or edit it directly. Metadata-only edits retain the current connection test; connection/secret edits increment `connectionRevision`, replace `lastTest` with the new result, and reset/re-record least-privilege acknowledgement.

Agent-safe list operations return `DataSourceSummary`; they never return `DataSourcePublicView` or `DataSource.connection`.

Describe contracts:

```ts
export interface DataObjectRef {
  namespace: string;
  name: string;
  qualifiedName: string;
  kind: 'table' | 'view';
  comment?: string;
}

export interface DataFieldDescription {
  name: string;
  databaseType: string;
  nullable: boolean;
  defaultExpression?: string;
  comment?: string;
  primaryKey: boolean;
}

export interface DataRelationshipDescription {
  from: { object: string; fields: string[] };
  to: { object: string; fields: string[] };
}

export interface DataObjectDescription extends DataObjectRef {
  fields: DataFieldDescription[];
  relationships: DataRelationshipDescription[];
  contextFacts: DataContextFact[];
}

export interface DataSourceDescription {
  source: DataSourceSummary;
  scope: 'catalog' | 'objects';
  objects: Array<DataObjectRef | DataObjectDescription>;
  nextCursor?: string;
  schemaFingerprint: string;
  renderedContext?: string;
  warnings: string[];
}
```

Internal query validation contract:

```ts
export type DataQueryValidation =
  | {
      valid: true;
      dialect: 'postgresql' | 'mysql';
      safeSql: string; // serialized accepted AST, before runtime outer limit
      referencedObjects: string[];
      placeholderCount: number;
    }
  | {
      valid: false;
      code:
        | 'QUERY_PARSE_FAILED'
        | 'QUERY_NOT_READ_ONLY'
        | 'QUERY_MULTIPLE_STATEMENTS'
        | 'QUERY_OBJECT_DENIED'
        | 'QUERY_PARAMETER_MISMATCH'
        | 'QUERY_SHAPE_UNSUPPORTED';
      message: string;
    };
```

Tool input limits are also enforced before parsing or connector dispatch: SQL at most 50,000 characters, purpose at most 500, at most 100 parameters, each string/date parameter at most 16 KiB, and at most 64 KiB of parameter text in total. PostgreSQL placeholders may reuse an index but must form a contiguous `$1..$n` set matching the parameter array; MySQL `?` occurrences must match exactly. Counts come from the parsed/tokenized representation, not regex over comments or string literals.

## 9. Persistence and Secrets

### 9.1 Collections

Use the existing desktop `StorageProvider` rather than adding a second application database.

| Collection                      | Key                             | Value                                            |
| ------------------------------- | ------------------------------- | ------------------------------------------------ |
| `data_sources`                  | `sourceId`                      | `DataSource`                                     |
| `data_source_catalog`           | `catalog`                       | `DataSourceCatalog` name/default/source-ID index |
| `data_source_contexts`          | `sourceId`                      | current context plus retained revision numbers   |
| `data_source_context_revisions` | `${sourceId}:${revisionPadded}` | immutable revision snapshot                      |

```ts
export interface DataSourceCatalog {
  version: 1;
  sourceIds: string[]; // deterministic default/name/ID order
  normalizedNameToId: Record<string, string>;
  defaultSourceId?: string;
}

export interface DataSourceContextEnvelope {
  version: 1;
  current: DataSourceContext;
  retainedRevisions: number[]; // ascending, includes current revision
}
```

Use zero-padded revision keys such as `sourceId:00000012` so prefix listing remains ordered. Context revision retention defaults to the latest 50 revisions per source.

The current desktop provider rejects collection names outside `ServerStorageProvider.VALID_COLLECTIONS`; implementation must add all four names there and to the shared `CollectionName` type. Tables remain lazily created, so no standalone SQL migration is required. `DataSourceCatalog` is authoritative for case-folded name uniqueness, ordered source IDs, and the single default ID. On first boot with source records but no catalog, rebuild it only if records are internally consistent; duplicate names or multiple defaults fail the data-source subsystem closed with `DATA_SOURCE_STORE_CORRUPT`.

The provider's `Transaction` supports only `get`, `set`, and `delete`, not `list`. The catalog therefore makes every source invariant addressable by known keys inside one transaction. The stored context envelope similarly carries its retained revision numbers so a context write can set the current snapshot, add the immutable revision, and delete the oldest revision atomically without listing inside the transaction.

`ServerStorageProvider` uses savepoints on one SQLite connection and an async callback, so `DataSourceStore` and `DataContextStore` share one process-local async mutation mutex. All data-source SQLite transactions run under this mutex and contain no network or keychain calls. Callers rely on callback auto-commit and do not call `tx.commit()`/`tx.abort()` directly.

Do not store query results, schema caches, or database passwords in these collections.

### 9.2 Credential keys

Use the existing `CredentialStore`:

```text
service = data-source
account = <sourceId>:password:v<secretVersion>
value   = database password
```

The actual desktop service is prefixed by `ControlFrameCredentialStore`, for example `workx-data-source` depending on the host prefix.

Add `DataSourceSecretStore` as a narrow wrapper. Connector and service code must not call generic credential services directly.

```ts
export interface DataSourceSecretStore {
  getPassword(sourceId: string, version: number): Promise<string | null>;
  setPassword(sourceId: string, version: number, value: string): Promise<void>;
  deletePassword(sourceId: string, version: number): Promise<void>;
  deleteAllPasswordVersions(sourceId: string): Promise<void>;
  reconcileReferencedVersions(references: Map<string, number>): Promise<void>;
}
```

Versioned accounts make password replacement crash-safe without ever persisting an old password for compensation. Startup reconciliation may list account names for the private `data-source` service and delete versions not referenced by an active/tombstoned source; it never returns that list through a service or tool.

### 9.3 Write ordering

Source create:

1. Validate/normalize the complete source and test the candidate connection using the in-memory password.
2. Require acknowledgement when the test assessment is warning/unknown.
3. Generate source ID, set `revision=1`, `connectionRevision=1`, `secretVersion=1`, and attach the fresh `lastTest`.
4. Write password version 1 to keychain.
5. In one SQLite transaction, write the source, catalog, empty context, and context revision 1.
6. If persistence fails, best-effort delete password version 1; startup reconciliation removes it after a crash.
7. Register the active source in memory.

Source update:

1. Require `expectedRevision` and reject stale edits.
2. Validate the complete merged source.
3. For a connection-affecting change, resolve the kept password or use the replacement password, test the complete candidate, and require any warning acknowledgement before mutation.
4. For password replacement, write `secretVersion+1` first. Never overwrite the referenced keychain entry.
5. In one SQLite transaction, increment `revision`, increment `connectionRevision` for any connection/secret change, update `secretVersion` when replaced, attach the fresh test, update catalogue invariants, and persist.
6. If SQLite persistence fails, delete the unreferenced new secret version. The old version remains authoritative.
7. Replace the registry entry and invalidate the old pool/cache before accepting another operation.
8. Best-effort delete the old secret version; startup reconciliation cleans it if interrupted.

Source delete:

1. Persist `lifecycleState='deleting'`, `enabled=false`, `agentAccessEnabled=false`, and clear default status; mirror the tombstone in the registry so no new operation starts.
2. Cancel queued work, abort the active query by destroying its checked-out connection, and close pool/cache with a bounded wait.
3. Delete every versioned password account. If this fails, retain the tombstone and return a retryable deletion error.
4. In one SQLite transaction, delete source/current/revision records and update the catalog.
5. Remove the registry entry. If step 4 fails, the secretless tombstone remains safe and startup cleanup retries it.

Startup first completes `deleting` tombstones, then reconciles unreferenced secret versions, then exposes active sources. Context update and revision creation occur in one `StorageProvider.transaction` under the shared mutation mutex.

Source names are case-insensitively unique in the MVP. At most one source is the default. Creating/updating a source with `isDefault=true` clears the flag on the previous default in the same storage transaction before refreshing the registry.

### 9.4 Public views

No service or tool returns `connection.username`, `connection.host`, `caPem`, or password to the model. Management UI services may return host, port, database, username, and TLS mode, but return only `passwordConfigured: boolean` for the password.

## 10. Semantic Context Model

Use structured facts plus a freeform overview. Structured facts enable deduplication, conflict detection, schema association, and future scoped retrieval; the overview supports business explanations that do not fit a fixed shape.

```ts
export type DataContextFactKind =
  | 'object_meaning'
  | 'field_meaning'
  | 'enum_value'
  | 'unit'
  | 'metric_definition'
  | 'join_hint'
  | 'exclusion_rule'
  | 'timezone_rule'
  | 'caveat'
  | 'other';

export interface DataContextSubject {
  namespace?: string;
  object?: string;
  field?: string;
}

export interface DataContextFact {
  id: string;
  kind: DataContextFactKind;
  subject: DataContextSubject;
  assertion: string;
  structuredValue?: {
    value?: string;
    meaning?: string;
    unit?: string;
  };
  status: 'active' | 'superseded';
  provenance: {
    source: 'user_chat' | 'settings';
    sessionId?: string;
    turnId?: string;
    evidenceQuote?: string;
    createdAt: string;
  };
  confidence: 'user_asserted';
  schemaFingerprint?: string;
}

export interface DataSourceContext {
  version: 1;
  sourceId: string;
  revision: number;
  overviewMarkdown: string;
  facts: DataContextFact[];
  createdAt: string;
  updatedAt: string;
}

export interface DataLearningTurn {
  principal: DataAccessPrincipal;
  currentUserText: string;
  durableLearningEligible: boolean;
}

export interface LearnContextResult {
  sourceId: string;
  priorRevision: number;
  currentRevision: number;
  addedFacts: DataContextFact[];
  deduplicatedFactIds: string[];
}

export interface ManualContextFactInput {
  kind: DataContextFactKind;
  subject: DataContextSubject;
  assertion: string;
  structuredValue?: DataContextFact['structuredValue'];
}

export type ManualContextFactOperation =
  | { operation: 'add'; fact: ManualContextFactInput }
  | { operation: 'replace'; factId: string; fact: ManualContextFactInput }
  | { operation: 'supersede'; factId: string };

export interface ManualContextUpdate {
  expectedRevision: number;
  overviewMarkdown?: string;
  factOperations?: ManualContextFactOperation[];
}

export interface DataContextRevisionSummary {
  revision: number;
  createdAt: string;
  createdBy: 'user_chat' | 'settings';
  activeFactCount: number;
}
```

Context limits are: overview Markdown 20,000 characters; at most 1,000 total facts; assertion 1..2,000; evidence quote 8..500 after trim; each structured value/meaning/unit 1,000; and at most 100 manual fact operations per request. Manual settings edits use the same limits. Context storage may contain business-sensitive meaning, but rejects credential-like values and bulk/raw-record payloads before write.

Manual context operations are atomic. `replace` supersedes the prior fact and adds a new settings-provenance fact; it never mutates revision history. Automatic learning is additive only. If any learned fact conflicts with active context, the entire learn call fails with `CONTEXT_CONFLICT` and writes no partial revision; deduplicated facts are returned only on otherwise successful calls.

The MVP does not assign model-generated confidence scores. A learned fact is stored only as `user_asserted`; model guesses are not facts.

### 10.1 Learning policy

The agent must distinguish:

- Immediate context: always use the user's statement for the current request.
- Session context: remains available in the current conversation.
- Durable source context: save clear facts for future sessions.

Automatically eligible examples:

- `ord_hdr.st = 2 means paid`.
- `amt is stored in cents`.
- `cust_mst contains customers`.
- `sales excludes test customers`.
- `last month uses America/Los_Angeles`.

Not automatically durable:

- `For this report, exclude California`.
- `This time, count pending orders`.
- Questions, guesses, and hypotheticals.
- Raw result rows or personal data.
- Any credential or token.

### 10.2 `automatic`, `ask`, and `off`

- `automatic`: save clear, validated, non-conflicting facts and show an Undo notification.
- `ask`: use facts now, then ask before calling `data_learn_context`.
- `off`: use facts in the current/session context only.

### 10.3 Evidence and provenance

`data_learn_context` requires an exact `evidence_quote` copied from the current user turn. Do **not** use `Session.getCurrentTurnItems()`: that method drains the pending-input queue and does not represent the original user submission.

Instead, `RepublicAgent.submitOperation()` captures an immutable `DataTurnSnapshot` from only user-supplied text/clipboard items **before** the input funnel, mention expansion, hooks, or synthetic notifications add content. It also records `InputOrigin`. The snapshot is threaded through `EngineOp` -> `RegularTask` -> `TurnManager`. `RegularTask` supplies the engine submission ID as the stable `turnId`; `TurnManager` reuses that ID for every tool call in the task instead of generating a timestamp ID per call.

```ts
export interface DataTurnSnapshot {
  currentUserText: string;
  origin: InputOrigin;
  durableLearningEligible: boolean; // false for scheduler/synthetic/sub-agent input
}
```

`ToolRegistry` adds a narrow data-tool metadata seam. Data tools receive an immutable origin/principal summary; only `data_learn_context` receives `currentUserText`. `ApprovalContext` gets those fields only for data tools so the synchronous risk assessors can verify access/evidence. File handles, hook state, browser URL, and user text are not broadcast to unrelated tools. The handler independently repeats the normalized substring and origin checks before writing.

Evidence matching applies Unicode NFKC, normalizes CRLF to LF, trims each side, and collapses whitespace runs, but remains case-sensitive and does not remove punctuation. The normalized 8..500-character quote must be a substring of normalized `currentUserText`; one quote may support multiple closely related facts, but every fact carries a verified quote.

Automatic durable learning is allowed only for direct attended desktop user submissions in the MVP (`origin.channel='local'`). Scheduler, app-server/remote, connector, hook-added, synthetic notification, and sub-agent prompts may use facts in their current model context but cannot persist them automatically. This prevents an indirect agent or remote client from poisoning durable source meaning.

If evidence cannot be verified, automatic persistence is rejected with `CONTEXT_EVIDENCE_MISSING`. The agent may still use the information for the current request and can ask the user to confirm a proposed update.

### 10.4 Schema association and conflicts

Before automatically saving a table/field fact:

1. Resolve the target source.
2. Use schema discovery to verify the named object/field when it is explicit.
3. Store the current schema fingerprint.
4. Compare against active facts with the same kind and subject.

Exact duplicates are no-ops. Compatible facts are merged. Contradictory facts return `CONTEXT_CONFLICT`; the agent must use the newest user statement only after resolving the contradiction when it materially changes the current answer, and must not replace durable context silently.

### 10.5 Context retrieval

`data_describe` includes relevant facts automatically. `data_get_context` returns the full current context when the model needs broader business definitions.

For the MVP, cap the full rendered context at 20,000 characters. If the source exceeds the cap, prioritize:

1. Facts attached to requested objects/fields.
2. Metric definitions and exclusions.
3. Timezone rules.
4. Source overview.
5. Remaining active facts by newest update.

The UI always shows the full stored context and revision history.

## 11. Native SQL Connectors

### 11.1 Dependencies

Add production dependencies to the root package and desktop-runtime bundle:

- `pg@^8.22.0` for PostgreSQL.
- `mysql2@^3.23.0` for MySQL.
- `node-sql-parser@5.4.0` for dialect-aware defensive AST validation; pin the parser exactly because AST/serialization behavior is part of the security contract.
- `@types/pg@^8.20.0` as a development dependency.

Import dialect-specific SQL parser entrypoints when feasible to avoid bundling every supported dialect. The parser is a defense-in-depth validator, not the primary security boundary.

These versions were reviewed on 2026-07-16. `pg`, `mysql2`, and `node-sql-parser` are pure JavaScript in this path; never enable `pg.native`. The existing desktop-runtime Vite configuration has `ssr.noExternal=true`, so bundle them rather than adding new external runtime packages. Extend the sidecar entry self-test to import both drivers, instantiate both dialect parsers, and round-trip `$1`/`?` placeholders from the isolated packaged tree. If Vite leaves an unresolved optional `pg-native` import, fail the build and add an explicit build-time false stub; do not copy or ship `pg-native`.

MVP compatibility targets:

- PostgreSQL 12 or newer.
- MySQL 8.0 or newer.

TLS mapping is explicit: `disable` uses no TLS; `require` encrypts but permits an unverified server certificate and must show a warning; `verify-full` verifies the certificate chain and hostname using the supplied CA or platform trust roots. Never silently downgrade TLS after a handshake failure. Do not set client key/certificate fields in the MVP.

### 11.2 Pool defaults

Pools are keyed by `sourceId` and created lazily.

```text
maximum pool clients       2
minimum pool clients       0
connect timeout            5 seconds
idle client timeout        60 seconds
max concurrent data_query  1 per source
queued data_query calls     4 per source, FIFO
query queue wait timeout    5 seconds, then QUERY_BUSY
default statement timeout  15 seconds
maximum statement timeout  60 seconds
```

`data_describe` and connection testing use the same pool but do not bypass the connector's bounded acquisition timeout. A source-level semaphore serializes `data_query`; source tests and schema reads may use the second pool slot.

On credential/config replacement, close the old pool before the next operation. On idle network failure, discard the failed client and let the pool establish a new one. Do not advertise a permanent “connected” state; UI status is `untested`, `testing`, `reachable`, `error`, or `in_use`.

### 11.3 PostgreSQL execution

Use one checked-out `pg` client for the complete operation:

1. `BEGIN READ ONLY`.
2. Set transaction-local statement, lock, and idle-in-transaction timeouts using runtime-clamped integer values.
3. Execute **exactly one** data statement: the connector-owned outer-limit wrapper around `safeSql`, through extended query mode with the user's bound parameters and `rowMode: 'array'`.
4. `ROLLBACK` in `finally` when the connection remains healthy.
5. Release a healthy client; on abort/client-wall-timeout, destroy the checked-out connection so PostgreSQL cancels work on disconnect and never return uncertain transaction state to the pool.

The user query must never be concatenated into transaction-control SQL. The only concatenation involving it is the post-validation outer wrapper around AST-serialized `safeSql`; transaction-control statements are static except for runtime-generated clamped integer timeout literals. Do not depend on node-postgres private cancellation APIs.

### 11.4 MySQL execution

Use one checked-out `mysql2/promise` connection:

1. Ensure multi-statements are disabled in connection options.
2. `START TRANSACTION READ ONLY`.
3. Read the current session `MAX_EXECUTION_TIME`, set it to the runtime-clamped policy value using an integer generated by WorkX, and remember the prior value.
4. Execute **exactly one** data statement: the connector-owned outer-limit wrapper around `safeSql`, with the user's parameters and array rows.
5. `ROLLBACK` in `finally` when healthy.
6. Restore `MAX_EXECUTION_TIME` before release; destroy the connection on cancellation, client-wall-timeout, restore failure, or uncertain state.

MySQL read-only transactions can still modify temporary tables. AST policy must reject DDL/DML, and source setup must require a least-privileged account.

### 11.5 Query row limiting

The MVP uses a dialect-specific outer wrapper for validated top-level `SELECT` queries. `SqlReadOnlyPolicy` serializes the accepted single AST back to `safeSql`; connectors wrap that serialized output rather than the original model string:

```sql
SELECT * FROM (<validated-user-query>) AS workx_limited_result
LIMIT <policy-maxRows-plus-one>
```

The limit is an integer produced by runtime policy, never model input. The validator must prove through tests that serialization preserves placeholders and parameter order for every accepted query shape. If a valid dialect construct cannot be safely serialized/wrapped, fail closed with `QUERY_SHAPE_UNSUPPORTED`; do not execute unbounded SQL. A later connector revision may replace wrapping with streaming cursors.

`node-sql-parser@5.4.0` was manually checked during design review for PostgreSQL `$1`, MySQL `?`, PostgreSQL CTE, and `UNION ALL` serialization. That check is evidence for the choice, not a substitute for the committed dialect corpus and packaged-build tests.

The extra row determines `truncated=true` and is not returned.

### 11.6 Type normalization

Return JSON-safe values:

- Preserve `NULL` as `null`.
- Preserve booleans as booleans.
- Preserve safe integers as numbers.
- Return `BIGINT`, arbitrary-precision numeric/decimal, and monetary values as strings.
- Return dates/timestamps as ISO strings and include database type metadata.
- Return JSON columns as JSON values when safe and bounded.
- Replace binary/blob values with `{ omitted: true, type, bytes }`.
- Truncate any individual textual cell over 4,000 characters with an explicit marker.

Native SQL rows are represented as arrays aligned to `columns`, not objects. This preserves duplicate column labels from joins and avoids silent last-key-wins data loss.

## 12. SQL Safety Model

No single layer is sufficient. Apply all layers.

### 12.1 Least-privileged account

The connection UI states that a dedicated read-only account is required. Prefer a read replica. The account should have only connect, namespace usage, and select privileges for approved objects. Revoke database/schema creation and temporary-object privileges where supported.

Connection testing reports `readOnlyAssessment` as `verified`, `warning`, or `unknown`, with reasons. It must not claim complete verification merely because a read-only transaction succeeds; functions and privilege inheritance make complete proof impractical.

If verification is `warning` or `unknown`, the user must acknowledge the least-privilege warning before enabling agent access.

Agent access additionally requires `lastTest.status='reachable'`, `lastTest.connectionRevision===source.connectionRevision`, a configured referenced secret, and (when required) `policy.leastPrivilegeAcknowledgement.connectionRevision===source.connectionRevision`. These are runtime gates, not just UI validation.

### 12.2 AST policy

Parse using the connector dialect. Reject parser errors. Require exactly one AST statement. Allow only a top-level `SELECT`/read query.

Recursively reject:

- `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `REPLACE`, or data-modifying CTEs.
- `CREATE`, `ALTER`, `DROP`, `TRUNCATE`, `RENAME`, or `SELECT INTO`.
- `CALL`, `EXECUTE`, prepared-statement control, or stored-procedure invocation syntax.
- `COPY`, bulk load/export, outfile/dumpfile, or file/network access syntax.
- Transaction/session control.
- Permission/role changes.
- Locks such as `FOR UPDATE` and `LOCK IN SHARE MODE`.
- Multiple statements, regardless of comments or delimiters.
- Referenced tables outside source allowlists.

Function calls remain possible for analytics. The database account and transaction boundary remain authoritative because SQL parsing cannot establish that arbitrary user-defined functions have no side effects.

### 12.3 Transaction enforcement

Execute inside database-supported read-only transactions. Always roll back. Use database-side timeouts where supported plus client-side abort/cancellation.

### 12.4 Resource enforcement

- One in-flight analytical query per source.
- Source-configured timeout, clamped to 60 seconds.
- Default 200 rows; hard maximum 1,000.
- Serialize tool output below 40,000 characters so WorkX's 50,000-character tier-1 persistence threshold is not triggered.
- Stop adding rows at the row or output-character boundary and set `truncated=true`.
- Apply the same 40,000-character envelope cap to list/describe outputs; paginate deterministically rather than relying on WorkX oversized-result persistence.
- Do not retry timeouts automatically.
- Permit at most two model correction attempts for ordinary schema/query errors in a user request.

The outer row limit and post-decode cell/output limiter bound data returned to the model, not the driver's allocation for one pathological database value. The UI and alpha documentation state this limitation; aggregate-first prompting, short timeouts, row limits, and least-privileged allowlists reduce exposure. Strict pre-decode byte bounding requires cursor/streaming connector work deferred from the MVP.

### 12.5 Source-only routing

Agent tools accept `source_id`, never a connection URL, host, username, password, MCP server URL, or driver options. The runtime rejects disabled/non-agent-visible sources before connector dispatch.

## 13. Result Contract

```ts
export interface DataColumn {
  name: string;
  databaseType?: string;
  normalizedType:
    | 'null'
    | 'boolean'
    | 'number'
    | 'string'
    | 'date'
    | 'json'
    | 'binary-omitted'
    | 'mixed';
}

export interface DataResult {
  sourceId: string;
  sourceName: string;
  shape: 'tabular' | 'documents' | 'scalar';
  columns?: DataColumn[];
  rows?: unknown[][]; // values align by index with columns; duplicate labels are preserved
  documents?: Array<Record<string, unknown>>;
  value?: unknown;
  rowCount: number;
  truncated: boolean;
  truncationReasons?: Array<'row_limit' | 'result_size' | 'cell_size'>;
  executionMs: number;
  provenance: {
    connectorId: string;
    transport: 'native' | 'mcp';
    queryLanguage: string;
    queryHash: string;
  };
}
```

The agent result omits host, database username, server version, and raw driver error details.

`queryHash` is lowercase hex SHA-256 over `connectorId + "\n" + safeSql`; it excludes parameters so observability cannot recover values. `rowCount` is the number of rows returned after removing the sentinel and applying the character limit, not an estimate of all matching database rows.

## 14. Agent Tool Contracts

Register tools on desktop only and mark them as deferred built-ins with data-analysis search hints. Register them even when no source exists so newly created sources become usable without recreating sessions; `data_list_sources` returns an empty list when appropriate.

### 14.1 `data_list_sources`

Purpose: discover agent-visible sources and select the right source.

Input:

```ts
interface DataListSourcesInput {
  search?: string;
  cursor?: string;
}
```

Output fields:

- `id`
- `name`
- `category`
- `connectorId`
- `description`
- `businessTimezone`
- `isDefault`
- safe capability summary

Return at most 50 sources per page in deterministic default/name/ID order. Cursors are opaque base64url-encoded, schema-versioned offsets bound to the normalized search; malformed/mismatched cursors fail validation. Never return connection coordinates or credentials.

Runtime metadata:

```text
readOnly         true
concurrencySafe  true
destructive      false
risk score       0
```

### 14.2 `data_describe`

Purpose: discover catalog/schema and retrieve relevant semantic context before querying.

```ts
interface DataDescribeRequest {
  source_id: string;
  scope: 'catalog' | 'objects';
  search?: string;
  objects?: string[]; // qualified names for scope=objects
  cursor?: string;
  include_context?: boolean; // default true
}
```

Catalog responses are paginated and capped at 100 objects. Object responses return columns, types, nullable status, primary keys, foreign keys, comments, and attached active facts. Apply source namespace/object allowlists before returning schema.

Runtime metadata: read-only, concurrency-safe, non-destructive, risk 0.

### 14.3 `data_query`

Purpose: execute one bounded, read-only analytical query.

```ts
type DataQueryParameter =
  | { type: 'string'; value: string }
  | { type: 'number'; value: number }
  | { type: 'boolean'; value: boolean }
  | { type: 'null' }
  | { type: 'date'; value: string }; // validated ISO-8601 text

interface DataQueryRequest {
  source_id: string;
  query_language: 'sql';
  query: string;
  parameters?: DataQueryParameter[];
  purpose: string;
}
```

PostgreSQL uses `$1..$n`; MySQL uses `?`. The connector verifies placeholder count. The runtime rejects parameter conversion failures before database execution.

Runtime metadata:

```text
readOnly         true
concurrencySafe  false
destructive      false
risk score       15 by default; source queryApproval may force ask_user
max result       45,000 declared; connector guarantees <40,000 serialized
```

Marking the tool not concurrency-safe also prevents WorkX parallel-tool orchestration from launching sibling data queries together. The source semaphore remains the authoritative cross-session limit.

All analytical handlers require the narrow `DataTurnSnapshot` origin to be local/attended and the session to be an authorized desktop UI session. The runtime/assessor denies scheduler, app-server, connector, remote, synthetic, and sub-agent principals with `DATA_ACCESS_ORIGIN_DENIED`. This is checked again in the handler so approval `yolo` cannot bypass it.

### 14.4 `data_get_context`

```ts
interface DataGetContextInput {
  source_id: string;
}
```

Returns the current rendered context, active structured facts, revision, and last update. It is read-only, concurrency-safe, non-destructive, risk 0.

### 14.5 `data_learn_context`

```ts
interface LearnDataContextFactInput {
  kind: DataContextFactKind;
  namespace?: string;
  object?: string;
  field?: string;
  assertion: string;
  value?: string;
  meaning?: string;
  unit?: string;
  evidence_quote: string;
}

interface LearnDataContextRequest {
  source_id: string;
  facts: LearnDataContextFactInput[];
  reason: string;
}
```

Maximum 10 facts per call. The handler obtains session/turn provenance from `ToolContext`, verifies evidence, validates schema association, detects conflicts, updates context transactionally, and returns added/deduplicated facts plus prior/current revisions. A conflict throws `CONTEXT_CONFLICT` and makes no partial write.

Runtime metadata:

```text
readOnly         false
concurrencySafe  false
destructive      false for additive facts; revert/replacement is UI-only in MVP
risk             auto-approve only when learningMode=automatic and evidence is verified
```

After success, emit `ToolExecutionProgress` through `ToolContext.onProgress` with `type='data_context_learned'`, source ID/name, short fact summaries, new revision, and prior revision. Never include credentials, evidence quotes, or raw rows. `EventProcessor` maps this subtype to a system notification with View/Undo actions. Undo calls revert with both the target prior revision and `expectedCurrentRevision=newRevision`, so a later edit yields `CONTEXT_REVISION_CONFLICT` instead of being overwritten.

`data_query` uses the same existing progress seam with `type='data_query'`: a start event carries source name, purpose, AST-serialized SQL with placeholders, and parameter **types/count only**; completed/failed events carry duration, row count, truncation, and safe error code. `EventProcessor` correlates them by `call_id` into one expandable card. Parameter values and rows never enter progress events. These UI protocol events are local and may be included in the existing local transcript; the structured audit/telemetry path still receives only the query hash.

## 15. Runtime Service API

Add `createDataSourceServices()` and wire it into `registerAllServices` only for the desktop-runtime profile.

| Service                            | Purpose                                          |
| ---------------------------------- | ------------------------------------------------ |
| `dataSources.status`               | Feature availability and supported connector IDs |
| `dataSources.list`                 | Full management-safe source list                 |
| `dataSources.get`                  | Get one management-safe source                   |
| `dataSources.create`               | Create metadata and password                     |
| `dataSources.update`               | Update metadata and password action              |
| `dataSources.delete`               | Delete source, secret, context, pool             |
| `dataSources.test`                 | Test a saved source and CAS-persist `lastTest`   |
| `dataSources.testCandidate`        | Test unsaved form values without persistence     |
| `dataSources.getContext`           | Full context for editor                          |
| `dataSources.updateContext`        | Manual context edit                              |
| `dataSources.listContextRevisions` | Revision history                                 |
| `dataSources.revertContext`        | Restore revision as a new revision               |
| `dataSources.refreshSchema`        | Invalidate schema cache and re-describe          |

```ts
export interface DataSourcesStatus {
  state: 'initializing' | 'ready' | 'unavailable' | 'stopping';
  available: boolean;
  toolsEnabled: boolean;
  connectorIds: string[];
  errorCode?: 'DATA_SOURCES_UNAVAILABLE' | 'DATA_SOURCE_STORE_CORRUPT';
}

// Request payloads before the existing ServiceResponse wrapping.
export type DataSourceServiceRequests = {
  'dataSources.status': Record<string, never>;
  'dataSources.list': Record<string, never>;
  'dataSources.get': { sourceId: string };
  'dataSources.create': CreateDataSourceInput;
  'dataSources.update': { sourceId: string; input: UpdateDataSourceInput };
  'dataSources.delete': { sourceId: string; expectedRevision: number };
  'dataSources.test': { sourceId: string; expectedRevision: number };
  'dataSources.testCandidate': TestDataSourceCandidateInput;
  'dataSources.getContext': { sourceId: string };
  'dataSources.updateContext': { sourceId: string; input: ManualContextUpdate };
  'dataSources.listContextRevisions': { sourceId: string };
  'dataSources.revertContext': {
    sourceId: string;
    targetRevision: number;
    expectedCurrentRevision: number;
  };
  'dataSources.refreshSchema': { sourceId: string };
};
```

Management payload rules:

- Create requires a non-empty password.
- Update uses `passwordAction: 'keep' | 'replace'`; `replace` requires a non-empty password.
- Empty password never means “erase existing password.”
- `create` and every connection/password-affecting `update` repeat the connection test before persistence; `testCandidate` is only an editor preview.
- `test` requires `expectedRevision`; it returns the test plus the updated public view when its source snapshot still matches. A concurrent edit returns `SOURCE_REVISION_CONFLICT` and does not attach a stale test.
- Password is accepted only on create, update, and test-candidate requests; responses never echo it.
- `delete` and context revert require explicit UI confirmation.
- `delete` also requires the current `expectedRevision`; a stale confirmation cannot tombstone a source edited in another window.
- Context revert requires `targetRevision` and `expectedCurrentRevision` and always creates a new revision.
- Agent tools cannot invoke management services through a tool definition.

`ServiceRegistry` handlers return their typed DTO directly; thrown typed errors become the existing failed `ServiceResponse`. Do not add a second `{success,data}` wrapper. Every `dataSources.*` handler, including read methods, verifies `SubmissionContext.channelId==='desktop-runtime-main'` and `channelType==='tauri'`; other channels receive `SERVICE_FORBIDDEN`. This prevents global service registration from exposing connection metadata or arbitrary candidate connection tests to app-server/remote channels.

Before relying on that guard, change `StdioRuntimeChannel` context construction to spread untrusted `frame.context` first and then overwrite `channelId`/`channelType` with adapter-owned values. Add a spoofing regression test. Channel identity must never be caller-overridable.

`dataSources.status` is always registered for desktop runtime. Data-source initialization is non-fatal to the rest of WorkX: if storage/connector initialization fails, status returns `available:false` with a sanitized code, all other data-source services return `DATA_SOURCES_UNAVAILABLE`, and no data tools are registered. Extension and normal server profiles register none of these services.

## 16. End-to-End Workflows

### 16.1 Create and test a source

```text
User opens Data Sources settings
  -> enters PostgreSQL/MySQL structured connection fields
  -> UI calls dataSources.testCandidate
  -> runtime validates fields and retrieves the candidate connector
  -> connector connects with candidate password and TLS policy
  -> connector checks database identity, schema visibility, and read-only posture
  -> UI displays reachable/TLS/read-only assessment
  -> user acknowledges any least-privilege warning
  -> UI calls dataSources.create
  -> runtime repeats the test against the exact candidate being saved
  -> runtime stores versioned password in keychain
  -> runtime atomically stores source/catalog/empty context in storage.db
  -> runtime publishes the registry entry
```

### 16.2 Answer a normal analytical question

User: “What were last month's paid sales?”

```text
Authorized local desktop agent calls data_list_sources or selects an unambiguous default
  -> data_describe catalog/objects with relevant semantic context
  -> if “sales” remains ambiguous, ask user
  -> generate aggregate SQL with explicit date bounds and source timezone
  -> data_query
  -> runtime resolves source and connector
  -> validate source policy, AST, parameters, allowlists
  -> acquire per-source query permit and database client
  -> read-only transaction + timeout + bounded query
  -> normalize and cap result
  -> agent explains result, assumptions, source, and truncation if any
```

### 16.3 Use and learn context in the same request

User: “Show last month's paid sales. In this database `st = 2` means paid and `amt` is in cents.”

```text
Agent uses the two facts immediately
  -> describes schema and resolves source/object/fields
  -> queries WHERE st = 2 and converts cents
  -> after successful resolution/query, calls data_learn_context
  -> runtime verifies exact user evidence and schema association
  -> runtime stores a new context revision
  -> agent answers the current question
  -> UI shows “Saved 2 notes to Production Sales · Undo”
```

The query is the primary action. A context-save failure does not invalidate an otherwise successful query; the final answer reports that the notes were used but could not be saved.

### 16.4 Multiple sources

If only one agent-visible source exists, the model may select it automatically. If a default exists and the question clearly matches its description/context, use it. If multiple sources plausibly match, ask the user rather than guessing.

Queries against different sources can run independently across sessions. Queries against the same source are serialized by the runtime semaphore.

### 16.5 Hybrid analysis in a future release

```text
Question compares native PostgreSQL and MCP warehouse
  -> data_query(source_id=postgres-source)
  -> data_query(source_id=warehouse-mcp-source)
  -> each connector returns normalized DataResult
  -> agent combines small aggregates
```

The MVP must not implement cross-source joins, but its result contract must not prevent this flow.

## 17. MCP and Connector Extensibility

MCP is a transport/tool protocol, not automatically a data-source contract. An arbitrary MCP server may expose incompatible tool names and result shapes.

Future MCP support uses one of two bindings:

1. A WorkX Data MCP profile with known describe/query schemas.
2. A connector-specific binding that maps known MCP tools to the `DataSourceConnector` interface.

```ts
export interface McpDataSourceBinding {
  id: string;
  serverId: string;
  listObjectsTool?: string;
  describeTool?: string;
  queryTool: string;
  cancelTool?: string;
  inputMapping: Record<string, string>;
  outputShape: 'workx-data-result-v1' | 'custom';
  declaredReadOnly: boolean;
}
```

A future `McpDataSourceConnector` calls the existing `MCPManager`, maps arguments/results, and reports capability/trust limits. WorkX can cap returned MCP content, but cannot enforce remote statement timeouts or read-only behavior unless the MCP server contract supports them. Sources with `readOnlyGuarantee='declared'|'unknown'` require stronger approval UI.

MCP-owned credentials remain with the MCP server/auth flow. The logical `DataSource` stores only its MCP server/binding reference.

## 18. Schema Discovery and Cache

### PostgreSQL

Use `information_schema` plus `pg_catalog` where required for:

- Schemas, tables, and views.
- Columns, types, nullability, and defaults.
- Primary/foreign keys.
- Table/column comments.

### MySQL

Use `information_schema` for:

- Tables and views.
- Columns, data types, nullability, and keys.
- Constraints and relationships.
- Table/column comments.

Filter allowed namespaces/objects inside the query and again after normalization. Never rely solely on model-side filtering.

Cache normalized descriptions in memory for 10 minutes, keyed by source ID, `connectionRevision`, allowlist fingerprint, and request scope. Invalidate on connection/allowlist update, manual refresh, connection error suggesting schema change, or connector disposal. Description/business-context-only edits do not churn pools.

Object and field names are sorted by connector-normalized qualified identity before pagination. Catalog pages cap at 100 objects; object-detail pages cap at 20 objects and the entire serialized agent response at 40,000 characters. Return `nextCursor`/warnings before that cap rather than invoking the generic oversized-result store.

Compute a schema fingerprint from sorted normalized object/column identities. Context facts retain the fingerprint at learning time. When referenced objects disappear, return a context warning and show stale facts in the UI; do not delete them automatically.

## 19. Prompt Behavior

Add a desktop prompt fragment loaded only when data-source tools are enabled. Required instructions:

- Use data tools for questions about configured business data.
- Never ask for or expose database credentials.
- Select a source by ID only after listing/identifying it.
- Describe relevant schema and context before the first query against a source in a turn unless already available.
- Prefer database-side filtering and aggregation; avoid `SELECT *` and raw-data downloads.
- Generate only one read-only statement.
- Use parameters for user-provided literal values.
- Respect the source business timezone and state date-range assumptions.
- Treat clear user-provided business facts as authoritative for the current request.
- Under automatic learning, call `data_learn_context` after using clear durable facts; do not learn temporary instructions or guesses.
- Ask when metric meaning, source selection, or conflicting saved context is material to correctness.
- Do not retry a timeout. Make at most two corrections for ordinary SQL/schema errors.
- Report truncation and do not present a partial result as complete.

Tool descriptions remain the primary discovery mechanism; do not inject full schemas or full semantic context into the system prompt.

## 20. UI Design

Add `Data Sources` as a desktop-only top-level Settings navigation view and search section. Update both `NavigationView` unions (`Settings.svelte` and `settingsSearchRegistry.ts`), add `SettingsSection.DATA_SOURCES`, add the desktop-filtered card in `SettingsMenu.svelte`, and render `DataSourcesSettings.svelte` in `Settings.svelte`. Deep links use `/settings?view=data-sources&source=<uuid>&tab=context`; `Settings.svelte` validates these query values before selecting the view.

### 20.1 Source list

Each card shows:

- Name and description.
- PostgreSQL/MySQL badge.
- Database name, with host hidden until details are opened.
- Default and enabled state.
- Agent access state.
- Last test status/time.
- A stale-test badge when the test does not match `connectionRevision` (agent access remains blocked).
- Deletion-pending state with Retry Delete; tombstones are never shown as usable.
- Context fact count.
- Edit, Test, Context, and Delete actions.

### 20.2 Source editor

Fields:

- Display name.
- Engine.
- Host, port, database, username, password.
- TLS mode and optional CA PEM.
- Business timezone.
- Short business description.
- Allowed namespaces and optional tables/views.
- Default source.
- Agent access enabled.
- Query approval mode.
- Context-learning mode.
- Max returned rows and timeout within allowed ranges.

Show a prominent notice:

> Query results are sent to your selected AI model so it can answer your question. Bounded tool results and the assistant's answer are stored in local WorkX conversation history under the current retention settings.

Show a least-privilege checklist and require acknowledgement when the connection test cannot verify a read-only account. Saving repeats the test and may therefore present a changed warning even after the preview test. Never pre-fill, trim, cache in a Svelte store, log, or restore password fields after navigation.

### 20.3 Context editor

Provide:

- Freeform overview Markdown editor.
- Structured active fact list grouped by object/field and kind.
- Provenance and last-updated time.
- Stale-schema warnings.
- Manual add/edit/supersede actions.
- Revision history and restore.
- Automatic/Ask/Off learning selection.

### 20.4 Tool-call display

For `data_query`, show an expandable card with:

- Source name.
- Purpose.
- AST-serialized SQL and placeholders; show parameter types/count but never parameter values in protocol progress events.
- Execution duration.
- Returned row count and truncation state.
- Connector provenance.

Never display or serialize credentials in the card.

### 20.5 Learning notification

On automatic context save:

```text
Saved 2 notes to “Production Sales” context.  View  Undo
```

Undo calls `dataSources.revertContext` to create a new revision from the prior snapshot; it does not delete history.

Implement this through the existing `ToolExecutionProgress` pipeline: extend `ToolProgressData` with typed data-query/context-learned variants, special-case them in `EventProcessor`, add generic `ProcessedEventAction` descriptors in `src/types/ui.ts`, and render accessible pending/success/error action buttons in `SystemEvent.svelte`. View uses the validated settings deep link. Undo supplies `targetRevision=priorRevision` and `expectedCurrentRevision=newRevision`, refreshes the card on success, and shows a non-destructive “context changed; review before reverting” message on revision conflict.

## 21. Privacy and Data Handling

### 21.1 Model transmission

Schema, selected semantic context, SQL, parameters, and returned rows supplied as tool output enter the active model context. The user must be informed before enabling agent access.

### 21.2 Local persistence in the MVP

Current WorkX rollout policy persists `function_call`, `function_call_output`, user messages, and assistant messages. Therefore bounded query input/output and any data repeated in the assistant answer are stored locally in conversation history.

The data-query UI progress card also carries placeholder-only SQL through the local thread event pipeline and may appear in the existing local transcript. It never carries parameter values or rows. This is covered by the same disclosure; structured audit/telemetry events contain only the query hash.

MVP controls:

- Cap serialized `data_query` output below 40,000 characters.
- Never send raw rows to telemetry or application logs.
- Never log SQL parameter values.
- Ensure stdio/control-frame debug logging never serializes `dataSources.create`, `update`, or `testCandidate` request payloads; seeded-secret transport tests cover this path.
- Never invoke the oversized-result backing store for `data_query`; truncate at row boundaries first.
- Encourage aggregate queries and schema/table allowlists.
- Respect existing rollout retention and session deletion.

Future hardening should add a core tool-result persistence policy that can provide full output to the current model call while recording a redacted rollout representation. That is deliberately not hidden inside this MVP because current replay/prompt-cache semantics require one byte-identical representation.

### 21.3 Semantic context privacy

Semantic context is persisted locally and sent to the model when relevant. Reject credentials and obvious raw record dumps. The UI permits review and deletion.

## 22. Approval and Risk Integration

Add `DataQueryRiskAssessor` and `DataContextRiskAssessor`.

`DataQueryRiskAssessor` is constructed with a synchronous read-only registry view and `SqlReadOnlyPolicy`. Connector `validateQuery` is intentionally synchronous so the assessor can validate before approval; the handler repeats validation before execution. The assessor:

- Score 15 for validated read-only query with `queryApproval='auto_read'`.
- Force `ask_user` when source policy is `ask_each_query`.
- Deny the attempt when origin/session is not authorized, source is non-active/disabled, agent access is disabled, password/test/acknowledgement is missing or stale, query validation fails, or the selected connector lacks a policy-enforced read-only query path. The handler remains authoritative in `yolo` mode and re-denies invalid calls.

`DataContextRiskAssessor` is constructed with a synchronous read-only view of `DataSourceRegistry` so it can inspect the source's current learning mode. It:

- Auto-approves the attempt only when source learning mode is `automatic` and every evidence quote is present in the narrow `ApprovalContext.currentUserText` field.
- Ask when learning mode is `ask`.
- Deny persistence when learning mode is `off`.
- Does not authorize replacement. The handler performs schema/deduplication/conflict checks after approval and writes only additive non-conflicting facts; conflict resolution occurs through conversation plus UI/manual update.

Both assessors also require the narrow `ApprovalContext.dataAccessOrigin` to be local/attended. `DataContextRiskAssessor` additionally requires `durableLearningEligible=true`. These context checks are duplicated in runtime handlers because `ApprovalGate` deliberately auto-approves non-policy-denied actions in `yolo` mode.

Tool runtime metadata remains categorical even if approval mode is `yolo`; invalid/write SQL never reaches the approval escape path.

## 23. Errors and Sanitization

Use stable codes:

```ts
export type DataSourceErrorCode =
  | 'SOURCE_NOT_FOUND'
  | 'SOURCE_DISABLED'
  | 'SOURCE_REVISION_CONFLICT'
  | 'SOURCE_DELETION_PENDING'
  | 'DATA_SOURCE_STORE_CORRUPT'
  | 'DATA_SOURCES_UNAVAILABLE'
  | 'DATA_ACCESS_ORIGIN_DENIED'
  | 'SERVICE_FORBIDDEN'
  | 'AGENT_ACCESS_DISABLED'
  | 'CONNECT_TIMEOUT'
  | 'AUTH_FAILED'
  | 'TLS_FAILED'
  | 'SOURCE_UNREACHABLE'
  | 'CONNECTOR_NOT_FOUND'
  | 'SECRET_NOT_FOUND'
  | 'QUERY_PARSE_FAILED'
  | 'QUERY_NOT_READ_ONLY'
  | 'QUERY_MULTIPLE_STATEMENTS'
  | 'QUERY_OBJECT_DENIED'
  | 'QUERY_PARAMETER_MISMATCH'
  | 'QUERY_SHAPE_UNSUPPORTED'
  | 'QUERY_TIMEOUT'
  | 'QUERY_CANCELLED'
  | 'QUERY_BUSY'
  | 'RESULT_TRUNCATED'
  | 'SCHEMA_NOT_FOUND'
  | 'CONTEXT_EVIDENCE_MISSING'
  | 'CONTEXT_CONFLICT'
  | 'CONTEXT_SCHEMA_AMBIGUOUS'
  | 'CONTEXT_REVISION_CONFLICT';
```

Create a data-source error sanitizer that removes:

- Passwords and credential-bearing URIs.
- Host/user values from agent-visible messages.
- Driver stack traces.
- SQL snippets returned by the database server beyond a short safe diagnostic.
- TLS certificate contents.

Management UI services may return more connection-oriented detail than agent tools, but never secrets or stack traces.

## 24. Observability

Emit structured local events with:

- Source ID and connector ID.
- Operation type (`test`, `describe`, `query`, `context_learn`).
- Start/end time and duration.
- Success/failure code.
- Row count and truncation boolean.
- Query SHA-256 hash.
- Pool counts without connection coordinates.

Do not emit:

- Query text.
- Parameters.
- Rows/documents.
- Context evidence text.
- Host, username, password, CA material.

Telemetry remains behind the existing live telemetry preference and receives only the safe fields above if product analytics later opts in.

## 25. Runtime Lifecycle and Wiring

During `ServerAgentBootstrap.initialize()` when `profile === 'desktop-runtime'`, initialize data sources after steps 0/0b (storage and credentials) and before the `AgentRegistry`/initial primary session is created:

1. Create a bootstrap-owned `DataSourceRuntimeHandle` whose initial status is unavailable/initializing; this handle always exists for desktop services.
2. Construct `DataSourceStore` and `DataContextStore` over `getStorageProvider()` with one shared mutation mutex.
3. Construct `DataSourceSecretStore` over `getCredentialStore()`.
4. Complete deleting tombstones and reconcile unreferenced secret versions.
5. Construct/register `PostgresNativeConnector` and `MySqlNativeConnector`, validate/load active sources into `DataSourceRegistry`, then publish the ready runtime through the handle.
6. `agentFactory` passes the ready runtime (if any) into each new `DesktopRuntimePlatformAdapter`; the initial primary session therefore receives tools too.
7. `registerServices()` passes the handle into `createDataSourceServices`, so `dataSources.status` remains available even when initialization failed.

`DataSourceAccessPolicy` receives a lazy bootstrap callback rather than the registry itself. At execution time it verifies the session exists in `AgentRegistry`, is a non-internal `primary` desktop chat session, and its recorded owner channel is `desktop-runtime-main`; it also checks the snapshot origin is local/attended. The lazy callback is safe to construct before `AgentRegistry` and avoids a bootstrap cycle. Sessions without a recorded matching owner fail closed.

Initialization failure is sanitized, recorded on the handle, and does not fail the rest of WorkX. A failed handle registers no model-facing tools.

`DesktopRuntimePlatformAdapter` gains an optional constructor dependency for the runtime. Its `registerPlatformTools()` calls `registerDataSourceTools(registry, runtime, toolsConfig)` after existing desktop tool registration only when ready and `toolsConfig.dataSources===true`. Evidence/access verification uses the narrow turn metadata seam in section 10.3 rather than giving the shared runtime mutable `Session` objects.

On bootstrap shutdown, first mark the handle stopping so new data operations fail; cancel queues/destroy active query connections and call `DataSourceRuntime.dispose()` before `ChannelManager.shutdown()` and session-registry cleanup. Pool closure has a bounded timeout and forced-destruction fallback. The current bootstrap does not close the global `StorageProvider`; do not claim or depend on such a step.

Runtime service source updates mutate the shared registry immediately, so existing sessions see new or changed sources without tool re-registration.

## 26. Proposed Source Layout

```text
src/core/data-sources/
  types.ts
  errors.ts
  DataSourceRegistry.ts
  DataSourceRuntime.ts
  DataSourceRuntimeHandle.ts
  DataSourceStore.ts
  DataContextStore.ts
  DataSourceSecretStore.ts
  DataSourceMutationMutex.ts
  DataSourceAccessPolicy.ts
  DataResultLimiter.ts
  context/
    ContextLearningService.ts
    ContextConflictDetector.ts
    contextRenderer.ts
  query/
    SqlReadOnlyPolicy.ts
    parameterCodec.ts
  index.ts

src/desktop-runtime/data-sources/
  createDesktopDataSourceRuntime.ts
  native/
    PostgresNativeConnector.ts
    MySqlNativeConnector.ts
    NativePoolRegistry.ts
    schema/
      postgresSchema.ts
      mysqlSchema.ts
    normalization/
      postgresTypes.ts
      mysqlTypes.ts

src/tools/data-sources/
  definitions.ts
  register.ts
  DataQueryRiskAssessor.ts
  DataContextRiskAssessor.ts

src/core/services/
  data-sources-services.ts

src/webfront/settings/data-sources/
  DataSourcesSettings.svelte
  DataSourceList.svelte
  DataSourceEditor.svelte
  DataSourceContextEditor.svelte
  DataSourceTestResult.svelte
  dataSourceForm.ts
```

Future:

```text
src/core/data-sources/mcp/
  McpDataSourceConnector.ts
  McpDataSourceBindingStore.ts
```

## 27. Configuration

Add camel-case `dataSources?: boolean` to `IToolsConfig` (matching `execCommand`/`webSearch`), `DEFAULT_TOOLS_CONFIG`, and `configSchema.ts`. Default it to `true`; registration remains desktop-runtime-only, so extension/server behavior is unchanged. It controls model-facing tool availability, not whether settings can manage sources. `enable_all_tools` does not override an explicit `dataSources=false` because database access is a separate sensitive capability.

When false:

- Data tools are hidden/not exposed to the model.
- Runtime services and connection testing remain available.
- Scheduled/background agents cannot query sources.

Each source's `agentAccessEnabled` is an additional mandatory gate.

No source metadata is added to `IAgentConfig`; source records belong in `StorageProvider`. Only the tool toggle belongs in agent config.

## 28. Testing Strategy

### 28.1 Unit tests

- Registry registration, source routing, replacement, invalidation, and disposal.
- Store allowlist integration, catalog CRUD/invariants, shared mutation serialization, transaction rollback, revision retention, tombstone recovery, and source deletion.
- Versioned secret key names, orphan reconciliation, crash-boundary recovery, and no-secret public views.
- Source validation and policy clamping.
- SQL AST acceptance/rejection corpus for both dialects.
- Multi-statement, comments, CTE writes, `SELECT INTO`, locks, outfile/copy, and allowlist bypass attempts.
- Parameter placeholder validation/conversion.
- Parser/serializer round-trip for PostgreSQL `$1`, MySQL `?`, CTEs, unions, comments/string-literal pseudo-placeholders, and duplicate placeholders.
- Result type normalization and row/character/cell truncation.
- Error sanitization with credential-bearing driver errors.
- Context evidence matching, deduplication, conflicts, schema association, automatic/ask/off modes, and revision revert.
- Tool definitions and runtime metadata.
- Risk assessors.
- Service payload validation and password response omission.

### 28.2 Connector integration tests

Run disposable PostgreSQL and MySQL instances in integration CI or an opt-in Docker suite:

- Successful TLS/non-TLS connection according to test fixture.
- Authentication failure sanitization.
- Schema discovery for tables, views, comments, primary keys, and foreign keys.
- Read-only aggregate query.
- DML/DDL rejection before execution.
- Read-only transaction rollback.
- Timeout and cancellation.
- Row limit and large-cell handling.
- Decimal/bigint/date/null/JSON/binary normalization.
- Pool reuse, idle failure recovery, config invalidation, and shutdown.
- Concurrent queries to one source serialize; different sources can proceed independently.

### 28.3 Runtime integration tests

- Desktop bootstrap constructs one runtime shared by two agent sessions.
- Initial primary and subsequently created desktop sessions both register tools; app-server/internal sessions are denied at runtime.
- New source created after sessions exist is immediately listable/queryable.
- Password travels WebView -> runtime service -> keychain and never appears in persisted metadata or returned response.
- Tool query triggers approval and plan-review behavior correctly.
- Automatic context learning uses current facts, persists a revision, emits notification, and supports Undo.
- Original user-text snapshot excludes funnel/hook/synthetic text, is non-destructive, and uses one stable engine submission turn ID across tool calls.
- Scheduler, remote/app-server, connector, and sub-agent turns cannot query or persist context in the MVP.
- Query still succeeds when context persistence fails.
- Disabled tool/source gates execution.
- Sidecar shutdown closes pools.
- Data-source initialization failure leaves WorkX running and `dataSources.status` available.

### 28.4 UI tests

- Create/edit/delete/test multiple sources.
- Password keep/replace semantics.
- TLS and least-privilege warnings.
- Context editor and revision restore.
- Privacy disclosure.
- Query tool-card rendering and truncation indication.
- Learning notification and Undo.
- Deep-linked View action, revision-conflict-safe Undo, and direct service-response handling without a nested success wrapper.

### 28.5 Security tests

- No password in config, storage collections, logs, events, tool schemas/results, errors, or snapshots.
- No password in stdio service request logging; versioned keychain account names contain no password material.
- Connection URI credential redaction.
- Prompt/tool input cannot supply an arbitrary host.
- Parser bypass corpus.
- Allowed-object enforcement after quoted/case-folded identifier normalization.
- Query cancellation leaves no writable/dirty pooled session.
- MCP connector cannot claim database enforcement without a trusted binding in future tests.

## 29. Rollout

1. Land contracts, stores, registry, and tests behind the tool toggle.
2. Land PostgreSQL connector and management UI; enable for internal testing.
3. Land query tools and semantic-context learning for PostgreSQL.
4. Land MySQL connector against the same contract and test suite.
5. Run packaging tests on Linux, macOS, and Windows.
6. Enable the Data Sources settings entry for alpha users.
7. Monitor safe operation metrics and error codes; never inspect query text/results through telemetry.

The feature remains alpha and desktop-only through the MVP.

## 30. Acceptance Criteria

The design is implemented when all of the following are true:

- A user can save at least two PostgreSQL and two MySQL sources with independent credentials and policies.
- Passwords are stored only in the OS keychain and are never returned after write.
- Password replacement and deletion survive crashes through versioned secrets, reconciliation, and deletion tombstones; metadata never points at a half-replaced password.
- The runtime creates pools lazily and shares them across agent sessions.
- The agent can list sources, describe schema/context, execute a bounded read-only query, and explain the result.
- Ambiguous source or metric meaning produces a clarification instead of an unsupported guess.
- DML, DDL, multiple statements, data-modifying CTEs, locks, and object-allowlist bypasses are rejected before execution.
- Database-side read-only transactions, timeout/cancellation, row limit, result-character limit, and source concurrency limit are active.
- Each connector executes the wrapped analytical statement exactly once per `data_query` call.
- A clear user statement such as “`st = 2` means paid and `amt` is cents” is used in the current query and, in automatic mode, saved with verified evidence and an Undo notification.
- Temporary report instructions are used now but are not automatically saved.
- Context conflicts are surfaced and never overwritten silently.
- Undo refuses to overwrite context changed after the learning notification.
- Multiple sources work independently; the tool selects by source ID and never accepts connection coordinates.
- Data management services and data tools reject non-local app-server/scheduler/connector/sub-agent access in the MVP.
- Query results are not logged or sent to telemetry, and the UI clearly discloses model transmission/local history persistence.
- Existing desktop, extension, and server tests remain green.
- Desktop package builds include required pure-JS drivers/parser on all supported targets.
- Agent-visible list/describe/context/query outputs remain below their declared caps and never fall into generic oversized-result persistence.
- The registry/connector contracts permit a future MCP connector without changing the model-facing tool names or context store.

## 31. Deferred Follow-ups

- MCP data-source profile and binding UI.
- Snowflake, BigQuery, Redshift, Databricks, SQL Server, Oracle, SQLite, and NoSQL connectors.
- Shared semantic profiles across production/staging/warehouse sources.
- Local DuckDB/Arrow analysis for cross-source joins and larger datasets.
- Charts, downloadable reports, notebooks, and scheduled analyses.
- SSH tunnels, cloud IAM, OAuth, and client certificate authentication.
- Fine-grained column masking/redaction rules.
- Ephemeral sensitive tool outputs with redacted rollout persistence.
- Read-replica routing and cost/query-plan budgets.
- Admin-managed source policy and enterprise source provisioning.

## 32. References

- WorkX architecture: `docs/ARCHITECTURE.md`
- Desktop runtime: `src/desktop-runtime/WorkXRuntimeBootstrap.ts`
- Desktop tool registration: `src/desktop/tools/registerDesktopTools.ts`
- Tool runtime metadata: `src/tools/runtimeMetadata.ts`
- Credential store: `src/desktop-runtime/credentials/ControlFrameCredentialStore.ts`
- Shared runtime services: `src/core/services/index.ts`
- MCP manager/adapter: `src/core/mcp/MCPManager.ts`, `src/core/mcp/MCPToolAdapter.ts`
- PostgreSQL pooling and queries: <https://node-postgres.com/features/pooling>, <https://node-postgres.com/features/queries>
- PostgreSQL read-only transactions: <https://www.postgresql.org/docs/current/sql-set-transaction.html>
- PostgreSQL statement/lock timeouts: <https://www.postgresql.org/docs/current/runtime-config-client.html>
- MySQL2 pools: <https://sidorares.github.io/node-mysql2/docs/examples/connections/create-pool>
- MySQL read-only transactions: <https://dev.mysql.com/doc/refman/8.4/en/commit.html>
- SQL AST parser: <https://www.npmjs.com/package/node-sql-parser>
