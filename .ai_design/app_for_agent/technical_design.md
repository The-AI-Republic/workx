# App Store For Apple Pi Agent: Technical Design

Date: 2026-05-19

## Summary

This design adds an app-store style connector system to Apple Pi. Users install apps from a marketplace, and the agent can discover and lazily activate those apps as tools without loading every installed connector into model context.

MVP scope:

```text
App == one existing MCP server
One app can expose N MCP tools
OAuth/user secrets are stored in local OS keychain
Home-page backend stores app catalog and user installation state
Apple Pi stores local manifest/metadata cache
Agent discovers apps through a small always-active app toolset
App priority controls default tool exposure:
  P0 core, P1 pinned, P2 folded
```

Long-term intent:

```text
App is independent from MCP.
Future runtime types can include API, CLI, SDK, browser automation, database, webhook, or hybrid runtimes.
```

## Goals

- Provide a unified app marketplace UI in Apple Pi.
- Keep MCP as the only runtime type in MVP.
- Avoid model context explosion for users with many installed apps.
- Keep OAuth tokens out of Markdown, manifests, prompts, and the home-page database for MVP.
- Allow installed app state to sync across devices.
- Require per-device reconnect when local keychain credentials are missing.
- Support install, reconnect, lazy activation, deactivate, and uninstall.

## Non-Goals For MVP

- No non-MCP runtime support.
- No cloud sync of OAuth tokens.
- No third-party unreviewed arbitrary MCP install flow.
- No billing/reviews/ranking.
- No full resource indexing across remote SaaS contents.
- No automatic activation of all installed apps at startup.

## Terminology

```text
App:
  User-facing marketplace/installable entity.
  Apps are introduced by this design as a new layer above MCP/tools/plugins.

AppVersion:
  Immutable versioned manifest and metadata.

AppInstallation:
  User's cloud-level install state for an app.

DeviceConnection:
  This device's local connection/auth state for an app.

AppManifest:
  Machine-readable runtime/auth/capability metadata. No secrets.

AppMetadataMarkdown:
  Agent-searchable natural language description. No secrets.

Runtime:
  Execution backend. MVP supports only MCP.

Active App:
  App whose MCP server is currently connected and whose tools are registered for a session.

Exposed Tool:
  Tool schema included in a model call.
```

## App, Tool, And Plugin

This design introduces `App` as a new first-class concept. It is intentionally different from both `Tool` and `Plugin`.

```text
App:
  User-facing installable capability.

Tool:
  Agent-facing callable function.

Plugin:
  Developer/distribution package that can add code, config, skills, apps, or tools.
```

### App

An app is what the user sees in the marketplace:

```text
GitHub
Google Drive
Slack
Linear
```

It answers:

```text
What service/capability did the user install?
Is it installed?
Is it connected on this device?
Is it pinned or folded?
What metadata should app_search use?
What runtime should activate it?
```

For MVP:

```text
1 app -> 1 MCP server
```

Long term:

```text
1 app -> MCP / HTTP API / CLI / SDK / browser automation / hybrid runtime
```

### Tool

A tool is what the LLM can call:

```text
app_search
app_activate
github__search_issues
github__read_issue
gdrive__search_files
slack__send_message
```

It answers:

```text
What function can the model invoke right now?
What input schema does it have?
What handler executes it?
Is it read-only, risky, or destructive?
```

Relationship:

```text
1 app -> N tools
```

Installing an app does not necessarily expose all its tools. App priority and tool exposure policy decide which tools enter the model tool list.

### Plugin

A plugin is a developer/package mechanism. It can contain:

```text
skills
MCP server configs
tool definitions
runtime code
marketplace metadata
assets
one or more apps
```

It answers:

```text
How is functionality packaged and loaded into Apple Pi?
Who published this code/config?
What files/code should be installed or enabled?
```

Relationship:

```text
1 plugin -> 0..N apps
1 plugin -> 0..N skills
1 plugin -> 0..N MCP configs/tools
```

Clean mental model:

```text
Users install apps.
Agents call tools.
Developers publish plugins/packages.
```

MVP does not require plugin packaging for marketplace apps. The home-page catalog can provide app manifests directly. Later, plugins may become one distribution path for apps, especially third-party/local apps.

## App Priority And Tool Exposure

App priority controls default exposure to the model.

```text
P0 = core
P1 = pinned
P2 = folded
```

Priority belongs primarily to the app, not to individual tools. Tools inherit effective exposure from their app, then the app's tool exposure policy decides which subset is actually shown.

### P0 Core

```text
Always shown in the model tool list.
Built into Apple Pi.
User cannot remove or fold.
Required for basic agent operation.
```

Examples:

```text
app_search
app_activate
app_deactivate
app_list_active
grep
glob
planning_tool
```

P0 may be represented as a virtual/system app internally, but it is not a normal marketplace app.

### P1 Pinned

```text
Shown in the model tool list by default.
Comes from installed apps.
User/workspace can pin or fold.
Subject to context/tool budget and trust policy.
Only curated tools should be exposed by default.
```

P1 does not mean all tools from the app are always shown. It means the app is eligible to expose selected low-risk/read/search tools by default.

Example:

```json
{
  "appId": "com.browserx.github",
  "priority": 1,
  "toolExposure": {
    "pinned": ["search_issues", "read_issue"],
    "onActivate": ["create_issue", "comment_on_issue", "close_issue"]
  }
}
```

### P2 Folded

```text
Not shown as direct tools by default.
Searchable through app_search.
Can be activated for a session/task.
```

Folded app metadata is indexed locally, but the app's MCP server is not connected and its tool schemas are not included until activation.

### Model Perspective

From the LLM's perspective:

```text
P0 and P1 tools both appear as ordinary callable tools.
P2 apps only appear indirectly through app_search results until activated.
```

The runtime enforces the difference:

```text
P0:
  always registered before every turn

P1:
  registered only if installed, enabled, connected, trusted, and within budget

P2:
  metadata only until app_activate succeeds
```

Recommended defaults:

```text
Max pinned apps auto-exposed:
  3-5

Max pinned tools per app:
  3-8

Pinned default tool types:
  read/search tools only

Write/destructive tools:
  require activation and approval

Community/untrusted apps:
  folded only
```

## High-Level Architecture

```text
Home-page backend
  -> App catalog DB
  -> App versions/manifests
  -> User app installation records
  -> Metadata markdown download

Apple Pi UI
  -> App marketplace
  -> Installed apps
  -> Connect/reconnect/uninstall

Apple Pi local runtime
  -> Local manifest cache
  -> Local metadata markdown cache
  -> OS keychain credentials
  -> App search index
  -> App activation service
  -> MCPManager
  -> ToolRegistry

Apple Pi agent
  -> always-active app_search/app_activate tools
  -> lazily activated MCP app tools
```

## MVP Binding Decisions

These decisions bind the design to the current BrowserX/Apple Pi and home-page codebases.

```text
Activation scope:
  MVP uses global MCP activation, matching current MCPManager/DesktopAgentBootstrap behavior.
  When an app MCP server is activated, its selected tools are registered on all active sessions.
  True per-session MCP scoping is deferred.

MCP transport:
  Catalog-scale MVP supports streamable-http, sse, and stdio manifests.
  Existing BrowserX code only supports sse and stdio today, so adding streamable-http is MVP-critical if registry ingestion is in scope.
  SSE-only launch is allowed as a time-boxed preview path, not the long-term remote-MCP strategy.

MCP auth:
  MVP extends MCPManager.connect with a non-persisted RuntimeAuthContext.
  Runtime auth is threaded into MCPClient/SSEClientTransport/StreamableHTTPTransport as ephemeral headers.
  OAuth tokens must never be stored in MCPServerConfig.apiKey or persisted mcpServers config.

OAuth default:
  Default remote-MCP auth is direct-to-vendor MCP-standard OAuth discovery + PKCE.
  Dynamic Client Registration is used when the provider supports it.
  Platform static OAuth clients are used when BrowserX must register Apple Pi with the provider first.
  Hand-authored authorizationUrl/tokenUrl manifests are fallback exceptions, not the catalog-scale default.

MCP server config lifecycle:
  Marketplace app MCP configs are runtime-only/non-persisted.
  They follow the builtin browser server precedent: held in MCPManager memory, recreated from app manifest/local cache.

Provider identity:
  Apple Pi account identity and provider account identity are separate.
  Matching email is only a hint and never an authorization shortcut.
  User app installation can succeed before provider auth succeeds; the device remains needs_auth until the provider connection is completed.

OAuth callback:
  MVP uses the existing localhost callback server at http://localhost:1455/auth/callback.
  The airepublic-pi:// deep-link scheme remains available for app-login style flows but is not the default for app OAuth.

Secret storage:
  MVP reuses the existing CredentialStore/KeytarCredentialStore/keychain_commands stack.
  No parallel SecretStore abstraction is introduced.

Home-page migration:
  Existing /api/v1/mcp, McpServerList, and UserMcpInstall are deprecated for the new app store path.
  New /api/v1/apps tables/endpoints are greenfield for MVP; old server-side token storage is not reused.

Catalog growth:
  Official MCP Registry ingestion is a first-class source of app catalog rows.
  Registry rows generate draft app_versions, manifests, and metadata markdown through an ingestion/introspection pipeline.
```

## Repository Split

Home-page repo:

```text
/home/rich/dev/airepublic/home-page/s1/home-page
```

Owns:

- Marketplace API.
- App catalog database.
- User installation records.
- App manifest and metadata publication.
- Optional admin/publisher UI later.

BrowserX/Apple Pi repo:

```text
/home/rich/dev/airepublic/open_source/s2/browserx
```

Owns:

- App store UI inside Apple Pi.
- Local install cache.
- OS keychain secret store.
- Agent app discovery tools.
- MCP lazy activation and ToolRegistry integration.

## Data Model: Home-Page Backend

The old `mcp_server_list` and `user_mcp_install` concepts are deprecated for this feature. MVP should add new app-store tables/endpoints instead of extending the old MCP marketplace path.

Rationale:

```text
Existing old path:
  /api/v1/mcp
  McpServerList
  UserMcpInstall
  server-side OAuth callback
  Fernet-encrypted mcp_user_info credential storage

New MVP path:
  /api/v1/apps
  App/AppVersion/UserAppInstallation/UserAppDeviceConnection
  desktop-local OAuth PKCE
  local OS keychain credential storage
```

No new MVP code should write user SaaS OAuth tokens into `UserMcpInstall.mcp_user_info`. Existing rows can remain for legacy/deprecated behavior until a migration cleanup is scheduled.

Migration delivery:

```text
The home-page backend currently relies on SQLAlchemy metadata.create_all during startup.
MVP can introduce the new app tables through the same schema registration path.
If Alembic/Flyway becomes the production migration path before implementation, create equivalent migrations for these tables.
```

### apps

Global app identity.

```text
id                  integer primary key autoincrement
app_id              varchar(128) unique not null index  -- com.browserx.github
slug                varchar(128) unique not null index  -- github
name                varchar(255) not null index
description         text
publisher_id        varchar(128) nullable
status              varchar(32) not null default active -- active | hidden | disabled | removed
latest_version      varchar(64) nullable
trust_tier          varchar(32) not null default community -- first_party | verified | registry | community | aggregator
provider_registration_status varchar(32) not null default ready -- ready | needs_company_registration | verification_pending | restricted | unsupported
icon_url            text nullable
categories          json/list nullable
tags                json/list nullable
created_at          datetime default func.now()
updated_at          datetime default func.now(), onupdate func.now()
```

### app_versions

Immutable app release metadata.

```text
id                   integer primary key autoincrement
app_id               varchar(128) not null index
version              varchar(64) not null
manifest             json not null               -- canonical manifest JSON for MVP
metadata_md          text not null               -- canonical markdown for MVP
manifest_sha256      varchar(64) not null
metadata_sha256      varchar(64) not null
signature            text nullable
status               varchar(32) not null        -- draft | active | deprecated | revoked
created_at           datetime default func.now()
published_at         datetime nullable

unique(app_id, version)
```

MVP stores `manifest` and `metadata_md` directly in Postgres so the first implementation does not need object storage, signed URLs, or a separate publishing pipeline. Later, `manifest_url` and `metadata_url` can be added for large catalogs or CDN delivery.

### user_app_installations

Cloud source of truth for installation intent/state.

```text
id                    integer primary key autoincrement
user_id               varchar(128) not null index
app_id                varchar(128) not null index
installed_version     varchar(64) nullable
install_status        varchar(32) not null       -- installed | uninstalled | disabled
enabled               boolean not null default true
priority              integer not null default 2 -- 0 core, 1 pinned, 2 folded
installed_at          datetime nullable
uninstalled_at        datetime nullable
last_synced_at        datetime nullable
created_at            datetime default func.now()
updated_at            datetime default func.now(), onupdate func.now()

unique(user_id, app_id)
```

### user_app_device_connections

Optional non-secret device status. This helps UI explain cross-device reconnect status.

```text
id                    integer primary key autoincrement
user_id               varchar(128) not null index
device_id             varchar(128) not null index
app_id                varchar(128) not null index
metadata_status       varchar(32) not null default missing
device_status         varchar(32) not null       -- missing_metadata | ready | needs_auth | connected | auth_error | blocked_by_provider_registration
runtime_status        varchar(32) not null default inactive
provider_account_hint varchar(255) nullable      -- email/username, no secrets
scopes                json/list nullable
last_connected_at     datetime nullable
last_seen_at          datetime nullable
created_at            datetime default func.now()
updated_at            datetime default func.now(), onupdate func.now()

unique(user_id, device_id, app_id)
```

No OAuth access tokens or refresh tokens are stored in home-page for MVP.

Home-page implementation notes:

```text
Use the existing SQLAlchemy style in backend/data_store/db/schema/public:
  Column(Integer, primary_key=True, autoincrement=True)
  Column(String(...))
  Column(JSON)
  Column(DateTime, default=func.now(), onupdate=func.now())
  from ....config.database import Base

Use stable string identifiers for app_id and device_id.
Do not use UUID primary keys for MVP unless the rest of the home-page schema is migrated first.
```

### State Enums

Use these enums consistently in backend records, local `installed.json`, UI, and agent-tool results.

Cloud installation status:

```text
installed
uninstalled
disabled
```

Metadata status:

```text
missing
synced
stale
hash_mismatch
```

Device connection status:

```text
missing_metadata
ready
needs_auth
connected
auth_error
blocked_by_provider_registration
```

Runtime status:

```text
inactive
active
error
```

`ready` means manifest/metadata are present and no auth is required. `connected` means manifest/metadata are present and a local credential exists for an auth-required app.

Provider registration status:

```text
ready
needs_company_registration
verification_pending
restricted
unsupported
```

`provider_registration_status` is about BrowserX/Apple Pi as a company/application being allowed to use the provider platform. It is separate from a user's provider account connection. Example: Linear can be `ready` while a specific device is `needs_auth`; Google Workspace may be `verification_pending` until BrowserX completes Google OAuth app verification for requested scopes.

Trust tier:

```text
first_party
verified
registry
community
aggregator
```

Trust tier controls default exposure, activation friction, and whether privileged runtime behavior such as token forwarding is permitted. Registry namespace verification is a provenance signal, not a blanket safety guarantee.

### Device Identity

Apple Pi must generate a stable per-installation device id.

```text
Generation:
  crypto.randomUUID() on first app-store sync/install.

Storage:
  Persist in ConfigStorageProvider under key appStore.deviceId.
  Mirror in OS keychain only if future privacy policy requires harder-to-copy identity.

Lifecycle:
  Survives normal app restarts and upgrades.
  Resets when the user clears Apple Pi local config/data.
  Is not a hardware fingerprint.
```

The backend treats `device_id` as an opaque client-generated id. It is used only to report per-device connection status; it is not an authentication factor.

## App Manifest Schema

Manifest is machine-readable and drives runtime setup. It must contain no secrets.

```json
{
  "schemaVersion": "2026-05-19",
  "appId": "com.linear.linear",
  "slug": "linear",
  "name": "Linear",
  "version": "1.0.0",
  "publisher": {
    "id": "linear",
    "name": "Linear",
    "verified": true
  },
  "trust": {
    "tier": "first_party",
    "source": "official_mcp_registry",
    "namespaceVerified": true
  },
  "runtime": {
    "type": "mcp",
    "transport": "streamable-http",
    "url": "https://mcp.linear.app/mcp",
    "serverName": "linear"
  },
  "providerRegistration": {
    "status": "ready",
    "clientMode": "dynamic_client_registration",
    "notes": "BrowserX does not need a pre-created Linear client when DCR is available."
  },
  "auth": {
    "type": "mcp_oauth",
    "provider": "linear",
    "identityRelationship": "external_provider_account",
    "clientMode": "dynamic_client_registration",
    "discovery": {
      "authorizationServerMetadata": true,
      "protectedResourceMetadata": true
    },
    "pkce": true,
    "scopes": ["read", "write"],
    "redirect": {
      "type": "localhost",
      "uri": "http://localhost:1455/auth/callback"
    }
  },
  "capabilities": [
    "Search Linear issues",
    "Read projects and team context",
    "Create issues",
    "Comment on issues"
  ],
  "priorityDefaults": {
    "defaultPriority": 2,
    "userCanPin": true,
    "workspaceCanPin": true
  },
  "toolPolicy": {
    "mode": "allowlist",
    "namespace": "slug_double_underscore",
    "pinned": ["search_issues", "read_issue"],
    "onActivate": [
      "search_issues",
      "read_issue",
      "create_issue",
      "comment_on_issue"
    ]
  },
  "permissions": [
    {
      "id": "linear.issues.read",
      "risk": "low",
      "description": "Read issues, projects, teams, and comments"
    },
    {
      "id": "linear.issues.write",
      "risk": "medium",
      "description": "Create issues or comments"
    }
  ],
  "metadata": {
    "markdownUrl": "https://home.example.com/api/v1/apps/com.linear.linear/metadata.md",
    "sha256": "..."
  }
}
```

Provider registration variants:

```json
{
  "providerRegistration": {
    "status": "verification_pending",
    "clientMode": "platform_static_client",
    "provider": "google",
    "requiredCompanyAction": "Complete Google OAuth consent screen verification for requested Workspace scopes."
  },
  "auth": {
    "type": "mcp_oauth",
    "provider": "google",
    "identityRelationship": "external_provider_account",
    "clientMode": "platform_static_client",
    "clientIdRef": "google_workspace_desktop_client",
    "pkce": true
  }
}
```

The first example is a Linear-style flow: the user must have or create a Linear account through Linear OAuth, but BrowserX does not need a per-user account mapping beyond the OAuth token. The second example is a Google Workspace-style flow: BrowserX must register/verify Apple Pi with Google before public users can connect their Google accounts.

## Provider Registration And User Connections

There are two independent authorization layers.

```text
Provider registration:
  BrowserX/Apple Pi as a company or OAuth client is allowed to access the provider platform.
  Examples: Google Cloud OAuth consent screen, verified domains, scope verification, OAuth client id.

User provider connection:
  A specific Apple Pi user connects their external provider account on this device.
  Examples: a Linear user signs in through Linear OAuth; a Google Workspace user grants Drive/Gmail scopes.
```

Apple Pi identity and provider identity must remain separate:

```text
Apple Pi account:
  Owns app marketplace install state and sync state.

Provider account:
  Owns SaaS data permissions, workspace membership, and provider-side scopes.

Email matching:
  UI hint only. Never a proof of identity, workspace membership, or authorization.
```

Scenario handling:

```text
User has Linear with a different email:
  Install succeeds.
  OAuth opens Linear.
  User signs in with any Linear-supported method.
  Store token locally and providerAccountHint only.

User has Linear with the same email:
  Same flow. Do not auto-link or skip OAuth.

User has no Linear account:
  Install can still succeed.
  Linear OAuth/signup handles account creation if Linear supports it.
  Until OAuth completes, local device state remains needs_auth.

Google Workspace-style provider:
  Install can be visible in the catalog.
  Connect is disabled or marked unavailable until providerRegistration.status is ready.
  Once BrowserX has a verified/static Google OAuth client, users connect their Google accounts normally.
```

Supported auth/client modes:

```text
mcp_oauth_dynamic_client_registration:
  Discover authorization metadata, register dynamically, run PKCE.
  Best catalog-scale path when provider supports DCR.

mcp_oauth_platform_static_client:
  BrowserX pre-registers Apple Pi with the provider and ships a non-secret public client id.
  Required for providers such as Google Workspace that need company-side OAuth setup/verification.

mcp_oauth_manual_provider_config:
  Manifest contains provider-specific authorizationUrl/tokenUrl/client metadata.
  Acceptable for a curated app, not for high-volume registry ingestion.

api_key:
  User supplies a provider API key or token; store it in OS keychain.

none:
  Public or anonymous MCP server.
```

Home-page may store provider registration metadata and public client identifiers. It must not store user access tokens, refresh tokens, API keys, authorization codes, or provider sessions in MVP.

## Metadata Markdown

One markdown file per app/MCP server.

Purpose:

- Searchable by `app_search`.
- Helps the agent decide which installed app to activate.
- Contains natural language use cases, synonyms, tool groups, resource types.

Must not contain:

- OAuth tokens.
- API keys.
- User identifiers.
- Provider secrets.

Example:

```md
# GitHub

App ID: com.browserx.github
Runtime: MCP

## Used For
- Search repositories, issues, pull requests, and code discussions
- Read issue details and pull request context
- Create issues or comments after user approval

## Best When User Asks
- find a bug report
- summarize open pull requests
- check repository issues
- comment on a pull request

## Tool Groups
### Search
- search_issues
- search_repositories

### Read
- read_issue
- read_pull_request

### Write
- create_issue
- comment_on_issue

## Resource Types
- repositories
- issues
- pull requests
- comments
- code search results
```

## Apple Pi Local Storage

Recommended layout:

```text
<apple-pi-data-dir>/apps/
  installed.json
  manifests/
    com.browserx.github.json
  metadata/
    com.browserx.github.md
  sync-queue.json
```

`installed.json`:

```json
{
  "apps": [
    {
      "appId": "com.browserx.github",
      "cloudInstalled": true,
      "enabled": true,
      "priority": 1,
      "manifestVersion": "1.0.0",
      "manifestSha256": "...",
      "metadataSha256": "...",
      "metadataStatus": "synced",
      "deviceStatus": "connected",
      "runtimeStatus": "inactive",
      "credentialRef": {
        "service": "apps:com.browserx.github",
        "account": "default"
      },
      "oauthClientRegistrationRef": {
        "service": "apps:com.browserx.github:oauth-client-registration",
        "account": "default"
      },
      "installedAt": "2026-05-19T00:00:00Z",
      "lastSyncedAt": "2026-05-19T00:00:00Z"
    }
  ]
}
```

For MVP, one account per app is supported. The credential account id is always `default`. Multi-account support can be added later by changing `credentialRef.account` to a generated connection id and changing `user_app_installations` uniqueness.

## Credential Storage

Reuse the existing BrowserX credential abstraction and desktop keychain implementation.

Existing code:

```text
src/core/storage/CredentialStore.ts
src/desktop/storage/KeytarCredentialStore.ts
tauri/src/keychain_commands.rs
```

Do not introduce a parallel `SecretStore` interface. Add an app-specific wrapper around `CredentialStore`.

```ts
import type { CredentialStore } from "@/core/storage/CredentialStore";

export interface OAuthTokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  tokenType?: string;
  scopes?: string[];
  providerAccountHint?: string;
}

export class AppCredentialStore {
  constructor(private readonly credentials: CredentialStore) {}

  serviceFor(appId: string): string {
    // KeytarCredentialStore will apply the existing applepi- prefix.
    return `apps:${appId}`;
  }

  async saveOAuthTokens(appId: string, tokens: OAuthTokenSet): Promise<void> {
    await this.credentials.set(this.serviceFor(appId), "default", JSON.stringify(tokens));
  }

  async getOAuthTokens(appId: string): Promise<OAuthTokenSet | null> {
    const raw = await this.credentials.get(this.serviceFor(appId), "default");
    return raw ? JSON.parse(raw) as OAuthTokenSet : null;
  }

  async deleteOAuthTokens(appId: string): Promise<void> {
    await this.credentials.delete(this.serviceFor(appId), "default");
  }
}
```

Dynamic Client Registration metadata:

```ts
export interface OAuthClientRegistration {
  clientId: string;
  clientSecret?: string;
  clientIdIssuedAt?: number;
  clientSecretExpiresAt?: number;
  registrationClientUri?: string;
  registrationAccessToken?: string;
  issuer?: string;
}
```

Storage rule:

```text
Public/non-secret DCR fields may be mirrored in installed.json for diagnostics.
Any returned client_secret, registration_access_token, or provider registration credential must be stored in OS keychain only.
For MVP, cache DCR metadata per user/app/device under:
  service: apps:<appId>:oauth-client-registration
  account: default
If provider DCR metadata expires or is missing, rerun registration before OAuth.
```

Do not rely on `listAccounts()` for app credentials. Native account listing is best-effort/unsupported on most OS keychains. `installed.json` stores the credential reference, so enumeration is unnecessary.

```text
Final stored native keychain service:
  applepi-apps:<appId>

Final account:
  default
```

On Linux without a keyring provider, fail clearly. Do not silently write plaintext tokens.

## Home-Page API

The old `/api/v1/mcp` API is deprecated for this feature. The new app-store path should use `/api/v1/apps` endpoints and new app helpers/tables.

Auth binding:

```text
Do not add /api/v1/apps to public_api_prefixes.
AuthMiddleware protects /api/... by default.
Endpoint handlers should use get_current_user(request, db) and derive user_id from the validated JWT/database user.
Never accept user_id from request body, query params, OAuth callback payload, or device-status payload as authority.
```

FastAPI route ordering:

```text
Define static collection routes before dynamic app-id routes:
  /marketplace
  /installations
  /{appId}
  /{appId}/...

Otherwise /installations can be captured by /{appId}.
```

### List Marketplace Apps

```http
GET /api/v1/apps/marketplace?q=&cursor=&limit=50
Authorization: Bearer <user token>
```

Returns catalog cards merged with user install state.

```json
{
  "items": [
    {
      "appId": "com.browserx.github",
      "slug": "github",
      "name": "GitHub",
      "description": "Search repositories, issues, and pull requests.",
      "iconUrl": "https://...",
      "version": "1.0.0",
      "capabilities": [
        "Search repositories",
        "Read issues",
        "Comment on pull requests"
      ],
      "runtime": {
        "type": "mcp",
        "transport": "streamable-http"
      },
      "trust": {
        "tier": "first_party",
        "namespaceVerified": true
      },
      "providerRegistration": {
        "status": "ready",
        "clientMode": "dynamic_client_registration"
      },
      "install": {
        "status": "installed",
        "enabled": true
      }
    }
  ],
  "nextCursor": null
}
```

### Get App Detail

```http
GET /api/v1/apps/{appId}
Authorization: Bearer <user token>
```

Returns app detail, install state, version info, permissions, and safe manifest metadata.

Marketplace, detail, install, and sync responses must include `trust` and `providerRegistration` summaries so the UI can render install/connect states without downloading every manifest. Full manifest remains the source of truth for runtime setup.

### Get Manifest

```http
GET /api/v1/apps/{appId}/manifest
Authorization: Bearer <user token>
```

Returns the manifest JSON directly for MVP.

### Get Metadata Markdown

```http
GET /api/v1/apps/{appId}/metadata.md
Authorization: Bearer <user token>
```

Returns markdown only. No user secrets.

### Install

```http
POST /api/v1/apps/{appId}/install
Authorization: Bearer <user token>
Content-Type: application/json

{
  "version": "1.0.0",
  "deviceId": "dev_..."
}
```

Response:

```json
{
  "status": "installed",
  "appId": "com.browserx.github",
  "version": "1.0.0",
  "manifestSha256": "...",
  "metadataSha256": "...",
  "requiresAuth": true,
  "trust": {
    "tier": "first_party",
    "namespaceVerified": true
  },
  "providerRegistration": {
    "status": "ready",
    "clientMode": "dynamic_client_registration"
  }
}
```

### Uninstall

```http
DELETE /api/v1/apps/{appId}/installation
Authorization: Bearer <user token>
Content-Type: application/json

{
  "deviceId": "dev_..."
}
```

Response:

```json
{
  "status": "uninstalled",
  "appId": "com.browserx.github"
}
```

### Sync User Installations

```http
GET /api/v1/apps/installations
Authorization: Bearer <user token>
```

Response:

```json
{
  "items": [
    {
      "appId": "com.browserx.github",
      "status": "installed",
      "enabled": true,
      "version": "1.0.0",
      "manifestSha256": "...",
      "metadataSha256": "...",
      "deviceStatus": "needs_auth",
      "metadataStatus": "synced",
      "runtimeStatus": "inactive",
      "trust": {
        "tier": "first_party",
        "namespaceVerified": true
      },
      "providerRegistration": {
        "status": "ready",
        "clientMode": "dynamic_client_registration"
      }
    }
  ]
}
```

### Report Device Status

```http
POST /api/v1/apps/{appId}/device-status
Authorization: Bearer <user token>
Content-Type: application/json

{
  "deviceId": "dev_...",
  "metadataStatus": "synced",
  "deviceStatus": "connected",
  "runtimeStatus": "inactive",
  "providerAccountHint": "user@example.com",
  "scopes": ["repo", "read:org"]
}
```

Response:

```json
{
  "status": "ok",
  "appId": "com.browserx.github",
  "deviceId": "dev_..."
}
```

The response must not include credentials, access tokens, refresh tokens, authorization codes, or provider session data.

## Home-Page Implementation Plan

New files:

```text
backend/apps/main/api/v1/endpoints/apps.py
backend/data_store/db/schema/public/App.py
backend/data_store/db/schema/public/AppVersion.py
backend/data_store/db/schema/public/UserAppInstallation.py
backend/data_store/db/schema/public/UserAppDeviceConnection.py
backend/data_store/db/helper/AppStoreHelper.py
```

Modify:

```text
backend/apps/main/api/v1/router.py
  import apps
  api_router.include_router(apps.router, prefix="/apps", tags=["Apps"])

backend/main.py
  import the four new schema classes near the existing McpServerList/UserMcpInstall imports:
    from data_store.db.schema.public.App import App
    from data_store.db.schema.public.AppVersion import AppVersion
    from data_store.db.schema.public.UserAppInstallation import UserAppInstallation
    from data_store.db.schema.public.UserAppDeviceConnection import UserAppDeviceConnection
  this registers them before DSBase.metadata.create_all(bind=engine) in dev

backend/middleware/auth_middleware.py
  no change for MVP
  leave /api/v1/apps protected by default
```

Endpoint dependencies:

```text
from backend.common.configs.config.database import get_db
from backend.common.utils.auth.auth import get_current_user

Use current_user = Depends(get_current_user).
Use str(current_user.user_id), matching the User schema's UUID user_id field returned by UsersHelper.
```

Helper ownership:

```text
AppStoreHelper owns all joins across app catalog, versions, user installations, and device connections.
Endpoint functions should stay thin: validate request, call helper, shape response.
```

Minimum helper methods:

```text
upsert_catalog_app(app_payload, version_payload)
list_marketplace(user_id, q, cursor, limit)
get_app_detail(user_id, app_id)
get_active_version(app_id)
get_manifest(app_id)
get_metadata_md(app_id)
install_app(user_id, app_id, version, device_id)
uninstall_app(user_id, app_id, device_id)
list_user_installations(user_id, device_id)
upsert_device_status(user_id, app_id, device_id, metadata_status, device_status, runtime_status, provider_account_hint, scopes)
```

Catalog seed:

```text
MVP must include one idempotent seed path for first-party apps.
Preferred: add a small backend script that opens get_db/create_engine_for_db and calls AppStoreHelper.upsert_catalog_app().
Do not require manual SQL for the first vertical slice.
```

## Catalog Ingestion

The long-term catalog should grow from machine-readable upstream feeds instead of hand-authored app rows.

Primary source:

```text
Official MCP Registry:
  GET https://registry.modelcontextprotocol.io/v0.1/servers?limit=&cursor=
  Use metadata.nextCursor pagination.
  Poll roughly hourly for registry-ingested tiers.
```

Registry mapping:

```text
server.name                         -> apps.app_id
server.title/name                   -> apps.name/slug
server.description                  -> apps.description and metadata seed
server.version                      -> app_versions.version
server.remotes[].type/url           -> manifest.runtime.transport/url
server.packages[]                   -> future stdio/local package install data
_meta.status/isLatest/updatedAt     -> app_versions status and freshness
namespace verification/provenance   -> apps.trust_tier input
```

Ingestion pipeline:

```text
1. Fetch registry pages.
2. Deduplicate by server.name + version.
3. Filter unsupported transports only if BrowserX runtime cannot consume them yet.
4. Produce draft app_versions with manifest JSON.
5. Decide introspection mode:
   - unauthenticated if server permits initialize/tools/list without auth.
   - provider test tenant/service account for curated first-party apps.
   - deferred until first user connection for auth-required registry/community apps.
6. For introspectable servers, connect in a sandbox/introspection worker.
7. Run initialize + tools/list and capture tool names/descriptions/schemas.
8. Generate toolPolicy and metadata markdown from server + tool descriptions.
9. For non-introspectable apps, generate minimal metadata from registry fields and mark toolPolicy as pending_introspection.
10. Mark app version active only after validation and trust policy pass.
```

Ingestion job model:

```text
Job identity:
  source + cursor window + server.name + server.version

Idempotency:
  unique(app_id, version) in app_versions.
  Re-running ingestion updates draft rows but never mutates active immutable app_versions in place.

Locking:
  Use a single-row ingestion lock or advisory DB lock per source.
  If another job holds the lock, skip or return 409 from admin trigger.

Retry:
  Retry transient registry/network failures with exponential backoff.
  Store last_success_at, last_cursor, last_error, and failure_count in ingestion job state.

Approval:
  first_party curated seed rows may auto-activate after validation.
  registry/community rows enter draft or review_pending unless trust policy allows automatic publication.
```

Home-page ingestion modules:

```text
backend/data_store/db/helper/AppStoreHelper.py
  upsert_catalog_app(...)
  upsert_app_version(...)

backend/data_store/db/helper/AppCatalogIngestionHelper.py
  sync_official_mcp_registry(...)
  map_registry_server_to_manifest(...)
  run_introspection(...)
  mark_stale_versions(...)

backend/apps/main/api/v1/endpoints/apps.py
  public/user marketplace API

backend/apps/main/api/v1/endpoints/app_admin.py  # later/admin-only
  trigger ingestion
  review/approve generated app versions
```

Trust policy:

```text
first_party:
  BrowserX-controlled or directly verified vendor-operated app.

verified:
  Registry namespace or publisher provenance is verified, but BrowserX has not manually reviewed every behavior.

registry:
  Registry source without enough signal for verified/first_party.

community:
  Broad directory or self-submitted app; explicit user approval required.

aggregator:
  Meta-app such as Zapier/Composio/Pipedream that exposes many downstream actions behind one MCP app.
  Requires separate sub-search and permission UX.
```

Provider registration policy:

```text
DCR-capable providers:
  registry row can often become an installable app without BrowserX creating a provider OAuth client first.

Static-client providers:
  catalog row may exist, but connect is blocked until BrowserX completes provider registration/verification.
  Example: Google Workspace OAuth consent screen and sensitive/restricted scope verification.

User-supplied credential providers:
  app can be installable if the user supplies an API key/client config and it is stored only in local keychain.
```

Legacy MCP path:

```text
Do not modify /api/v1/mcp for the app-store MVP except to mark it deprecated in comments or docs.
Do not call UserMcpInstallHelper from new /api/v1/apps endpoints.
Do not store OAuth tokens in UserMcpInstall.mcp_user_info from the new app-store flow.
```

## Apple Pi Modules

Suggested new modules:

```text
src/core/apps/
  AppManifest.ts
  AppInstallation.ts
  AppMarketplaceClient.ts
  AppLocalStore.ts
  AppMetadataIndex.ts
  AppActivationService.ts
  AppAgentTools.ts

src/core/apps/credentials/
  AppCredentialStore.ts

src/desktop/storage/
  KeytarCredentialStore.ts   # existing, reused

src/desktop/apps/
  DesktopOAuthFlow.ts
  DesktopAppInstallController.ts

src/webfront/marketplace/
  AppStore.svelte
  AppDetail.svelte
  InstalledApps.svelte
```

BrowserX implementation bindings:

```text
src/core/apps/AppManifest.ts
  Runtime-independent manifest and validation types.
  MVP validates schemaVersion, appId, slug, version, runtime.type=mcp, transport=streamable-http|sse|stdio, auth, providerRegistration, trust, toolPolicy.

src/core/apps/AppInstallation.ts
  Local installed.json types, state enums, priority enum, sync queue item types.

src/core/apps/AppMarketplaceClient.ts
  Typed client for /api/v1/apps.
  Uses the existing authenticated home-page HTTP client/auth token plumbing where available.
  Does not accept or return secrets.

src/core/apps/AppLocalStore.ts
  File-backed store under <apple-pi-data-dir>/apps.
  Reads/writes installed.json, manifests/*.json, metadata/*.md, sync-queue.json atomically.
  Owns device id creation by storing appStore.deviceId in ConfigStorageProvider.

src/core/apps/AppMetadataIndex.ts
  Uses the existing ripgrep executor pattern from src/tools/file-search/ripgrep.ts.
  Searches metadata/*.md, then joins each match with AppLocalStore state.

src/core/apps/AppActivationService.ts
  Implements app_activate/app_deactivate/app_list_active behavior.
  Owns runtime-only MCP server registration and RuntimeAuthContext construction.

src/core/apps/AppAgentTools.ts
  Registers always-active app_search/app_activate/app_deactivate/app_list_active tool definitions.

src/core/apps/credentials/AppCredentialStore.ts
  Thin wrapper over CredentialStore; service apps:<appId>, account default.

src/desktop/apps/DesktopOAuthFlow.ts
  Provider-agnostic OAuth PKCE flow using the existing localhost callback server pattern.

src/desktop/apps/DesktopAppInstallController.ts
  UI/controller orchestration for install, reconnect, uninstall, sync on login, sync queue drain.
```

Modify existing BrowserX files:

```text
src/core/mcp/types.ts
  Add RuntimeAuthContext.
  Add streamable-http to MCPTransportType.
  Add runtime-only MCP config metadata or a separate runtime registration input.

src/core/mcp/MCPManager.ts
  Add addRuntimeServer(input) or addServer(input, { persist: false }).
  Runtime app servers are held in memory and excluded from persistServers().
  Extend connect(id, authContext?) without changing persisted config shape.

src/core/mcp/MCPClient.ts
  Accept RuntimeAuthContext headers and pass them to SSEClientTransport.

src/core/mcp/transports/SSEClientTransport.ts
  Accept headers for POST/message requests.
  Do not rely on headers for EventSource GET.

src/core/mcp/transports/StreamableHTTPTransport.ts
  Add MCP Streamable HTTP transport using the MCP SDK transport contract.
  Support auth headers from RuntimeAuthContext.
  Prefer this transport for registry-ingested remote MCP servers.

src/desktop/agent/DesktopAgentBootstrap.ts
  Keep current global MCP registration for MVP.
  Register app agent tools as always-active tools when desktop agent sessions are created.

src/core/mcp/MCPToolAdapter.ts
  Keep existing <serverName>__<toolName> naming.
  AppActivationService must ensure manifest.runtime.serverName is unique before connecting.
```

Local storage implementation:

```text
Desktop MVP should use a real filesystem directory so ripgrep can search markdown.
Recommended root: <Tauri app data dir>/apps.
If BrowserX lacks a generic app-data-dir filesystem service, add one small desktop storage adapter instead of putting markdown into ConfigStorageProvider.
Use ConfigStorageProvider only for the stable appStore.deviceId and small settings.
```

## Agent Tools

Always active tools registered into `ToolRegistry`.

### app_search

Search local installed app metadata.

Input:

```json
{
  "type": "object",
  "properties": {
    "query": {
      "type": "string"
    },
    "limit": {
      "type": "number",
      "default": 10
    },
    "includeNeedsAuth": {
      "type": "boolean",
      "default": true
    }
  },
  "required": ["query"]
}
```

Output:

```json
{
  "matches": [
    {
      "appId": "com.browserx.github",
      "name": "GitHub",
      "score": 0.91,
      "status": "connected",
      "why": "Can search issues, pull requests, and repositories.",
      "capabilities": ["Search issues", "Read pull requests"]
    }
  ]
}
```

MVP search implementation:

```text
Use ripgrep over local metadata markdown files.
Join markdown search results with AppLocalStore installed.json state at query time.
The join owner is AppMetadataIndex.search(), which returns ranked matches enriched with AppLocalStore state.
Rank by exact app name/tag/capability matches, then content matches.
Return compact top results.
```

Future:

```text
Add embeddings, resource index, usage-based ranking, LLM reranker.
```

### app_activate

Activate an installed app for the global desktop runtime.

MVP activation is global because current MCP tool registration listens to `MCPManager` events and registers tools on all active sessions. Session-scoped activation is deferred until MCPManager and ToolRegistry registration support per-session scoping.

Input:

```json
{
  "type": "object",
  "properties": {
    "appId": {
      "type": "string"
    },
    "reason": {
      "type": "string"
    }
  },
  "required": ["appId"]
}
```

Behavior:

```text
1. Verify app is locally installed and enabled.
2. Verify metadata and manifest exist.
3. Verify providerRegistration.status is ready.
4. Resolve auth mode:
   - none: continue without credentials.
   - api_key: read API key from keychain.
   - mcp_oauth_*: read/refresh OAuth access token from keychain.
5. If credentials are required but missing, return needs_auth.
6. Create or reuse runtime-only MCP server config.
7. Build RuntimeAuthContext:
   - direct-to-vendor: attach provider token/API key to the provider MCP transport.
   - BrowserX-controlled proxy: attach token only if manifest explicitly permits trusted first-party forwarding.
8. Connect MCPManager.
9. Discover tools.
10. Apply tool allowlist and exposure policy.
11. Register tools on all active sessions for MVP.
12. Return compact available tool summary.
```

If provider registration is not ready:

```json
{
  "status": "blocked_by_provider_registration",
  "appId": "com.google.workspace",
  "message": "Google Workspace is installed, but Apple Pi provider verification is not ready yet."
}
```

If credentials are missing:

```json
{
  "status": "needs_auth",
  "appId": "com.browserx.github",
  "message": "GitHub is installed but needs reconnect on this device."
}
```

If the app is not installed:

```json
{
  "status": "not_installed",
  "appId": "com.browserx.github",
  "message": "GitHub is not installed."
}
```

If the app is disabled:

```json
{
  "status": "disabled",
  "appId": "com.browserx.github",
  "message": "GitHub is installed but disabled."
}
```

### app_deactivate

Disconnect app runtime and unregister tools from all active sessions for MVP.

### app_list_active

Return active apps and compact tool summaries.

## MCP Activation Path

MVP path:

```text
app_activate
  -> AppActivationService
  -> AppLocalStore.loadManifest(appId)
  -> AppCredentialStore.getOAuthTokens(appId) when auth is required
  -> MCPManager.addRuntimeServer or reuse existing runtime server
  -> MCPManager.connect(server.id, runtimeAuthContext)
  -> MCPManager emits tools-updated
  -> DesktopAgentBootstrap setupMCPToolRegistration registers tools on all active sessions
  -> next model call sees activated app tools
```

Existing relevant code:

- `src/core/mcp/MCPManager.ts`
- `src/core/mcp/MCPToolAdapter.ts`
- `src/desktop/agent/DesktopAgentBootstrap.ts`
- `src/tools/ToolRegistry.ts`

Current BrowserX code supports `sse` and `stdio` only. Catalog-scale MVP adds `streamable-http` because the official registry and most modern first-party remote MCP servers are Streamable-HTTP-first. An SSE-only launch is allowed only as a short preview path.

Tool naming:

```text
Registered tool name = <manifest.runtime.serverName>__<mcpToolName>
```

`serverName` must be globally unique among active app runtimes. For marketplace apps, default to manifest `slug`, and reject activation if another active runtime already owns the same server name.

Runtime MCP server configs:

```text
Add an MCPManager runtime-only registration path.
Runtime app servers are not persisted to ConfigStorageProvider/mcpServers.
Do not use addServer for marketplace activation unless it gains a persist:false option.
```

## Remote MCP Auth Models

Default model: Apple Pi connects directly to the provider MCP endpoint and performs provider OAuth locally.

```text
Apple Pi MCP client
  -> provider remote MCP endpoint
  -> provider OAuth discovery / PKCE / optional DCR
  -> local OS keychain token storage
```

Proxy/token-forwarding model: Apple Pi attaches a local OAuth access token to a BrowserX-controlled MCP endpoint. This is the exception path, not the catalog-scale default.

Manifest must explicitly permit this:

```json
{
  "runtime": {
    "type": "mcp",
    "transport": "sse",
    "url": "https://mcp.browserx.ai/github/sse",
    "authForwarding": {
      "mode": "oauth_access_token_header",
      "header": "Authorization",
      "scheme": "Bearer",
      "trustedFirstPartyOnly": true
    }
  }
}
```

Policy:

```text
Prefer direct-to-vendor MCP OAuth for registry-ingested and third-party apps.
Only allow token forwarding for apps whose publisher/trust level is first_party.
Only forward tokens to BrowserX-controlled endpoints.
Never forward tokens to community or arbitrary URL apps.
Never include token in tool args, prompts, logs, metadata, or manifest.
Mask auth headers in diagnostics.
```

Implementation detail:

Current `MCPServerConfig` supports `apiKey`, but that field is persisted. Do not store OAuth tokens inside persisted MCP config. MVP must add non-persisted runtime auth for direct-to-vendor and BrowserX-controlled MCP connections.

Required addition:

```ts
interface RuntimeAuthContext {
  headers?: Record<string, string>;
}

interface IMCPManager {
  connect(id: string, authContext?: RuntimeAuthContext): Promise<void>;
}
```

Threading:

```text
MCPManager.connect(id, authContext)
  -> createAdapter(config, authContext)
  -> MCPClient({ config, apiKey, headers: authContext.headers })
  -> StreamableHTTPTransport or SSEClientTransport({ url, timeout, apiKey, headers })
```

`SSEClientTransport` already supports custom headers for POST message requests. MVP must extend `MCPClient` to pass headers through. EventSource cannot send custom headers, so first-party MCP servers must not require the OAuth Authorization header on the SSE GET stream; they should require it on POST tool-call/message requests, or accept a non-secret app/session id on the SSE URL and validate bearer auth on POST.

If a candidate MCP server requires Authorization on the EventSource GET request, it is not compatible with this MVP auth-forwarding model.

## Install Flow

```text
User clicks Install
  -> Apple Pi POST /api/v1/apps/{appId}/install
  -> backend records installation
  -> Apple Pi downloads manifest + metadata
  -> Apple Pi verifies sha256
  -> Apple Pi writes local manifest/metadata
  -> if providerRegistration.status is not ready, mark device needs_auth/blocked_by_provider_registration
  -> if user provider auth is required and providerRegistration.status is ready, start connect flow
  -> OAuth/API-key flow returns to Apple Pi
  -> Apple Pi stores token JSON/API key in OS keychain
  -> Apple Pi updates installed.json with credentialRef
  -> Apple Pi reports non-secret device connected status to backend
```

No MCP connection is opened during install unless user chooses "activate now".

## OAuth And Provider Connection Flow

Desktop-first provider connection flow:

```text
1. Read manifest providerRegistration and auth mode.
2. If providerRegistration.status is not ready, stop and show provider-registration blocker.
3. If auth.clientMode is dynamic_client_registration, discover provider metadata and register client.
4. If auth.clientMode is platform_static_client, load BrowserX public client id from manifest/config.
5. Apple Pi generates code_verifier, code_challenge, state.
6. Apple Pi opens provider authorization URL.
7. User signs into or signs up for the provider account using provider-supported methods.
8. Redirect comes back to http://localhost:1455/auth/callback.
9. Apple Pi validates state.
10. Apple Pi exchanges code for token using PKCE.
11. Apple Pi stores token JSON in OS keychain.
12. Apple Pi writes credentialRef locally.
13. Apple Pi updates home-page device connection status without sending token.
```

Use existing infrastructure:

```text
tauri/src/oauth_server.rs
start_oauth_callback_server
src/desktop/auth/ChatGPTOAuthDesktopFlow.ts as the implementation pattern
```

If provider does not support desktop PKCE, fallback options must be app-specific and reviewed. Same-email Apple Pi and provider accounts must still go through provider authorization; email match is not an auth shortcut.

## Sync On Login / New Device

```text
1. Apple Pi authenticates user with home-page.
2. Apple Pi calls GET /api/v1/apps/installations.
3. For each installed app:
   - If manifest missing or hash mismatch, download manifest.
   - If metadata missing or hash mismatch, download metadata markdown.
   - If no local credentialRef/keychain secret, mark needs_auth.
4. Rebuild app metadata index.
5. Installed apps appear in UI as connected or needs reconnect.
```

App search should include needs-auth apps by default but clearly return status so the agent can ask for reconnect if needed.

## Uninstall Flow

```text
User clicks Uninstall
  -> Apple Pi confirms
  -> mark local app uninstalling
  -> if active, disconnect MCP server
  -> unregister tools from active sessions
  -> delete keychain secret
  -> delete local manifest
  -> delete local metadata markdown
  -> remove installed.json entry
  -> rebuild app metadata index
  -> DELETE /api/v1/apps/{appId}/installation
  -> if backend call fails, enqueue sync retry
```

Uninstall is local-first for safety. Home-page is the cloud source of truth, but local secrets must be removed immediately when requested.

Optional future:

```text
Call provider token revocation endpoint if supported.
```

## Error Handling

Install:

- Backend unavailable: show retry, do not create local install.
- Manifest download fails: installation remains cloud-installed but local `missing_metadata`.
- Hash mismatch: reject manifest/metadata.
- OAuth fails: mark `auth_error`.
- Keychain unavailable: fail connect, do not store plaintext.

Activate:

- Missing manifest: try sync, then fail.
- App not in local/cloud install records: return `not_installed`.
- App installed but disabled: return `disabled`.
- Provider registration not ready: return `blocked_by_provider_registration`.
- Missing credential: return `needs_auth`.
- Token expired: refresh if refresh token exists.
- Refresh failed: mark `auth_error`.
- MCP connection failed: mark runtime error, keep installed state.

Uninstall:

- MCP disconnect fails: best-effort continue.
- Keychain delete fails: report error and keep app marked partially uninstalled until secret is deleted.
- Backend uninstall fails: local uninstall succeeds, enqueue remote sync.

## Security Requirements

- No OAuth tokens in Markdown.
- No OAuth tokens in manifests.
- No OAuth tokens in model prompts.
- No OAuth tokens in tool arguments.
- No OAuth tokens in persisted MCP server config.
- OS keychain only for local token storage.
- Token forwarding only for trusted first-party MCP apps.
- Mask auth headers in logs.
- Verify manifest and metadata hashes.
- Prefer signed manifests before third-party apps are allowed.
- Use PKCE for OAuth.
- Validate OAuth state.
- Never accept `user_id` from OAuth callback payload as authority.
- Never auto-link provider accounts by matching email with Apple Pi accounts.
- Treat provider account hints as display-only, non-authoritative metadata.
- Store platform public client ids only when the provider model allows public/native clients; never store provider client secrets in app manifests.
- For provider-managed static clients, block connect until provider registration and verification are complete.

## Implementation Phases

### Phase 1: Schema And Local Cache

- BrowserX: add `AppManifest.ts`, `AppInstallation.ts`, `AppLocalStore.ts`, and `AppMetadataIndex.ts`.
- BrowserX: add local app storage under `<apple-pi-data-dir>/apps`.
- BrowserX: add metadata markdown cache and ripgrep search.
- BrowserX: add install index model and device id creation.
- Home-page: add `App`, `AppVersion`, `UserAppInstallation`, and `UserAppDeviceConnection` schema classes.
- Home-page: import the new schema classes in `backend/main.py` so dev `metadata.create_all` sees them.
- Home-page: include trust tier and provider registration status in catalog records/manifests.

### Phase 2: Home-Page API

- Add `/api/v1/apps/marketplace`.
- Add `/api/v1/apps/installations`.
- Add `/api/v1/apps/{appId}`.
- Add `/api/v1/apps/{appId}/manifest`.
- Add `/api/v1/apps/{appId}/metadata.md`.
- Add install/uninstall endpoints.
- Add `/api/v1/apps/{appId}/device-status`.
- Add `backend/apps/main/api/v1/endpoints/apps.py`.
- Register the apps router in `backend/apps/main/api/v1/router.py`.
- Create new app helpers/tables for the `/api/v1/apps` path.
- Do not reuse old `/api/v1/mcp` server-side credential storage for new apps.
- Add a migration note/admin cleanup task for deprecated `McpServerList` and `UserMcpInstall` rows.
- Add idempotent seed script for curated first-party apps.
- Add registry ingestion helper behind an internal/admin-only entrypoint.

### Phase 3: Credential Store

- Reuse existing `CredentialStore`.
- Add `AppCredentialStore` wrapper.
- Reuse existing `KeytarCredentialStore` and Tauri keychain commands.
- Avoid `listAccounts()` reliance.
- Add tests/mocks.

### Phase 4: Transport And OAuth

- Add Streamable HTTP transport support.
- Add desktop OAuth PKCE flow.
- Add MCP-standard OAuth metadata discovery.
- Add Dynamic Client Registration when advertised by provider.
- Add platform static client mode for providers requiring BrowserX registration.
- Add provider registration blockers in install/connect UI and app tool results.
- Use existing localhost callback handling at `127.0.0.1:1455`.
- Store token JSON in OS keychain.
- Record non-secret device connection status.

### Phase 5: Agent App Tools

- Register `app_search`, `app_activate`, `app_deactivate`, `app_list_active`.
- Use app metadata index for discovery.
- Implement activation using `MCPManager`.
- Add global active app tracking for MVP.
- Add runtime-only MCP app server registration.
- Add non-persisted `RuntimeAuthContext` through MCPManager/MCPClient/SSEClientTransport.

### Phase 6: UI

- App store list.
- App detail.
- Install/connect/reconnect/uninstall states.
- Installed apps screen.
- Active apps indicator.

### Phase 7: Hardening

- Manifest hash verification.
- Runtime auth context that is not persisted.
- Tool allowlist.
- Idle disconnect.
- Active app/tool limits.
- Remote sync retry queue.
- Sync queue drain/backoff/conflict handling.

## Test Plan

BrowserX unit tests:

```text
AppManifest:
  accepts valid MCP manifest
  rejects missing appId/version/runtime
  accepts streamable-http, sse, and stdio transports
  rejects non-MCP runtime for MVP
  validates providerRegistration and trust tier

AppLocalStore:
  creates device id once and reuses it
  writes installed.json atomically
  writes/deletes manifest and metadata files
  preserves unrelated installed app records

AppMetadataIndex:
  searches metadata markdown with ripgrep
  joins search results with installed.json state
  returns needs_auth status without activating app

AppCredentialStore:
  stores, reads, and deletes tokens through mocked CredentialStore
  never calls listAccounts

AppActivationService:
  returns not_installed for missing app
  returns disabled for disabled app
  returns needs_auth for auth-required app without keychain token
  returns blocked_by_provider_registration when provider registration is not ready
  creates runtime-only MCP config
  calls MCPManager.connect(id, RuntimeAuthContext)
  does not write token to persisted MCP server config

StreamableHTTPTransport:
  connects to a streamable-http MCP endpoint
  sends RuntimeAuthContext headers without persisting them
  handles provider OAuth access token refresh handoff
```

Home-page tests:

```text
GET /api/v1/apps/marketplace requires auth and returns catalog plus install state.
GET /api/v1/apps/installations is defined before /{appId} and does not route as appId=installations.
POST /api/v1/apps/{appId}/install creates or reactivates UserAppInstallation.
DELETE /api/v1/apps/{appId}/installation marks uninstalled and updates device status without deleting catalog rows.
POST /api/v1/apps/{appId}/device-status upserts UserAppDeviceConnection.
Manifest and metadata endpoints return no credential fields.
Request body user_id is ignored or rejected.
No new /api/v1/apps path writes UserMcpInstall.mcp_user_info.
Registry ingestion maps server.name/version/remotes into App/AppVersion rows.
Provider registration status blocks connect but does not require hiding catalog entry.
```

Manual end-to-end acceptance:

```text
1. Seed one first-party MCP app in home-page.
2. Sign into Apple Pi and open app marketplace.
3. Install app.
4. Apple Pi writes manifest and metadata markdown locally.
5. app_search finds the installed app by a natural language query.
6. app_activate connects runtime-only MCP server and exposes namespaced tools.
7. Restart Apple Pi; app remains installed, inactive, searchable.
8. On a second machine, sync shows installed app but needs_auth until local OAuth reconnect.
9. Uninstall deletes local metadata and keychain token before remote sync retry.
10. Confirm no OAuth token appears in installed.json, manifest, metadata, persisted mcpServers, logs, or home-page rows.
```

Expected verification commands once implementation starts:

```text
BrowserX:
  npm run type-check
  npm run test -- App
  npm run test -- MCPManager
  npm run test -- SSEClientTransport

Home-page:
  pytest backend/tests backend/data_store/db/helper/tests
```

## Suggested Limits

```text
Installed apps:
  High cap; stored as metadata only.

Active apps globally:
  5-10.

Connected MCP servers globally:
  10-25.

Tool schemas per model call:
  30-80.

Idle disconnect:
  5-15 minutes.

Pinned always-active apps:
  3-5 maximum.
```

## Deferred Decisions

These are intentionally out of MVP and should not block implementation.

```text
Manifest hosting:
  MVP serves manifest JSON and metadata markdown directly from /api/v1/apps.
  Signed object storage/CDN delivery is deferred until catalog size or publisher workflow requires it.

Local metadata storage:
  MVP stores markdown files under <apple-pi-data-dir>/apps/metadata so ripgrep can search them.
  ConfigStorageProvider is not used for markdown content.

Tool allowlist compatibility:
  MVP allowlist uses raw MCP tool names from the manifest.
  On activation, missing allowlisted tools are skipped and reported in app_activate warnings.
  Tool renames require publishing a new app version/manifest.

Provider OAuth revocation:
  MVP uninstall deletes local keychain tokens and remote installation/device status.
  Calling provider-specific token revocation endpoints is deferred.

Multi-account:
  MVP supports one account per user/app/device with account id default.
  Multi-account support is deferred and requires changing local credentialRef, backend uniqueness, and UI account selection.
```

## Sync Queue

`sync-queue.json` stores local operations that must be retried against home-page after local state has already changed.

Queue item:

```json
{
  "id": "queue_...",
  "type": "install_sync|uninstall_sync|device_status_sync",
  "appId": "com.browserx.github",
  "attempt": 0,
  "nextAttemptAt": "2026-05-19T00:00:00Z",
  "createdAt": "2026-05-19T00:00:00Z",
  "payload": {}
}
```

Drain policy:

```text
Drain on Apple Pi startup, login, network regain, and every 5 minutes while signed in.
Use exponential backoff with jitter: 1m, 5m, 15m, 1h, 6h max.
Drop or quarantine items after 10 failed attempts and surface them in diagnostics.
```

Conflict policy:

```text
Local uninstall wins for local secrets and metadata.
If backend says app already uninstalled, mark queue item complete.
If backend says app no longer exists, mark local app removed and complete.
If backend says app disabled by policy, keep local credentials deleted and mark disabled.
```

## Recommended Immediate Next Step

Implement the MVP vertical slice with one first-party MCP app:

```text
1. Add one app record to home-page catalog.
2. Add manifest and metadata markdown endpoints.
3. Add Apple Pi local app cache.
4. Add app_search over local markdown metadata.
5. Add app_activate that connects the MCP server.
6. Add keychain-backed token storage only if the chosen app requires OAuth.
7. Add uninstall cleanup.
```

This proves the product loop without committing to non-MCP runtimes yet.
