# Track 43 Tasks

**Status (2026-05-18): PARTIALLY IMPLEMENTED.**

Verified additive foundation exists and builds: runtime profile, desktop runtime
entrypoint, server-build Vite config, path-compatible storage providers, stdio
carrier/channel, control-frame credential bridge, desktop-runtime prompt/profile
wiring, Rust supervisor/relay, and a parity harness skeleton. Desktop now starts
through the sidecar relay by default. The old in-WebView agent bootstrap,
WebView storage/rollout/terminal bridges, fetch proxy, and terminal sandbox
sidecar have been removed. Remaining P3/P4 work is deeper desktop-service
parity, packaging/native-addon proof, and full parity/hardening.

The design is now locked for implementation: desktop runtime sidecar builds with `__BUILD_MODE__='server'`, runs with `APPLEPI_RUNTIME_PROFILE=desktop-runtime`, exposes `platformId='desktop'`, uses desktop path-compatible providers, and communicates through Rust-relayed stdio.

P1/P2 are additive behind a flag. P3 is the irreversible desktop cutover and requires the parity harness to be green.

See [`design.md`](./design.md) for the final decisions, dispatch audit disposition, storage path requirements, and UI/auth replacement rules.

## Phase 1: Runtime Foundation And Parity Harness

Goal: create a runnable desktop runtime sidecar without changing current desktop behavior.

- [x] Add `src/runtime/profile.ts` with `server`, `desktop-runtime`, and `desktop-webview` profile detection.
- [x] Add `src/desktop-runtime/index.ts`. It must set `APPLEPI_RUNTIME_PROFILE=desktop-runtime`, read the Rust launch handshake, configure desktop runtime dependencies, and start `PiRuntimeBootstrap`.
- [x] Add `vite.config.desktop-runtime.mts` using a Node SSR target and `define: { __BUILD_MODE__: "'server'" }`.
- [x] Add `npm run build:desktop-runtime`.
- [ ] Extend `scripts/build-sidecar.mjs` for the desktop runtime sidecar.
- [ ] Package `better-sqlite3` native prebuilds/addon files for Linux, macOS, and Windows. The dependency exists, but packaging must prove the native module loads inside the sidecar.

### Path-compatible storage providers

- [x] Add `DesktopRuntimeStorageProvider` over the exact Rust desktop file `<config_dir>/storage.db`.
- [x] Add `DesktopRuntimeSQLiteAdapter` over the exact Rust desktop file `<config_dir>/storage.db` for scheduler/execution stores.
- [x] Add `DesktopRuntimeRolloutStorageProvider` over the exact Rust desktop file `<config_dir>/rollouts.db`.
- [x] Add `DesktopRuntimeConfigStorageProvider` over the exact Rust desktop file `<config_dir>/config.json`, preserving current JSON object semantics.
- [x] Update `core/storage/index.ts` and rollout/config provider factories so `desktop-runtime` uses these providers under server build mode.
- [ ] Add provider tests against fixture copies of existing Rust-created DB/config files. Assert no new `storage/`, `rollouts/`, or `config-storage.json` files are created.
- [ ] Add a no-op open/read/write test for all existing desktop collections used by scheduler, sessions, config, cache, rollout, token usage, and task output chunks.

### Stdio carrier and runtime channel

- [x] Add a length-prefixed JSON stdio carrier. Stdout is protocol frames only; stderr is diagnostics only.
- [ ] Reuse `@applepi/ws-server` frame schemas/helpers where they exist. Do not depend on nonexistent `TransportBridge` or `DirectBridge` classes.
- [x] Implement `StdioRuntimeChannel` as a `ChannelAdapter` for runtime-side channel traffic.
- [x] Implement frame families: `hello`, `hello-ok`, `request`, `response`, `event`, `control-request`, `control-response`, `ping`, `pong`, `shutdown`.
- [ ] Add tests for partial frames, multiple frames per chunk, oversized frames, invalid JSON, protocol version mismatch, nonce mismatch, and stderr isolation.

### Shared bootstrap

- [x] Extract `ServerAgentBootstrap` shared logic into `PiRuntimeBootstrap`.
- [x] Keep current server behavior unchanged behind `profile='server'`.
- [ ] Parameterize bootstrap over channel, platform adapter, storage set, scheduler set, auth set, runtime host paths, and control bridge clients.
- [x] Add `DesktopRuntimePlatformAdapter` with `platformId='desktop'`.
- [x] Configure desktop runtime prompt/persona as Apple Pi desktop (`applepi`), not `applepi-server`.
- [ ] Configure desktop approval rules, managed policy, plan review, and model settings parity with the old desktop bootstrap.
- [x] Ensure `RepublicAgent` receives the desktop platform adapter and desktop platform label.
- [x] Ensure `A2AManager` and MCP manager are initialized with explicit desktop platform where needed.
- [x] Replace the `Session.ts` server-build suggestion skip with runtime profile/capability logic so desktop runtime suggestions remain enabled.

### MCP, tools, and Node desktop behavior

- [x] Make desktop runtime MCP stdio use `NodeMCPBridge`.
- [x] Remove Tauri `invoke` path resolution from desktop builtin browser MCP setup. Use handshake-provided `browserMcpSidecarPath`, `projectRoot`, and app paths.
- [ ] Port browser tools to Node-capable launch/process/file behavior or explicit Rust control frames where OS trust is required.
- [x] Port terminal tools to Node `child_process`/PTY or document and implement a deliberate Rust control bridge.
- [ ] Port skills/plugins filesystem access to Node providers.
- [x] Ensure runtime uses Node `fetch`; no desktop fetch proxy.

### UI service replacements

- [x] Replace `desktop/ui/main.ts` `initializeDesktopAgent()` with relay client initialization only.
- [x] Replace `desktop/main.ts` `bootstrap.shutdown()` with Rust supervisor shutdown.
- [x] Replace `UserLoginStatus.svelte` direct `getDesktopAgentBootstrap().setAuthMode(...)` with a runtime service request.
- [ ] Define and implement runtime services/control frames for `agent.initAuth` or `auth.setMode`, `auth.getState`, `auth.logout`, and auth state events.
- [ ] Runtime auth must use desktop keychain token source. Do not pass WebView token getter functions across IPC.
- [x] Add `RuntimeConfigStorageProvider` for WebView desktop config access over the relay, or an equivalent pre-mount config relay. This must exist before deleting `storage_commands`.
- [x] Stop initializing the WebView credential store after cutover; credentials are runtime-owned.

### Parity harness

- [x] Build a cross-binding parity harness that can run the same agent scenarios over current server websocket and desktop runtime stdio.
- [ ] Cover chat request/response, streaming events, tool call, MCP stdio server, config read/write, rollout read/write, auth mode update, scheduler job creation, scheduler trigger, cancellation, reconnect, and graceful shutdown.
- [ ] P1 exit requires the harness to pass against the new sidecar in dev mode.

## Phase 2: Rust Supervisor And Relay Behind Flag

Goal: Tauri can start and talk to the sidecar, while the old in-WebView path remains the default.

- [ ] Add Rust runtime supervisor module.
- [ ] Spawn the desktop runtime as a Tauri `externalBin` from Rust, not from WebView shell APIs.
- [ ] Generate a launch nonce and pass resolved host data to the runtime handshake.
- [ ] Resolve and pass exact paths: `configDir`, `storageDbPath`, `rolloutDbPath`, `configJsonPath`, cache/log dirs, `browserMcpSidecarPath`, `projectRoot`, platform info, and keychain service prefix.
- [ ] Implement `hello`/`hello-ok` handshake validation.
- [ ] Implement ping/pong health, bounded restart backoff, graceful shutdown, SIGTERM/SIGKILL fallback, and parent-bound child cleanup.
- [ ] Relay WebView `agent_send` invocations to runtime stdin and runtime stdout events to WebView events.
- [ ] Add relay client `ChannelAdapter` in the WebView behind a build/runtime flag.
- [ ] Add UI states for runtime starting, reconnecting, down, and permanently failed.

### Rust control-frame bridges

- [ ] Keychain bridge: get, set, delete, list, and error mapping over existing Rust keychain commands.
- [ ] Scheduler OS bridge: register, update, remove, and fire/submit scheduled jobs using existing scheduler OS trust code.
- [ ] Window bridge: show/focus/submit path used by scheduler notifications.
- [ ] Notification bridge: job-start and job-finished notifications.
- [ ] Deeplink bridge: forward auth callback deeplinks to runtime.
- [ ] Diagnostics bridge: stderr capture and recent-runtime-log access.

### Phase 2 tests

- [ ] Rust unit tests for supervisor spawn, handshake reject, restart, graceful quit, forced kill, orphan cleanup, and stderr handling.
- [ ] Integration test for WebView relay request/response and event ordering.
- [ ] Run parity harness through Rust relay. P2 exit requires green parity.

## Phase 3: Desktop Cutover

Goal: desktop uses the sidecar by default. This phase is irreversible and requires P2 parity green.

- [x] Switch desktop startup to Rust-supervised runtime sidecar.
- [x] Remove old in-WebView agent initialization.
- [x] Remove direct imports of `DesktopAgentBootstrap` and `getDesktopAgentBootstrap` from UI/shell code.
- [x] Remove WebView credential-store initialization.
- [x] Switch WebView config access to `RuntimeConfigStorageProvider` or the approved runtime config relay.
- [ ] Port remaining desktop-only bootstrap wiring to `PiRuntimeBootstrap`.
- [x] Delete `DesktopAgentBootstrap` after all behavior is ported.
- [ ] Delete or retire the WebView/Tauri-only desktop platform adapter if no remaining UI-only use exists.
- [x] Delete fetch proxy and HTTP Rust command path.
- [ ] Delete storage, DB, rollout, terminal, skills, plugins, OAuth, MCP manager, browser helper, and generic process/file Rust commands that are replaced by runtime implementations.
  - Done: storage, DB, rollout, terminal, terminal sandbox helper.
  - Remaining: skills/plugins filesystem, OAuth callback, MCP manager/browser helper, and generic trusted shell commands that still serve UI or shell-only responsibilities.
- [ ] Keep keychain, scheduler OS registration, tray, deeplink, updater, global shortcut, notification, autostart, single-instance, window, and theme shell code.
- [ ] Shrink large-payload spill to the Rust-to-WebView hop only.
- [ ] Add static/grep guard tests that fail if desktop UI imports `DesktopAgentBootstrap`, `createCredentialStore`, runtime SQLite providers, or agent bootstrap entrypoints.

## Phase 4: Hardening, Migration Safety, And Packaging

- [ ] No-op migration verification with real existing desktop data on Linux, macOS, and Windows.
- [ ] Confirm existing `storage.db`, `rollouts.db`, and `config.json` are opened in place and not replaced by empty server-path files.
- [ ] Confirm existing keychain entries are readable through the runtime keychain bridge with the same service names.
- [ ] Crash/restart soak while streaming a response.
- [ ] Crash/restart soak during MCP tool call.
- [ ] Scheduler-across-restart test.
- [ ] Session rehydrate from disk after runtime restart.
- [ ] Large payload test across runtime-to-Rust and Rust-to-WebView boundaries.
- [ ] Resource footprint measurement: old in-WebView desktop vs sidecar desktop, idle and under load.
- [ ] Startup latency measurement.
- [ ] `npm run tauri:build` smoke on Linux, macOS, and Windows.
- [ ] Verify updater includes and replaces the runtime sidecar.
- [ ] Verify native SQLite addon loading in packaged app on all supported OS/arch combinations.
- [ ] Verify server mode still starts and passes existing server tests.

## Final Done Criteria

- [ ] Desktop app starts with no in-WebView agent bootstrap.
- [ ] UI can login, logout, switch auth mode, chat, stream, cancel, use tools, configure models, and schedule jobs.
- [ ] Runtime crash does not kill the UI; UI reconnects after supervisor restart.
- [ ] Existing user data remains visible after upgrade.
- [ ] Existing scheduled jobs remain visible and executable after upgrade.
- [ ] No unexpected local HTTP port is opened by the desktop runtime.
- [ ] Server mode behavior is unchanged.
- [ ] Three-OS packaged builds pass smoke tests.
