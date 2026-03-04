# MCP Store Design Document

**Status**: Draft
**Date**: 2026-03-04
**Platforms**: Apple Pi (Desktop/Tauri) + Apple Pi Server (Node.js)
**Depends on**: MCP infrastructure (`MCPManager`, `MCPConfig`, `IMCPServerConfig`, `MCPToolAdapter`)

> **Vision**: Make adding capabilities to the agent as easy as installing an app from an app store.
> Browse, install, configure, and manage MCP servers from a unified UI — no manual JSON/TOML editing,
> no CLI, no guessing at config formats.

---

## Table of Contents

1. [Objective](#1-objective)
2. [Current State & Gaps](#2-current-state--gaps)
3. [Architecture Overview](#3-architecture-overview)
4. [Server Manifest Format](#4-server-manifest-format)
5. [Catalog Service](#5-catalog-service)
6. [Package Management](#6-package-management)
7. [Schema-Driven Configuration](#7-schema-driven-configuration)
8. [Credential Binding](#8-credential-binding)
9. [Enhanced Lifecycle Management](#9-enhanced-lifecycle-management)
10. [Security & Trust](#10-security--trust)
11. [Agent Experience](#11-agent-experience)
12. [UI/UX Design](#12-uiux-design)
13. [Server Mode API](#13-server-mode-api)
14. [Data Connector as Store Entry](#14-data-connector-as-store-entry)
15. [Implementation Phases](#15-implementation-phases)
16. [Open Questions](#16-open-questions)

---

## 1. Objective

Create an MCP Store that lets users discover, install, and configure MCP servers through a unified interface — transforming the agent from a chat assistant into an extensible platform that can interact with databases, APIs, developer tools, communication platforms, and more.

### Goals

| ID | Goal | Status |
|----|------|--------|
| G1 | Browsable catalog of MCP servers with categories and search | Planned |
| G2 | One-click install (npm, binary, Docker) | Planned |
| G3 | Schema-driven config UI — no manual JSON/TOML editing | Planned |
| G4 | Secure credential binding via CredentialStore | Planned |
| G5 | Health monitoring, auto-restart, lazy start | Planned |
| G6 | Approval tier mapping per MCP server/tool | Planned |
| G7 | Works on both Desktop and Server platforms | Planned |
| G8 | Backward compatible with existing `MCPManager` / `IMCPServerConfig` | Planned |
| G9 | Support for user-contributed MCP servers (not just curated) | Planned |

### Non-Goals

- Building our own MCP servers (we use community/third-party servers)
- Hosting a public registry service (Phase 1 uses a built-in catalog; remote registry is future work)
- MCP server development tooling (SDK, testing framework)
- Browser extension MCP support (already works via `MCPClient` SSE transport)

---

## 2. Current State & Gaps

### What Exists Today

| Component | Location | What It Does |
|-----------|----------|-------------|
| `IMCPServerConfig` | `src/core/mcp/types.ts` | Config type: id, name, transport, command, args, env, url, apiKey, platform, enabled, builtin |
| `MCPConfig` | `src/core/mcp/MCPConfig.ts` | Zod validation, storage (chrome.storage / ConfigStorageProvider), migration |
| `MCPManager` | `src/core/mcp/MCPManager.ts` | Singleton lifecycle, adapter creation, tool routing, event dispatch |
| `MCPToolAdapter` | `src/core/mcp/MCPToolAdapter.ts` | MCP tool → ToolDefinition conversion, `serverName__toolName` namespacing |
| `NodeMCPBridge` | `src/server/mcp/NodeMCPBridge.ts` | stdio transport via `child_process` (server mode) |
| `RustMCPBridge` | `src/core/mcp/RustMCPBridge.ts` | stdio transport via Tauri IPC (desktop mode) |
| `MCPClient` | `src/core/mcp/MCPClient.ts` | SSE transport for remote MCP servers |
| `MCPSettings.svelte` | `src/webfront/settings/` | Manual server config UI (add/edit/remove, connect/disconnect) |

### Gaps the Store Fills

| # | Gap | Impact |
|---|-----|--------|
| 1 | **No discovery** — users must know which MCP server exists and what npm package to install | Users can't find useful MCP servers |
| 2 | **Manual config** — users write JSON with command/args/env by hand | Error-prone, no validation feedback |
| 3 | **No config schema** — each MCP server has its own undocumented config format | Users read README files and guess |
| 4 | **Credentials in env vars** — passwords/tokens passed as `env` in config, stored in plaintext | Security risk on shared machines |
| 5 | **No health monitoring** — crashed MCP servers go undetected | Broken tools with no feedback |
| 6 | **No lazy start** — all enabled servers start at boot | Wasted resources for infrequently-used servers |
| 7 | **No approval mapping** — all MCP tools default to the same approval tier | No per-server risk classification |
| 8 | **5-server limit** — hardcoded `MAX_USER_SERVERS = 5` | Limits extensibility |
| 9 | **No package management** — user must `npm install -g` manually | Friction, no updates |

---

## 3. Architecture Overview

```
┌────────────────────────────────────────────────────────────────────────┐
│                           MCP Store                                    │
│                                                                        │
│  ┌─────────────────┐  ┌──────────────────┐  ┌──────────────────────┐  │
│  │    Catalog       │  │    Installer      │  │   Config Generator   │  │
│  │                 │  │                  │  │                      │  │
│  │  Built-in JSON  │  │  npm install     │  │  Manifest.config     │  │
│  │  Remote API     │  │  Binary download │  │  Schema → form UI    │  │
│  │  User manifests │  │  Docker pull     │  │  Secret fields →     │  │
│  │                 │  │  Version check   │  │    CredentialStore   │  │
│  └────────┬────────┘  └────────┬─────────┘  └──────────┬───────────┘  │
│           │                    │                        │              │
└───────────┼────────────────────┼────────────────────────┼──────────────┘
            │                    │                        │
            ▼                    ▼                        ▼
┌────────────────────────────────────────────────────────────────────────┐
│                    MCPManager (enhanced)                                │
│                                                                        │
│  Existing:                          New:                               │
│    addServer / removeServer           healthCheck (periodic ping)      │
│    connect / disconnect               autoRestart (on crash)           │
│    getAllTools / executeTool           lazyStart (on first tool call)   │
│    event dispatch                     autoStop (idle timeout)          │
│                                       credentialInjection (stdin/tmp)  │
│                                       instanceMultiplexing             │
│                                                                        │
│  Transport adapters:                                                   │
│    MCPClient (SSE) | NodeMCPBridge (stdio) | RustMCPBridge (stdio)    │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
            │
            ▼
┌────────────────────────────────────────────────────────────────────────┐
│                    MCP Server Processes                                 │
│                                                                        │
│  ┌─────────┐  ┌─────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐ │
│  │ DBHub   │  │ GitHub  │  │ Slack    │  │ Browser  │  │ Custom   │ │
│  │ (stdio) │  │ (stdio) │  │ (stdio)  │  │ (stdio)  │  │ (SSE)    │ │
│  └─────────┘  └─────────┘  └──────────┘  └──────────┘  └──────────┘ │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

### Layers

| Layer | Responsibility | Changes to Existing Code |
|-------|---------------|-------------------------|
| **Catalog** | Discovery, search, metadata | New module |
| **Installer** | Package management | New module |
| **Config Generator** | Schema → UI → credential binding | New module, replaces manual config form |
| **MCPManager** | Lifecycle + new capabilities | Extend existing singleton |
| **Store UI** | Browse, install, configure | New page, replaces MCPSettings.svelte |
| **Server API** | Remote management (server mode) | New handlers |

---

## 4. Server Manifest Format

The manifest is the central data structure. It describes everything the store needs to know about an MCP server: what it does, how to install it, how to configure it, and what security controls to apply.

### 4.1 Manifest Schema

```typescript
interface MCPServerManifest {
  // ── Identity ──────────────────────────────────────────────────────
  /** Unique identifier (e.g., 'dbhub', 'github', 'slack') */
  id: string;
  /** Display name */
  name: string;
  /** Short description (one line) */
  summary: string;
  /** Detailed description (markdown) */
  description?: string;
  /** Version of this manifest */
  manifestVersion: string;
  /** Author or organization */
  author: string;
  /** Source repository URL */
  repository?: string;
  /** Icon URL or bundled icon name */
  icon?: string;
  /** Categorization */
  categories: MCPCategory[];
  /** Search tags */
  tags?: string[];
  /** License (SPDX identifier) */
  license?: string;

  // ── Installation ──────────────────────────────────────────────────
  install: MCPInstallSpec;

  // ── Runtime ───────────────────────────────────────────────────────
  runtime: MCPRuntimeSpec;

  // ── Configuration ─────────────────────────────────────────────────
  /** JSON Schema for user-configurable settings */
  configSchema?: JSONSchema7;
  /** Which fields in configSchema contain secrets */
  secretFields?: string[];
  /** Fields that map to environment variables at spawn time */
  envMapping?: Record<string, string>;

  // ── Security ──────────────────────────────────────────────────────
  /** Default approval tier for tools (0-4) */
  defaultApprovalTier?: number;
  /** Per-tool approval tier overrides */
  toolApprovals?: Record<string, number>;
  /** Whether this server performs write operations */
  hasWriteOperations?: boolean;
  /** Whether read-only mode is supported */
  supportsReadOnly?: boolean;

  // ── Capabilities ──────────────────────────────────────────────────
  /** Expected MCP tools this server exposes */
  expectedTools?: string[];
  /** Expected MCP resources this server exposes */
  expectedResources?: string[];
  /** Whether the server supports multiple concurrent connections */
  supportsMultipleInstances?: boolean;

  // ── Platform ──────────────────────────────────────────────────────
  /** Which platforms this server supports */
  platforms?: ('desktop' | 'server')[];
}

type MCPCategory =
  | 'database'
  | 'developer-tools'
  | 'communication'
  | 'productivity'
  | 'cloud'
  | 'analytics'
  | 'file-system'
  | 'web'
  | 'ai-ml'
  | 'other';

interface MCPInstallSpec {
  /** npm package name (primary install method) */
  npm?: string;
  /** Pre-built binary URLs per platform */
  binary?: {
    linux?: string;
    darwin?: string;
    win32?: string;
  };
  /** Docker image */
  docker?: string;
  /** Minimum version required */
  minVersion?: string;
}

interface MCPRuntimeSpec {
  /** Transport protocol */
  transport: 'stdio' | 'sse';
  /** Command to spawn (stdio) */
  command?: string;
  /** Command arguments */
  args?: string[];
  /** Static environment variables (non-secret) */
  env?: Record<string, string>;
  /** URL template for SSE transport (can reference config vars) */
  url?: string;
  /** Whether to start lazily (on first tool call) vs eagerly */
  lazyStart?: boolean;
  /** Idle timeout in ms before auto-stopping (0 = never) */
  idleTimeoutMs?: number;
  /** Health check interval in ms (0 = disabled) */
  healthCheckIntervalMs?: number;
  /** Max restarts before giving up */
  maxRestarts?: number;
}
```

### 4.2 Manifest Examples

**DBHub (database gateway):**
```json
{
  "id": "dbhub",
  "name": "DBHub",
  "summary": "Universal database gateway for PostgreSQL, MySQL, SQLite, SQL Server",
  "author": "Bytebase",
  "repository": "https://github.com/bytebase/dbhub",
  "icon": "database",
  "categories": ["database"],
  "tags": ["sql", "postgresql", "mysql", "sqlite", "analytics"],
  "license": "MIT",

  "install": {
    "npm": "@bytebase/dbhub"
  },

  "runtime": {
    "transport": "stdio",
    "command": "npx",
    "args": ["@bytebase/dbhub"],
    "lazyStart": true,
    "idleTimeoutMs": 300000,
    "healthCheckIntervalMs": 60000,
    "maxRestarts": 3
  },

  "configSchema": {
    "type": "object",
    "properties": {
      "dsn": {
        "type": "string",
        "title": "Connection String",
        "description": "Database connection string (e.g., postgresql://user@host:5432/db)",
        "format": "uri"
      },
      "readonly": {
        "type": "boolean",
        "title": "Read-only mode",
        "description": "Restrict to read-only SQL operations",
        "default": true
      }
    },
    "required": ["dsn"]
  },
  "secretFields": ["dsn"],
  "envMapping": {
    "dsn": "DATABASE_URL"
  },

  "defaultApprovalTier": 2,
  "toolApprovals": {
    "search_objects": 0,
    "execute_sql": 2
  },
  "hasWriteOperations": true,
  "supportsReadOnly": true,
  "supportsMultipleInstances": true,
  "platforms": ["desktop", "server"]
}
```

**GitHub:**
```json
{
  "id": "github",
  "name": "GitHub",
  "summary": "Interact with GitHub repositories, issues, PRs, and code search",
  "author": "Anthropic",
  "repository": "https://github.com/modelcontextprotocol/servers",
  "icon": "github",
  "categories": ["developer-tools"],
  "tags": ["git", "code", "issues", "pull-requests"],

  "install": {
    "npm": "@modelcontextprotocol/server-github"
  },
  "runtime": {
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-github"],
    "lazyStart": true
  },

  "configSchema": {
    "type": "object",
    "properties": {
      "token": {
        "type": "string",
        "title": "Personal Access Token",
        "description": "GitHub PAT with repo access"
      }
    },
    "required": ["token"]
  },
  "secretFields": ["token"],
  "envMapping": {
    "token": "GITHUB_PERSONAL_ACCESS_TOKEN"
  },

  "defaultApprovalTier": 1,
  "toolApprovals": {
    "create_issue": 2,
    "create_pull_request": 3,
    "push_files": 3,
    "search_code": 0,
    "search_repositories": 0,
    "get_file_contents": 0
  },
  "platforms": ["desktop", "server"]
}
```

**Slack:**
```json
{
  "id": "slack",
  "name": "Slack",
  "summary": "Read and send Slack messages, manage channels",
  "author": "Anthropic",
  "categories": ["communication"],
  "tags": ["messaging", "chat", "team"],

  "install": {
    "npm": "@modelcontextprotocol/server-slack"
  },
  "runtime": {
    "transport": "stdio",
    "command": "npx",
    "args": ["-y", "@modelcontextprotocol/server-slack"]
  },

  "configSchema": {
    "type": "object",
    "properties": {
      "botToken": {
        "type": "string",
        "title": "Bot Token",
        "description": "Slack Bot User OAuth Token (xoxb-...)"
      },
      "teamId": {
        "type": "string",
        "title": "Team ID",
        "description": "Slack workspace team ID"
      }
    },
    "required": ["botToken"]
  },
  "secretFields": ["botToken"],
  "envMapping": {
    "botToken": "SLACK_BOT_TOKEN",
    "teamId": "SLACK_TEAM_ID"
  },

  "defaultApprovalTier": 2,
  "toolApprovals": {
    "slack_list_channels": 0,
    "slack_get_channel_history": 1,
    "slack_post_message": 3,
    "slack_reply_to_thread": 3
  },
  "platforms": ["desktop", "server"]
}
```

---

## 5. Catalog Service

### 5.1 Catalog Sources

```typescript
class MCPCatalog {
  private builtinManifests: MCPServerManifest[];   // shipped with app
  private remoteManifests: MCPServerManifest[];    // fetched from registry
  private userManifests: MCPServerManifest[];      // user-added

  /** Load built-in catalog from bundled JSON */
  async loadBuiltin(): Promise<void>;

  /** Fetch remote catalog (future - requires registry API) */
  async fetchRemote(): Promise<void>;

  /** Add a user manifest from URL or JSON */
  async addUserManifest(source: string | MCPServerManifest): Promise<void>;

  /** Search/filter catalog */
  search(query: string, filters?: CatalogFilters): MCPServerManifest[];

  /** Get manifest by ID */
  getManifest(id: string): MCPServerManifest | null;

  /** List by category */
  listByCategory(category: MCPCategory): MCPServerManifest[];
}

interface CatalogFilters {
  categories?: MCPCategory[];
  platforms?: ('desktop' | 'server')[];
  installed?: boolean;
  hasWriteOperations?: boolean;
}
```

### 5.2 Built-in Catalog

Phase 1 ships with a curated JSON file of ~15-20 well-tested MCP servers:

```
packages/mcp-catalog/
├── catalog.json          # Array of MCPServerManifest
├── icons/                # SVG icons for each server
└── package.json          # @aspect/mcp-catalog
```

The catalog JSON is bundled into the main app at build time. Updates ship with app releases.

### 5.3 Curated Servers (Phase 1)

| ID | Name | Category | Package |
|----|------|----------|---------|
| `dbhub` | DBHub | database | `@bytebase/dbhub` |
| `github` | GitHub | developer-tools | `@modelcontextprotocol/server-github` |
| `gitlab` | GitLab | developer-tools | `@modelcontextprotocol/server-gitlab` |
| `slack` | Slack | communication | `@modelcontextprotocol/server-slack` |
| `google-drive` | Google Drive | productivity | `@modelcontextprotocol/server-gdrive` |
| `google-maps` | Google Maps | web | `@modelcontextprotocol/server-google-maps` |
| `filesystem` | Filesystem | file-system | `@modelcontextprotocol/server-filesystem` |
| `memory` | Memory | ai-ml | `@modelcontextprotocol/server-memory` |
| `brave-search` | Brave Search | web | `@modelcontextprotocol/server-brave-search` |
| `puppeteer` | Puppeteer | web | `@modelcontextprotocol/server-puppeteer` |
| `postgres` | PostgreSQL (official) | database | `@modelcontextprotocol/server-postgres` |
| `sqlite` | SQLite (official) | database | `@modelcontextprotocol/server-sqlite` |
| `sentry` | Sentry | developer-tools | `@modelcontextprotocol/server-sentry` |
| `linear` | Linear | productivity | `mcp-server-linear` |
| `notion` | Notion | productivity | `notion-mcp-server` |

### 5.4 Remote Registry (Future)

A hosted API that returns `MCPServerManifest[]`:

```
GET https://registry.applepi.dev/v1/catalog
GET https://registry.applepi.dev/v1/catalog?category=database&q=mongo
GET https://registry.applepi.dev/v1/catalog/{id}
```

Community contributors can submit manifests via PR or API. Manifests are reviewed and signed before inclusion.

---

## 6. Package Management

### 6.1 Installer

```typescript
class MCPInstaller {
  /** Install a package from the manifest */
  async install(manifest: MCPServerManifest): Promise<InstallResult>;

  /** Check if a package is installed */
  async isInstalled(manifest: MCPServerManifest): Promise<boolean>;

  /** Get installed version */
  async getInstalledVersion(manifest: MCPServerManifest): Promise<string | null>;

  /** Check for updates */
  async checkUpdate(manifest: MCPServerManifest): Promise<UpdateInfo | null>;

  /** Update to latest version */
  async update(manifest: MCPServerManifest): Promise<InstallResult>;

  /** Uninstall a package */
  async uninstall(manifest: MCPServerManifest): Promise<void>;
}

interface InstallResult {
  success: boolean;
  version: string;
  error?: string;
}

interface UpdateInfo {
  currentVersion: string;
  latestVersion: string;
}
```

### 6.2 Installation Strategies

**npm (primary):**
```typescript
// Install globally so `npx` can find it
await exec(`npm install -g ${manifest.install.npm}@latest`);
```

**npx (zero-install fallback):**
Many MCP servers work with `npx -y` which downloads on first run. This is the simplest path — no explicit install step needed. The manifest's `runtime.command = 'npx'` and `runtime.args = ['-y', packageName]` handle it.

**Docker (server mode):**
```typescript
await exec(`docker pull ${manifest.install.docker}`);
// Spawn via: docker run --rm -i ${manifest.install.docker}
```

**Binary (future):**
Download platform-specific binary to `~/.applepi/mcp-bin/`.

### 6.3 Install Location

```
~/.applepi/
├── mcp-packages/           # npm packages (isolated from system)
│   └── node_modules/
│       ├── @bytebase/dbhub/
│       └── @modelcontextprotocol/server-github/
├── mcp-bin/                 # downloaded binaries
│   ├── dbhub-linux-x64
│   └── github-mcp-darwin-arm64
└── mcp-catalog-cache.json   # cached remote catalog
```

For Phase 1, we can skip explicit installation and rely on `npx -y` which handles download automatically. Explicit install is an optimization for faster startup.

---

## 7. Schema-Driven Configuration

This is the core UX innovation. Instead of users editing JSON configs, the manifest's `configSchema` drives a form UI.

### 7.1 Flow

```
User clicks "Install" on DBHub in store
        │
        ▼
MCPInstaller.install(manifest)
        │ (npm install or npx will handle)
        ▼
Store reads manifest.configSchema
        │
        ▼
ConfigGenerator renders form:
  ┌──────────────────────────────────┐
  │  Configure DBHub                 │
  │                                  │
  │  Connection String *             │
  │  ┌──────────────────────────┐    │
  │  │ postgresql://...         │ 🔒 │  ← secretField → lock icon
  │  └──────────────────────────┘    │
  │                                  │
  │  Read-only mode                  │
  │  [✓] Restrict to read-only      │
  │                                  │
  │         [Cancel]   [Save]        │
  └──────────────────────────────────┘
        │
        ▼
ConfigManager:
  - Non-secret values → MCPServerConfig.metadata
  - Secret values → CredentialStore
  - Build env vars from envMapping at spawn time
```

### 7.2 Config Generator

```typescript
class MCPConfigGenerator {
  /**
   * Generate MCPServerConfig from manifest + user values.
   *
   * Splits user input into:
   * - Regular config fields → stored in MCPServerConfig.metadata
   * - Secret fields → stored in CredentialStore
   * - Env mapping → reconstructed at spawn time
   */
  async generateConfig(
    manifest: MCPServerManifest,
    userValues: Record<string, unknown>
  ): Promise<{
    serverConfig: Partial<IMCPServerConfig>;
    secrets: Record<string, string>;
  }>;

  /**
   * Build environment variables for spawning.
   *
   * Reads secrets from CredentialStore and maps them to
   * env var names defined in manifest.envMapping.
   */
  async buildSpawnEnv(
    manifest: MCPServerManifest,
    serverConfig: IMCPServerConfig
  ): Promise<Record<string, string>>;
}
```

### 7.3 JSON Schema → Form Mapping

| JSON Schema Type | Form Control |
|-----------------|--------------|
| `string` | Text input |
| `string` + `format: "uri"` | URL input with validation |
| `string` + `format: "password"` or in `secretFields` | Password input (masked) |
| `string` + `enum` | Dropdown select |
| `number` | Number input |
| `boolean` | Toggle switch |
| `integer` + `minimum/maximum` | Slider or number input |
| `object` | Nested fieldset |
| `array` of `string` | Tag input |

The form renderer is a generic Svelte component that takes any JSON Schema and renders an appropriate form. This is reusable beyond MCP (e.g., tool-specific config).

---

## 8. Credential Binding

### 8.1 The Problem

Community MCP servers expect credentials as environment variables:

```bash
# Typical MCP server usage today:
GITHUB_PERSONAL_ACCESS_TOKEN=ghp_abc123 npx @modelcontextprotocol/server-github
DATABASE_URL=postgresql://user:pass@host/db npx @bytebase/dbhub
SLACK_BOT_TOKEN=xoxb-abc123 npx @modelcontextprotocol/server-slack
```

This puts secrets in:
- Process environment (visible via `ps eww` or `/proc/PID/environ`)
- Shell history
- Docker inspect output

### 8.2 The Solution

The store splits config into public and secret parts:

```
                    Store UI (user fills form)
                            │
                ┌───────────┼───────────┐
                │           │           │
                ▼           │           ▼
        ConfigStorage       │     CredentialStore
        (non-secrets)       │     (encrypted)
                            │
        { readonly: true }  │   { dsn: "pg://user:pass@host/db" }
                            │
                            │
                    At spawn time:
                            │
                ┌───────────▼───────────┐
                │   MCPManager reads    │
                │   secrets from        │
                │   CredentialStore     │
                │                       │
                │   Maps via envMapping:│
                │   dsn → DATABASE_URL  │
                │                       │
                │   Spawns process with │
                │   env vars set        │
                └───────────────────────┘
```

### 8.3 Credential Storage Keys

Following the existing `provider-apikey-{providerId}` pattern:

```
Service: applepi
Account: mcp-{serverId}-{fieldName}

Examples:
  applepi : mcp-github-01-token          → "ghp_abc123..."
  applepi : mcp-dbhub-01-dsn             → "postgresql://user:pass@host/db"
  applepi : mcp-slack-01-botToken         → "xoxb-abc123..."
```

### 8.4 Spawn-Time Injection

```typescript
// In enhanced MCPManager, before spawning:

async function buildProcessEnv(
  config: IMCPServerConfig,
  manifest: MCPServerManifest
): Promise<Record<string, string>> {
  const env: Record<string, string> = {
    ...process.env,
    ...(config.env ?? {}),           // static env from config
    ...(manifest.runtime.env ?? {}), // static env from manifest
  };

  // Inject secrets from CredentialStore
  if (manifest.secretFields && manifest.envMapping) {
    const credentials = getCredentialStore();
    for (const field of manifest.secretFields) {
      const envVar = manifest.envMapping[field];
      if (envVar) {
        const secret = await credentials.get(
          'applepi',
          `mcp-${config.id}-${field}`
        );
        if (secret) {
          env[envVar] = secret;
        }
      }
    }
  }

  return env;
}
```

### 8.5 Security Properties

| Property | How It's Achieved |
|----------|------------------|
| Secrets not in config files | CredentialStore (OS keychain / AES-256-GCM) |
| Secrets not in shell history | Spawned programmatically, not via shell |
| Secrets not in process listing | Env vars are inherited, not in command line args |
| Secrets not in Docker inspect | Server mode uses in-process env injection |
| Secrets redacted in logs | `logs.tail` filters env vars from child process output |
| Secrets not in config export | `exportConfig()` skips CredentialStore entries |

Note: Env var inheritance means secrets are visible in `/proc/PID/environ` on Linux. This is acceptable for single-user desktop apps but could be improved in server mode by using stdin-based injection for MCP servers that support it (see Open Questions).

---

## 9. Enhanced Lifecycle Management

### 9.1 Changes to MCPManager

The existing `MCPManager` singleton is extended, not replaced:

```typescript
// New fields on IMCPServerConfig (backward compatible — all optional)
interface IMCPServerConfig {
  // ... existing fields ...

  /** Manifest ID this config was generated from */
  manifestId?: string;

  /** User-provided config values (non-secret) */
  metadata?: Record<string, unknown>;

  /** Whether to start lazily (on first tool call) */
  lazyStart?: boolean;

  /** Idle timeout before auto-stop (ms, 0 = never) */
  idleTimeoutMs?: number;

  /** Health check interval (ms, 0 = disabled) */
  healthCheckIntervalMs?: number;

  /** Max auto-restarts before giving up */
  maxRestarts?: number;

  /** Per-tool approval tier overrides */
  toolApprovals?: Record<string, number>;

  /** Default approval tier for all tools from this server */
  defaultApprovalTier?: number;
}
```

### 9.2 Health Monitoring

```typescript
class MCPHealthMonitor {
  private intervals: Map<string, NodeJS.Timeout> = new Map();

  /** Start health checks for a server */
  startMonitoring(serverId: string, intervalMs: number): void {
    const timer = setInterval(async () => {
      const connection = mcpManager.getConnection(serverId);
      if (connection?.status !== 'connected') return;

      try {
        // MCP ping (list tools as lightweight health check)
        await mcpManager.executePing(serverId);
      } catch {
        console.warn(`[MCPHealth] Server ${serverId} failed health check`);
        await this.handleUnhealthy(serverId);
      }
    }, intervalMs);

    this.intervals.set(serverId, timer);
  }

  /** Handle unhealthy server — attempt restart */
  private async handleUnhealthy(serverId: string): Promise<void> {
    const config = mcpManager.getServer(serverId);
    const restartCount = this.getRestartCount(serverId);
    const maxRestarts = config?.maxRestarts ?? 3;

    if (restartCount >= maxRestarts) {
      console.error(`[MCPHealth] Server ${serverId} exceeded max restarts (${maxRestarts})`);
      mcpManager.emit('health-failed', { serverId });
      return;
    }

    console.log(`[MCPHealth] Restarting server ${serverId} (attempt ${restartCount + 1})`);
    await mcpManager.disconnect(serverId);
    await mcpManager.connect(serverId);
    this.incrementRestartCount(serverId);
  }
}
```

### 9.3 Lazy Start

```typescript
// In MCPManager.executeTool():

async executeTool(prefixedName: string, args: unknown): Promise<IMCPToolResult> {
  const [serverName, toolName] = prefixedName.split('__');
  const server = this.getServerByName(serverName);

  if (!server) throw new Error(`MCP server not found: ${serverName}`);

  // Lazy start: connect on first tool call
  const connection = this.connections.get(server.id);
  if (!connection || connection.status === 'disconnected') {
    if (server.lazyStart || server.lazyStart === undefined) {
      console.log(`[MCPManager] Lazy-starting server ${server.name}`);
      await this.connect(server.id);
    } else {
      throw new Error(`MCP server ${server.name} is not connected`);
    }
  }

  // Reset idle timer
  this.resetIdleTimer(server.id);

  return this._executeTool(server.id, toolName, args);
}
```

### 9.4 Auto-Stop (Idle Timeout)

```typescript
private idleTimers: Map<string, NodeJS.Timeout> = new Map();

private resetIdleTimer(serverId: string): void {
  const existing = this.idleTimers.get(serverId);
  if (existing) clearTimeout(existing);

  const config = this.getServer(serverId);
  const timeout = config?.idleTimeoutMs ?? 0;
  if (timeout <= 0) return;

  const timer = setTimeout(async () => {
    console.log(`[MCPManager] Auto-stopping idle server ${config?.name}`);
    await this.disconnect(serverId);
    this.idleTimers.delete(serverId);
  }, timeout);

  this.idleTimers.set(serverId, timer);
}
```

### 9.5 Server Limit

Remove the hardcoded `MAX_USER_SERVERS = 5` limit. Replace with a configurable limit (default: 20) or remove entirely since lazy start + auto-stop means inactive servers consume no resources.

---

## 10. Security & Trust

### 10.1 Trust Model

MCP servers are **untrusted code** running as child processes. The store mitigates risk at multiple levels:

| Layer | Control |
|-------|---------|
| **Catalog curation** | Built-in catalog contains only reviewed, well-known servers |
| **Approval gate** | All MCP tool calls go through existing approval system |
| **Tier mapping** | Each manifest defines per-tool approval tiers (read=auto, write=ask) |
| **Credential isolation** | Secrets in CredentialStore, injected at spawn only |
| **Process isolation** | Each MCP server runs in its own process |
| **Network** | Server mode API requires TLS/loopback for store operations |

### 10.2 Approval Tier Integration

The manifest's `toolApprovals` map feeds into the approval gate:

```typescript
// When registering MCP tools with ToolRegistry:

function registerMCPToolWithApproval(
  tool: IMCPTool,
  manifest: MCPServerManifest,
  registry: ToolRegistry
): void {
  const tier = manifest.toolApprovals?.[tool.name]
    ?? manifest.defaultApprovalTier
    ?? 2;  // default: ask

  registry.register({
    ...adaptTool(tool, serverName),
    metadata: {
      approvalTier: tier,
      mcpServer: manifest.id,
      hasWriteOperations: manifest.hasWriteOperations,
    },
  });
}
```

### 10.3 User-Added Servers

Users can add MCP servers not in the catalog. These are treated as higher risk:

- Default approval tier: 3 (always ask)
- No curated metadata — user must provide all config manually
- Warning displayed: "This server is not from the curated catalog"
- Same credential binding and lifecycle management applies

---

## 11. Agent Experience

### 11.1 Tool Availability

When a user installs an MCP server via the store, its tools become available to the agent automatically via the existing `tools-updated` event flow:

```
Store: install + configure MCP server
  → MCPManager.addServer(config) + connect
    → Adapter discovers tools
      → MCPManager emits 'tools-updated'
        → MCPToolAdapter.registerMCPTools()
          → ToolRegistry now has new tools
            → Agent can use them in next turn
```

No changes to the agent or ToolRegistry needed.

### 11.2 System Prompt Context

When MCP servers are connected, the system prompt includes available tool context:

```
Connected integrations:
- DBHub (database): execute_sql, search_objects
- GitHub (developer-tools): search_code, create_issue, get_file_contents, ...
- Slack (communication): list_channels, post_message, ...

Use these tools to help the user with their requests.
```

This is injected via `PromptComposer` as a dynamic context block.

### 11.3 Tool Namespacing

Existing convention: `serverName__toolName` (double underscore).

With the store, `serverName` is the manifest's `name` field (sanitized). For multiple instances of the same server (e.g., two DBHub connections), the instance is disambiguated:

```
dbhub__execute_sql              (single instance)
dbhub-prod__execute_sql         (named instance: "prod")
dbhub-staging__execute_sql      (named instance: "staging")
```

---

## 12. UI/UX Design

### 12.1 Store Page

Replaces the current `MCPSettings.svelte` with a richer interface:

```
┌──────────────────────────────────────────────────────────────────┐
│  MCP Store                                          [Search...] │
│──────────────────────────────────────────────────────────────────│
│                                                                  │
│  Categories: [All] [Database] [Dev Tools] [Communication] ...   │
│                                                                  │
│  ── Installed (3) ───────────────────────────────────────────── │
│                                                                  │
│  ┌────────┐  DBHub                               ● Connected   │
│  │  [DB]  │  Universal database gateway           [Configure]   │
│  └────────┘  PostgreSQL · Read-only               [Disconnect]  │
│                                                                  │
│  ┌────────┐  GitHub                               ● Connected   │
│  │  [GH]  │  Repos, issues, PRs, code search      [Configure]  │
│  └────────┘  5 tools available                    [Disconnect]  │
│                                                                  │
│  ┌────────┐  Slack                                ○ Stopped     │
│  │  [SL]  │  Messages, channels                    [Configure]  │
│  └────────┘  Idle — will start on use              [Remove]     │
│                                                                  │
│  ── Available ───────────────────────────────────────────────── │
│                                                                  │
│  ┌────────┐  Google Drive                          [Install]    │
│  │  [GD]  │  Search, read, organize files                       │
│  └────────┘                                                      │
│                                                                  │
│  ┌────────┐  Notion                                [Install]    │
│  │  [NO]  │  Pages, databases, search                           │
│  └────────┘                                                      │
│                                                                  │
│  ┌────────┐  Sentry                                [Install]    │
│  │  [SE]  │  Error tracking, issue management                   │
│  └────────┘                                                      │
│                                                                  │
│  ── Custom ──────────────────────────────────────────────────── │
│  [+ Add Custom MCP Server]                                       │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### 12.2 Install + Configure Flow

```
User clicks [Install] on "GitHub"
        │
        ▼
┌──────────────────────────────────────────┐
│  Install GitHub MCP Server               │
│──────────────────────────────────────────│
│                                          │
│  Personal Access Token *                 │
│  ┌────────────────────────────────┐      │
│  │ ghp_•••••••••••••••••••••••   │ 🔒   │
│  └────────────────────────────────┘      │
│  Create a token at github.com/settings   │
│  Requires: repo, read:org scopes         │
│                                          │
│  Security:                               │
│  · Token stored in OS Keychain           │
│  · Read operations: auto-approved        │
│  · Write operations: require approval    │
│                                          │
│           [Cancel]   [Install & Connect] │
└──────────────────────────────────────────┘
        │
        ▼
Store:
  1. Save config to MCPManager
  2. Save token to CredentialStore
  3. Connect (or mark for lazy start)
  4. Show "Connected" in store page
```

### 12.3 Custom Server (Advanced)

For MCP servers not in the catalog:

```
┌──────────────────────────────────────────┐
│  Add Custom MCP Server                   │
│──────────────────────────────────────────│
│                                          │
│  Transport: [stdio ▼]                    │
│                                          │
│  Command:  [npx                      ]   │
│  Args:     [-y, my-custom-mcp-server ]   │
│                                          │
│  Environment Variables:                  │
│  ┌──────────────┐  ┌──────────────────┐  │
│  │ API_KEY      │  │ ••••••••••       │  │
│  └──────────────┘  └──────────────────┘  │
│  [+ Add Variable]                        │
│                                          │
│  ⚠ This server is not from the curated  │
│    catalog. All tool calls will require  │
│    your approval.                        │
│                                          │
│           [Cancel]   [Add & Connect]     │
└──────────────────────────────────────────┘
```

---

## 13. Server Mode API

### 13.1 Scopes

```typescript
// Added to Scope type
| 'store.read'
| 'store.write'
```

Granted to `operator` role only.

### 13.2 Methods

| Method | Scope | Description |
|--------|-------|-------------|
| `store.catalog` | `store.read` | List available MCP servers from catalog |
| `store.installed` | `store.read` | List installed MCP servers with status |
| `store.install` | `store.write` | Install + configure an MCP server (requires TLS/loopback) |
| `store.configure` | `store.write` | Update config for installed server (requires TLS/loopback) |
| `store.uninstall` | `store.write` | Remove an MCP server |
| `store.connect` | `store.write` | Connect a configured server |
| `store.disconnect` | `store.write` | Disconnect a running server |
| `store.health` | `store.read` | Get health status of all servers |

---

## 14. Data Connector as Store Entry

With the MCP Store, the data connector feature (from `data_connector_design.md`) becomes a store entry rather than custom infrastructure:

### What the Store Replaces

| Original Design | Store Approach |
|-----------------|---------------|
| Custom `ConnectorManager` | MCPManager + manifest config |
| Custom `DataQueryTool` | Tools discovered from DBHub MCP server |
| Custom adapter per database | DBHub handles all SQL databases |
| Custom query sanitizer | DBHub has built-in read-only mode |
| `src/data/` module (15+ files) | Manifest JSON + store UI (already built) |

### What Remains Specific to Data Connectors

| Component | Why It's Still Needed |
|-----------|---------------------|
| Connection string parser | Parse `postgresql://user:pass@host/db` to extract password for CredentialStore |
| Schema context injection | Inject available tables into system prompt (requires querying DBHub after connect) |
| `/data` slash command | Convenience shortcut |
| Special settings UI section | Data connectors may warrant a dedicated settings section for discoverability |

### Multiple Database Connections

DBHub supports multi-database config via TOML. With the store's `supportsMultipleInstances: true`, users can install multiple DBHub instances:

```
DBHub — Production (postgresql)     ● Connected
DBHub — Analytics (mysql)           ● Connected
DBHub — Staging (sqlite)            ○ Stopped
```

Each instance has its own config, credentials, and connection state.

---

## 15. Implementation Phases

### Phase 1 — Foundation

| Task | Location | Description |
|------|----------|-------------|
| Define `MCPServerManifest` type | `src/core/mcp/store/types.ts` | Manifest schema |
| Create built-in catalog | `src/core/mcp/store/catalog.ts` | Bundled JSON with ~5 servers (DBHub, GitHub, Filesystem, Memory, Brave Search) |
| Implement `MCPConfigGenerator` | `src/core/mcp/store/config-generator.ts` | Schema → config + credential split |
| Implement credential binding | `src/core/mcp/store/credential-binding.ts` | CredentialStore integration + spawn-time env injection |
| Extend `IMCPServerConfig` | `src/core/mcp/types.ts` | Add manifestId, metadata, lazyStart, toolApprovals |
| Update `MCPManager` spawn | `src/core/mcp/MCPManager.ts` | Read secrets from CredentialStore, inject as env vars |
| JSON Schema form renderer | `src/webfront/components/SchemaForm.svelte` | Generic component for any JSON Schema |
| Store UI page | `src/webfront/mcp-store/StorePage.svelte` | Browse catalog, install, configure |
| Remove 5-server limit | `src/core/mcp/MCPManager.ts` | Increase or remove `MAX_USER_SERVERS` |
| Tests | `src/core/mcp/__tests__/` | Manifest validation, config generation, credential binding |

### Phase 2 — Lifecycle

| Task | Location | Description |
|------|----------|-------------|
| Lazy start | `src/core/mcp/MCPManager.ts` | Connect on first tool call |
| Auto-stop (idle timeout) | `src/core/mcp/MCPManager.ts` | Disconnect after inactivity |
| Health monitoring | `src/core/mcp/store/health-monitor.ts` | Periodic ping, crash detection |
| Auto-restart | `src/core/mcp/store/health-monitor.ts` | Restart crashed servers (with backoff) |
| Approval tier mapping | `src/core/mcp/MCPToolAdapter.ts` | Read tiers from manifest, pass to ToolRegistry |
| Server mode API handlers | `src/server/handlers/store.ts` | `store.*` methods |
| Tests | `src/core/mcp/__tests__/` | Lifecycle, health, approval integration |

### Phase 3 — Catalog Expansion

| Task | Location | Description |
|------|----------|-------------|
| Expand catalog to ~15-20 servers | `src/core/mcp/store/catalog.ts` | Add Slack, Google Drive, Notion, Linear, Sentry, etc. |
| Multiple instances support | `src/core/mcp/MCPManager.ts` | Same manifest, different configs |
| System prompt context injection | `src/core/PromptLoader.ts` | List connected MCP servers + tools in prompt |
| Update check | `src/core/mcp/store/installer.ts` | Compare installed vs latest version |
| Search/filter in store UI | `src/webfront/mcp-store/` | Category filter, text search |

### Phase 4 — Remote Registry (Future)

| Task | Description |
|------|-------------|
| Registry API design | REST API for manifest CRUD + search |
| Community submission flow | PR-based or API-based manifest submission |
| Manifest signing | Verify manifest integrity + author identity |
| Popularity/rating data | Download counts, user ratings |
| Remote catalog fetch | App fetches latest catalog on startup |

---

## 16. Open Questions

| # | Question | Options | Status |
|---|----------|---------|--------|
| 1 | Should the store be a separate page or integrated into existing settings? | A) New page (more visible) B) Tab in settings (consistent) | Open |
| 2 | Should we support stdin-based credential injection for MCP servers that support it? | A) Env vars only (simpler) B) Env vars + stdin (more secure) | Leaning A for Phase 1 |
| 3 | How to handle MCP servers that require OAuth flows (e.g., Google Drive)? | A) Open browser for OAuth B) Require pre-generated token | Open |
| 4 | Should manifests be versioned independently from the app? | A) Bundled with app B) Fetched independently C) Both | Open |
| 5 | How to handle breaking changes in MCP server config formats? | A) Manifest version field B) Migration scripts | Open |
| 6 | Should the store support MCP servers via SSE transport (remote servers)? | A) stdio only B) Both stdio and SSE | Leaning B |
| 7 | Should the agent be able to suggest installing MCP servers? | A) Yes (agent sees catalog) B) No (user-initiated only) | Open |
| 8 | Package naming: `@aspect/*` or `@applepi/*`? | Need to align with npm org | Open |
| 9 | Should the remote registry be public or authenticated? | A) Public catalog B) Auth required C) Public catalog + auth for submission | Open |
| 10 | How to handle MCP server conflicts (two servers expose same tool name)? | A) Namespace always B) Prompt user to pick C) Priority system | Current: namespace via `server__tool` |
