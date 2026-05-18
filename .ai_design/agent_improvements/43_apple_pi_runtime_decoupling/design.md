# Track 43: Apple Pi Runtime Decoupling (Out-of-Process Agent)

**Priority: P1** | **Effort: XL** | **Status: READY FOR IMPLEMENTATION (design locked 2026-05-17)**

This track moves the Apple Pi desktop agent out of the Tauri WebView and into a supervised native Node runtime process. Tauri remains the UI, shell, and OS-trust boundary. The agent runtime owns agent state, tools, storage, MCP, scheduler orchestration, and auth mode.

The previous review rounds are preserved as background, but the blocking questions are now resolved in this document:

- The runtime sidecar is a **Node bundle built with `__BUILD_MODE__='server'`**.
- The sidecar sets a separate runtime profile: **`APPLEPI_RUNTIME_PROFILE=desktop-runtime`**.
- The runtime still presents desktop semantics where they matter: **`platformId='desktop'`**, desktop prompt/persona, desktop approval rules, desktop scheduler behavior, desktop MCP/browser tool behavior, and existing desktop on-disk paths.
- The desktop UI bundle remains a Tauri/WebView bundle with `__BUILD_MODE__='desktop'`.
- `src/server/index.ts` is **not** the desktop runtime entrypoint. Add a dedicated desktop runtime entrypoint.

## Problem

The current desktop agent runs inside the Tauri WebView, in the same JS context as the Svelte UI. That creates four durable problems:

1. The agent is trapped in the browser sandbox. It needs Rust shims for HTTP, filesystem, storage, terminal, browser, MCP, OAuth, skills, plugins, and keychain.
2. UI and agent lifecycle are coupled. Tauri has to hide the window rather than close it so the JS heap that contains the agent survives.
3. Desktop and server maintain separate bootstraps with duplicated wiring and drift.
4. The agent pays WebView IPC taxes for work that should be local to the runtime process.

Goal: Tauri supervises a bundled runtime sidecar. The WebView is a UI client. The runtime is the single in-process home for the agent.

## Final Architecture

```
Tauri shell / Rust
  - starts, monitors, restarts, and stops the runtime sidecar
  - relays UI frames between WebView and runtime stdio
  - resolves desktop paths and passes them in the launch handshake
  - keeps OS-trust bridges: keychain, scheduler registration, tray, deeplink,
    updater, notification, autostart, global shortcut, window control

Svelte WebView
  - renders UI only
  - talks to the runtime through a relay ChannelAdapter
  - uses service-backed config/auth APIs instead of importing the bootstrap
  - does not create the agent, credential store, rollout store, or SQLite stores

Desktop runtime sidecar
  - Node process, server build mode, desktop runtime profile
  - PiRuntimeBootstrap with desktop profile wiring
  - RepublicAgent, AgentRegistry, MCP, tools, memory, storage, scheduler logic
  - stdio ChannelAdapter carrier to Rust
  - optional co-located websocket server only for explicit remote-access mode
```

## Decision 0: Build Mode And Runtime Profile

Use a two-axis model:

| Axis | Desktop UI | Desktop runtime sidecar | Server |
|---|---|---|---|
| Compile-time `__BUILD_MODE__` | `desktop` | `server` | `server` |
| Runtime profile | `desktop-webview` | `desktop-runtime` | `server` |
| Platform label exposed to agent | UI only | `desktop` | `server` |
| Runtime entrypoint | `src/desktop/ui/main.ts` | `src/desktop-runtime/index.ts` | `src/server/index.ts` |

Rationale:

- A Node sidecar cannot use `__BUILD_MODE__='desktop'` safely. Several desktop branches dispatch to Tauri/Rust implementations that do not exist in a sidecar, including `createTauriFileSystem()` and `RustMCPBridge`.
- A Node sidecar can use `__BUILD_MODE__='server'` to get Node-capable implementations such as Node filesystem and Node MCP stdio transport.
- Server build mode alone is not enough. The sidecar must override server assumptions with the `desktop-runtime` profile: desktop paths, desktop platform label, desktop prompt, desktop approval rules, desktop auth/keychain bridge, desktop scheduler bridge, and server-only behavior suppression.

Implementation:

- Add a small runtime profile module, for example `src/runtime/profile.ts`.
- The desktop runtime entrypoint sets `process.env.APPLEPI_RUNTIME_PROFILE='desktop-runtime'` before bootstrap code imports providers that read the profile.
- Server entrypoints default to `server`.
- UI code may use `desktop-webview` only for client-side factory decisions.

## Dispatch Audit Decisions

| Site | Runtime disposition |
|---|---|
| `core/memory/MemoryFileSystem.ts` | Server build gives Node filesystem. Desktop runtime must keep desktop memory paths where applicable. |
| `core/mcp/MCPManager.ts` | Server build gives `NodeMCPBridge`; pass platform `desktop` explicitly so desktop-scoped MCP servers are used. Replace Tauri-side builtin browser path resolution with handshake-provided paths. |
| `core/mcp/transports/index.ts` | With server build the default becomes server-like. Desktop runtime must explicitly configure stdio MCP transport for desktop MCP servers where needed. |
| `core/storage/index.ts` | Add `desktop-runtime` provider branches that open the existing desktop file paths, not server subdirectories. |
| `storage/rollout/provider/createRolloutStorageProvider.ts` | Add `desktop-runtime` branch for the existing desktop rollout DB path. |
| `core/memory/createMemoryService.ts` | Server/desktop both allow memory; no special UI dependency. |
| `core/a2a/A2AManager.ts` | Desktop runtime must call `A2AManager.getInstance('desktop')` or equivalent explicit platform wiring. |
| `core/PromptLoader.ts` | Use Apple Pi desktop prompt/persona, not `applepi-server`. |
| `core/Session.ts` suggestion gate | Replace `__BUILD_MODE__ === 'server'` with runtime capability/profile logic so one-tap desktop suggestions remain enabled in `desktop-runtime`. |
| `core/messaging/index.ts` | UI-only. The runtime must not import desktop WebView messaging. |
| `tools/registerPlatformTools.ts` | `RepublicAgent` should use the injected desktop runtime platform adapter. Avoid global `detectPlatform()` in the sidecar path. |
| `RepublicAgent.ts` | Inject `platformId='desktop'` for desktop runtime so agent type, approval defaults, and desktop behavior remain correct. Explicitly pass unattended/server flags where the profile requires them. |

## Decision 1: Dedicated Runtime Entrypoint

Do not boot the desktop runtime through `src/server/index.ts`.

Add a new entrypoint, for example `src/desktop-runtime/index.ts`, that:

1. Reads the Rust launch handshake.
2. Sets the runtime profile to `desktop-runtime`.
3. Installs desktop path/auth/scheduler/keychain bridge dependencies.
4. Configures the desktop prompt context.
5. Starts `PiRuntimeBootstrap` on a stdio-backed channel.

Server-only features stay in server mode unless deliberately enabled later:

- Public HTTP listener and websocket listener.
- Remote RBAC/session handshake.
- Server watchdog HTTP health surface.
- Server data directory defaults.
- Server config file defaults.
- Server stale-connection cleanup and tick broadcasting.
- Server log streaming or diagnostics endpoints that imply remote clients.

The desktop runtime may keep local diagnostics internally, but they must not create a listening port by default.

## Decision 2: One Bootstrap

Extract the shared bootstrap into `PiRuntimeBootstrap`.

`PiRuntimeBootstrap` is parameterized over:

- `profile`: `server` or `desktop-runtime`.
- `channel`: `ServerChannel`, `StdioRuntimeChannel`, or a test harness channel.
- `platformAdapter`: server adapter or desktop runtime adapter.
- `storageSet`: config, key-value, rollout, scheduler, execution, memory.
- `schedulerSet`: event storage, execution storage, alarms/OS registration bridge.
- `authSet`: token getter, credential bridge, auth callback handler.
- `runtimeHost`: resolved paths, sidecar locations, app metadata, shell bridge clients.

Current server behavior must remain unchanged when `profile='server'`.

Desktop runtime behavior uses:

- `platformId='desktop'`.
- Desktop approval rules and managed policy wiring.
- Desktop prompt composer config (`applepi`, not `applepi-server`).
- Desktop MCP/browser tools with Node-capable implementations.
- Desktop scheduler semantics with OS registration through Rust control frames.
- Auth token access through runtime-owned keychain bridge, not a WebView token getter.

## Decision 3: Transport And Protocol

Use Rust-relayed stdio between Tauri and the runtime.

`@applepi/ws-server` currently provides method/frame schemas and helpers, but the inspected package does **not** contain a shipped `TransportBridge` or `DirectBridge` implementation. Therefore P1 must implement the desktop stdio carrier directly. Reuse the package's protocol constants, frame schemas, method names, and frame constructors where useful, but do not implement against nonexistent bridge classes.

Carrier rules:

- Runtime stdout is reserved for length-prefixed JSON frames.
- Runtime stderr is logs/diagnostics and is never parsed as protocol.
- Rust relays frames between child stdout/stdin and WebView events/invokes.
- Rust may validate only the outer carrier shape, nonce, and lifecycle; it does not own agent semantics.
- Large-payload spill remains only on the Rust-to-WebView hop if WebView limits require it. Runtime-to-Rust stdio should stream framed payloads directly.

Minimum frame families:

- `hello` / `hello-ok`: nonce, protocol version, runtime profile, resolved paths.
- `request` / `response`: service and channel requests.
- `event`: agent/channel events to UI.
- `control-request` / `control-response`: runtime asks Rust to perform keychain, scheduler, window, notification, deeplink, and shell operations.
- `ping` / `pong`: supervisor health.
- `shutdown`: graceful termination.

## Decision 4: Storage And Migration

No one-time data migration is required for the first cut if the desktop runtime uses path-compatible providers. This is mandatory.

Rust currently stores desktop data under `ProjectDirs::from("com", "airepublic", "pi").config_dir()`:

| Data | Current desktop file | Required runtime provider |
|---|---|---|
| General key-value storage | `<config_dir>/storage.db` | `DesktopRuntimeStorageProvider` over this exact file |
| SQLite adapter for scheduler/execution stores | `<config_dir>/storage.db` | `DesktopRuntimeSQLiteAdapter` over this exact file |
| Rollout storage | `<config_dir>/rollouts.db` | `DesktopRuntimeRolloutStorageProvider` over this exact file |
| Config storage | `<config_dir>/config.json` | `DesktopRuntimeConfigStorageProvider` preserving current JSON shape |
| Credentials | OS keychain with existing `applepi-` service names | Runtime credential store calling Rust keychain control frames |

Do not point server providers at the desktop config directory unchanged. Server providers currently use subpaths such as `storage/storage.db`, `rollouts/rollouts.db`, and `config-storage.json`, which would create empty replacement data.

Schema inspection result:

- The Rust storage DB table shape and server `ServerStorageProvider` table shape are compatible for key-value collections: `key TEXT PRIMARY KEY`, `value TEXT NOT NULL`, `created_at INTEGER NOT NULL`, `updated_at INTEGER NOT NULL`.
- The rollout DB schemas are compatible enough to implement a path-compatible Node provider over the existing file.
- Runtime providers may add compatible indexes, but must not rename tables, move files, or rewrite values during first launch.
- Config storage must preserve current `config.json` object semantics. The WebView chunking behavior was only a Tauri IPC workaround and must not define the runtime storage format.

P4 still verifies this as a no-op migration with real existing user data on Linux, macOS, and Windows.

## Decision 5: UI Config, Auth, And Bootstrap Calls

The UI cannot call `getDesktopAgentBootstrap()` after the cut.

Confirmed direct call replacements:

| Current call | Replacement |
|---|---|
| `desktop/ui/main.ts` calls `initializeDesktopAgent()` | Rust starts runtime; UI initializes relay client only. |
| `desktop/main.ts` calls `bootstrap.shutdown()` | Rust supervisor sends runtime `shutdown` and owns child termination. |
| `UserLoginStatus.svelte` calls `bootstrap.setAuthMode(...)` | UI sends service request, for example `agent.initAuth` or `auth.setMode`, to the runtime. |

Auth-specific rule:

- Do not pass a WebView `tokenGetter` to the runtime. Functions cannot be serialized, and credentials should not remain WebView-owned.
- Runtime auth uses a desktop keychain token source. The keychain implementation calls Rust `keychain_*` control frames.
- Rust forwards auth deeplinks to the runtime as an `auth:callback` control/event frame.
- The runtime stores refreshed tokens and emits auth state updates back to the UI.

Config-specific rule:

- The UI still needs config access before and during mount.
- Replace desktop WebView config storage with a relay-backed `RuntimeConfigStorageProvider` implementing the existing config storage interface over runtime services, or with a minimal Rust relay command that forwards to runtime before mount.
- Remove WebView credential-store initialization in the cut. Credentials become runtime-only.

This is part of P1/P2, not cleanup.

## Decision 6: Desktop Runtime Platform Adapter

Add `DesktopRuntimePlatformAdapter` instead of reusing the current WebView/Tauri desktop adapter directly.

Responsibilities:

- `platformId='desktop'`.
- Register desktop tools that are Node-capable.
- Use Node implementations for filesystem, browser launch/control, terminal, skills, plugins, HTTP, MCP process management, and OAuth callback handling where possible.
- Use Rust control frames only for OS-trust operations that should stay in Tauri/Rust: keychain, scheduler registration, show/focus window, notification, tray/deeplink/updater/autostart/global shortcut.

Known tool implementation notes:

- Terminal tools must move away from current Tauri invoke paths to Node `child_process`/PTY or a deliberately retained Rust bridge if security requires it.
- Browser builtin MCP must not call Tauri `invoke` to locate sidecars or project root. Use handshake-provided `browserMcpSidecarPath`, `projectRoot`, and app paths.
- MCP stdio must use `NodeMCPBridge` in the sidecar.
- Desktop prompt and approval behavior should remain desktop, not server.

## Rust Command Surface

| Rust surface | Fate |
|---|---|
| Storage DB, rollout DB, config storage commands | Delete after runtime path-compatible providers are active and UI config relay exists. |
| HTTP/fetch proxy | Delete; runtime uses Node fetch. |
| Terminal commands | Delete unless a specific security review keeps a Rust bridge. |
| Skills/plugins filesystem commands | Delete; runtime uses Node filesystem providers. |
| OAuth local server | Delete; runtime can own local HTTP callback handling or Rust can forward deeplinks only. |
| MCP manager/browser/process helper commands | Delete after Node runtime replacements land. |
| Keychain commands | Keep as Rust control-frame bridge. |
| Scheduler OS registration commands | Keep as Rust control-frame bridge. |
| Tray, deeplink, updater, global shortcut, notification, autostart, single instance, window/theme shell code | Keep in Tauri/Rust. |

## Packaging

Add a desktop runtime build and sidecar package:

- `vite.config.desktop-runtime.mts`: Node SSR target, `__BUILD_MODE__='server'`.
- `src/desktop-runtime/index.ts`: runtime entrypoint.
- `scripts/build-sidecar.mjs`: extended to build/package the runtime sidecar.
- Tauri `externalBin`: includes the runtime executable.

`better-sqlite3` is already present as an optional dependency in the root package, but production packaging must explicitly include the correct native prebuilds or extracted native addon files for each supported OS/arch. This is a packaging deliverable, not an open design question.

Preferred first implementation:

- Dev: run the runtime bundle under system Node for fast iteration.
- Production: package a sidecar launcher/runtime executable using the existing sidecar build pattern, with native addon extraction verified on Linux, macOS, and Windows.

## Implementation Phases

1. P1: Add runtime profile, desktop runtime entrypoint, path-compatible Node providers, stdio carrier, `PiRuntimeBootstrap`, desktop runtime platform adapter, UI service replacements, and parity harness. Server behavior unchanged.
2. P2: Add Rust supervisor, launch handshake, stdio relay, keychain/scheduler/window/notification/deeplink control frames, relay ChannelAdapter, and runtime-down/reconnecting UI states behind a build flag.
3. P3: Cut desktop over to the runtime relay, remove in-WebView bootstrap, remove WebView credential initialization, port desktop-only wiring, and delete dead Rust commands.
4. P4: Harden and measure: no-op migration verification, crash/restart soak, scheduler restart behavior, large payloads, packaging, resource footprint, and three-OS smoke builds.

## Acceptance Criteria

Implementation-ready means the following are true before coding starts:

- The runtime build mode decision is locked: server build mode plus desktop runtime profile.
- Desktop existing data paths are locked and path-compatible providers are required.
- UI bootstrap/direct-call replacements are enumerated.
- `@applepi/ws-server` is treated as frame/schema infrastructure only; no nonexistent bridge abstraction is assumed.
- Server-only behavior suppression is explicit.
- Auth/keychain ownership is runtime-side with Rust control frames.
- UI config access has a replacement path before `storage_commands` can be deleted.

Done means:

- Existing desktop data opens in the runtime without migration or empty replacement DB creation.
- The desktop UI can start, login, chat, use tools, schedule jobs, restart, and recover after runtime crash.
- Server mode still passes its existing tests and starts unchanged.
- The desktop app builds and smokes on Linux, macOS, and Windows with the sidecar included.

## Verified Anchors

- In-WebView bootstrap: `src/desktop/ui/main.ts`, `src/desktop/bootstrap/DesktopAgentBootstrap.ts`, `src/desktop/channels/TauriChannel.ts`.
- Build-mode dispatches: `src/core/memory/MemoryFileSystem.ts`, `src/core/mcp/MCPManager.ts`, `src/core/mcp/transports/index.ts`, `src/core/storage/index.ts`, `src/storage/rollout/provider/createRolloutStorageProvider.ts`, `src/core/a2a/A2AManager.ts`, `src/core/PromptLoader.ts`, `src/core/Session.ts`, `src/tools/registerPlatformTools.ts`.
- Direct bootstrap calls: `src/desktop/ui/main.ts`, `src/desktop/main.ts`, `src/webfront/components/common/UserLoginStatus.svelte`.
- Desktop Rust storage paths: `tauri/src/db_storage.rs`, `tauri/src/rollout_db.rs`, `tauri/src/storage_commands.rs`.
- Server provider path mismatch: `src/server/storage/ServerStorageProvider.ts`, `src/server/storage/NodeSQLiteAdapter.ts`, `src/storage/rollout/provider/TSRolloutStorageProvider.ts`, `src/server/storage/FileConfigStorageProvider.ts`.
- Protocol package: `packages/ws-server`.
- Tauri sidecar/shell capability: `tauri/Cargo.toml`, `tauri/capabilities/default.json`.
