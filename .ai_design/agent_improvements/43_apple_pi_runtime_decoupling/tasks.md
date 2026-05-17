# Track 43 Tasks

> **Status (2026-05-17):** DESIGN — **NOT implementation-ready** (design-reviewed ×3).
> Effort XL. P0 is now a **blocking decision gate**: round 3 found the build-mode
> strategy broken (C9), the data-migration plan understated (C11), and direct
> UI→bootstrap calls unscoped (C10). P1 estimates are invalid until P0a/P0b/P0c
> close. P1–P2 remain additive/reversible behind a build flag; **P3 is the
> irreversible cut, gated on the P1 parity harness being green.** The frame
> protocol (`@applepi/ws-server`) and a headless runtime already ship.

See [`design.md`](./design.md) — Validation Notes (rounds 1–3; **C5 keychain
reversal, C9 build-mode strategy broken, C10 direct bootstrap calls, C11 data
migration**), Decision 0 (OPEN — gated on the P0 dispatch audit), the
command-collapse table, and the `server_mode_design.md` reconciliation.

---

## Phase 0: Verification + DECISION gate (BLOCKING — design is not READY until 0a/0b/0c close)

Anchors verified on `agent-improvements` (2026-05-17); re-confirm and record findings inline.

### 0a — Dispatch audit + finalize Decision 0 (build-mode strategy is OPEN)

- [ ] **Full `=== 'desktop'` dispatch audit.** `grep -rn "__BUILD_MODE__ === 'desktop'\|=== \"desktop\"\|platformId === 'desktop'\|platform === 'desktop'" src/core src/tools src/storage | grep -v __tests__`. For **every** site, record whether it dispatches to a Tauri/Rust-backed impl that breaks in a Node sidecar. Known-bad confirmed: `core/memory/MemoryFileSystem.ts:17` (`createTauriFileSystem`), `core/mcp/MCPManager.ts:565` (`RustMCPBridge`), the storage/cred/rollout factories. Also classify `messaging/index.ts:46`, `a2a/A2AManager.ts:72`, `PromptLoader.ts:119`, `mcp/transports/index.ts:90`, `registerPlatformTools.ts`.
- [ ] **Decide & record Decision 0.** Evaluate the leading candidate (build runtime as `__BUILD_MODE__='server'` → free Node impls; layer desktop deltas: schema/path-faithful providers, keychain bridge, desktop approval/persona, `platformId='desktop'`; suppress server-only behaviors). Exhaustively enumerate the server-only behaviors to suppress (RBAC handshake, health monitor, `Session.ts:2420`, …). Adopt or reject with rationale. **P1 cannot start until this is recorded.**

### 0b — Data-migration design (C11 — silent-empty-app risk)

- [ ] **Pin the exact desktop on-disk layout.** Confirmed: `storage.db`, `rollouts.db`, `config.json` under `ProjectDirs::from("com","airepublic","pi").config_dir()` (`db_storage.rs:257`, `rollout_db.rs:19`, `storage_commands.rs:35`). Server providers diverge: `<dir>/storage/storage.db`, `<dir>/rollouts/rollouts.db`, `<dir>/config-storage.json` (`ServerStorageProvider.ts:59`, `TSRolloutStorageProvider.ts:37`, `FileConfigStorageProvider.ts:15`).
- [ ] **Specify the migration.** Choose: (i) runtime providers that match the existing filenames/subdirs **and** are schema-compatible with the Rust-written DBs, OR (ii) an explicit one-time migration (copy/transform on first runtime launch, with rollback). Compare the Rust SQLite schema vs `better-sqlite3` provider schema; document the transform or prove identity. This is a P1 deliverable, not P4.

### 0c — Direct UI→bootstrap call inventory (C10)

- [ ] **Enumerate every non-channel UI/shell→bootstrap call.** Confirmed: `UserLoginStatus.svelte:106-109` (`getDesktopAgentBootstrap().setAuthMode`), `desktop/main.ts:15,72` (`shutdown`), `desktop/ui/main.ts:28` (`initializeDesktopAgent`). Sweep: `grep -rn "getDesktopAgentBootstrap\|DesktopAgentBootstrap" src/webfront src/desktop | grep -v __tests__`. For each, define the `ServiceRegistry` service or control-frame replacement (mechanism exists; `TauriChannel.supportsServices()=true`). Output: a service API list — a P1 deliverable.

### Remaining P0 checks

- [ ] **Re-confirm C5 (keychain).** `KeytarCredentialStore.ts` still `invoke('keychain_*')`; `keytar` still absent from `package.json`. ⇒ `keychain_commands` Rust bridge REQUIRED. If a native keytar dep was added, revisit Open Q1.
- [ ] **Re-confirm zero `MessageRouter`** (`grep -rln MessageRouter src | grep -v __tests__` = 0). If a router landed, revise C3.
- [ ] **Re-confirm D1 (protocol package).** `packages/ws-server/` exists; `server/connection/handshake.ts` imports `@applepi/ws-server`; locate the `TransportBridge` interface + `DirectBridge` impl (the `StdioBridge` template).
- [ ] **Record exact resolved data paths (migration safety — highest user risk).** Run a built desktop app per OS; capture the actual on-disk paths for SQLite (`db_storage.rs:258-263` config dir + `storage.db`), rollout, config, and the keychain service prefix (`applepi-`). The Node-native providers + handshake payload MUST reproduce these byte-for-byte. Record here.
- [ ] **Confirm adapters inert + factories real.** `ServerPlatformAdapter.ts:66-103`, `DesktopPlatformAdapter.ts:133-170`, `core/storage/index.ts:74-152`, `createRolloutStorageProvider.ts:14-37`.
- [ ] **Confirm C7 (bootstrap coupling).** `ServerAgentBootstrap.ts:205` (`new ServerChannel`), `:1186-1193` (`ServerScheduleStorage/ServerExecutionStorage/ServerSchedulerAlarms(dataDir)`). Lock the parameterization surface: (transport, storage set, scheduler set).
- [ ] **Lock the desktop-only-wiring port list (P3 scope).** `DesktopAgentBootstrap.ts`: managed policy `:110-139`; approval enhancers `:284-329`; plan-review `:314-324`; MCP tool reg `:542-589`; scheduler `:763-886`; auth/keychain restore `:1039-1146`; config hot-swap `:998-1032`. Confirm ranges.
- [ ] **Find every webview storage-factory call site (P3 must zero these).** `grep -rn "createStorageProvider\|createCredentialStore\|createRolloutStorageProvider\|initializeConfigStorage\|initializeCredentialStore" src/desktop src/webfront` — incl. `desktop/ui/main.ts`. These move runtime-side.
- [ ] **Decide keychain default (Open Q1)** on a *signed* macOS build: Rust bridge (default) vs. native dep.
- [ ] **Add the supersede note** to `server_mode_design.md` §18.3/§18.6/§20.0 pointing at Track 43.

---

## Phase 1: Node-native providers + StdioBridge + parameterized bootstrap + parity harness

**Goal:** A headless runtime bundle with Node-native storage that speaks the
frame protocol over stdio. Server mode unchanged; fully additive.

- [ ] `vite.config.desktop-runtime.mts` — Node SSR target (mirror `vite.config.server.mts:13,16,27`); **`define __BUILD_MODE__` = the value finalized in P0a** (likely `'server'`, not `'desktop'`); `npm run build:desktop-runtime`.
- [ ] Implement the **P0a-finalized Decision 0 provider set** — schema/path-faithful to the existing Rust on-disk layout per the **P0b migration spec** (not just "pointed at the dir"); credential→**keychain control-frame client** (C5). Guard so the webview path is untouched until P3.
- [ ] Implement the **P0c bootstrap-call service API** (e.g. `auth.setMode`, lifecycle) over `ServiceRegistry`/control-frames, replacing the direct `getDesktopAgentBootstrap()` calls.
- [ ] Add `better-sqlite3` dependency + per-OS/arch prebuilt binary handling (C8).
- [ ] Add `StdioBridge implements TransportBridge` (peer of `DirectBridge`) + a length-prefixed stdio carrier (stderr = logs only). Reuse `@applepi/ws-server` codec/handshake; add the launch-nonce + resolved-paths handshake frame.
- [ ] Extract `ServerAgentBootstrap` → `PiRuntimeBootstrap` parameterized over **(transport, storage set, scheduler set)** (C7); `websocket`+server set = current behavior verbatim.
- [ ] **Build the cross-binding parity harness:** identical agent scenarios over `stdio` (runtime) and `websocket` (server); assert identical event/result streams. Gates P3.
- [ ] Tests: codec round-trip / partial-frame / oversized / version-mismatch / nonce-reject; providers against the recorded paths.

## Phase 2: Rust supervisor + relay + UI relay client (behind build flag)

**Goal:** Tauri spawns/supervises the runtime and relays frames; in-webview
path still default. **Exit criterion: parity harness green.**

- [ ] Runtime as `externalBin`; **Rust-side** sidecar spawn on app start (no webview capability needed; `capabilities/default.json` already has `process:allow-restart`).
- [ ] Supervisor: nonce+resolved-paths handshake (inherited fd/env), ping/pong health (port `server/connection/watchdog.ts`), bounded-backoff restart, graceful→SIGTERM→SIGKILL, parent-bound child.
- [ ] Rust resolves data/config/cache/rollout dirs + keychain prefix and sends them in the handshake (Decision 3).
- [ ] Relay: `invoke('agent_send', frame)` → child stdin; stdout → `emit('pi:event', frame)`. Rust does NOT parse the agent protocol.
- [ ] **Keychain control-frame bridge** (`keychain_commands`) + **scheduler control-frame bridge** (`scheduler_commands`); `ui:show-window`, `notification`, deep-link `auth:callback` frames.
- [ ] Relay `ChannelAdapter` client (contract pinned in P0), behind the build flag; `runtime:reconnecting`/`runtime:down` UX.
- [ ] Rust tests: spawn/restart/quit, orphan kill, handshake reject, stderr→diagnostics. **Run the parity harness — must be green to exit P2.**

## Phase 3: The cut (irreversible — requires P2 parity green)

- [ ] Switch desktop build to the relay client; remove the build flag; UI bundle stays `__BUILD_MODE__='desktop'`.
- [ ] **Zero the webview storage-factory call sites** (P0 list) — all storage runtime-side.
- [ ] Port the P0 desktop-only-wiring list into `PiRuntimeBootstrap` as `platformId==='desktop'` branches.
- [ ] Delete `DesktopAgentBootstrap`, `DesktopPlatformAdapter`, the ~33 dead Rust commands (keep `keychain_commands` + `scheduler_commands` bridges + shell plugins), `src/desktop/polyfills/fetchProxy.ts`, `src/desktop/channels/websocket/WebSocketServer.ts`.
- [ ] Shrink `LargePayloadStore` to the Rust→webview hop only.

## Phase 4: Hardening + measurement

- [ ] **No-op on-disk migration verification** (highest user-facing risk): existing users' SQLite/rollout/config readable + keychain entries accessible at the recorded paths/prefix.
- [ ] Soak: crash/restart under load; scheduler-across-restart; session rehydrate from rollout.
- [ ] Large-payload streaming over stdio; latency vs. in-webview baseline.
- [ ] **Resource Footprint measurement** (design §Resource Footprint): idle + under-load RSS/CPU, in-webview vs decoupled, all three OSes. Record vs. the design's bounded-increase claim.
- [ ] `npm run tauri:build` smoke on Linux/macOS/Windows; updater delivers the sidecar (+ `better-sqlite3` prebuilts).
- [ ] Resolve Open Questions 1–4; mark Status: DONE.
