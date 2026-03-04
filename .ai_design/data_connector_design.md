# Data Connector Design Document

**Status**: Draft
**Date**: 2026-03-03
**Platforms**: Apple Pi (Desktop/Tauri) + Apple Pi Server (Node.js)
**Depends on**: Credential Store (#159), AgentConfig provider pattern, MCP infrastructure (`MCPManager`, `NodeMCPBridge`, `RustMCPBridge`)

> **Scope**: Desktop and Server mode only. Browser extension is out of scope — extension users
> do not need direct database access from a Chrome side panel.

---

## Table of Contents

1. [Objective](#1-objective)
2. [Background & Motivation](#2-background--motivation)
3. [Architecture Overview](#3-architecture-overview)
4. [Data Model](#4-data-model)
5. [Credential Security](#5-credential-security)
6. [Connector Lifecycle](#6-connector-lifecycle)
7. [Query Execution & Safety](#7-query-execution--safety)
8. [MCP Server Package](#8-mcp-server-package)
9. [Server Mode API](#9-server-mode-api)
10. [Agent Integration](#10-agent-integration)
11. [UI/UX Design](#11-uiux-design)
12. [Implementation Phases](#12-implementation-phases)
13. [Open Questions](#13-open-questions)

---

## 1. Objective

Enable the agent to connect to external data sources (relational databases, NoSQL stores, data warehouses) and perform automated data analysis on behalf of the user.

### Goals

| ID | Goal | Status |
|----|------|--------|
| G1 | Support major relational databases (PostgreSQL, MySQL, SQLite, SQL Server) | Planned |
| G2 | Support NoSQL stores (MongoDB, Redis) | Planned |
| G3 | Support data warehouses (BigQuery, Snowflake, Redshift) | Planned |
| G4 | Secure credential storage — never persist plaintext passwords | Planned |
| G5 | Read-only by default — prevent accidental data mutation | Planned |
| G6 | Connection testing before save | Planned |
| G7 | Agent can discover schema, run queries, and analyze results | Planned |
| G8 | Works on both Desktop and Server platforms | Planned |
| G9 | Zero bundle size impact on main app | Planned |

### Non-Goals

- Browser extension support (no direct DB access from Chrome side panel)
- Data ETL / migration between sources
- Real-time streaming connections (CDC, change streams)
- Connection pooling for multi-tenant server deployments (future work)

---

## 2. Background & Motivation

Users want the agent to answer questions about their data: "What were last month's top 10 customers by revenue?" or "Show me the distribution of response times in the logs collection." Today, users must manually export data, paste it into the chat, or use external tools. A native data connector lets the agent query data sources directly, enabling richer and faster analysis workflows.

### Why MCP as the Runtime Layer

Database client libraries are large (pg ~600KB, mongodb ~1.5MB, BigQuery SDK ~15MB, Snowflake SDK ~10MB). Bundling all drivers into the main app would add 30MB+ to the package. Instead, we use MCP (Model Context Protocol) to isolate database drivers in a **separate process**.

**Why not community MCP servers?**

Community MCP database servers exist (e.g., `@modelcontextprotocol/server-postgres`) but have significant gaps:

| Concern | Community MCP | Our MCP Server |
|---------|--------------|----------------|
| Credential handling | Env vars (visible in `ps aux`) | Received via MCP tool call over stdin, held in-memory only |
| Read-only enforcement | None (server decides) | Multi-layer: connection-level, query parsing, config flag |
| Query sanitization | None | Statement validation, parameterized queries, single-statement only |
| Result formatting | Raw JSON | Formatted for LLM consumption (markdown tables, truncation) |
| Schema discovery | Varies per server | Unified interface across all database types |
| Connection testing | Not supported | Test-before-save with transient credentials |
| Unified config | Each has own format | Single `IConnectorConfig` managed by main app |

**Decision: build `@aspect/data-connector-mcp` — our own MCP server package.**

The main app stays lightweight (zero additional dependencies). All database drivers live in the MCP server, which is:
- A separate npm package users install alongside the main app
- Pre-installed in the Docker image for server mode
- Spawned as a child process via existing `NodeMCPBridge` / `RustMCPBridge`

Community MCP servers remain available as an escape hatch for databases we don't support — users add them via the existing MCP settings page.

---

## 3. Architecture Overview

```
  Main App Process (lightweight)           MCP Child Process (heavy drivers)
 ┌────────────────────────────────┐       ┌─────────────────────────────────────┐
 │                                │       │  @aspect/data-connector-mcp         │
 │  RepublicAgent                 │       │                                     │
 │       │                        │       │  Drivers:                           │
 │       ▼                        │       │    pg, mysql2, better-sqlite3,      │
 │  ToolRegistry                  │       │    tedious, mongodb, ioredis,       │
 │    └─ data_query (MCP tool)    │       │    @google-cloud/bigquery,          │
 │       │                        │       │    snowflake-sdk                    │
 │       │  tool_call             │       │                                     │
 │       ├──────────────────────────────→ │  Tools exposed:                     │
 │       │  (stdio / MCP protocol)│       │    connect     (receive creds)      │
 │       │                        │       │    disconnect                       │
 │       │                        │       │    query        (execute SQL/NoSQL) │
 │       │                        │       │    get_schema   (list tables)       │
 │       │                        │       │    describe     (table details)     │
 │       │                        │       │    test         (ping + validate)   │
 │       │                        │       │                                     │
 │  ConnectorManager              │       │  Safety layer:                      │
 │    ├─ config (ConfigStorage)   │       │    read-only enforcement            │
 │    ├─ creds  (CredentialStore) │       │    query sanitizer                  │
 │    └─ MCP lifecycle            │       │    result truncation                │
 │       (spawn / shutdown)       │       │    statement timeout                │
 │                                │       │                                     │
 └────────────────────────────────┘       └─────────────────────────────────────┘
          │          │
 ┌────────▼──┐  ┌───▼──────────────┐
 │ ConfigStore│  │ CredentialStore  │
 │ (metadata) │  │ (secrets)        │
 │ host, port │  │ password, token  │
 │ dbName     │  │ cert key         │
 └────────────┘  └──────────────────┘
```

### Key Design Decisions

1. **MCP-based runtime** — database drivers live in a separate process, zero impact on main app bundle size
2. **Our own MCP server** — full control over security, query safety, and result formatting
3. **Split storage** — metadata in ConfigStorage, secrets in CredentialStore (same pattern as provider API keys)
4. **Credentials via MCP tool calls** — not env vars; passed over stdin at connect time, held in-memory only
5. **Read-only by default** — enforced in the MCP server at connection, query-parsing, and config levels
6. **Approval integration** — MCP tool calls go through existing approval gate

### How It Fits Existing Infrastructure

| Component | Role | Already exists? |
|-----------|------|-----------------|
| `MCPManager` | Manages MCP server lifecycle (spawn, shutdown, tool discovery) | Yes |
| `NodeMCPBridge` | stdio transport for server mode | Yes |
| `RustMCPBridge` | stdio transport for desktop (Tauri) | Yes |
| `ToolRegistry` | Registers MCP-discovered tools for agent use | Yes |
| `ApprovalGate` | Filters tool calls through risk tiers | Yes |
| `ConnectorManager` | **NEW** — manages connector config, credentials, MCP lifecycle | No |
| `@aspect/data-connector-mcp` | **NEW** — MCP server with database drivers | No |

---

## 4. Data Model

### 4.1 Connector Configuration

```typescript
/**
 * Stored in ConfigStorage (non-sensitive fields only).
 * Secrets stored separately in CredentialStore.
 */
interface IConnectorConfig {
  /** Unique identifier (UUID) */
  id: string;

  /** User-facing display name (e.g., "Production Analytics DB") */
  displayName: string;

  /** Connector type */
  type: ConnectorType;

  /** Connection metadata (type-specific) */
  connection: IConnectionMetadata;

  /** Whether this connector is read-only (default: true) */
  readOnly: boolean;

  /** Whether the connector is enabled */
  enabled: boolean;

  /** Max rows returned per query (default: 1000) */
  maxRows: number;

  /** Query timeout in milliseconds (default: 30000) */
  queryTimeoutMs: number;

  /** Credential reference marker — '[SECURED]' when password is stored */
  credential: '' | '[SECURED]';

  /** Creation timestamp */
  createdAt: number;

  /** Last successful connection timestamp */
  lastConnectedAt?: number;

  /** Optional tags for organization */
  tags?: string[];
}

type ConnectorType =
  // Relational
  | 'postgresql'
  | 'mysql'
  | 'sqlite'
  | 'sqlserver'
  // NoSQL
  | 'mongodb'
  | 'redis'
  // Data Warehouses
  | 'bigquery'
  | 'snowflake'
  | 'redshift';

/**
 * Non-sensitive connection metadata.
 * Type-specific fields are optional — each connector type uses a subset.
 */
interface IConnectionMetadata {
  host?: string;
  port?: number;
  database?: string;
  schema?: string;
  username?: string;
  ssl?: boolean | ISslConfig;

  // Warehouse-specific
  project?: string;      // BigQuery
  dataset?: string;      // BigQuery
  account?: string;      // Snowflake
  warehouse?: string;    // Snowflake
  region?: string;       // Redshift, Snowflake

  // File-based
  filePath?: string;     // SQLite
}

interface ISslConfig {
  mode: 'disable' | 'require' | 'verify-ca' | 'verify-full';
  caFile?: string;
  certFile?: string;
  // keyFile content stored in CredentialStore, not here
}
```

### 4.2 Credential Storage Keys

Following the existing `provider-apikey-{providerId}` pattern:

| CredentialStore Key | Value |
|---|---|
| `data-connector-password-{connectorId}` | Database password |
| `data-connector-token-{connectorId}` | Auth token (for warehouse OAuth flows) |
| `data-connector-sslkey-{connectorId}` | Client certificate private key |

Service name: `applepi` (same as provider API keys).

### 4.3 Stored Config

```typescript
/**
 * Stored in ConfigStorage under key 'data_connectors'.
 * Mirrors the IStoredConfig pattern used by AgentConfig.
 */
interface IStoredConnectors {
  connectors: Record<string, IConnectorConfig>;
}
```

---

## 5. Credential Security

### 5.1 Split Storage Model

```
  Main App Process                              MCP Process
 ┌──────────────────────────┐
 │  ConfigStorage            │
 │  {                        │
 │    "conn-abc123": {       │
 │      displayName: "Prod", │
 │      type: "postgresql",  │
 │      connection: {        │
 │        host: "db.example",│
 │        port: 5432,        │
 │        username: "reader" │
 │      },                   │
 │      credential: "[SEC]"  │  ← marker only
 │    }                      │
 │  }                        │
 └──────────────────────────┘
 ┌──────────────────────────┐      ┌───────────────────────────┐
 │  CredentialStore          │      │                           │
 │                           │      │  In-memory only:          │
 │  applepi:                 │ ───→ │  { conn-abc123:           │
 │    data-connector-password│ stdin│    host: "db.example",    │
 │      -conn-abc123         │      │    password: "s3cret" }   │
 │      → "s3cret"           │      │                           │
 │                           │      │  Never written to disk    │
 │  (Desktop: OS Keychain)   │      │  by the MCP process       │
 │  (Server: AES-256-GCM)   │      │                           │
 └──────────────────────────┘      └───────────────────────────┘
```

### 5.2 Credential Flow via MCP

Instead of passing credentials as env vars at MCP server startup (the typical community MCP pattern), our server receives them via a `connect` tool call over stdin:

```
Main App                                     MCP Server
   │                                              │
   │  spawn (no secrets in env/args)              │
   ├─────────────────────────────────────────────→│
   │                                              │
   │  tool_call: connect({                        │
   │    connectorId: "abc",                       │
   │    type: "postgresql",                       │
   │    host: "db.example",                       │
   │    port: 5432,                               │
   │    username: "reader",                       │
   │    password: "s3cret",   ← over stdin pipe   │
   │    readOnly: true                            │
   │  })                                          │
   ├─────────────────────────────────────────────→│
   │                                              │  store in-memory
   │                                              │  open DB connection
   │  result: { status: "connected",              │
   │            serverVersion: "16.2" }           │
   │←─────────────────────────────────────────────┤
   │                                              │
   │  tool_call: query({                          │
   │    connectorId: "abc",                       │
   │    query: "SELECT ...",                      │
   │    maxRows: 100                              │
   │  })                                          │
   ├─────────────────────────────────────────────→│  sanitize → execute
   │                                              │
   │  result: { columns: [...], rows: [...] }     │
   │←─────────────────────────────────────────────┤
```

The password travels over the stdio pipe (local IPC, not network) and is never:
- Written to disk by the MCP process
- Visible in process environment (`ps aux` shows no secrets)
- Logged by the MCP server

### 5.3 Connection String Parsing

If a user pastes a full connection string (e.g., `postgresql://user:pass@host:5432/db`), the main app must:

1. Parse the string into structured fields
2. Extract the password
3. Store the password in CredentialStore
4. Store only the password-stripped URI in ConfigStorage: `postgresql://user@host:5432/db`

```typescript
function parseConnectionString(uri: string): {
  metadata: Partial<IConnectionMetadata>;
  password?: string;
} {
  const url = new URL(uri);
  return {
    metadata: {
      host: url.hostname,
      port: url.port ? parseInt(url.port) : undefined,
      database: url.pathname.slice(1),
      username: url.username,
      ssl: url.searchParams.get('sslmode') !== 'disable',
    },
    password: url.password || undefined,
  };
}
```

### 5.4 Security Rules

| Rule | Rationale |
|------|-----------|
| Never log connection passwords or tokens | Prevents secret leakage in `logs.tail` |
| Never include passwords in config export | `exportConfig()` must redact connector credentials |
| Server mode: require TLS or loopback for `connectors.set` | Same as `credentials.set` — no plaintext over network |
| Connection test uses transient credentials | Test credentials are never written to disk until user confirms save |
| Agent never sees raw credentials | Agent calls `query(connectorId, sql)` — ConnectorManager resolves credentials internally |
| MCP process receives credentials via stdin only | Not env vars, not CLI args |
| MCP process never persists credentials | In-memory only, cleared on disconnect/shutdown |

---

## 6. Connector Lifecycle

### 6.1 MCP Server Lifecycle

The data connector MCP server is managed by `ConnectorManager`, which wraps `MCPManager`:

```
App startup
     │
     ▼
ConnectorManager.initialize()
     │
     ├─ Load saved connectors from ConfigStorage
     │
     ├─ If any connectors exist:
     │    Spawn @aspect/data-connector-mcp via MCPManager
     │    (lazy — only when first connector is used)
     │
     └─ Register ConnectorManager in bootstrap
          (available for DataQueryTool + settings UI)

App shutdown
     │
     ▼
ConnectorManager.shutdown()
     │
     ├─ Send disconnect for all active connections
     └─ MCPManager shuts down MCP server process
```

### 6.2 Connector CRUD

```
   User creates connector (settings UI or API)
           │
           ▼
   ┌───────────────┐
   │  Parse input   │  ← connection string or form fields
   │  Extract secret │
   └───────┬───────┘
           │
           ▼
   ┌───────────────┐
   │  Test connect  │  ← MCP tool_call: test({...config, password})
   │  (timeout 10s) │     transient, no persistence
   └───────┬───────┘
           │
       success?
      ╱        ╲
    yes          no → show error, let user fix
     │
     ▼
   ┌───────────────┐
   │  Save config   │  ← metadata → ConfigStorage
   │  Save secret   │  ← password → CredentialStore
   └───────┬───────┘
           │
           ▼
   ┌───────────────┐
   │  MCP connect   │  ← tool_call: connect({...config, password})
   │                │     MCP server holds connection in-memory
   └───────┬───────┘
           │
           ▼
      Ready for agent queries
```

### 6.3 ConnectorManager API

```typescript
class ConnectorManager {
  private configs: Map<string, IConnectorConfig> = new Map();
  private mcpServerName = '@aspect/data-connector-mcp';

  /** Load saved connectors, register MCP server config (lazy spawn) */
  async initialize(): Promise<void>;

  /** Add a new connector — saves config + credential, connects via MCP */
  async addConnector(config: IConnectorConfig, secret: string): Promise<void>;

  /** Update connector metadata */
  async updateConnector(id: string, patch: Partial<IConnectorConfig>): Promise<void>;

  /** Remove connector — disconnect, delete config + credential */
  async removeConnector(id: string): Promise<void>;

  /** Test a connection without saving (transient) */
  async testConnection(config: IConnectorConfig, secret: string): Promise<TestResult>;

  /** Execute a query via MCP tool call */
  async query(connectorId: string, request: QueryRequest): Promise<QueryResult>;

  /** Get schema via MCP tool call */
  async getSchema(connectorId: string): Promise<SchemaInfo>;

  /** Describe a table/collection via MCP tool call */
  async describeTable(connectorId: string, tableName: string): Promise<TableInfo>;

  /** List all configured connectors (metadata only, no secrets) */
  listConnectors(): IConnectorConfig[];

  /** Disconnect all and shut down MCP server */
  async shutdown(): Promise<void>;
}

interface TestResult {
  success: boolean;
  latencyMs: number;
  serverVersion?: string;
  error?: string;
}
```

---

## 7. Query Execution & Safety

All safety enforcement happens **inside the MCP server process**, not in the main app. This ensures safety even if the MCP server is used directly (e.g., during development).

### 7.1 Read-Only Enforcement (in MCP server)

For SQL databases, enforce read-only at multiple layers:

1. **Connection level** — Use read-only transaction mode where supported
   - PostgreSQL: `SET default_transaction_read_only = on;`
   - MySQL: `SET SESSION TRANSACTION READ ONLY;`
   - SQL Server: `SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED;` + read-only intent
2. **Query parsing** — Reject queries containing `INSERT`, `UPDATE`, `DELETE`, `DROP`, `ALTER`, `TRUNCATE`, `CREATE`, `GRANT`, `REVOKE` (simple keyword pre-check)
3. **Config flag** — `readOnly: true` passed in `connect` tool call, controls whether write queries are attempted

For NoSQL:
- MongoDB: Use read preference `secondaryPreferred` and reject write operations
- Redis: Restrict to read commands (`GET`, `HGETALL`, `KEYS`, `SCAN`, etc.)

### 7.2 Result Size Limits

| Setting | Default | Range |
|---------|---------|-------|
| `maxRows` | 1,000 | 1 – 10,000 |
| `queryTimeoutMs` | 30,000 | 1,000 – 300,000 |
| Max result payload | 5 MB | — |

Results exceeding `maxRows` are truncated with a note: `"Showing 1,000 of 45,231 rows. Add LIMIT clause for specific ranges."`

### 7.3 Approval Integration

MCP tool calls already go through the approval gate. We configure risk tiers for the data connector tools:

| MCP Tool | Approval Tier | Default |
|----------|--------------|---------|
| `get_schema` | Tier 0 | Auto-approve |
| `describe` | Tier 0 | Auto-approve |
| `query` (read-only connector) | Tier 2 | Ask (configurable) |
| `query` (read-write connector) | Tier 3 | Always ask |

The approval request shows:
- Connector display name + type
- The full query text
- Whether the connector is read-only

### 7.4 Query Sanitization (in MCP server)

1. **Parameterized queries** — The `query` tool accepts `params` array for prepared statements. The MCP server enforces parameterized execution.
2. **Single statement only** — Reject `;`-separated multi-statements
3. **Timeout enforcement** — Driver-level statement timeout per connector config

### 7.5 MCP Tool Schemas

```typescript
// Tools exposed by @aspect/data-connector-mcp

// connect — establish a database connection (receives credentials)
{
  name: 'connect',
  description: 'Connect to a database. Credentials are held in-memory only.',
  inputSchema: {
    type: 'object',
    properties: {
      connectorId: { type: 'string' },
      type: { type: 'string', enum: ['postgresql', 'mysql', ...] },
      host: { type: 'string' },
      port: { type: 'number' },
      database: { type: 'string' },
      username: { type: 'string' },
      password: { type: 'string' },
      ssl: { type: 'boolean' },
      readOnly: { type: 'boolean', default: true },
      queryTimeoutMs: { type: 'number', default: 30000 },
      maxRows: { type: 'number', default: 1000 },
    },
    required: ['connectorId', 'type'],
  },
}

// disconnect — close a database connection
{
  name: 'disconnect',
  inputSchema: {
    type: 'object',
    properties: { connectorId: { type: 'string' } },
    required: ['connectorId'],
  },
}

// query — execute a read query
{
  name: 'query',
  description: 'Execute a SQL query or NoSQL operation. Returns columns + rows.',
  inputSchema: {
    type: 'object',
    properties: {
      connectorId: { type: 'string' },
      query: { type: 'string' },
      params: { type: 'array' },
      maxRows: { type: 'number' },
    },
    required: ['connectorId', 'query'],
  },
}

// get_schema — list tables/collections
{
  name: 'get_schema',
  description: 'List all tables, views, and collections in the connected database.',
  inputSchema: {
    type: 'object',
    properties: { connectorId: { type: 'string' } },
    required: ['connectorId'],
  },
}

// describe — table/collection details
{
  name: 'describe',
  description: 'Get column names, types, and indexes for a table or collection.',
  inputSchema: {
    type: 'object',
    properties: {
      connectorId: { type: 'string' },
      table: { type: 'string' },
    },
    required: ['connectorId', 'table'],
  },
}

// test — test connectivity (does not persist)
{
  name: 'test',
  description: 'Test database connectivity with provided credentials. Does not persist.',
  inputSchema: {
    // Same as connect
  },
}
```

---

## 8. MCP Server Package

### 8.1 Package Structure

```
packages/data-connector-mcp/
├── package.json                  # @aspect/data-connector-mcp
├── tsconfig.json
├── src/
│   ├── index.ts                  # MCP server entry point (stdio transport)
│   ├── server.ts                 # MCP Server class, tool registration
│   ├── connection-pool.ts        # In-memory connection map
│   ├── adapters/                 # Database driver adapters
│   │   ├── types.ts              # DriverAdapter interface, QueryRequest/Result
│   │   ├── postgres.ts           # pg
│   │   ├── mysql.ts              # mysql2
│   │   ├── sqlite.ts             # better-sqlite3
│   │   ├── sqlserver.ts          # tedious
│   │   ├── mongo.ts              # mongodb
│   │   ├── redis.ts              # ioredis
│   │   ├── bigquery.ts           # @google-cloud/bigquery
│   │   ├── snowflake.ts          # snowflake-sdk
│   │   └── factory.ts            # ConnectorType → adapter constructor
│   ├── safety/
│   │   ├── read-only.ts          # Read-only enforcement per DB type
│   │   ├── sanitizer.ts          # Statement validation, multi-statement rejection
│   │   └── truncation.ts         # Result size limiting
│   └── __tests__/
│       ├── sanitizer.test.ts
│       ├── read-only.test.ts
│       ├── postgres.test.ts      # Integration test (requires pg)
│       └── sqlite.test.ts        # Integration test (in-memory SQLite)
└── README.md
```

### 8.2 Optional Dependencies

Not all users need all databases. Heavy drivers are optional:

```jsonc
// packages/data-connector-mcp/package.json
{
  "name": "@aspect/data-connector-mcp",
  "dependencies": {
    // Always included (small, covers most users)
    "pg": "^8.13",                        // ~600KB — PostgreSQL + Redshift
    "better-sqlite3": "^11.0"             // ~0 (already in monorepo)
  },
  "optionalDependencies": {
    // Installed only if user needs them
    "mysql2": "^3.12",                    // ~800KB
    "tedious": "^19.0",                   // ~2MB — SQL Server
    "mongodb": "^6.12",                   // ~1.5MB
    "ioredis": "^5.4",                    // ~400KB
    "@google-cloud/bigquery": "^7.9",     // ~15MB
    "snowflake-sdk": "^1.14"             // ~10MB
  }
}
```

The adapter factory uses dynamic `import()` with try/catch:

```typescript
async function createAdapter(type: ConnectorType): Promise<DriverAdapter> {
  switch (type) {
    case 'postgresql':
    case 'redshift':
      return new (await import('./postgres')).PostgresAdapter();
    case 'mongodb': {
      try {
        return new (await import('./mongo')).MongoAdapter();
      } catch {
        throw new Error(
          'MongoDB support requires the "mongodb" package. ' +
          'Install it: npm install mongodb'
        );
      }
    }
    // ...
  }
}
```

### 8.3 Docker Image

For server mode, the MCP server is pre-installed in the Docker image:

```dockerfile
# In Dockerfile — after main app install
# Install data connector MCP server with all drivers
RUN npm install -g @aspect/data-connector-mcp
```

The MCP server config is auto-registered in `ConnectorManager.initialize()`:

```typescript
// Register our MCP server with MCPManager
mcpManager.addServerConfig({
  id: 'data-connector',
  name: 'Data Connector',
  transport: 'stdio',
  command: 'npx',
  args: ['@aspect/data-connector-mcp'],
  scope: 'shared',
  autoStart: false,  // lazy — started when first connector is used
});
```

### 8.4 Desktop

On desktop, the MCP server is installed as a project dependency or globally:

- **Bundled**: Included in the Tauri app's Node.js sidecar
- **Or user-installed**: `npm install -g @aspect/data-connector-mcp`

The `RustMCPBridge` spawns it the same way it spawns any stdio MCP server.

---

## 9. Server Mode API

Following the pattern established by `credentials.*` handlers:

### 9.1 Scopes

```typescript
// Added to Scope type in packages/ws-server/src/methods.ts
| 'connectors.read'
| 'connectors.write'
```

Granted to `operator` role only.

### 9.2 Methods

| Method | Scope | Description |
|--------|-------|-------------|
| `connectors.list` | `connectors.read` | List all connectors (metadata only) |
| `connectors.get` | `connectors.read` | Get single connector config |
| `connectors.set` | `connectors.write` | Create/update connector (requires TLS or loopback) |
| `connectors.delete` | `connectors.write` | Remove connector and its credentials |
| `connectors.test` | `connectors.write` | Test connection without saving |
| `connectors.schema` | `connectors.read` | Get schema for a connector |

### 9.3 Handler Pattern

```typescript
// src/server/handlers/connectors.ts
// Follows same dependency injection pattern as credentials.ts

export interface ConnectorHandlerDeps {
  listConnectors: () => Promise<IConnectorConfig[]>;
  getConnector: (id: string) => Promise<IConnectorConfig | null>;
  setConnector: (config: IConnectorConfig, secret?: string) => Promise<void>;
  deleteConnector: (id: string) => Promise<void>;
  testConnection: (config: IConnectorConfig, secret: string) => Promise<TestResult>;
  getSchema: (connectorId: string) => Promise<SchemaInfo>;
}
```

---

## 10. Agent Integration

### 10.1 Tool Discovery

When the MCP server starts, `MCPManager` discovers its tools and registers them in `ToolRegistry` with the standard `mcp:data-connector:` prefix:

```
mcp:data-connector:connect
mcp:data-connector:disconnect
mcp:data-connector:query
mcp:data-connector:get_schema
mcp:data-connector:describe
mcp:data-connector:test
```

However, the agent should not call `connect`/`disconnect`/`test` directly — those are internal tools used by `ConnectorManager`. The agent-facing interface is a wrapper:

### 10.2 DataQueryTool (wrapper)

A thin wrapper registered in ToolRegistry that delegates to MCP tools internally but provides a cleaner agent-facing interface:

```typescript
{
  name: 'data_query',
  description: 'Query connected data sources. Supports SQL databases, MongoDB, and data warehouses.',
  parameters: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list_connectors', 'describe_schema', 'describe_table', 'query'],
      },
      connectorId: { type: 'string' },
      query: { type: 'string' },
      params: { type: 'array' },
      maxRows: { type: 'number' },
    },
    required: ['action'],
  },
}
```

The `DataQueryTool` implementation:
- `list_connectors` → reads from `ConnectorManager.listConnectors()` (no MCP call needed)
- `describe_schema` → ensures connector is connected, then calls MCP `get_schema`
- `describe_table` → ensures connector is connected, then calls MCP `describe`
- `query` → ensures connector is connected, then calls MCP `query`, formats results

The "ensures connector is connected" step is where `ConnectorManager` reads the credential from CredentialStore and calls MCP `connect` if not already connected. The agent never touches credentials.

### 10.3 Schema Context Injection

When connectors are configured, `PromptComposer` injects available connector metadata into the system prompt:

```
Available data connectors:
- "Production Analytics" (postgresql) — tables: users, orders, products, events
- "Logs" (mongodb) — collections: app_logs, error_logs, access_logs

Use the data_query tool to explore schemas and run queries.
```

This is a dynamic runtime context block — only present when connectors exist.

### 10.4 Result Formatting

Query results are formatted for LLM consumption:

```
Query: SELECT department, COUNT(*) as count, AVG(salary) as avg_salary
       FROM employees GROUP BY department ORDER BY count DESC LIMIT 5

Results (5 rows, 12ms):
| department  | count | avg_salary |
|-------------|-------|------------|
| Engineering | 142   | 145000.00  |
| Sales       | 98    | 95000.00   |
| Marketing   | 67    | 88000.00   |
| Support     | 54    | 72000.00   |
| Finance     | 41    | 110000.00  |
```

For large results, the formatter produces a summary + sample:
```
Results (1,000 of 45,231 rows, 340ms — truncated):
Columns: id (int), name (varchar), created_at (timestamp), status (varchar)
Sample (first 10 rows):
| id | name    | created_at          | status   |
...
```

---

## 11. UI/UX Design

### 11.1 Settings Panel

A new "Data Connectors" section in the settings panel (both desktop and server web UI):

```
┌─────────────────────────────────────────────────┐
│  Data Connectors                    [+ Add New] │
│─────────────────────────────────────────────────│
│                                                 │
│  ● Production Analytics DB        PostgreSQL    │
│    db.example.com:5432/analytics   Connected    │
│    Read-only · Last used 2h ago                 │
│                                        [⚙] [✕] │
│                                                 │
│  ● Logs MongoDB                   MongoDB       │
│    mongo.internal:27017/logs       Connected    │
│    Read-only · Last used 5m ago                 │
│                                        [⚙] [✕] │
│                                                 │
│  ○ Staging Warehouse              Snowflake     │
│    xy12345.snowflakecomputing.com  Disconnected │
│    Read-write · Never connected                 │
│                                        [⚙] [✕] │
│                                                 │
└─────────────────────────────────────────────────┘
```

### 11.2 Add/Edit Connector Dialog

```
┌─────────────────────────────────────────────────┐
│  Add Data Connector                             │
│─────────────────────────────────────────────────│
│                                                 │
│  Connection String (optional)                   │
│  ┌─────────────────────────────────────────┐    │
│  │ postgresql://user@host:5432/dbname      │    │
│  └─────────────────────────────────────────┘    │
│  Paste a connection string to auto-fill below   │
│                                                 │
│  ── OR fill in manually ──                      │
│                                                 │
│  Type:  [PostgreSQL ▼]                          │
│  Name:  [Production Analytics DB          ]     │
│  Host:  [db.example.com                   ]     │
│  Port:  [5432                             ]     │
│  Database: [analytics                     ]     │
│  Username: [reader                        ]     │
│  Password: [••••••••                      ]     │
│  SSL:   [✓] Require SSL                         │
│                                                 │
│  [✓] Read-only (recommended)                    │
│                                                 │
│        [Test Connection]   [Cancel]   [Save]    │
└─────────────────────────────────────────────────┘
```

### 11.3 Slash Command

Add `/data` slash command for quick connector access in chat:

```
/data list              — list configured connectors
/data schema <name>     — show schema for a connector
/data query <name> ...  — run a query (goes through approval)
```

---

## 12. Implementation Phases

The MCP-based architecture simplifies phasing — the main app code is written once in Phase 1 and never changes when new databases are added.

### Phase 1 — Foundation (PostgreSQL + SQLite)

**Main app (written once, stable after this phase):**

| Task | Location |
|------|----------|
| Define `IConnectorConfig`, `ConnectorType`, interfaces | `src/data/types.ts` |
| Implement `ConnectorManager` (config, creds, MCP lifecycle) | `src/data/ConnectorManager.ts` |
| Implement `DataQueryTool` (agent-facing wrapper) | `src/data/tools/DataQueryTool.ts` |
| Register in `ServerAgentBootstrap` | `src/server/agent/ServerAgentBootstrap.ts` |
| Register in `DesktopAgentBootstrap` | `src/desktop/agent/DesktopAgentBootstrap.ts` |
| Server API handlers (`connectors.*`) | `src/server/handlers/connectors.ts` |
| Add scopes + method registry entries | `packages/ws-server/src/methods.ts`, `src/server/auth/roles.ts` |
| Settings UI — connector list + add/edit dialog | `src/webfront/settings/` |
| Tests — ConnectorManager, DataQueryTool, handlers | `src/data/__tests__/`, `src/server/handlers/__tests__/` |

**MCP server package:**

| Task | Location |
|------|----------|
| MCP server scaffold (stdio transport, tool registration) | `packages/data-connector-mcp/src/server.ts` |
| Adapter interface + factory | `packages/data-connector-mcp/src/adapters/` |
| PostgreSQL adapter (`pg`) | `packages/data-connector-mcp/src/adapters/postgres.ts` |
| SQLite adapter (`better-sqlite3`) | `packages/data-connector-mcp/src/adapters/sqlite.ts` |
| Read-only enforcement | `packages/data-connector-mcp/src/safety/read-only.ts` |
| Query sanitizer | `packages/data-connector-mcp/src/safety/sanitizer.ts` |
| Result truncation | `packages/data-connector-mcp/src/safety/truncation.ts` |
| Tests | `packages/data-connector-mcp/src/__tests__/` |
| Dockerfile update (pre-install MCP server) | `Dockerfile` |

**Dependencies**: `pg` (in MCP package only, not main app)

### Phase 2 — Relational Expansion (MySQL, SQL Server)

Only MCP server package changes — main app is untouched.

| Task | Location |
|------|----------|
| MySQL adapter (`mysql2`) | `packages/data-connector-mcp/src/adapters/mysql.ts` |
| SQL Server adapter (`tedious`) | `packages/data-connector-mcp/src/adapters/sqlserver.ts` |
| Tests | `packages/data-connector-mcp/src/__tests__/` |

**Dependencies**: `mysql2`, `tedious` (optional)

### Phase 3 — NoSQL (MongoDB, Redis)

Only MCP server package changes.

| Task | Location |
|------|----------|
| MongoDB adapter | `packages/data-connector-mcp/src/adapters/mongo.ts` |
| Redis adapter | `packages/data-connector-mcp/src/adapters/redis.ts` |
| NoSQL query formatting | `packages/data-connector-mcp/src/safety/` |
| Tests | `packages/data-connector-mcp/src/__tests__/` |

**Dependencies**: `mongodb`, `ioredis` (optional)

### Phase 4 — Data Warehouses (BigQuery, Snowflake, Redshift)

Only MCP server package changes.

| Task | Location |
|------|----------|
| BigQuery adapter (service account auth) | `packages/data-connector-mcp/src/adapters/bigquery.ts` |
| Snowflake adapter (key-pair auth) | `packages/data-connector-mcp/src/adapters/snowflake.ts` |
| Redshift adapter (reuses `pg`) | `packages/data-connector-mcp/src/adapters/redshift.ts` |
| Warehouse-specific auth flows in UI | `src/webfront/settings/` (only UI change) |
| Tests | `packages/data-connector-mcp/src/__tests__/` |

**Dependencies**: `@google-cloud/bigquery`, `snowflake-sdk` (optional)

### Phase 5 — Polish

| Task | Description |
|------|-------------|
| Schema context injection in PromptComposer | Dynamic prompt block with available connectors |
| `/data` slash command | Chat shortcut for connector operations |
| Connection pooling in MCP server | Reuse connections, idle timeout |
| Schema caching with TTL | Avoid repeated `get_schema` calls |

---

## 13. Open Questions

| # | Question | Options | Status |
|---|----------|---------|--------|
| 1 | Should connectors support write mode at all in Phase 1? | A) Read-only only B) Read-only default with opt-in write | Open |
| 2 | How to handle long-running warehouse queries? | A) Stream results B) Async with polling C) Hard timeout | Open |
| 3 | Should the agent auto-discover schema on first connect? | A) Yes, inject into prompt B) Only on explicit request | Open |
| 4 | How to handle multi-database connectors (e.g., Postgres with multiple schemas)? | A) One connector per schema B) Schema selection in query | Open |
| 5 | Should we support SSH tunneling for database connections? | A) Phase 1 B) Later phase C) Never (use VPN) | Open |
| 6 | MCP server naming: `@aspect/data-connector-mcp` or `@applepi/data-connector-mcp`? | Need to align with package naming convention | Open |
| 7 | Should the MCP server expose `connect`/`disconnect` to the agent or hide them? | A) Hidden (ConnectorManager only) B) Exposed (agent manages connections) | Leaning A |
