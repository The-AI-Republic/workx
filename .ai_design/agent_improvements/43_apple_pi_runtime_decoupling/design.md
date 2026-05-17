# Track 43: Apple Pi Runtime Decoupling (Out-of-Process Agent)

**Priority: P1** · **Effort: XL** · **Status: DESIGN — NOT implementation-ready (blocked on the P0 dispatch audit; design-reviewed ×3, 2026-05-17)**

> Source: architecture pass + **three rounds of design review** on Apple Pi's desktop runtime (2026-05-17), line-level verified against `DesktopAgentBootstrap`, `TauriChannel`, both platform adapters, the `__BUILD_MODE__` factories, `KeytarCredentialStore`, `ServerAgentBootstrap`, `@applepi/ws-server`, the `tauri/src` command surface + `Cargo.toml`/`capabilities`, the Rust storage paths, and `server_mode_design.md`. Round 1 corrected 4 false premises; round 2 reversed the keychain decision; **round 3 (external cross-review) found that the round-2 build-mode strategy is broken and that two hard gaps — data-migration path-compatibility and direct UI→bootstrap calls — were underspecified** (see "Validation Notes — Round 3"). The status is therefore *not* READY: the build-mode strategy is an open decision gated on a complete dispatch audit. Not greenfield (the frame protocol is a shipped package; a headless runtime ships), but Decision 0 is unresolved.

## Problem

The agent runtime runs **inside the Tauri WebView, in the same JS context as the UI** (`DesktopAgentBootstrap.ts:8`, `TauriChannel.ts:7-8`, `desktop/ui/main.ts:57` "Initialize the agent bootstrap" then mount UI). Consequences, verified:

1. **Agent trapped in a browser sandbox.** ~40 `invoke()` shims to Rust (`main.rs:336-431`); `desktop/ui/main.ts:18-21` installs `installFetchProxy()` that *"routes external HTTP through Rust to bypass CORS"* — a per-request tax on the agent's own traffic.
2. **Sandbox artifacts in the design** — `TauriChannel.ts:156-160` `LargePayloadStore` for the WebView2 `postMessage` limit.
3. **Agent lifecycle bolted to UI lifecycle** — `main.rs:434-447` `prevent_close`+`hide` exists so the JS heap (and agent) survives a window close.
4. **Two runtimes maintained twice** — `DesktopAgentBootstrap.ts` (1267 ln) ∥ `ServerAgentBootstrap.ts` (~1500 ln); they drift (`DesktopAgentBootstrap.ts:906-907` "parity with ServerAgentBootstrap").

Goal: **Tauri owns only the UI + OS trust/shell boundary; the agent runs as a native Node process the Tauri shell spawns and supervises** — a bundled, auto-managed instance of the runtime `applepi-server` already ships.

## Validation Notes & Corrections

**Round 1 (architecture review):**
- **C1 — adapters are inert stubs.** `ServerPlatformAdapter.ts:66-103` & `DesktopPlatformAdapter.ts:133-170` return empty-body storage/cred stubs. Real per-mode routing is the `__BUILD_MODE__` factories `core/storage/index.ts:74-130` + `createRolloutStorageProvider.ts:14-37`. Work = replace desktop *providers*, not swap an adapter.
- **C2 — `__BUILD_MODE__` is a hard compile-time gate** (pervasive). The decoupled runtime can't naively reuse `'desktop'` (Tauri-invoke providers, no Tauri in Node) or `'server'` (wrong data dir/behavior). → see **Decision 0 (revised in round 2)**.
- **C3 — no `MessageRouter` exists** (`grep`=0); seam is `ChannelManager`/`ChannelAdapter`. `server_mode_design.md`'s `DesktopMessageRouter` is stale. Relay implements `ChannelAdapter`.
- **C4 — Track 43 supersedes `server_mode_design.md` §18.3/§20.0** (`TauriBridge`/`DesktopMessageRouter` dropped; WS collapses to a co-located `DirectBridge`).

**Round 2 (implementation-readiness review) — the load-bearing corrections:**

- **C5 (REVERSAL) — keychain DOES need the Rust bridge.** Round 1 claimed `KeytarCredentialStore` is native Node keytar. **False.** Its own header: *"Uses Tauri commands that wrap keytar … on the Rust side"*; it `import { invoke } from '@tauri-apps/api/core'` → `invoke('keychain_get')`. **`keytar` is absent from `package.json`.** ⇒ `keychain_commands` (Rust) is **KEPT as a required control-frame bridge**; the runtime's credential store calls it over a control frame. (Alternative — add a `keytar`/`keyring` native dep — is an Open Question, not the default.)

- **C6 `[SUPERSEDED by C9 — kept as historical record; do not act on this bullet in isolation]` (ARCHITECTURE CHANGE) — Decision 0 is NOT a new `__BUILD_MODE__` value.** Verified: ~10 `core/` modules branch on `__BUILD_MODE__ === 'desktop'` for *behavior*, not just storage — incl. `core/mcp/transports/index.ts:90` (`=== 'desktop' ? 'stdio' : 'sse'`, **MCP transport selection**), `core/messaging/index.ts:46`, `core/memory/MemoryFileSystem.ts:17`, `core/a2a/A2AManager.ts:72`, `core/mcp/MCPManager.ts:78`, `core/PromptLoader.ts:119`, `tools/registerPlatformTools.ts:24,73,128`. A new value would **silently disable every one** in the runtime. **Revised strategy:** the runtime bundle keeps `__BUILD_MODE__='desktop'` (all behavioral branches stay correct), and **only the 3 provider branches** (`createStorageProvider`/`createCredentialStore`/`createRolloutStorageProvider` + the ConfigStorage factory) are **rewired from Tauri-invoke to Node-native**. This is safe because, post-decouple, those factories execute **only in the Node runtime** — the UI-only webview no longer constructs the agent or storage (P3 must enforce this). Net: the divergence is confined to ~4 factory branches; zero behavioral-branch audit.

- **D1 (DE-RISK) — the frame protocol is real and already a package.** `packages/ws-server/` exists; `server/connection/handshake.ts` imports `PROTOCOL_VERSION, ConnectRequestSchema, makeResponse, makeEvent, negotiateProtocolVersion, WS_CLOSE, getRegisteredMethods, EVENT_SCOPE_MAP` from `@applepi/ws-server`. `server_mode_design.md` §18.5/§18.6 extraction is **done**, incl. the `TransportBridge` seam (`toAgent`/`onAgentEvent`/`isConnected`) with a working `DirectBridge`. ⇒ P1 is "add a `StdioBridge` + carrier", not "build a protocol." Substantially lowers P1 risk.

- **C7 — `ServerAgentBootstrap` extraction is more than a transport flag.** It directly `new`s `ServerChannel` (`:205`), `ServerScheduleStorage(dataDir)`/`ServerExecutionStorage(dataDir)`/`ServerSchedulerAlarms` (`:1186-1193`). The clean seam is `ServerChannel` (a `ChannelAdapter`); but the bootstrap also hard-codes the server scheduler/storage *set*. P1 must parameterize bootstrap over **(transport, storage set, scheduler set)**, not just transport.

- **C8 (caveat) — `better-sqlite3` is a native module NOT in root `package.json`.** `ServerStorageProvider.ts:55` does `await import('better-sqlite3')`; it works in server deployments where it's installed separately. The desktop-runtime bundle must **add `better-sqlite3` with per-OS/arch prebuilt binaries** (feeds Open Q2: bundling/compiling).

**Round 3 (external cross-review) — the load-bearing corrections that reset the status:**

- **C9 (REVERSAL of C6) — keeping `__BUILD_MODE__='desktop'` does NOT make the runtime work; the strategy is broken.** C6 claimed `'desktop'` branches "stay correct." Verified false for a *Node process*: many `=== 'desktop'` branches **dispatch to Tauri/Rust-backed implementations** that do not exist in a Node sidecar. Confirmed: `core/memory/MemoryFileSystem.ts:17` (`'desktop'` → `createTauriFileSystem()` — Tauri APIs absent in Node); `core/mcp/MCPManager.ts:565` (stdio MCP: `'server'`→`NodeMCPBridge`, else incl. `'desktop'`→**`RustMCPBridge`/Tauri-IPC** — Rust absent in the sidecar). Neither round-1 (new value → branches silently disabled) nor round-2 (`'desktop'` → branches dispatch to Tauri impls) is a valid simple pick. **Decision 0 ("4 storage factories") is decisively undercounted.** The runtime is architecturally closer to `'server'` (which already has the Node impls: `ServerStorageProvider`, `createNodeFileSystem`, `NodeMCPBridge`) than to `'desktop'`. The build-mode strategy is now an **open decision gated on a complete dispatch audit** (P0), with a leading candidate of *"build as `'server'`, parameterize data paths, add the keychain bridge + desktop approval/persona + `platformId='desktop'` label, suppress server-only behaviors"*.

- **C10 — direct UI→bootstrap calls bypass the channel entirely (missed scope).** The UI does not only talk to the agent via `ChannelAdapter`. `src/webfront/components/common/UserLoginStatus.svelte:106-109` dynamically imports `getDesktopAgentBootstrap()` and calls `bootstrap.setAuthMode(...)` **in-process**; `src/desktop/main.ts:15,72` calls `bootstrap.shutdown()`; `src/desktop/ui/main.ts:28` calls `initializeDesktopAgent()`. After decoupling the bootstrap lives in the sidecar — these need a **request/response service/control-frame API**, not just the event relay. Mitigation: the `ServiceRegistry` already exists and the channel carries it (`TauriChannel.supportsServices()=true`), so these become *service migrations* — real, previously-unscoped refactor work.

- **C11 — server providers are NOT drop-in even at the right dir (data-loss risk understated).** Verified file/dir divergence: desktop today (Rust) writes `<config_dir>/storage.db` (`db_storage.rs:257`), `<config_dir>/rollouts.db` (`rollout_db.rs:19`), `<config_dir>/config.json` (`storage_commands.rs:35`). The server providers write `<dataDir>/storage/storage.db` (`ServerStorageProvider.ts:59`), `<dataDir>/rollouts/rollouts.db` (`TSRolloutStorageProvider.ts:37`), `<dataDir>/config-storage.json` (`FileConfigStorageProvider.ts:15`) — **different subdirs AND filenames**, plus a probable Rust-vs-`better-sqlite3` **schema** mismatch. Pointing them at the desktop dir still yields fresh empty databases ("silent empty app"). The round-2 wording ("reuse … pointed at the resolved dir … reproduce byte-for-byte") **understated this**: it requires either path/filename/schema-faithful runtime providers OR an explicit one-time migration — a **hard P0/P1 requirement**, not P4 verification.

- **C5 confirmed independently** by the external review (no change; strengthens the round-2 reversal).

## Target Architecture

```
┌──────── Tauri shell (NO agent logic) ────────┐    ┌── Apple Pi runtime — native Node proc ──┐
│ WebView: Svelte UI ONLY                      │    │ PiRuntimeBootstrap (= ServerAgentBoot-  │
│   ChannelManager → relay ChannelAdapter      │    │   strap, parameterized: transport +    │
│      │ invoke('agent_send')  ▲ emit pi:event │stdio│   storage set + scheduler set)         │
│ Rust: supervisor + DUMB relay + shell        │◄──►│ RepublicAgent · AgentRegistry          │
│   • spawn/health/restart/kill                │frame│ __BUILD_MODE__ = Decision 0 (OPEN)     │
│   • resolves data paths + keychain bridge    │    │ storage/cred/rollout = Node-native     │
│   • tray/deeplink/updater/hotkeys/notify     │    │ StdioBridge (TransportBridge impl)     │
└───────────────────────────────────────────────┘    └─ spawns external Chrome + MCP subprocs ┘
```

### Decision 0 (OPEN — round-3 reset) — Build-mode strategy is unresolved; gated on the P0 dispatch audit

Round 1 (new `'desktop-runtime'` value) and round 2 (stay `'desktop'`, rewire 4 factories) are **both rejected** (C6/C9): a new value silently disables `=== 'desktop'` behavioral branches in the runtime; staying `'desktop'` makes those branches dispatch to **Tauri/Rust impls absent in a Node process** (`MemoryFileSystem.ts:17`→`createTauriFileSystem`, `MCPManager.ts:565`→`RustMCPBridge`, the storage factories, …). The divergence is **not** confined to 4 factories.

The strategy cannot be finalized until a **complete audit of every `__BUILD_MODE__ === 'desktop'` and `platformId === 'desktop'` dispatch that assumes Tauri/Rust** is done (P0, hard gate). Each such site needs a per-site decision: Node-native impl, runtime-context switch, or Rust control-frame bridge.

**Leading candidate (to validate in the audit), not yet adopted:** build the runtime as **`__BUILD_MODE__='server'`** — it already supplies the Node implementations the runtime needs (`ServerStorageProvider`, `createNodeFileSystem`, `NodeMCPBridge`) — then layer the desktop deltas: (a) **path/filename/schema-faithful** storage/rollout/config providers matching the existing Rust on-disk layout *or* a one-time migration (C11); (b) the **keychain control-frame bridge** to Rust (C5, same `applepi-` service names); (c) desktop approval rules + prompt persona + `platformId='desktop'` label; (d) suppress server-only behaviors (RBAC handshake, health monitor, `Session.ts:2420` server branch). The P0 audit must enumerate (d) exhaustively before this is adopted.

Invariants regardless of strategy: post-decouple the **UI-only webview must never call the storage/credential/rollout factories or `getDesktopAgentBootstrap()`** (C10) — all of it is runtime-side, reached via services/control-frames (P3 must enforce).

### Decision 1 — Transport: Rust-relayed stdio (no TCP port)

`agent runtime ⇄ Rust ⇄ UI` over the runtime's stdio; Rust is a transparent relay. The runtime keeps the WS server only for the optional remote-access feature, co-located with the agent via `DirectBridge` (not bridged through Rust). The new seam is a **`StdioBridge` implementing `@applepi/ws-server`'s `TransportBridge`** (peer of the existing `DirectBridge`).

### Decision 2 — One bootstrap

Retire `DesktopAgentBootstrap`. Runtime runs `PiRuntimeBootstrap` = `ServerAgentBootstrap` parameterized over (transport, storage set, scheduler set) — C7. Desktop-only wiring ports as `platformId==='desktop'` branches. `IPlatformAdapter.platformId` stays `'desktop'` (labelling: `getDefaultRules('desktop')` `DesktopAgentBootstrap.ts:289`, `RepublicAgent.ts:265`).

### Decision 3 — Lifecycle, supervision, and the handshake payload (Rust-owned)

Spawn on app start (Rust-side `Command`/sidecar — `tauri-plugin-shell = "2"` supports stdin write + stdout/stderr streams; spawning from Rust needs **no webview capability**, and `capabilities/default.json` already grants `process:allow-restart`). State machine: nonce handshake (inherited fd/env, never the webview) → ping/pong health (port `server/connection/watchdog.ts`) → bounded-backoff restart with `runtime:reconnecting` UX (sessions rehydrate from disk) → graceful shutdown → SIGTERM → SIGKILL; parent-bound child; single-instance already enforced (`main.rs:149`).

**The handshake payload (Rust→runtime) carries the resolved environment**, solving migration-path correctness: Rust resolves the **data/config/cache/rollout directories** (today these come from Tauri's path API → `@tauri-apps/api/path`, e.g. Rust `db_storage.rs:258-263` `config_dir.join("storage.db")`) and the **keychain availability/service prefix** (`applepi-`), and passes them to the runtime. The Node runtime must NOT recompute Tauri's app-dir algorithm itself.

### Wire protocol / large payloads

Reuse `@applepi/ws-server` (PROTOCOL_VERSION, frame codec, handshake) over a length-prefixed **stdio carrier** (stderr = logs, never parsed). The relay carries full `ChannelAdapter` traffic incl. the `ServiceRegistry` RPC `TauriChannel.supportsServices()=true` already multiplexes. Keep `LargePayloadStore` spill on the **Rust→webview hop only** (WebView2 limit); the runtime↔Rust hop streams freely.

## Rust Command Surface: Collapse vs. Survive

| Module (`tauri/src`) | Fate | Why |
|---|---|---|
| `storage_commands`, `db_storage`, `rollout_db` | **Delete** | Node-native providers (Decision 0). |
| `http_commands` + `desktop/polyfills/fetchProxy.ts` | **Delete** | Node `fetch`, no CORS. |
| `terminal_commands` | **Delete** | Node `child_process`. |
| `skills_commands`, `plugins_commands` | **Delete** | Node `fs` (`Filesystem{Skill,Plugin}Provider`). |
| `oauth_server` | **Delete** | Node `http.Server`. |
| `mcp_manager`, `browser_commands`, `sandbox`, `commands::get_*/file_exists/is_port_available` | **Delete** | Node `child_process`/CDP/stdlib; desktop builtin-MCP path (`DesktopPlatformAdapter.ts:50-96`) moves into the runtime. **Not free:** stdio MCP currently routes to `RustMCPBridge` under `'desktop'` (`MCPManager.ts:565`); in any Node runtime it must use `NodeMCPBridge` — a P0a dispatch-audit item, not automatic (C9). |
| `commands::get_platform_info` | **Move** to runtime / handshake | Runtime knows its OS/arch. |
| **`keychain_commands`** | **KEEP — required control-frame bridge (C5)** | `KeytarCredentialStore` is Tauri-invoke; `keytar` not a dep. |
| `scheduler_commands` (OS cron/launchd/Task Scheduler) | **KEEP — control-frame bridge** | OS-trust job registration. |
| `main.rs` shell plugins (tray/deeplink/autostart/updater/global-shortcut/notification/single-instance/window/theme) | **KEEP** | Tauri's remaining job. |

≈**33 of ~40 delete**; **2 kept as control-frame bridges** (`keychain_commands`, `scheduler_commands`); shell plugins stay.

## Shell ⇄ Runtime crossings (function call → control frame)

Scheduler "show window+focus+submit" `DesktopAgentBootstrap.ts:801-828`; job-start notification `:831-844`; deep-link `auth-callback` `main.rs:149-264` → `auth:callback` frame; **keychain get/set/delete/list** → keychain control frame (C5); OS scheduler register/remove → scheduler control frame; hotkeys/tray/autostart/updater stay Rust.

## Resource Footprint (analysis — verify in P4)

Not "1→2 processes doubling cost." Apple Pi is **already multi-process** (Chrome + MCP sidecars) and the UI↔agent boundary is **already serialized** (`TauriChannel` uses Tauri's `emit`/`listen` event bus, not a function call). The agent's working set (history, MCP, buffers) **moves heaps, it doesn't duplicate**.

- **RAM:** genuine new cost = one Node runtime baseline (~tens of MB; lower if compiled — Open Q2), partially offset by a lighter WebView JS heap and deleting the IPC-shim layer (`fetchProxy` double-buffering, `LargePayloadStore`).
- **CPU:** likely neutral-to-better — today every storage/HTTP op pays a serialize→IPC→Rust→deserialize tax; after, those are native in-process calls. New stdio cost applies only to lower-volume UI↔agent traffic that was already serialized.
- **Verdict:** modest bounded RAM increase for process isolation (UI crash/reload no longer kills the agent), sandbox escape, and desktop+server convergence — the standard thin-shell+runtime desktop architecture. **P4 measures idle + under-load RSS/CPU, in-webview vs decoupled, to confirm.**

## Reconciliation with `server_mode_design.md`

Track 43 supersedes §18.3/§18.6/§20.0: `TauriBridge` + unimplemented `DesktopMessageRouter` dropped; remote-access WS co-locates with the agent (`DirectBridge`). `src/desktop/channels/websocket/WebSocketServer.ts` (Tauri-invoke scaffold) → dead code, delete P3. `@applepi/ws-server` (§18.5, **already extracted**) is imported by the runtime; channel plugins (§20.0) run in the same runtime process — their intended desktop home.

## Phasing (parity harness precedes the irreversible cut)

1. **P0 — Verification + decision gate (BLOCKING; design is not READY until this completes).** Three hard sub-gates that must close before P1 estimates are valid: **(0a) Dispatch audit** — enumerate *every* `__BUILD_MODE__ === 'desktop'` and `platformId === 'desktop'` site that assumes Tauri/Rust (`MemoryFileSystem.ts:17`, `MCPManager.ts:565`, the storage factories, `messaging`, `a2a`, `PromptLoader`, …); per-site disposition; then **adopt or reject the `'server'`-base candidate** and finalize Decision 0. **(0b) Data-migration design** — pin the exact desktop on-disk layout (`storage.db`/`rollouts.db`/`config.json` at `ProjectDirs("com","airepublic","pi").config_dir`) and specify *either* path/filename/schema-faithful runtime providers *or* a one-time migration (C11). **(0c) Bootstrap-call inventory** — enumerate every direct `getDesktopAgentBootstrap()`/bootstrap method call from UI/shell (`setAuthMode`, `shutdown`, `initializeDesktopAgent`, `getRegistry`, `getScheduler`, `getReadyState`, …) and define the service/control-frame replacement for each (C10). Plus: record resolved paths, lock the desktop-only-wiring port list, decide keychain default vs native dep.
2. **P1 — Node-native providers + `StdioBridge` + parameterized bootstrap + parity harness.** Implement the Decision 0 strategy finalized in P0a (provider set per the chosen build mode, schema/path-faithful per P0b); add `better-sqlite3` + prebuilds (C8); add `StdioBridge` impl of `@applepi/ws-server`'s `TransportBridge`; parameterize `ServerAgentBootstrap`→`PiRuntimeBootstrap` over (transport, storage set, scheduler set) (C7); add the P0c bootstrap-call services. Build the cross-binding parity harness. Additive; server mode unchanged.
3. **P2 — Rust supervisor + relay + UI relay client (behind build flag).** Sidecar spawn/handshake (with resolved-paths payload, Decision 3)/health/restart; `agent_send` relay; **keychain + scheduler control-frame bridges**; relay `ChannelAdapter`. **Exit criterion: parity harness green.**
4. **P3 — The cut (irreversible; requires P2 parity green).** Switch desktop to the relay client; ensure the webview calls **no** storage factory; port desktop-only wiring; delete `DesktopAgentBootstrap`, `DesktopPlatformAdapter`, the ~33 dead Rust commands, `fetchProxy.ts`, `WebSocketServer.ts`.
5. **P4 — Hardening + measurement.** No-op on-disk migration verification (highest user risk); crash/restart soak; scheduler-across-restart; large-payload streaming; **Resource Footprint measurement**; three-OS packaging.

## Packaging

Runtime ships as a Tauri `externalBin` (precedent `tauri.conf.json:7-8,16`). Add it + a new `vite.config.desktop-runtime.mts` (Node SSR target like `vite.config.server.mts:13,16,27`; its `define __BUILD_MODE__` value is whatever Decision 0 finalizes in P0a — likely `'server'`, not `'desktop'`) + extend `scripts/build-sidecar.mjs`. Must bundle `better-sqlite3` with per-OS/arch prebuilts (C8). Open Q2: ship Node vs. SEA/Bun/pkg.

## Open Questions

1. **Keychain:** keep `keychain_commands` Rust bridge (default, C5) vs. add a `keytar`/`keyring` native dep to the runtime? Decide on a *signed* macOS build in P0.
2. Ship Node vs. compile (SEA/Bun/pkg) — bundle size vs. startup vs. native-module (`better-sqlite3`) prebuild handling.
3. Keep `prevent_close`/tray-hide UX once runtime survival no longer needs the webview alive?
4. Optional opt-in: expose the co-located WS so external clients attach to the desktop agent (the §18 vision, now simpler). Out of scope.

## Appendix — Verified Anchors

- In-webview: `DesktopAgentBootstrap.ts:8`; `TauriChannel.ts:7-8`; `desktop/ui/main.ts:18-21,57`.
- Adapters inert: `ServerPlatformAdapter.ts:66-103`, `DesktopPlatformAdapter.ts:133-170`.
- Real factories: `core/storage/index.ts:74-152`; `createRolloutStorageProvider.ts:14-37`.
- Keychain is Tauri-invoke (C5): `src/desktop/storage/KeytarCredentialStore.ts:1-15,55`; `keytar` absent from `package.json`.
- Behavioral build-mode branches (C6): `core/mcp/transports/index.ts:90`, `core/messaging/index.ts:46`, `core/memory/MemoryFileSystem.ts:17`, `core/a2a/A2AManager.ts:72`, `core/PromptLoader.ts:119`, `tools/registerPlatformTools.ts:24,73,128`.
- Protocol is a real package (D1): `packages/ws-server/`; `server/connection/handshake.ts:18-31` imports `@applepi/ws-server`.
- Bootstrap coupling (C7): `ServerAgentBootstrap.ts:205,1186-1193`.
- `better-sqlite3` native, not root dep (C8): `ServerStorageProvider.ts:4,55`.
- Path source-of-truth: `src/desktop/platform/paths.ts:10-19` (Tauri path API), Rust `db_storage.rs:258-263`.
- Tauri sidecar/stdio: `tauri/Cargo.toml:17-24` (`tauri-plugin-shell="2"`); `tauri/capabilities/default.json` (`process:allow-restart`; no `shell:execute` → spawn must be Rust-side).
- No `MessageRouter`: `grep -rln MessageRouter src` (non-test)=0.
- Supersedes: `server_mode_design.md` §18.3/§18.5/§18.6/§20.0; scaffold `src/desktop/channels/websocket/WebSocketServer.ts`.
