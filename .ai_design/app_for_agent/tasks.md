# App For Agent Implementation Tasks

This task list translates `technical_design.md` into implementation work across BrowserX/Apple Pi, home-page, and data_store_lib.

Status legend:
- `[x]` implemented in the current MVP PR set
- `[ ]` not implemented yet

## Phase 0 - Design Closure

- [x] Preserve the design chat in `.ai_design/app_for_agent/chat_history.md`.
- [x] Produce the implementation-oriented technical design in `.ai_design/app_for_agent/technical_design.md`.
- [x] Add catalog growth strategy in `.ai_design/app_for_agent/catalog_growth_survey.md`.
- [x] Resolve confirmed review gaps: runtime auth, global activation, device identity, existing keychain reuse, deep-link/localhost callback, state enums, migration notes.

## Phase 1 - Home-Page Catalog Control Plane

- [x] Add `apps` catalog table for marketplace app metadata.
- [x] Add `app_versions` table for manifest JSON and metadata markdown releases.
- [x] Add `user_app_installations` table for cross-device install intent.
- [x] Add `user_app_device_connections` table for non-secret per-device status.
- [x] Add `AppStoreHelper` for catalog, install, uninstall, manifest, metadata, and device status operations.
- [x] Add `/api/v1/apps/marketplace`.
- [x] Add `/api/v1/apps/installations`.
- [x] Add `/api/v1/apps/{app_id}`.
- [x] Add `/api/v1/apps/{app_id}/manifest`.
- [x] Add `/api/v1/apps/{app_id}/metadata.md`.
- [x] Add `/api/v1/apps/{app_id}/install`.
- [x] Add `/api/v1/apps/{app_id}/installation`.
- [x] Add `/api/v1/apps/{app_id}/device-status`.
- [x] Register the new routes under the home-page API router.
- [x] Register the new schema classes for dev `create_all`.
- [x] Add a Linear seed entry with Streamable HTTP MCP manifest metadata.

## Phase 2 - Apple Pi Local App State

- [x] Add app manifest, install, connection, auth, search, and activation TypeScript types.
- [x] Add `AppLocalStore` for device id, installed app records, cached manifests, cached metadata markdown, and sync queue.
- [x] Add `AppCredentialStore` wrapper over the existing OS keychain abstraction.
- [x] Keep OAuth tokens out of cached markdown, local manifest cache, MCP persisted config, and home-page tables.
- [x] Add `AppMarketplaceClient` for home-page catalog/install APIs.
- [x] Add `AppInstallService` for install, metadata download, local cache update, uninstall, and status reporting.
- [x] Add `AppMetadataIndex` for local installed-app search without exposing every app tool to the model.

## Phase 3 - MCP Runtime Activation

- [x] Add `streamable-http` as a supported MCP transport type.
- [x] Add non-persisted runtime auth headers for MCP client connections.
- [x] Add runtime-only MCP server configs in `MCPManager`.
- [x] Ensure runtime MCP configs are excluded from persisted `mcpServers`.
- [x] Add `AppActivationService` to lazily connect installed MCP apps.
- [x] Return explicit activation states for `not_installed`, `disabled`, `needs_auth`, `unsupported`, `activated`, `already_active`, `deactivated`, and `error`.
- [x] Deactivate apps by removing their runtime MCP server config.

## Phase 4 - Agent Tool Surface

- [x] Add always-active `app_search` tool.
- [x] Add always-active `app_activate` tool.
- [x] Add always-active `app_deactivate` tool.
- [x] Add always-active `app_list_active` tool.
- [x] Register app tools during desktop tool registration.
- [x] Keep installed app MCP tools folded until `app_activate`.
- [x] Reuse existing MCP tool registration so activated app tools use `{serverName}__{toolName}` names.

## Phase 5 - Apple Pi UI/Service Surface

- [x] Add `apps.marketplace` service handler.
- [x] Add `apps.installations` service handler.
- [x] Add `apps.install` service handler.
- [x] Add `apps.uninstall` service handler.
- [x] Add `apps.search` service handler.
- [x] Add `apps.activate` service handler.
- [x] Add `apps.deactivate` service handler.
- [x] Add `apps.listActive` service handler.
- [x] Wire app services into desktop service registration with the existing home-page auth token getter.
- [x] Build the app marketplace UI screen.
- [x] Build install/uninstall buttons against the new `apps.*` service handlers.
- [x] Show device status and `needs_auth` state in the UI.

## Phase 6 - OAuth And Provider Account Connection

- [x] Add local keychain storage abstraction for app OAuth token sets and OAuth client registrations.
- [x] Make activation return `needs_auth` when OAuth tokens are missing or expired.
- [x] Implement MCP OAuth 2.1 discovery against vendor metadata.
- [x] Implement Dynamic Client Registration where the vendor supports it.
- [x] Implement PKCE authorization flow using the existing localhost callback server.
- [x] Store provider OAuth tokens only in the local OS keychain.
- [x] Refresh expired OAuth access tokens before activation.
- [ ] Add provider-registration UX for vendors that require Apple Pi company setup before user OAuth.

## Phase 7 - Sync And Cross-Device Behavior

- [x] Keep home-page as the source of truth for what apps a user installed.
- [x] Keep provider credentials local-only per device.
- [x] Add local sync queue entries for failed uninstall/status reporting.
- [x] Add sync queue drain/backoff through app sync.
- [x] Add reinstall/resync flow to redownload missing manifest and metadata markdown on a new device.
- [x] Make new devices show installed apps as `needs_auth` until the user connects provider credentials locally.

## Phase 8 - Catalog Growth

- [x] Document first-party and registry ingestion strategy.
- [x] Make Streamable HTTP a first-class runtime transport.
- [ ] Add catalog ingestion job for curated first-party MCP servers.
- [ ] Add official MCP Registry ingestion.
- [ ] Add manifest and metadata markdown auto-generation from MCP `tools/list`.
- [ ] Add trust-tier review workflow for community and aggregator entries.

## Phase 9 - Verification

- [x] BrowserX: run `npm run type-check`.
- [x] BrowserX: run focused MCP tests for config and platform manager behavior.
- [x] Home-page/data_store_lib: run Python compile check with isolated pycache.
- [x] Add unit tests for `AppLocalStore`.
- [x] Add unit tests for `AppMetadataIndex`.
- [x] Add unit tests for `AppActivationService` using a mocked MCP manager.
- [x] Add home-page API tests for install, uninstall, manifest, metadata, and device status.
- [ ] Add an end-to-end smoke test for install -> search -> activate with a no-auth test MCP server.

## Current PR Set

- BrowserX / Apple Pi: https://github.com/The-AI-Republic/browserx/pull/253
- home-page: https://github.com/The-AI-Republic/home-page/pull/118
- data_store_lib: https://github.com/The-AI-Republic/data_store_lib/pull/48
