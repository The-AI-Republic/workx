# Runtime-Owned OpenHub Apps

Status: reviewed; implementation-ready with unified gateway authentication

## Review Outcome

The design is approved for implementation in the migration order in this
document. OpenHub gateway is the only user-credential boundary for WorkX. The
same credential is used for LLM routing, MCP app execution, and the Apps HTTP
control plane; Hub must not introduce a parallel user-token verifier.

## Summary

WorkX must perform every OpenHub Apps network request outside the Webfront.
The Webfront sends typed service requests and receives normalized application
data, access state, or structured errors. Except for a candidate key while the
user is actively entering/saving it, the Webfront never receives an OpenHub API
key or an AI Republic session token, and it never calls an OpenHub HTTP endpoint
directly.

The mechanism is shared by OSS WorkX and private WorkX. The distributions
differ only in the credential policy selected at build time:

| Distribution | Allowed credential | Apps becomes available when |
|---|---|---|
| OSS WorkX | User-supplied OpenHub API key | The key has been validated and stored |
| Private WorkX | AI Republic session JWT | The user has a valid login session |

An OpenHub API key is one credential for every enabled OpenHub gateway surface:
LLM routing, MCP, and Apps. It is not an OpenAI, Anthropic, Google, or other
model-provider BYOK credential. Private WorkX uses the same OIDC access token
created by its existing login flow for every gateway surface.

The same rule applies to third-party AI agents, not only WorkX. OpenHub mints
one `air_...` API key whose default scopes are `chat`, `models`, and `apps`.
That key authenticates LLM reasoning and model discovery under `/v1`, app tool
discovery and execution under `/mcp`, and the Apps control plane under
`/api/v1/apps`. Scope selection and model/provider/app allowlists may narrow a
key for least privilege, but they are restrictions on one credential—not
separate LLM and Apps credential types. OpenHub must never require a user to
mint a second Apps key alongside an LLM key.

## Goals

- Route catalog, installation, activation, connection, and credential requests
  through a WorkX runtime service.
- Keep OpenHub API keys and session JWTs out of the Webfront.
- Use one runtime credential source for OpenHub LLM routing, the Apps control
  plane, and the built-in OpenHub MCP connection.
- Make OSS WorkX API-key-only by default.
- Let private WorkX replace one narrow policy module to become login-only.
- Keep product-neutral runtime, UI, state, and transport code in public WorkX.
- Eliminate browser CORS as a dependency of the Apps feature.

## Non-goals

- Treating model-provider API keys as OpenHub credentials.
- Implementing OpenHub API-key issuance inside WorkX. WorkX links to the
  configured key-management page and accepts a key the user has obtained.
- Providing a generic runtime HTTP proxy.
- Allowing the Webfront to choose a backend base URL, authentication header, or
  arbitrary request path.
- Replacing backend authorization. Gateway remains authoritative for scopes,
  account state, and app allowlists regardless of the WorkX product policy.

## Trust Boundary

```text
Webfront UI
    | typed ServiceRequest (no stored credential)
    v
WorkX runtime service
    | fixed gateway URL + one runtime-owned credential + bounded HTTP request
    v
OpenHub gateway (/v1, /mcp, /api/v1/apps)
    | verified GatewayPrincipal; internal service-authenticated identity
    v
OpenHub Hub control-plane services (no user bearer re-verification)
    | normalized response or classified error
    v
WorkX runtime service
    | structured data only
    v
Webfront UI
```

For Desktop, the runtime is the Node sidecar reached through the Tauri channel.
For any other WorkX UI surface that exposes Apps, the same rule applies: its
background/runtime context performs the network call, while the rendered
Webfront uses the shared service contract.

Opening an OAuth authorization URL in the user's external browser is navigation
through the platform shell, not a Webfront API request. The runtime still owns
the authenticated OAuth-start request that produces that URL.

### Supported runtime surfaces

The initial implementation covers every surface that can currently render the
shared Apps route:

| UI surface | Trusted network runtime | Allowed service channel |
|---|---|---|
| Desktop Webfront | Node desktop-runtime sidecar | `tauri`, channel ID `desktop-runtime-main` |
| Extension Webfront | Extension background service worker | `sidepanel`, channel ID `sidepanel-main` |

Both runtimes register the same `apps.*` service factory with injected platform
dependencies. Server/WebSocket callers are denied. A future UI surface must add
an explicit trusted-channel authorizer before it can enable Apps.

The extension service worker remains the only extension context that
instantiates `ChromeCredentialStore`. The rendered side panel switches from a
direct `ChromeCredentialStore` to the same restricted runtime-relay
`CredentialStore` interface used by Desktop. Its generic relay can reach only
the model-provider namespace described below; OpenHub and session credentials
remain reachable only through narrow background services. No Webfront module
imports the concrete Chrome store or `VaultManager` for credential access.

Private extension builds currently do not configure an Apps catalog. If that
changes, their background runtime must provide session credentials without
passing browser cookies or tokens to the rendered Webfront. Until then, the
runtime reports `unconfigured` and navigation remains hidden.

## Public/Private Ownership

### Public WorkX

Public WorkX owns:

- OpenHub domain types and response normalization.
- The bounded OpenHub HTTP client.
- Runtime credential selection and secure storage integration.
- `apps.*` service handlers and structured errors.
- Apps access state and state-change events.
- OpenHub API-key Settings controls.
- The service-based Webfront Apps client.
- Built-in OpenHub MCP credential wiring and reconnection.
- The product-policy interface and the OSS default implementation.

### Private WorkX

Private WorkX owns only:

- A source overlay replacing the Apps access policy with `session-jwt` and
  disabling API-key configuration.
- Tests for the private policy.
- Production auth, catalog, gateway, and account-management environment values.
- Product-specific copy or key-management/login links exposed by the policy.

Private WorkX must not overlay the Apps page, runtime services, HTTP client, or
credential manager.

## Product Policy Seam

Add a runtime-safe policy seam under `src/core/apps`, so the same policy is
compiled into the runtime and Webfront bundles:

```ts
export type AppsAuthMethod = 'api-key' | 'session-jwt';

interface AppsPolicyCopy {
  title: string;
  description: string;
  action: string;
}

export type AppsAccessPolicy =
  | {
      authMethod: 'api-key';
      setupCopy: AppsPolicyCopy;
      apiKeyManagementUrl: string;
    }
  | {
      authMethod: 'session-jwt';
      setupCopy: AppsPolicyCopy;
    };
```

The discriminant is the only authentication-policy switch. UI visibility,
login requirements, credential-service availability, runtime credential
selection, and built-in MCP authentication are derived from `authMethod`; the
policy cannot express contradictory booleans.

Keep the interface in a stable public file such as
`src/core/apps/accessPolicyTypes.ts`. Put the replaceable implementation in
`src/core/apps/appsAccessPolicy.ts`.

The OSS implementation is API-key-only:

```ts
export const appsAccessPolicy: AppsAccessPolicy = {
  authMethod: 'api-key',
  apiKeyManagementUrl: resolveAppsPublicConfig().apiKeyManagementUrl,
  setupCopy: {
    title: 'Connect Apps',
    description: 'Add an OpenHub API key to install and connect apps.',
    action: 'Add API key',
  },
};
```

`resolveAppsPublicConfig()` resolves the non-secret
`WORKX_OPENHUB_API_KEY_MANAGEMENT_URL` in a runtime build and
`VITE_OPENHUB_API_KEY_MANAGEMENT_URL` in a UI build. Release configuration sets
both from one canonical value. Production builds reject a missing, non-HTTPS,
or credential-bearing URL; loopback HTTP is allowed in development. The value
may point to an OpenHub key-application page or account key-management page,
but never to a model-provider key page. A build parity test ensures the runtime
and Webfront resolved policies are identical.

The private overlay replaces only the implementation:

```text
private-overlay/src/core/apps/appsAccessPolicy.ts
private-overlay/src/core/apps/__tests__/appsAccessPolicy.test.ts
```

Its policy is session-only:

```ts
export const appsAccessPolicy: AppsAccessPolicy = {
  authMethod: 'session-jwt',
  setupCopy: {
    title: 'Sign in to use Apps',
    description: 'Apps are available through your AI Republic account.',
    action: 'Sign in',
  },
};
```

The runtime enforces the policy. Hiding the API-key field in the private UI is
not sufficient: private builds must reject API-key validate, save, and remove
service calls with `APPS_AUTH_METHOD_DISABLED`.

The policy takes precedence over `WORKX_GATEWAY_MCP_AUTH_MODE`,
`VITE_GATEWAY_MCP_AUTH_MODE`, and any stored/environment API key. A private
`session-jwt` build ignores API-key material even when stale configuration is
present. Runtime startup logs a redacted configuration warning when policy and
environment disagree.

## Credential Model

### OSS OpenHub API key

Store the single OpenHub gateway key in the runtime credential store using a name
that cannot collide with model-provider credentials:

```text
service: openhub
account: api_key
```

The desktop `ControlFrameCredentialStore` already adds its `workx-` OS-service
prefix, producing the platform keychain service name `workx-openhub`. Using
`workx.openhub` here would incorrectly double the product prefix.

The Webfront may submit a newly entered key to a narrow save service, but it can
never read the stored key back. After a successful save, the input is cleared
and subsequent state responses expose only `hasCredential: true`.

Saving is transactional:

1. Validate the candidate key against a fixed OpenHub endpoint.
2. Leave an existing known-good key untouched if validation fails.
3. Persist the candidate only after successful validation.
4. Reconnect the built-in OpenHub MCP server.
5. Publish the new Apps access state.

“Transactional” applies to credential replacement: validation or persistence
failure leaves the previous stored key and MCP connection unchanged. After a
successful store write, an MCP reconnect failure does not roll back a valid
key; Apps remains ready, MCP reports its existing connection error, and its
normal reconnect path retries with the same provider. Removal first commits the
credential-store deletion under the provider mutation lock, then clears the
in-memory generation and synchronously detaches the MCP client before publishing
state; closing any remote transport is best-effort after detachment. A delete
failure leaves the prior credential and connection unchanged.

Removing the key disconnects OpenHub MCP and clears the stored value. With no
managed fallback, Apps transitions to `needs-api-key`; with a managed fallback,
the provider validates that fallback and transitions to its resulting state.

### Reserved credential namespaces

The existing generic `credentials.*` relay accepts arbitrary service/account
names. Before adding the OpenHub credential, it must enforce a runtime-owned
namespace policy:

- `auth` and `openhub` are reserved and rejected by generic
  `credentials.get`, `set`, `delete`, and `listAccounts`.
- Only narrow `auth.*` handlers may access the `auth` namespace.
- Only narrow `apps.credentials.*` handlers may access the `openhub`
  namespace.
- Existing model-provider credential accounts remain available to the generic
  relay only when `service === 'workx'` and the account matches
  `provider-apikey-<providerId>`, where `providerId` matches
  `/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/`. `listAccounts` filters to that prefix.
  This preserves built-in and custom-provider persistence used by `AgentConfig`
  without making the relay a general keychain reader.
- Tests must prove that a Webfront service request cannot read
  `auth/access_token`, `auth/refresh_token`, or `openhub/api_key`.

This hardening is part of this implementation, not follow-up work. Without it,
the runtime-only credential boundary would be bypassable through an existing
service.

### Private session JWT

Private WorkX reads the existing runtime-owned `auth/access_token` credential.
On `401`, the runtime may use the existing OIDC refresh-token path once and
retry the original request once. An unrecoverable refresh transitions Apps to
`needs-login` with the stable `session_expired` reason used by the wider runtime
access flow.

An API key left in the credential store by another build is ignored when the
policy selects `session-jwt`.

### Shared OpenHub credential source

LLM routing, the Apps HTTP client, and the built-in OpenHub MCP connection
consume the same effective OpenHub credential. Private WorkX reads the existing
`auth/access_token` for all three; OSS reads the stored/managed OpenHub API key.
Apps and MCP use this runtime abstraction directly:

```ts
export interface OpenHubCredentialProvider {
  getState(): Promise<AppsAccessState>;
  getCredential(): Promise<{
    method: AppsAuthMethod;
    token: string;
  } | null>;
  handleUnauthorized(failed: {
    method: AppsAuthMethod;
    token: string;
  }): Promise<{
    method: AppsAuthMethod;
    token: string;
  } | null>;
}
```

This prevents the catalog from reporting Apps as enabled while MCP or LLM
routing uses a different or missing credential. Model-provider BYOK keys stay
outside this provider because they authenticate directly to third parties, not
to OpenHub.

`handleUnauthorized` never refreshes an API key; it marks that exact effective
stored or managed key invalid if it is still current. Session refresh is
single-flight across Apps, MCP, and concurrent requests. Callers that receive
`401` while a refresh is in progress await the same promise, and the provider
persists a rotated token pair once.

The OpenHub contract uses `Authorization: Bearer <credential>` for both API
keys and session JWTs. That is an internal client detail and never appears in
the Webfront contract.

## Required OpenHub Gateway Contract

Gateway already owns the canonical `GatewayPrincipal` resolver for both
`air_...` OpenHub API keys and Home Page OIDC access tokens. The Apps HTTP
facade must use that exact resolver and the coarse `apps` scope, just as `/v1`
uses `chat`/`models` and `/mcp` uses `apps`. Hub must not validate the WorkX
bearer a second time.

The backend contract for WorkX is:

```http
GET /api/v1/apps/credentials/me
Authorization: Bearer <openhub-api-key-or-session-jwt>
Accept: application/json
```

Successful response:

```json
{
  "contractVersion": 1,
  "capabilities": ["single-gateway-credential-v1"],
  "subjectId": "opaque-subject-id",
  "credentialType": "api-key",
  "scopes": ["chat", "models", "apps"],
  "allowedAppIds": null
}
```

Contract requirements:

- `200` means the credential is valid and identifies its effective scopes.
- WorkX accepts only `contractVersion: 1` with the exact
  `single-gateway-credential-v1` capability marker. A missing/unknown version
  or marker is `APPS_BACKEND_INCOMPATIBLE`, even if the endpoint returns `200`.
- `401` means missing, expired, revoked, or invalid credential.
- `403` means the credential is valid but lacks the gateway `apps` scope or is
  outside an API key's app allowlist.
- The response never returns the credential or a reusable derivative.
- Both API-key and OIDC validation require the existing gateway `apps` scope.
- `allowedAppIds` is retained in runtime state for authorization diagnostics,
  but the backend remains authoritative on every operation.

All routes in the fixed Apps operation map terminate user authentication at
gateway:

- WorkX always sends `Authorization`; it never intentionally invokes an
  anonymous variant.
- Gateway validates the bearer once into `GatewayPrincipal`, enforces `apps`
  and `allowedAppIds`, and never forwards the user bearer to Hub.
- Gateway forwards only the canonical user identity over the existing
  `CONNECTOR_RUNTIME_INTERNAL_TOKEN` service-authenticated channel.
- Hub continues to own catalog/install/connection/OAuth business logic and its
  browser pages, but trusts only a valid gateway-forwarded internal identity
  for WorkX calls.
- The Hub catalog page URL and gateway Apps API URL are separate configuration
  values. The runtime API defaults from `WORKX_GATEWAY_BASE_URL`; it never
  derives the authenticated API host from the Hub browser-page URL when a
  gateway base is present.

The runtime normalizes a successful response to the following redacted shape.
`subjectId` is retained only inside the runtime provider when needed and is
never sent to the Webfront or telemetry:

```ts
export interface AppsCredentialValidationResult {
  valid: true;
  credentialType: AppsAuthMethod;
  grantedScopes: string[];
  allowedAppIds: string[] | null;
}
```

This gateway endpoint must exist in the target OpenHub deployment before OSS
key-save support can ship. If the final backend path or scope names differ,
update the runtime client constant and this document together; do not substitute
a public Hub marketplace request. A key may carry multiple gateway scopes, and
this endpoint confirms that the same credential includes `apps`.

The runtime validates a candidate key through this endpoint before persisting
it. Normal authenticated control-plane calls also classify `401` and `403`
independently; a valid but under-scoped key is never described as malformed.

## Apps Access State

The runtime is authoritative for credential/configuration readiness. Backend
availability is tracked separately so a transient outage cannot invalidate a
known-good credential or blank stale UI data:

```ts
export type AppsCredentialStatus =
  | 'unconfigured'
  | 'needs-api-key'
  | 'needs-login'
  | 'validating'
  | 'unverified'
  | 'ready'
  | 'invalid-credential'
  | 'forbidden';

export type AppsBackendStatus = 'unknown' | 'reachable' | 'unavailable';
export type AppsCapabilityStatus = 'unknown' | 'supported' | 'incompatible';
export type AppsCredentialSource =
  | 'none'
  | 'stored-api-key'
  | 'managed-api-key'
  | 'session';

export type AppsAccessReason =
  | 'catalog_unconfigured'
  | 'runtime_surface_unsupported'
  | 'api_key_missing'
  | 'login_required'
  | 'session_expired'
  | 'credential_rejected'
  | 'insufficient_scope'
  | 'validation_unavailable'
  | 'backend_incompatible';

export interface AppsAccessState {
  configured: boolean;
  credentialStatus: AppsCredentialStatus;
  backendStatus: AppsBackendStatus;
  capabilityStatus: AppsCapabilityStatus;
  authMethod: AppsAuthMethod;
  credentialSource: AppsCredentialSource;
  hasCredential: boolean;
  allowedAppIds?: string[] | null;
  reason?: AppsAccessReason;
  revision: number;
  updatedAt: number;
}
```

State transitions are:

```text
OSS:     unconfigured | needs-api-key -> validating -> ready
                                      -> invalid-credential
                                      -> forbidden
                                      -> unverified (validation could not complete)
Private: unconfigured | needs-login   -> validating -> ready
                                      -> needs-login (expired/revoked)
                                      -> forbidden
                                      -> unverified (validation could not complete)
Either backend health: unknown <-> reachable <-> unavailable
Backend capability:   unknown -> supported | incompatible
```

`configured` means that the runtime surface, trusted service channel, and
catalog base are configured; it does not imply that a credential is ready.
Both auth modes pass through `validating` before `ready`. A credential that has
not been validated in the current runtime remains `unverified`; prior cached
success or mere local presence never silently promotes it to `ready`. Every
catalog and mutation service, including the otherwise-public marketplace list,
requires `credentialStatus === 'ready'` and
`capabilityStatus === 'supported'`. OSS without a key and private without a
login do not make anonymous fallback requests.

Network, timeout, `429`, and `5xx` failures affect `backendStatus` or the
individual service response only. They do not change `credentialStatus` from
`ready` and do not erase cached marketplace data. A successful authenticated
request returns `backendStatus` to `reachable`.

On first validation, `404` or `405` from the fixed introspection path, or a
successful response without the required version/capability marker, sets
`capabilityStatus: 'incompatible'`, `backendStatus: 'reachable'`, and returns
`APPS_BACKEND_INCOMPATIBLE`; it never stores a candidate key. A startup
credential that cannot be validated because the backend is unreachable or
incompatible remains `unverified`. Once this process has established `ready`,
a transient outage preserves `ready`; `401` or `403` still changes credential
state immediately. Capability is retried on explicit Validate/Save, login or
runtime reconnect, rather than cached permanently.

Expose `apps.getState` and emit an `apps.stateChanged` event after login,
logout, credential save/remove, unrecoverable refresh, and availability
changes. The Apps page renders its setup/login/ready state from this contract,
not from compile-time URL constants or direct credential probes.

The state controller increments `revision` for every committed transition and
serializes save, remove, login/logout, refresh completion, and MCP lifecycle
side effects through one mutation queue. The Webfront ignores an event whose
revision is older than its current snapshot; after runtime reconnect it replaces
local state with a fresh `apps.getState` result. A `401` handler invalidates or
refreshes only the exact credential generation that made the failed request,
so an old in-flight request cannot invalidate a newly saved key or session.

`apps.stateChanged` is added as an explicit `StateUpdateEvent` variant and is
handled by a shared Apps state store. It is not emitted as an untyped generic
payload. Desktop and extension runtimes use their existing channel broadcast
mechanisms to publish the same event shape.

## Runtime HTTP Client

Add a platform-neutral `OpenHubAppsClient` under `src/core/apps`.

It receives only runtime dependencies:

```ts
export interface OpenHubAppsClientOptions {
  catalogApiBaseUrl: string;
  credentials: OpenHubCredentialProvider;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}
```

The client owns:

- URL construction beneath the configured catalog API base.
- Credential resolution and authentication headers.
- JSON serialization and response normalization.
- Bounded structured backend error-code parsing.
- Timeouts and bounded response reads.
- A single session refresh and retry after `401`.
- Error classification into stable service error codes.

Security constraints:

- The catalog base comes from `RuntimeStateController.getUrls()`; it is never a
  request parameter.
- Internal runtime configuration and Webfront-safe runtime state use different
  types. `gatewayMcpApiKey` and every present/future secret field are excluded
  from `runtime.getStateSnapshot`, diagnostics payloads, and state-change
  events. Redaction is allowlist-based, not a blacklist spread over
  `RuntimeUrlConfig`.
- Production URLs must use HTTPS. Loopback HTTP is allowed for local
  development.
- App IDs are validated and path-encoded.
- Query, cursor, limit, and credential-field inputs are validated.
- `Content-Type` is sent only on requests with a body.
- Unexpected redirects are rejected for authenticated API calls.
- Each HTTP attempt has a 15-second timeout; service calls use the existing
  30-second RPC timeout.
- JSON response bodies are limited to 2 MiB before parsing.
- Query is limited to 256 Unicode code points, cursor to 2 KiB, marketplace
  limit to `1..100`, app ID to 256 ASCII identifier characters, account hint to
  256 Unicode code points, and each submitted credential field to 16 KiB with
  at most 32 fields and 64 KiB total decoded input.
- A candidate OpenHub key is trimmed once at the UI boundary, must be non-empty,
  and is limited to 16 KiB before it enters the service channel. Runtime
  validation repeats the size/non-empty checks and stores the exact trimmed
  candidate that it validated.
- Logs include service name, status, and request ID, never authorization
  headers, submitted credential fields, or response bodies that may contain
  secrets.

The current Webfront does not consume runtime URL fields. Therefore this change
removes `urls` from `DesktopRuntimeStateSnapshot` and removes the unused
`runtime.getUrlConfig` service rather than attempting to redact a secret-bearing
object. Internal `RuntimeStateController.getUrls()` remains runtime-only. If a
future UI needs a URL, it must add a purpose-specific, allowlisted field or
service; `RuntimeUrlConfig` itself is never serializable across the UI channel.

Apps configuration visibility comes only from `apps.getState`; the Webfront
does not receive the catalog API base or MCP URL.

### Fixed upstream operation map

`catalogApiBaseUrl` is the gateway URL ending at `/api/v1/apps`. The client
implements only these relative operations; it does not expose a generic request
helper through the service layer:

| Runtime operation | Method and relative path |
|---|---|
| Validate WorkX credential | `GET /credentials/me` |
| List marketplace | `GET /marketplace` |
| Install | `POST /{appId}/install` |
| Uninstall | `DELETE /{appId}/uninstall` |
| Activate | `POST /{appId}/activate` |
| Deactivate | `POST /{appId}/deactivate` |
| Read app auth status | `GET /{appId}/auth/status` |
| Start app OAuth | `POST /{appId}/auth/oauth/start` |
| Submit app-managed manual credential | `POST /{appId}/auth/api-key` |

The last route name is the current OpenHub contract for both API-key and basic
manual app credentials; it is unrelated to the WorkX/OpenHub API key stored by
`apps.credentials.*`. All response objects pass through strict normalizers.
Unknown enum values degrade to safe display states and never select a runtime
operation.

## Service Contract

Add `src/core/services/apps-services.ts` and register it through
`registerAllServices` in both current UI runtimes. `AppsServiceDeps` includes an
injected `authorizeContext(context)` function. Desktop permits only the Tauri
main channel; extension permits only the side-panel main channel. A default
deny authorizer prevents accidental registration from exposing Apps to server,
WebSocket, app-server, or future channels.

| Service | Input | Output |
|---|---|---|
| `apps.getState` | none | `AppsAccessState` |
| `apps.marketplace.list` | `query?`, `cursor?`, `limit?` | `MarketplacePage` |
| `apps.install` | `appId` | normalized app card or `null` |
| `apps.uninstall` | `appId` | normalized app card or `null` |
| `apps.activate` | `appId` | normalized app card or `null` |
| `apps.deactivate` | `appId` | normalized app card or `null` |
| `apps.auth.getStatus` | `appId` | normalized auth status |
| `apps.auth.startOAuth` | `appId` | authorization URL and expiry metadata |
| `apps.auth.submitCredentials` | `appId`, declared fields, `accountHint?` | normalized auth status |
| `apps.credentials.validate` | candidate OpenHub key | `AppsCredentialValidationResult` |
| `apps.credentials.save` | candidate OpenHub key | `AppsAccessState` after revalidation and persistence |
| `apps.credentials.remove` | none | `AppsAccessState` |
| `apps.icon.get` | `appId` | `{ mimeType, base64 }` or `null` |

The service never accepts an access token, API base URL, raw path, method,
headers, or generic body from the Webfront.

Register `apps.credentials.validate`, `apps.credentials.save`, and
`apps.auth.submitCredentials` as sensitive service paths in the shared channel
redactor. Their parameters may exist only in the in-memory/transport request
needed to reach the trusted runtime. Debug logging, diagnostics, telemetry,
rollout recording, error serialization, and developer inspection helpers emit
only the service name and request ID, never parameter values. This is enforced
centrally rather than relying only on individual handlers. The existing
credential-service redaction tests are extended to cover all three paths.

`apps.auth.startOAuth` does not accept a caller-provided return URL. The runtime
sends either `null` or an exact platform callback URL supplied through trusted
`AppsServiceDeps`; Desktop and extension dependencies cannot derive it from
Webfront location data. The returned authorization URL is limited to 8 KiB,
must use HTTPS, and must not contain URL credentials. It is opened through the
platform's external-browser action; it is never fetched or embedded by the
Webfront. OAuth state is kept by OpenHub/runtime and is not returned as a
separate service field. The external-browser action logs at most the HTTPS
origin, never the full authorization URL or its query string.

Credential submission for a connected third-party app is distinct from the
OpenHub API key. `apps.auth.submitCredentials` forwards only fields declared by
that app's current auth-status response. If no status is cached, the runtime
fetches it before validation. Unknown fields are rejected; missing required
fields are rejected; the runtime never trusts a field declaration supplied by
the Webfront. The runtime must not log or persist those field values locally.

`apps.credentials.validate` never stores the candidate and never changes the
effective `credentialSource` or credential status; it may update only backend
health/capability observations. In particular, failure of a candidate must not
invalidate an existing effective key. `apps.credentials.save` always performs
its own validation immediately before writing; it does not accept or trust a
previous validation result. Private session-only policy rejects validate, save,
and remove.

## Structured Errors

Add `AppsServiceError` with `errorCode`, `retryable`, and an optional HTTP
status retained in the runtime. The UI receives safe copy through the existing
`ServiceResponse` error path.

Initial stable codes:

| Code | Retryable | Meaning |
|---|---:|---|
| `APPS_NOT_CONFIGURED` | no | No catalog API base is configured |
| `APPS_BACKEND_INCOMPATIBLE` | no | The target OpenHub deployment lacks the required credential contract |
| `APPS_AUTH_METHOD_DISABLED` | no | The build policy forbids the requested credential operation |
| `APPS_API_KEY_REQUIRED` | no | OSS build has no stored OpenHub key |
| `APPS_LOGIN_REQUIRED` | no | Private build has no usable session |
| `APPS_INVALID_CREDENTIAL` | no | OpenHub rejected the credential after allowed refresh |
| `APPS_FORBIDDEN` | no | Credential is valid but lacks required Apps/MCP scope or app access |
| `APPS_INVALID_ARGUMENT` | no | Input validation failed |
| `APPS_NOT_FOUND` | no | The app does not exist |
| `APPS_CONFLICT` | no | The requested state transition conflicts with current state |
| `APPS_RATE_LIMITED` | yes | OpenHub returned `429` |
| `APPS_UNAVAILABLE` | yes | Network, timeout, or OpenHub `5xx` failure |
| `APPS_INVALID_RESPONSE` | yes | OpenHub returned malformed or oversized data |

Do not expose arbitrary backend response bodies or free-form backend messages.
The client may parse a bounded structured backend error code, but maps only an
explicit allowlist to local user copy; unknown codes use the local status-based
message. This rule also applies to FastAPI `{detail}` and OpenHub
`{error:{message}}`, either of which could echo a submitted credential. Raw
response bodies are neither returned nor logged.

## Webfront Changes

Replace `src/webfront/lib/apis/apps` network logic with a typed service client.
`Apps.svelte` continues to own presentation orchestration such as debounced
search, optimistic card replacement, OAuth browser opening, and connection
polling, but every data operation calls an `apps.*` service.

The Webfront must remove:

- Direct `fetch` calls for Apps.
- `credentials: 'include'` use for Apps.
- The desktop access-token cache.
- Calls to `auth.getAccessToken`.
- Knowledge of OpenHub authentication headers.
- Direct use of the catalog API base URL.

The static `GATEWAY_CATALOG_API_BASE_URL` check is also removed from navigation
construction. The shared Apps state store calls `apps.getState` after the
runtime channel initializes and exposes a derived `showAppsNavigation` value:

- `configured: false` hides Apps navigation.
- `configured: true` shows Apps navigation even when the user still needs an
  API key or login, so the page can present the appropriate setup action.
- Runtime reconnect triggers a state re-read.
- Direct navigation to `/apps` still renders the same runtime-derived setup or
  unconfigured state; it never falls back to direct HTTP.

An `AbortSignal` cannot be serialized over the service channel. Debounced
search uses a monotonically increasing generation ID and ignores responses
older than the latest requested generation. Runtime HTTP calls have their own
timeout. Cancellation of the remote call is not required for the first
implementation.

## Remote Icons

Returning a remote `iconUrl` and rendering it in `<img src>` would violate the
no-Webfront-HTTP boundary. Marketplace cards therefore expose only whether an
icon exists and a stable app ID/reference.

`apps.icon.get` lazily downloads the icon in the runtime and returns a bounded
asset result suitable for a local URL or data URL. The runtime:

- Resolves the remote icon URL only from its cached normalized marketplace
  record; the Webfront cannot submit a URL.
- Allows a small image MIME allowlist.
- Rejects active formats unless sanitized.
- Enforces a 256 KiB decoded payload limit. Base64/RPC output is limited to
  350 KiB and is never included in global state snapshots or logs.
- Caches successful assets with a bounded LRU and expiry.
- Falls back to the existing initial-letter placeholder on any failure.

The first implementation supports PNG, JPEG, and WebP only, verifies MIME type
and magic bytes, allows at most 128 cached icons or 16 MiB total decoded cache
size, and expires entries after one hour. It caches failures for one minute to
avoid request storms. SVG and animated formats are excluded until a sanitizer
and explicit tests exist.

## OpenHub MCP Integration

The built-in OpenHub MCP connection and gateway LLM routing must use the same
effective credential source as the Apps services.

- OSS startup with no key leaves the built-in OpenHub MCP disconnected.
- Saving a valid key connects/reconnects it immediately.
- Removing or invalidating the key disconnects it.
- Private login connects it using the session JWT.
- Private logout or unrecoverable session refresh disconnects it.
- A transient OpenHub outage does not erase either credential.

Refactor the current session-token-specific MCP callbacks into a credential
provider that can supply either `api-key` or `session-jwt` per request. Built-in
gateway server seeding derives `authMode` from `AppsAccessPolicy`, not directly
from `RuntimeUrlConfig.gatewayMcpAuthMode`, and does not copy a user credential
into `IMCPServerConfig.apiKey`.

Managed/headless environment API-key support may remain for OSS API-key builds
with this precedence:

1. Product policy decides the only allowed auth method.
2. For OSS `api-key`, a key stored through `apps.credentials.save` wins.
3. An environment key is a non-readable managed fallback.
4. For private `session-jwt`, all stored/environment API keys are ignored.

Environment keys remain internal runtime values and are never included in
config snapshots. Saving/removing an end-user key does not mutate environment
configuration. MCP and Apps requests call the same provider, share the same
single-flight session refresh, and observe credential changes without putting
the secret in persisted MCP configuration.

## Settings UX

The shared Apps settings component renders from `AppsAccessPolicy` and
`AppsAccessState`.

OSS behavior:

- Show a masked OpenHub API-key field.
- Provide a configured key-management link.
- Support Validate, Save, Replace, and Remove. Save revalidates even if Validate
  just succeeded.
- When `credentialSource` is `managed-api-key`, label the credential as
  administrator-managed and do not offer Remove. Saving a user key is allowed
  and changes the effective source to `stored-api-key`; removing that stored
  override revalidates and falls back to the managed key when present.
- Never display or repopulate the stored key.
- Explain that model-provider API keys do not enable Apps.

Private behavior:

- Do not render the OpenHub API-key field or credential actions.
- Show login state and a Sign in action when needed.
- Use existing AI Republic login/logout flows.

The Apps page uses the same state: `needs-api-key` routes OSS users to the Apps
settings section, while `needs-login` invokes the existing login flow.

The credential input exists only for the duration of the user's edit and the
single service request. Components clear it in `finally`, never place it in a
Svelte/global store, never persist it in browser storage, and disable form
instrumentation that could log field values.

## Migration Plan

0. Land and deploy the gateway Apps HTTP facade using the existing
   `GatewayPrincipal` resolver and its internal service-authenticated Hub hop.
   Add contract fixtures to WorkX; do not enable OSS key persistence before a
   target gateway exposes `single-gateway-credential-v1`.
1. Harden generic `credentials.*` with reserved namespaces and an explicit
   model-provider credential validator. Move the extension side panel to the
   restricted runtime relay, leaving `ChromeCredentialStore` in the background
   worker. Add auth/OpenHub non-disclosure tests.
2. Split internal runtime URL configuration from the allowlisted Webfront-safe
   snapshot and remove `gatewayMcpApiKey` from every service/event payload.
3. Add shared Apps types, discriminated access policy, state controller,
   structured errors, and protocol event types.
4. Add the single-flight `OpenHubCredentialProvider` with OSS API-key,
   managed-environment fallback, and session-JWT behavior.
5. Add the bounded `OpenHubAppsClient` and migrate existing normalization tests
   out of the Webfront network module.
6. Add `apps.*` services with injected channel authorization and register them
   in the desktop sidecar and extension background runtime.
7. Wire the credential provider into built-in OpenHub MCP lifecycle handling
   and remove secret-bearing built-in MCP configuration.
8. Add shared Settings UI for the single OpenHub key.
9. Convert Apps navigation and page data operations to the state/service client
   with a stale-response guard.
10. Add runtime-owned icon loading and remove remote icon URLs from UI data.
11. Remove `auth.getAccessToken` after confirming it has no remaining callers.
12. Add the private session-only policy overlay and its tests.
13. Build and smoke-test OSS API-key and private login flows on every enabled
    runtime surface.

The cutover should be atomic for a build: do not ship a state where the
Webfront has lost direct networking before the corresponding runtime services
are registered.

Steps 1 and 2 are security prerequisites for the new secret. They may land as
separate public WorkX changes, but Apps API-key UI must remain disabled until
both are present.

### Proposed file map

Keep domain/runtime code out of `src/webfront`:

```text
src/core/apps/accessPolicyTypes.ts
src/core/apps/appsAccessPolicy.ts                 # public implementation; private overlay seam
src/core/apps/appsPublicConfig.ts
src/core/apps/types.ts
src/core/apps/AppsAccessController.ts
src/core/apps/OpenHubCredentialProvider.ts
src/core/apps/OpenHubAppsClient.ts
src/core/apps/AppIconCache.ts
src/core/services/apps-services.ts
src/webfront/lib/apis/apps/index.ts               # typed service client only
src/webfront/stores/appsStore.ts
src/webfront/settings/AppsSettings.svelte
```

Tests live beside these modules or in their existing `__tests__` directories.
Platform bootstraps construct the controller/provider/client and inject them
into the shared service factory; neither the client nor provider imports a
Desktop, extension, Svelte, or private-product module.

## Test Plan

### Public unit tests

- OSS policy is the `api-key` discriminant and private/session-only behavior
  cannot be combined with API-key configuration.
- Generic credential services reject `auth` and `openhub` namespaces while
  preserving allowed model-provider persistence.
- Extension Webfront code cannot import the concrete Chrome credential store or
  Vault credential functions and reaches model-provider keys only through the
  restricted background relay.
- Runtime state/URL/event serialization contains no key, token, or secret URL
  fields, including managed environment keys.
- Credential validation uses only the authenticated introspection endpoint and
  verifies required Apps/MCP scopes.
- A fixed Apps route never treats an invalid/revoked bearer as an anonymous
  success; backend contract tests cover the public-without-header and
  strict-with-header cases separately.
- Introspection `404`/`405` or a missing contract/capability marker marks the
  backend incompatible and never persists a candidate; transient failures leave
  a startup credential unverified.
- Candidate-key validation is transactional.
- Candidate-key length/trimming rules are identical in UI and runtime.
- Stored keys are never returned by state or credential services.
- Sensitive Apps service parameters and full OAuth URLs are redacted from every
  log, diagnostic, telemetry, rollout, and error path.
- Marketplace and mutation responses normalize sparse and malformed fields.
- App IDs and all service inputs are validated.
- `401`, insufficient-scope `403`, app `404`, `409`, `422`, `429`, and `5xx`
  map correctly without conflating invalid and forbidden credentials.
- Concurrent session `401`s share one refresh and each retry exactly once.
- Save/remove/logout races are serialized, stale `401`s cannot invalidate a new
  credential generation, and state revisions never move backward.
- API-key `401` becomes `invalid-credential` without refresh.
- Network, timeout, redirect, oversized, and malformed responses are bounded
  and do not invalidate a known-good credential.
- Private/disabled credential methods are rejected by runtime policy.
- Desktop accepts only `desktop-runtime-main`/`tauri`; extension accepts only
  `sidepanel-main`/`sidepanel`; all other service contexts are denied.
- Icon MIME, size, lookup, and cache constraints hold.
- OAuth start accepts no Webfront return URL and rejects non-HTTPS, credentialed,
  or oversized authorization URLs.
- Credential-bearing backend error bodies cannot be reflected to the UI or
  logs.
- LLM, MCP, and Apps resolve the same OpenHub credential; MCP
  connects/disconnects with that credential state.
- Product policy overrides conflicting MCP auth-mode and environment-key
  configuration.
- Managed OSS keys are non-readable, can be overridden by a stored user key,
  and become effective again after removal of that override.

### Webfront tests

- Apps operations issue the expected service names and typed parameters.
- Apps Webfront source contains no direct `fetch` or `auth.getAccessToken` use.
- No credential appears in component state after a save completes.
- Older search results cannot replace newer results.
- OSS `needs-api-key` and private `needs-login` render different actions.
- Navigation is driven by `apps.getState`, not Webfront URL constants, and
  remains visible while configured-but-unauthenticated.
- OAuth polling uses `apps.auth.getStatus` and stops on cancellation/timeout.
- Missing icons render the local placeholder without a remote request.

### Private overlay tests

- The private policy selects `session-jwt`.
- API-key behavior and UI are therefore absent and runtime API-key operations
  are rejected.
- Private copy remains registered with the shared localization system.

### Integration and smoke tests

- OSS: no key -> save valid OpenHub key -> catalog loads -> install/connect ->
  MCP tools appear -> remove key -> catalog and MCP become unavailable.
- OSS: invalid key does not replace an existing valid key.
- OSS: valid but under-scoped key reports forbidden and is not marked ready.
- Private: signed out -> login -> catalog loads -> install/connect -> MCP tools
  appear -> logout -> catalog and MCP become unavailable.
- Private: expired access token refreshes without exposing a token to the UI.
- Production Hub CORS configuration is irrelevant to Desktop behavior because
  the request originates in the runtime.
- Production Hub CORS configuration is likewise irrelevant to the extension
  side panel because requests originate in its background worker.
- Extension Apps requests originate in the background service worker and never
  in the rendered side panel.

## Acceptance Criteria

- No Apps Webfront module initiates an HTTP request.
- No Apps service returns an OpenHub key or session JWT.
- Generic credential and runtime-state services cannot reveal reserved
  OpenHub/auth secrets.
- OSS Apps requires a validated, securely stored OpenHub API key.
- Private Apps requires a valid AI Republic login and provides no API-key path.
- Catalog and built-in OpenHub MCP always use the same effective credential.
- The OpenHub validation endpoint proves required Apps/MCP scopes and
  distinguishes invalid (`401`) from forbidden (`403`).
- Every WorkX Apps request carries the effective credential, and OpenHub never
  downgrades a supplied invalid bearer to anonymous access.
- A backend without the validation capability fails closed with
  `APPS_BACKEND_INCOMPATIBLE` and cannot receive a persisted candidate key.
- Desktop and extension either register trusted runtime Apps services or report
  `unconfigured`; neither falls back to Webfront networking.
- Transient backend failures preserve credential readiness and stale UI data.
- Private behavior is implemented by a narrow policy overlay rather than
  duplicated runtime or UI files.
- Both auth modes pass their unit and integration tests; every enabled Desktop
  or extension distribution passes its build and production smoke tests.
