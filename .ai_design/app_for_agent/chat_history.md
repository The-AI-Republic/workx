# App Store For Agent: Design Chat History

Date: 2026-05-19

This document captures the design conversation and decisions for adding an app-store style connector system to Apple Pi / BrowserX.

## Initial Connector Model

The discussion started from current AI products such as Claude Code and ChatGPT showing many SaaS connectors. The core architecture identified was:

```text
AI app
  -> tool-calling runtime
  -> connector or MCP server
  -> OAuth token or API credential
  -> SaaS API
  -> filtered result/action response
  -> model
```

The important distinction was:

- The SaaS provider usually exposes a normal developer API, not a special LLM API.
- The AI product wraps that API as tools.
- MCP is one standardized way to expose tools/resources to AI clients.
- A CLI may be used behind a connector, but is usually an implementation detail rather than the connector protocol.

## OAuth And Token Storage

OAuth flow was broken down as:

```text
User clicks Connect
  -> app redirects to provider OAuth consent screen
  -> provider redirects back with authorization code
  -> app exchanges code for access/refresh token
  -> app stores credential securely
  -> connector uses token when tools run
```

The first model considered was storing OAuth tokens on the backend. That is common for hosted connectors, but it means the backend owns user SaaS credential risk.

The later decision for MVP was:

```text
Store OAuth credentials locally in the user's OS keychain.
Do not store user SaaS OAuth tokens in the home-page backend.
```

The home-page backend will store catalog and install state. Apple Pi will store per-device credentials locally.

Recommended secret storage:

```text
Apple Pi TypeScript
  -> SecretStore abstraction
  -> Tauri commands
  -> Rust native keychain implementation
  -> macOS Keychain / Windows Credential Manager / Linux Secret Service
```

This was later superseded after code validation: Apple Pi already has `CredentialStore`, `KeytarCredentialStore`, and Tauri `keychain_commands`, so the final design reuses those instead of introducing a parallel `SecretStore`.

## Connector Runtime Taxonomy

The possible ways to connect to an app were listed:

1. Direct SaaS API over HTTP, REST, GraphQL, gRPC, SOAP, JSON-RPC.
2. Official CLI.
3. MCP server over stdio, SSE, or streamable HTTP.
4. Browser automation through extension/content script, Playwright, CDP, or DOM automation.
5. Official SDK/library.
6. Webhooks/events.
7. Vendor app/plugin platforms such as Slack apps, GitHub apps, Google Workspace add-ons, Atlassian apps.
8. File/import/export.
9. Database/data warehouse access.
10. Email/calendar protocols such as IMAP, SMTP, CalDAV, Exchange/EWS.
11. RSS/Atom/public feeds.
12. Native desktop automation.

The product abstraction chosen was:

```text
App = installable user-facing capability package
Runtime = how Apple Pi executes it
Tools = concrete callable functions exposed to the agent
```

For MVP:

```text
App == one MCP server
One app can expose N MCP tools
```

Long term:

```text
App != MCP server

App runtime can be:
  mcp
  http_api
  graphql
  cli
  sdk
  browser_automation
  desktop_automation
  database
  webhook
  hybrid
```

## App Store And Home-Page Backend

We inspected `/home/rich/dev/airepublic/home-page/s1/home-page` and found:

- FastAPI backend.
- PostgreSQL/SQLAlchemy data layer.
- Existing deprecated MCP marketplace endpoints.
- Existing `MCPServerListHelper`.
- Existing `UserMcpInstallHelper`.

The conclusion was that this project is a reasonable place for the catalog/control plane, but the old MCP-specific API should be refactored for the new app concept.

Responsibilities:

```text
home-page backend:
  available app catalog
  app versions/manifests
  user installation source of truth
  install/uninstall records
  metadata/manifest download source

Apple Pi:
  app store UI
  installed app local cache
  OS keychain credential storage
  app metadata search
  lazy MCP activation
  ToolRegistry integration
```

The backend should know what apps the user installed, but not store local OAuth credentials in MVP.

## New Device / Cross-Computer Behavior

The design separates cloud install state from local device connection state:

```text
Cloud installation state:
  installed | uninstalled | disabled

Device connection state:
  missing_metadata | ready | needs_auth | connected | auth_error

Runtime state:
  inactive | active | error
```

When a user switches to a new computer:

```text
1. Apple Pi logs in.
2. Apple Pi fetches installed apps from home-page.
3. Missing/stale manifests and metadata markdown files are downloaded.
4. Local app search index is rebuilt.
5. Apps without local keychain credentials are marked "needs reconnect".
6. User reconnects each app on that device when needed.
```

This preserves privacy while still allowing installed apps to follow the user across devices.

Future alternatives discussed:

- Backend-stored tokens for cross-device auth.
- End-to-end encrypted credential sync.
- Per-device auth for MVP.

MVP decision:

```text
Use per-device auth with local OS keychain.
```

## Agent Context Explosion Problem

If a user installs 1000+ apps, Apple Pi must not connect and expose all tools.

Cheap and acceptable:

```text
1000 installed app records
1000 manifests
1000 compact capability summaries
1000 disconnected MCP runtime configs
```

Expensive and unacceptable:

```text
1000 active MCP connections
1000 MCP tool discovery calls at startup
all tool schemas in the model context
all servers reconnecting and health-checking
```

The key lifecycle distinction:

```text
installed:
  app is in user's library

connected:
  auth/setup exists for this device

indexed:
  local manifest and metadata are available

active:
  MCP server is connected for the current runtime/task. MVP activation is global across active sessions.

exposed:
  app tools are included in the current model call
```

## Lazy Activation

The agreed design is a two-stage system:

```text
Stage 1: App/resource discovery
  Small always-active tools search local app metadata.

Stage 2: App activation
  Load only relevant MCP server tools.
```

Always-active tools:

```text
app_search
app_activate
app_list_active
app_deactivate
```

Possible future tools:

```text
app_search_resources
app_read_resource
```

When the user asks a broad task:

```text
"Write a report to my professor about my thesis of Company A's employee salary change trend."
```

The agent should first search installed app metadata:

```text
app_search({
  query: "thesis professor report company salary employee trend"
})
```

Apple Pi returns compact candidates:

```json
[
  {
    "appId": "com.browserx.google-drive",
    "name": "Google Drive",
    "why": "Searches and reads thesis documents, reports, PDFs, and spreadsheets.",
    "status": "connected"
  },
  {
    "appId": "com.browserx.gmail",
    "name": "Gmail",
    "why": "Finds professor emails and report requirements.",
    "status": "needs_auth"
  }
]
```

The agent activates only relevant apps:

```text
app_activate({ appId: "com.browserx.google-drive" })
```

Then Apple Pi connects the MCP server, discovers tools, registers them, and the next model call can use the real app tools.

## Metadata Markdown Files

The design borrows from Apple Pi's current code search model:

```text
Agent does not see all files.
Agent uses grep/glob to search files.
```

For apps:

```text
Agent does not see all installed MCP tool schemas.
Agent uses app_search to search app metadata markdown files.
```

MVP stores one markdown file per app/MCP server:

```text
~/.apple-pi/apps/metadata/com.browserx.github.md
```

Example content:

```md
# GitHub

App ID: com.browserx.github
MCP Server: github
Status: connected

## Used For
- Search repositories, issues, pull requests, and code discussions
- Read issue details and PR context
- Create issues or comments after user approval

## Best When User Asks
- "find the bug report"
- "summarize open PRs"
- "check repo issues"
- "comment on a pull request"

## Tools Summary
- search_issues: Search GitHub issues and pull requests by query.
- read_issue: Read a specific issue or pull request.
- create_issue: Create a new issue. Requires approval.

## Resource Types
- repositories
- issues
- pull requests
- comments
```

The markdown is for discovery only. It must not contain secrets.

Machine-readable runtime data lives in a manifest JSON file beside it:

```text
~/.apple-pi/apps/manifests/com.browserx.github.json
```

The manifest includes runtime/auth references but no secrets.

## Install Flow

For MVP, install means:

```text
Connect this user/device to an existing MCP app.
Do not spin up a fresh server per install.
```

Flow:

```text
1. User opens app store in Apple Pi.
2. Apple Pi fetches available apps and user install state from home-page.
3. User clicks Install/Connect.
4. Apple Pi calls home-page install API.
5. Home-page records user installation.
6. Apple Pi fetches manifest and metadata markdown.
7. If OAuth is needed, Apple Pi performs OAuth and stores tokens in OS keychain.
8. Apple Pi writes local manifest and metadata markdown.
9. Apple Pi updates local installed app index.
10. app_search can now find the app.
11. The app remains inactive until agent/user activates it.
```

## Uninstall Flow

Uninstall must tell home-page and also clean local runtime data.

Flow:

```text
1. User clicks Uninstall.
2. Apple Pi marks app uninstalling locally.
3. If app is active, disconnect its MCP server.
4. Unregister its tools from active agent sessions.
5. Delete metadata markdown.
6. Delete manifest JSON.
7. Delete local install/index entry.
8. Delete OAuth/API credential from OS keychain.
9. Call home-page uninstall API.
10. If backend call fails, keep local uninstall and queue remote sync retry.
```

After uninstall:

```text
app_search no longer finds the app
app_activate fails with not_installed
agent no longer sees app tools
local OAuth secret is removed
home-page records user app as uninstalled
```

Optional provider token revocation can be added later. MVP can delete local credentials and mark uninstall.

## Remote MCP Auth Decision

Because OAuth tokens are local, remote MCP servers need auth from Apple Pi at activation/tool-call time.

Options discussed:

```text
A. Apple Pi attaches local OAuth access token/header to MCP connection/calls.
B. Apple Pi runs a local MCP proxy that reads keychain.
C. Each MCP server handles its own auth/session.
```

Decision for MVP:

```text
Use A for trusted first-party MCP apps only.
Apple Pi reads local keychain token and attaches auth to the MCP client connection.
```

This must be explicit in the app manifest and restricted by trust policy.

## Existing Apple Pi Code Search Reference

Current Apple Pi code search uses native file-search tools:

```text
Apple Pi agent
  -> ToolRegistry
  -> grep / glob tool
  -> ripgrep executor
  -> local rg binary or bundled @vscode/ripgrep
  -> formatted result back to agent
```

Important pattern:

```text
Do not expose raw shell or all files to the model.
Expose semantic search tools and return compact results.
```

The app metadata search should follow the same pattern.

## Final MVP Agreement

```text
App is a new concept.
MVP app maps one-to-one to an MCP server.
One app can contain many tools.
App is different from Tool and Plugin:
  users install apps,
  agents call tools,
  developers publish plugins/packages.
Home-page is catalog and install source of truth.
Apple Pi stores local manifest/metadata cache.
Apple Pi stores OAuth tokens in OS keychain.
App metadata markdown is downloaded on install/sync.
Agent always sees app_search/app_activate only.
MCP tools are lazy-activated for relevant apps.
Uninstall removes local files, local secrets, active tools, and updates home-page.
```

## App Priority Model

After the first design doc was created, we added an explicit priority model for app exposure:

```text
P0 = core
P1 = pinned
P2 = folded
```

Priority is primarily a property of apps, not individual tools.

```text
P0 Core:
  Built into Apple Pi.
  Always appears in the model tool list.
  User cannot remove or fold.
  Examples: app_search, app_activate, grep, glob, planning_tool.

P1 Pinned:
  Installed app whose selected tools appear in the model tool list by default.
  User/workspace can move it back to folded.
  Subject to trust, context budget, and tool exposure policy.

P2 Folded:
  Installed app that is not directly exposed to the model.
  Searchable through app_search.
  Activated only when relevant.
```

The model sees P0 and P1 tools the same way: as normal callable tools. The difference is enforced by runtime policy and lifecycle.

We also separated app priority from tool exposure:

```text
App priority:
  P0/P1/P2 controls whether the app is core, pinned, or folded.

Tool exposure:
  Controls which tools from the app are shown when pinned or activated.
```

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

This means GitHub is pinned, but only the curated low-risk tools are always shown. Write/destructive tools require activation and approval.

The design now treats `App` as the product layer, `Tool` as the execution layer, and `Plugin` as the developer/package distribution layer:

```text
Plugin/package layer:
  how capabilities are distributed

App/product layer:
  what the user installs, connects, pins, folds, or uninstalls

Tool/execution layer:
  what the agent can call
```

## Claude Review Validation And Fix Decisions

A Claude Code review was validated against the actual PR branch and existing code. Most findings were confirmed, so the technical design was updated with binding implementation decisions.

Resolved decisions:

```text
Activation scope:
  MVP uses global activation.
  This matches the current DesktopAgentBootstrap behavior where MCP tools-updated events register tools on all active sessions.
  Session-scoped MCP activation is deferred.

MCP auth forwarding:
  MVP extends MCPManager.connect(id, authContext?) with a non-persisted RuntimeAuthContext.
  Auth headers are threaded into MCPClient/SSEClientTransport.
  OAuth tokens must not go into MCPServerConfig.apiKey because non-builtin MCP configs are persisted.

SSE header limitation:
  SSEClientTransport can send custom headers on POST message requests.
  EventSource cannot send custom headers on the SSE GET stream.
  First-party MCP servers for MVP must not require OAuth Authorization on the SSE GET connection.

Runtime MCP configs:
  Marketplace app MCP configs are runtime-only and not persisted to mcpServers.
  They follow the builtin browser-server precedent: recreated from app manifest/local cache.

Credential storage:
  Reuse existing CredentialStore, KeytarCredentialStore, and tauri keychain_commands.
  Do not introduce a parallel SecretStore.
  Do not rely on listAccounts because native account listing is unsupported on most keychains.

OAuth callback:
  Use the existing localhost callback server at http://localhost:1455/auth/callback for MVP app OAuth.
  The registered deep-link scheme is airepublic-pi://, not apple-pi://.

Home-page migration:
  Existing /api/v1/mcp, McpServerList, UserMcpInstall, and server-side OAuth callback are deprecated for the new app-store path.
  Add new /api/v1/apps tables/endpoints for MVP.
  Do not write new user SaaS OAuth tokens to UserMcpInstall.mcp_user_info.

Device identity:
  Apple Pi generates crypto.randomUUID() on first app-store sync/install.
  Store it in ConfigStorageProvider under appStore.deviceId.
  Backend treats it as an opaque non-authentication id.

Multi-account:
  Out of MVP scope.
  Use one account per app with credentialRef.account = "default".

Tool namespace:
  Registered MCP tool name remains <serverName>__<toolName>.
  Marketplace serverName defaults to manifest slug and must be globally unique while active.

app_search:
  Search markdown files, then join results with installed.json state at query time.
  AppMetadataIndex owns the join with AppLocalStore.

Sync queue:
  sync-queue.json now has drain/backoff/conflict rules.
```

The `app_activate` contract was expanded with explicit `not_installed`, `disabled`, and `needs_auth` results.

## End-To-End Implementation Readiness Review

A follow-up review bound the design more tightly to both repositories.

Confirmed implementation decisions:

```text
Home-page schema:
  Use the current SQLAlchemy style: integer autoincrement primary keys, String stable IDs, JSON, DateTime, and schema registration through metadata.create_all in dev.

Home-page auth:
  /api/v1/apps stays protected by default.
  Do not add it to public_api_prefixes.
  Use get_current_user and derive user_id from the validated User row, never from request payloads.

Home-page routing:
  Register /marketplace and /installations before /{appId} so FastAPI does not capture collection routes as app ids.

Manifest delivery:
  MVP serves manifest JSON and metadata markdown directly from /api/v1/apps.
  Signed object storage/CDN delivery is deferred.

BrowserX local cache:
  Store app manifests, metadata markdown, installed.json, and sync-queue.json under <apple-pi-data-dir>/apps.
  Use ConfigStorageProvider only for small settings such as appStore.deviceId.

BrowserX implementation plan:
  Add concrete app modules under src/core/apps and src/desktop/apps.
  Extend MCPManager, MCPClient, SSEClientTransport, and DesktopAgentBootstrap along the existing MCP code path.

Deferred decisions:
  Provider OAuth revocation, signed object storage, multi-account UX, and advanced tool allowlist migration are out of MVP.
```

The technical design now includes concrete home-page files, BrowserX files, helper methods, endpoint contracts, and test gates.

## Catalog Growth, DCR, And Provider Registration

We reviewed how to increase app-store supply quickly.

Decisions:

```text
Catalog supply:
  The app store should ingest from the official MCP Registry and curated first-party lists instead of hand-building every app.

Transport:
  Streamable HTTP is required for catalog-scale remote MCP.
  SSE-only can be a short launch window, not the long-term strategy.

Auth:
  MCP-standard OAuth discovery + PKCE is the default path.
  Dynamic Client Registration is used when providers support it.
  Platform static clients are used when BrowserX must register Apple Pi with the provider first.
  Hand-authored auth URLs are fallback exceptions.

Identity:
  Apple Pi account identity and provider account identity are separate.
  Same email is display-only and never skips provider OAuth.

Linear example:
  User installs Linear in Apple Pi, then connects any Linear account through Linear OAuth.
  Same email, different email, SSO, or provider signup all use the same provider-authorized flow.

Google Workspace example:
  BrowserX must register/verify Apple Pi with Google before public users can connect requested Workspace scopes.
  User install can exist before company-side provider registration is ready, but connect is blocked.
```

The technical design now tracks provider registration status separately from user/device connection status and treats BrowserX-hosted token forwarding as the exception rather than the default catalog-scale model.
