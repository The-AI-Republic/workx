# Design: WorkX Server Decoupling (Node-first runtime, optional Docker)

**Location**: `.ai_design/workx_server_decoupling/design.md`
**Created**: 2026-05-19
**Status**: Draft (design — no implementation)
**Input**: User description: *"Time to refactor and improve our server mode. It seems we wrap the WorkX server mode into Docker by default. WorkX desktop is UI + AI agent runtime core logic bound together; WorkX server is a headless AI agent where UI and agent logic are 'chopped' apart — the UI lives in one place the user remotely visits, while the AI agent runtime stays in another. Keep it close to desktop. Discuss the design first."*

---

## 1. Problem & Framing

### 1.1 The stated premise, corrected

"We wrap WorkX server into Docker by default" is **half true**:

- The npm scripts are already plain Node — `dev:server` (`node ... src/server/index.ts`), `build:server` (`vite build`), `start:server` (`node dist/server/index.mjs`). They are **not** Docker.
- But every other surface positions Docker as the blessed path: `README.md:13` calls WorkX Server *"Headless (Docker/K8s)"*; `README.md:166` makes a `#### Docker` section the headline (`docker compose up -d`); `Dockerfile` + `docker-compose.yml` are the production artifacts.
- A prior commit (`826622d0`) did make the scripts Docker-first; it was reverted, but the docs were never reverted with it. **The "Docker by default" feeling is a docs/positioning artifact, not the run scripts.**

Docker is therefore not the problem to solve. It is one packaging recipe of the runtime. The real goal is the user's architectural model.

### 1.2 The architectural model (validated by the code)

> WorkX **Desktop** = UI + AI agent runtime bound together.
> WorkX **Server** = the *same* runtime, headless, with the UI detached and reachable remotely.

This is not two architectures. It is one runtime with a different transport on one seam. The codebase is already built symmetrically toward this and the wiring was never finished:

| Mode | UI side (`UIChannelTransport`) | Runtime side (`ChannelAdapter`) | Co-location |
|---|---|---|---|
| Desktop (default) | `TauriTransport` | `TauriChannel` | same process — *bound* |
| Desktop sidecar | `RuntimeRelayTauriTransport` | `StdioRuntimeChannel` | same machine, 2 procs (stdio) |
| Extension | `ChromeExtensionTransport` | `SidePanelChannel` | same browser (chrome.runtime) |
| **Server** | **`WebSocketTransport({url})` — stub** | **`ServerChannel` (WS)** | **different machines (network)** |

The runtime core (`RepublicAgent` + `AgentRegistry`) is already byte-identical across desktop and server (same agent factories in `DesktopAgentBootstrap` / `ServerAgentBootstrap`). The seam is `ChannelAdapter` (runtime side) ↔ `UIChannelClient`/`UIChannelTransport` (UI side). Only the bottom row was never connected.

---

## 2. Locked Decisions

These were decided during design discussion and are fixed for this spec:

| # | Decision | Rationale |
|---|---|---|
| D1 | **Node-first; Docker optional.** Plain Node/npx is the first-class path. Docker is one optional recipe for "heavy/remote box" deployments. | Closes the docs↔scripts contradiction; keeps server close to desktop. |
| D2 | **UI is one artifact, configurable target.** The same Svelte UI can be (a) co-served by the runtime box, (b) deployed standalone pointed at a runtime URL, (c) the desktop app pointed at a remote runtime. | "All of them" — but realized as one build with a configurable runtime URL, not separate UIs. |
| D3 | **Two delegation surfaces.** First-party UI↔runtime over WS *and* cross-agent delegation via A2A. | Each serves a genuinely different need (full-fidelity first-party remoting vs. interoperable coarse delegation). |
| D4 | **Single-tenant appliance.** One user/team per server instance. Multi-user SaaS is an explicit non-goal for this spec. | Today's architecture is single-tenant; keeps scope small. Multi-user is a separate future workstream. |

> **Correction to D3 surfaced during code investigation:** there is **not** a "raw envelope vs method-RPC" duality. There is exactly **one** WS protocol (`@workx/ws-server` method-RPC + event frames). `WebSocketTransport` already targets it (and is a stub — see §4.1). "Two surfaces" now means: the one WS protocol (first-party UI + 3rd-party programmatic) **plus** A2A (cross-agent). Less protocol surface than originally feared — good.

---

## 3. User Scenarios & Testing *(mandatory)*

### User Story 1 — Run the server with no Docker (Priority: P1)

An operator clones the repo (or installs the package) and starts the headless agent with a single Node command, no Docker knowledge required. Docs match what the scripts actually do.

**Why this priority**: This is the Node-first reset. Today the docs send users to Docker while the scripts are Node — the contradiction is the onboarding tax.

**Independent Test**: On a clean machine with Node 22+, follow the README server section start-to-finish without Docker and reach a running server answering `/health`.

**Acceptance Scenarios**:
1. **Given** Node 22+ and no Docker, **When** the operator runs the documented start command, **Then** the server listens, `/health` returns OK, and a WS client can connect.
2. **Given** the README server section, **When** read top-to-bottom, **Then** no step requires Docker and Docker appears only as a clearly-labeled optional deployment recipe.
3. **Given** `docker compose up -d`, **When** used, **Then** it still works (Docker remains a supported optional path, not removed).

### User Story 2 — Visit the server in a browser and get a working UI (Priority: P1)

An operator runs a single server instance and opens its URL in a browser. They get the full WorkX UI, which connects back to that same instance's runtime over WebSocket. It behaves like the desktop app, headless-hosted.

**Why this priority**: This is the "standalone appliance" mode and the core realization of the user's model — UI detached from runtime, reachable remotely.

**Independent Test**: Start one instance, open its URL in a browser, send a chat turn, use a non-chat feature (e.g., MCP server list), confirm events stream back.

**Acceptance Scenarios**:
1. **Given** a running single-tenant instance, **When** the operator opens its URL, **Then** the Svelte UI loads and establishes an authenticated WS session to the same host.
2. **Given** the loaded UI, **When** the operator sends a chat message, **Then** streamed agent/chat events render with the same fidelity as desktop.
3. **Given** the loaded UI, **When** the operator triggers a non-chat service request (e.g., list MCP servers, list sessions), **Then** it succeeds (not just `chat.send`).
4. **Given** the same UI build, **When** deployed standalone and pointed at a remote runtime URL via config, **Then** it works against that remote runtime.

### User Story 3 — Desktop delegates a heavy job to a remote runtime (Priority: P2)

A user on the bound desktop app delegates a resource-heavy task to a remote headless WorkX instance. The remote runs the work; results stream back into the desktop conversation. The desktop keeps its local runtime for everything else.

**Why this priority**: This is the original motivation ("agents need lots of resources; offload to a beefy box") and the second consumption mode. Lower priority because the desktop A2A client already exists — the missing half is the server endpoint.

**Independent Test**: Configure the desktop's existing A2A client with a headless instance's URL, ask the desktop agent something that triggers delegation, confirm the remote processes it and results appear in the desktop conversation.

**Acceptance Scenarios**:
1. **Given** a headless instance exposing an A2A endpoint, **When** its URL is added in desktop A2A settings, **Then** its agent card is fetched and its skills appear as tools (existing DONE-021 client behavior).
2. **Given** that connection, **When** the desktop agent delegates a task, **Then** a task is created on the remote, processed by its `RepublicAgent`, and results stream into the desktop conversation.
3. **Given** the desktop, **When** no delegation is requested, **Then** the local bound runtime handles work unchanged (delegation is additive, not a relocation).

### User Story 4 — One runtime bootstrap, not three (Priority: P3)

A maintainer adds a runtime capability once and it is available across desktop, sidecar, and server, without re-implementing the init dance per platform.

**Why this priority**: Maintainability. `DesktopAgentBootstrap` / `ServerAgentBootstrap` / `PiRuntimeBootstrap` triplicate the same sequence; divergence is a recurring bug source. Pure refactor — no user-visible behavior change.

**Independent Test**: A representative runtime change (e.g., a new shared tool registration) is made once in the unified bootstrap and verified present in all three carriers.

**Acceptance Scenarios**:
1. **Given** the unified `RuntimeBootstrap`, **When** desktop / sidecar / server start, **Then** each produces an equivalent agent runtime with only carrier + optional headless layers differing.
2. **Given** the refactor, **When** the existing test suites run, **Then** behavior is unchanged across all platforms.

---

## 4. Code Investigation Findings (resolved open questions)

All four pre-design unknowns were resolved by reading the code. Two invalidated earlier assumptions.

### 4.1 One WS protocol; `WebSocketTransport` is a non-functional stub

There is exactly one WS protocol: `@workx/ws-server` method-RPC + event frames (`packages/ws-server/src/frames.ts`, `methods.ts`). `WebSocketTransport.sendOp()` already emits `{type:'req', method:'chat.send', params:{op,...}}` — it *is* a method-RPC client. Against the real server it **cannot work today**:

1. **No `connect` handshake/auth.** It opens the socket and sends methods directly. The server requires the challenge/response (`src/server/connection/handshake.ts`); `authorizeMethod` (`src/server/auth/authorize.ts`) returns `unauthorized('Not authenticated')` for every method without it.
2. **No frame `id`.** `RequestFrameSchema` (`packages/ws-server/src/frames.ts:23`) is RPC-with-ids; `sendOp` sends none → fails frame validation, no response correlation.
3. **Only ever `chat.send`** regardless of Op. `UIChannelClient.serviceRequest()` (MCP/session/config) has no path → all non-chat UI features dead.
4. **Event decode shape mismatch.** `makeEvent` → `{type:'event', event, payload, seq}` (`frames.ts:256-262`) and `ServerChannel.sendEvent` sets `payload = {...eventMsg, sessionId}` (`src/server/channels/ServerChannel.ts:87-114`). `WebSocketTransport` reads `data.payload?.msg`, which never exists → UI receives **zero** events.

**Impact**: P1's real cost is *completing this stub into a working `@workx/ws-server` client* (handshake+auth, framed ids, full method + `serviceRequest` coverage, correct event decoding) — not "wire the missing branch."

### 4.2 Auth: three independent surfaces; the UI surface is unbuilt

- Connection handshake (`src/server/connection/auth.ts`): modes `none` (loopback only) / `token` / `password` / `trusted-proxy`; only `trusted-proxy` yields a `userId`.
- Method/event scopes (`src/server/auth/authorize.ts`, `src/server/auth/roles.ts`): roles `operator|channel|node`, per-connection scope gating on every method and outbound event.
- A2A server auth: **N/A — not built.** `src/core/a2a/A2AServer.ts` is a throwing stub (P3-deferred). A2A *client*/*manager* are implemented.

They share connection-scoped `ConnectionAuth` but are otherwise independent. `WebSocketTransport` performs none. For single-tenant Mode A the simplest fit is loopback `none` (local) or `token` (remote).

### 4.3 Multi-tenancy: single-tenant only (confirms D4)

Two end-users cannot safely share one instance today:
- `AgentRegistry` keyed by `sessionId` only — no user/tenant principal (`src/core/registry/AgentRegistry.ts:50`).
- One shared primary agent at bootstrap; all connections route to it (`src/server/agent/ServerAgentBootstrap.ts:403`; `src/server/index.ts:295` `sessionKey: ws:main:${connectionId}`).
- One global credential vault `credentials.enc` (`src/server/storage/FileCredentialStore.ts`).
- `SessionIndex.accountId` exists but is always `''` (`src/server/persistence/SessionIndex.ts`).
- `ServerChannel.sendEvent` filters by scope, not user.

This **confirms D4** (single-tenant appliance). Multi-user would need a principal in the keyspace, per-user vaults, per-user partitioning, ownership checks — explicitly out of scope here.

### 4.4 Build mode is compile-time only; no `web` target

`__BUILD_MODE__` is a Vite `define`, typed `'extension'|'desktop'|'server'|'mobile'` (`src/types/globals.d.ts:14`) — **no `'web'`**. The server build is SSR with no UI/html input. No runtime transport/URL selection exists anywhere (`getUIClient` at `src/core/messaging/index.ts:41-66` `throw`s for non desktop/extension; no `location.origin`/env URL in `messaging/` or `platformStore`).

**Impact**: Mode A needs a **new `'web'` build mode** + vite config + `getUIClient` branch + globals type extension, with the runtime URL from `location.origin` (co-served) or injected config (standalone). Net-new and additive, not a toggle.

### 4.5 A2A server is greenfield (revises earlier assumption)

`specs/DONE-021-a2a-agent-protocol/` built the A2A **client** + manager and specced the server only for extension (card-only) and desktop (Tauri micro-server). `A2AServer.ts` is a throwing stub. So Story 3's server endpoint is **new implementation**, not "extend a spec" — but the desktop client side is ready, so the desktop change stays near-zero.

---

## 5. Target Architecture

**One runtime half, N carriers; the network carrier is a first-class peer of in-process.**

- **Runtime half**: `RepublicAgent` + `AgentRegistry` (unchanged core) behind a unified `RuntimeBootstrap`.
- **Carriers** (the seam): in-process (`TauriChannel`), stdio (`StdioRuntimeChannel`), WS (`ServerChannel`). Headless-only concerns (handshake/auth, rate-limit, health, persistence) are **optional layers the WS carrier enables**, not a forked bootstrap.
- **UI**: one Svelte build; `UIChannelClient` selects its transport; for `web`/remote it constructs a *completed* `WebSocketTransport` whose URL is `location.origin` (co-served) or injected config (standalone/desktop-remote).
- **Delegation**: first-party UI↔runtime over the one WS protocol; cross-agent via a new headless `A2AServer` endpoint that the existing desktop A2A client consumes.
- **Packaging**: Node-first (`npm run start:server` / `npx`); Docker is one optional recipe for heavy/remote deployments.

**Non-goals (this spec)**: multi-user SaaS; per-user vaults/partitioning; protocol convergence of stdio/in-proc onto method-RPC; hardening the Docker image (separate follow-up).

---

## 6. Functional Requirements

- **FR-1**: `npm run start:server` (and an `npx`-style entry) MUST run the headless server on Node 22+ with no Docker, and the README server section MUST match the scripts (Docker demoted to an explicitly-optional recipe).
- **FR-2**: A new `web` build mode MUST produce a browser bundle of the existing Svelte UI; `globals.d.ts` and `getUIClient()` MUST support it.
- **FR-3**: `WebSocketTransport` MUST be completed into a working `@workx/ws-server` client: performs the `connect` handshake + auth, sends id-framed requests, supports the full method set including `serviceRequest`, and decodes `{type:'event',event,payload,seq}` correctly.
- **FR-4**: The server MUST optionally serve the `web` bundle; the served UI MUST connect back to the same origin's WS and authenticate (loopback `none` or `token`).
- **FR-5**: The same `web` bundle MUST support a configurable remote runtime URL (standalone deploy / desktop-pointed-remote) without a rebuild.
- **FR-6**: A headless `A2AServer` endpoint MUST be implemented (agent card + `message/send` → the instance's `RepublicAgent`/`ToolRegistry`) such that the existing desktop A2A client can connect and delegate with no desktop architectural change.
- **FR-7**: `DesktopAgentBootstrap` / `ServerAgentBootstrap` / `PiRuntimeBootstrap` MUST be unified into one `RuntimeBootstrap` + thin carrier + optional headless layers, with no behavior change to existing platforms.
- **NFR-1**: Single-tenant only; no requirement to isolate multiple end-users (D4).
- **NFR-2**: Existing extension/desktop behavior MUST be unchanged by every phase (additive only).
- **NFR-3**: Existing third-party `@workx/ws-server` method-RPC clients MUST keep working (UI uses the same protocol; no breaking protocol changes).

---

## 7. Phasing

| Phase | Scope | Delivers | Risk |
|---|---|---|---|
| **P0** | Docs/packaging truth-up: README Node-first, Docker labeled optional, `npx`-style entry. | Story 1. Removes the contradiction. | Trivial |
| **P1** | `web` build mode + vite config + `getUIClient` branch + globals; **complete `WebSocketTransport`** (handshake/auth/ids/methods/events); server static-serves `web`; single-tenant. | Story 2 (the appliance). | Medium — the stub completion is the real work (§4.1). |
| **P2** | Implement headless `A2AServer` (card + `message/send` → RepublicAgent). | Story 3 (desktop delegation). Desktop side ~unchanged. | Medium |
| **P3** | Unify the three bootstraps → `RuntimeBootstrap` + carriers + optional layers. | Story 4 (maintainability). | Medium — pure refactor, broad blast radius. |
| **P4** | (Optional/future) desktop multi-runtime full-session remoting; later, multi-user SaaS. | Power features. | Out of scope here. |

---

## 8. Risks & Open Items

- **R1 (P1)**: `WebSocketTransport` completion touches the auth handshake and full method coverage — larger than a wiring task. Mitigate by treating §4.1 items 1–4 as explicit P1 sub-tasks with their own tests.
- **R2 (P1)**: Three auth surfaces. For single-tenant, constrain Mode A to loopback `none` or `token`; do not attempt auth unification in this spec.
- **R3 (P3)**: Bootstrap unification has a wide blast radius across all platforms; gate on the full existing test suites (NFR-2).
- **O1**: Exact `web` runtime-URL injection mechanism (build-time env vs. served `/config.json` vs. `location.origin` default) — to be fixed in the P1 plan.
- **O2**: Whether P0 ships an actual published `npx` package or just a documented `node dist/...` path — to be fixed in the P0 plan.

---

## 9. Success Criteria

1. A new operator starts the server on Node with no Docker by following the README, and Docker remains a working optional path.
2. Opening a single instance's URL yields a working UI (chat **and** non-chat service requests, streamed events) connected to that instance.
3. The same UI bundle works standalone against a configured remote runtime URL.
4. The existing desktop A2A client delegates a task to a headless instance and receives results, with no desktop architectural change.
5. Adding one runtime capability in the unified bootstrap surfaces it on desktop, sidecar, and server; all existing suites pass unchanged.
