# Track 23: Agentic Payments (x402)

**Priority: P2 (strategic / forward-looking)** · **Effort: L** (was M — see "Why effort grew") · **Status: READY TO IMPLEMENT (prototype-gated, self-contained)**

> Source: claudy↔browserx grounding passes (2026-05-14 / multi-platform 2026-05-15 / **end-to-end implementation-readiness rewrite 2026-05-16**). The 2026-05-16 pass read **all six** claudy x402 files in full and ran four code-grounding agents over `browserx/src` (HTTP/tool seams, the approval/gate path, the dependency tracks, the credential stores), then verified the load-bearing browserx files first-hand. Every file:line below was checked against current `src/`. Speculative + security-sensitive: prototype behind the in-track config gate; **no real funds before Phase 4**.

> **The previous ⚠️ ERROR is now resolved (2026-05-16), not deferred.** The old doc's headless-safety argument said "route payments through `ApprovalGate`; on the server it times out and denies → fail closed." Verified against real code, that is wrong **twice over**, and the truth is *worse* than the original flag stated:
> 1. `ApprovalGate` calls the **core** `ApprovalManager` (`src/core/approval/ApprovalGate.ts:23` imports `../ApprovalManager`), not the exec one. On the server the core manager **never denies on timeout**: `balanced` (`getTimeoutForMode()===0`, `src/core/ApprovalManager.ts:183-184`) **hangs forever**; `high_speed` (`600000`) **auto-APPROVES** with `decision:'approve', metadata:{timeout:true}` (`src/core/ApprovalManager.ts:145-176`) — i.e. **fail-OPEN**.
> 2. Worse: **`ApprovalGate` is never constructed on the server at all.** `setApprovalGate` is called only in `src/extension/background/service-worker.ts:118` and `src/desktop/agent/DesktopAgentBootstrap.ts:258`. `ServerAgentBootstrap` never wires it, so `ToolRegistry.approvalGate` is `undefined` and the entire `if (this.approvalGate)` block (`src/tools/ToolRegistry.ts:426-469`) is **skipped** server-side — a payment routed "through the gate" on the server would execute with **no approval interception whatsoever**.
>
> The *policy conclusion* ("headless payments must fail CLOSED unless explicitly pre-authorized") was always right and is kept. The *mechanism* is now corrected to an **active, explicit policy gate that is the default-deny** — never the byproduct of an assumed timeout, and never dependent on a gate that isn't there. See "Per-Platform Behavior" and "Phase 3". This matches `14_plan_review/design.md` → "Validation Notes → Correction 4".

---

## Problem

BrowserX is a web-browsing agent that navigates and could **transact** (paywalled APIs, pay-per-call data, agent-to-agent paid services) but has **zero** payment/wallet/402 handling. Verified greenfield: a full-tree grep for `payment|wallet|x402|USDC|EIP-712|x-payment` finds no implementation — the only `402` in `src/` is `src/core/models/ModelClientError.ts` reusing the code for **LLM usage-limit** errors (an unrelated naming collision to keep in mind). HTTP 402 micropayments are a clean, transparent capability and a forward-looking differentiator.

## What Claudy Does (verified — all six files read in full)

`src/services/x402/` (~1021 LOC, USDC, `@see coinbase/x402`):

- **`paymentFetch.ts`** — `wrapFetchWithX402(innerFetch)` and `addX402AxiosInterceptor(instance)`. On a `402` *and* an `x-payment-required` header (`:44-63`), if `isX402Enabled()`, call `handlePaymentRequired(header, getX402SessionSpentUSD())`; on success set the `x-payment` header and re-issue the **same** request once (`:78-99`). Not 402 / not enabled / no header → pass through untouched.
- **`client.ts`** — `parsePaymentRequirement` → `validatePaymentRequirement` (per-request USD cap, session USD cap, network match, USDC-asset match; `:55-102`) → `createPayment` (EIP-3009 `transferWithAuthorization` over EIP-712) → base64 `encodePaymentHeader`. `handlePaymentRequired` orchestrates and calls `addX402Payment`.
- **`config.ts`** — key custody in `~/.claude/config.json` via `getGlobalConfig`/`saveGlobalConfig` (file mode `600`), `X402_PRIVATE_KEY` env override (`:88-95`); `deriveAddress` via Node `crypto` secp256k1; EIP-55 checksum. `isX402Enabled()` = `config.enabled && privateKey present`.
- **`tracker.ts`** — in-memory, **session-scoped** ledger: `addX402Payment`, `getX402SessionSpentUSD`, `formatX402Cost()` (chalk-dim summary grouped by resource domain), `resetX402SessionPayments()` on session switch.
- **`types.ts`** — `PaymentRequirement`, `PaymentPayload`, `X402WalletConfig`, `X402PaymentRecord`, `X402_HEADERS` (`x-payment-required` / `x-payment`, lowercase), `USDC_ADDRESSES`, `X402_DEFAULTS` (`enabled:false`, `network:'base'`, **`$0.10/request`, `$5.00/session`** — the prior prose's "$1 session" was wrong).
- **`commands/x402/x402.ts`** + `index.ts` — `/x402` (aliases `wallet`,`pay`), subcommands `setup|status|enable|disable|set-limit|set-session|network|remove`, `supportsNonInteractive:true`.
- **Two clean chokepoints**: `services/api/client.ts` (`wrapFetchWithX402(inner)`) + the WebFetch axios interceptor.

**Verified caveat — claudy's crypto is genuinely broken; do NOT port it.** `client.ts`/`config.ts` use `createHash('sha3-256')` as "keccak256" — **SHA3-256 ≠ Ethereum Keccak-256** (different padding), `signEIP712` hardcodes recovery `v=27` and uses Node's generic ECDSA (no low-S / recovery-id guarantee), and the `uint256` packing via `writeBigUInt64BE` is hand-rolled. This is not a stylistic preference: a literal port would produce signatures the USDC contract rejects. The "vetted library only" decision below is therefore a **hard requirement grounded in code**, not caution.

## BrowserX Mapping — the real seam (verified)

### There is NO central fetch chokepoint, and the web tools cannot even see a 402

Claudy wraps one `fetch` + one axios. BrowserX has neither, and crucially its web tools do **not perform Node HTTP at all** — they drive Chrome:

| Tool | File | HTTP mechanism (verified) | Can it observe a 402? |
|---|---|---|---|
| WebScrapingTool | `src/tools/WebScrapingTool.ts` | `chrome.tabs.create` + `chrome.scripting.executeScript` (DOM) | **No** — no `Response` object exists |
| DataExtractionTool | `src/tools/DataExtractionTool.ts` | `chrome.scripting.executeScript` on `document` | **No** |
| WebSearchTool | `src/tools/WebSearchTool.ts` | CDP `Page.navigate` (`:122`) | **No** — `Page.navigate` returns `{frameId,loaderId}`, no status |
| NavigationTool | `src/tools/NavigationTool.ts` | `chrome.tabs.update(...,{url})`; status via polling `tabs.get().status` | **No** on the nav path; the lone real Node `fetch` is the dead `checkUrlAccessibility()` (`:680-693`, HEAD-only, never dispatched) |
| NetworkInterceptTool | `src/tools/NetworkInterceptTool.ts` | none (observer) — `chrome.webRequest`/`declarativeNetRequest` | **Yes, passively**: `logResponse()` (`:556-570`) records `details.statusCode` and `details.responseHeaders` into an internal map. Cannot re-issue an authenticated retry. |
| CDP layer | `src/core/tools/browser/{BrowserController,DebuggerClient}.ts` | interfaces only; desktop impl raw CDP over WebSocket | **No** for navigated content (no `Network.responseReceived` subscription exists) |

There are two parallel tool trees — `src/tools/*` (canonical) and `src/extension/tools/*` (extension twins, same logic, different line numbers).

**Consequence (the central divergence from claudy):** x402 *cannot* be added by transparently wrapping existing tools — they neither share an HTTP client nor expose HTTP status. It must be a **new, explicit, agent-initiated resource-fetch capability** that does a real Node `fetch` (the runtime supports it — `NavigationTool.checkUrlAccessibility:682` proves `fetch`/`response.status`/`response.headers` work here) and is the *only* surface allowed to pay. `NetworkInterceptTool` is the *only* place a navigation 402 is observable and is used **observe-and-surface only** — never to pay.

### Injection seam (verified)

`ToolRegistry.execute()` builds a `ToolContext` for every handler at `src/tools/ToolRegistry.ts:497-506`; `ToolContext` (`src/tools/BaseTool.ts:166-173`) today carries only `sessionId/turnId/toolName/callId/metadata/onProgress` — **no services handle**. This is the natural, uniform injection point: thread an optional `payments` capability handle into `ToolContext`, populated centrally in `execute()`, reachable by the new resource-fetch tool and by nothing else by construction.

### Dependency tracks — VERIFIED STATE (this is why the doc is now self-contained)

Per the repo's `_DONE`-unreliable reality, each was grep-verified in `src/`:

| Track | Claimed dep | **Actual state in `src/`** | This doc's response |
|---|---|---|---|
| 22 Feature Flags | gate via `feature('X402')` | **Does not exist.** Only a test-only telemetry `FeatureFlagRecorder` (`src/core/session/state/SessionServices.ts:23-26`), `undefined` outside tests, nothing gates on it | Ship behind an **in-track config boolean** (default OFF all platforms). Migrate to Track 22 if it ever lands. |
| 18 USD Cost | spend folds into `formatTotalCost()` | **Does not exist.** Only token counting (`src/core/AgentTask.ts` `TokenBudget`) | Carry a **self-contained spend tracker** (port claudy's `tracker.ts` model). Expose a future fold-in hook. |
| 20 Managed Policy | server payee/amount allowlist layer | **Does not exist.** No managed-settings layer; closest is the server Zod config `src/server/config/server-config.ts` | Add a **new `x402` Zod sub-schema** under `ServerConfigSchema` (mirrors `ExecConfigSchema:36-39`), read via `getServerConfig()`. |
| 14 Plan/Approval | route payment through `ApprovalGate` | Exists **but server-absent** (see banner). Constructed only ext/desktop | Use `ApprovalGate` **only ext/desktop**; server uses the explicit policy gate + `preExecuteCheck`. |
| 03 Commands | `/x402` setup command | Exists **webfront-only** (`src/webfront/commands/CommandRegistry.ts`, `commandRegistry.register`). Server has no slash-command registry | `/x402` is **ext/desktop (webfront) only**; server is config-driven (no command). |

**Why effort grew M→L:** three "dependencies" must be shipped as minimal in-track slices for this track to work end-to-end standalone. This is deliberate — the alternative (block on three unstarted tracks) makes Track 23 un-shippable.

### Key custody surfaces (verified — shared `CredentialStore`)

All three implement `src/core/storage/CredentialStore.ts` (`get/set/delete/listAccounts(service,account)`; singletons `getCredentialStore()`/`setCredentialStore()`). ⚠️ Do **not** confuse with the narrower `IPlatformAdapter.ICredentialStore` (`get(key)/set(key,value)/delete(key)`) — wallet keys use the service/account `CredentialStore`.

| Platform | Impl | Posture | x402 custody decision |
|---|---|---|---|
| Extension | `ChromeCredentialStore` | `chrome.storage.local` + app-layer `VaultManager` encryption; high-value malware/exfil target; MV3 SW eviction breaks multi-step sign→retry | **No hot signing key. Detect + surface for human approval (or delegate to a paired desktop/server). Never an autonomous payer.** |
| Desktop (Tauri) | `KeytarCredentialStore` | OS keychain via Rust `invoke('keychain_*')` (macOS Keychain / Win Cred Mgr / libsecret); interactive user present | **The signer home.** Strongest custody + a human at spend time. |
| Server (headless) | `FileCredentialStore(dataDir)` | `credentials.enc`, AES-256-GCM, key = `scryptSync(process.env.VITE_VAULT_SECRET,…)` (**throws if unset**), file mode `0o600`; **fails OPEN to `{}` on decrypt error** | Tolerable only with a real secrets manager supplying `VITE_VAULT_SECRET`; **fail-closed policy mandatory** (below). The decrypt-fail-to-empty behavior must be treated as "no key ⇒ deny", never "no key ⇒ skip checks". |

## Per-Platform Behavior (the core safety design)

A capability that *spends money* behaves very differently per platform, driven by key-custody safety and whether a human can approve at spend time. Platform is read from `IPlatformAdapter.platformId` (`'extension'|'desktop'|'server'`, `src/core/platform/IPlatformAdapter.ts:69`, exposed as `RepublicAgent.platformAdapter.platformId`).

- **Extension (Chrome MV3) — never an autonomous payer.** Worst custody, malware target, MV3 fragility. The extension **detects** the 402, parses the `PaymentRequirement`, and **surfaces it for explicit human approval** via the existing `ApprovalGate` (which *is* constructed here). It holds **no hot signing key**; it may optionally delegate signing to a paired, more-trusted desktop/server host. No key ⇒ surface only.
- **Desktop (Tauri) — the natural wallet/signer home.** OS-keychain custody, interactive user who explicitly opted in, and `ApprovalGate` *is* constructed here (`DesktopAgentBootstrap.ts:258`). Above a trivial threshold the payment routes through `ApprovalGate.check()` (`ToolRegistry.ts:447`) as a destructive action — a human is present, no timeout pressure.
- **Server (headless) — strategically the most interesting, the most dangerous, FAIL CLOSED.** No human at spend time; a compromised unattended agent that can pay is a fund-draining hole. **`ApprovalGate` does not exist on the server** (verified) — so safety must NOT come from it or from any timeout. **Corrected mechanism:**
  1. The x402 capability checks `platformId === 'server'` and, if so, **default-denies** unless an explicit server-side allowlist policy resolves the specific payee domain *and* the amount is within the per-request / per-day cap. The deny is **explicit and is the default** (no policy ⇒ deny), never the byproduct of an assumed timeout.
  2. The policy is read from the new `server.x402` Zod sub-schema (`getServerConfig()`), supplied by the operator's config (backed by a real secrets/policy source, e.g. a K8s ConfigMap/Secret), never env-implicit, never logged.
  3. The capability additionally registers/honours a guard at the only platform-uniform choke that actually runs on the server — `ToolRegistry.preExecuteCheck` (`src/tools/ToolRegistry.ts:407-423`, runs unconditionally before the absent gate block) — so even a mis-wired call path cannot bypass the deny. (`preExecuteCheck` returning `behavior:'deny'` ⇒ `PRE_EXECUTE_DENIED`, before any handler runs.)
  4. Every server deny **and** every server-allowed payment emits an audit log entry. This composes with the unattended loop: a 402 mid-unattended-run is denied-unless-allowlisted and surfaced via the existing log surface.

## Key design decisions (and divergences from claudy)

1. **No global interceptor — a new explicit capability + a dedicated resource-fetch tool.** browserx has no fetch chokepoint and the web tools can't see HTTP status. Build `core/payments/x402/` and a single new agent-initiated resource-fetch tool that owns the only payable `fetch`. Reached via a `payments` handle on `ToolContext` (`BaseTool.ts:166-173`), populated in `ToolRegistry.execute` (`:497-506`). The central divergence from claudy.
2. **Never auto-pay on browser navigation.** A 402 from a navigated page is non-idempotent and high-risk. `NavigationTool`/`WebSearchTool`/CDP 402s are **observed** via `NetworkInterceptTool.logResponse` (`:556-570`) and surfaced, never auto-settled. Payment is only for explicit agent-initiated resource fetches through the new tool.
3. **Hard spend limits + per-platform approval, default-deny.** Per-request / per-session USD caps enforced *before* signing (port claudy's `validatePaymentRequirement` logic). Above a trivial threshold: `ApprovalGate.check()` on ext/desktop (where it exists); **explicit allowlist-or-deny on server** (where the gate does not).
4. **Vetted crypto only — do NOT port claudy's hand-rolled EIP-712 (verified broken).** Use `viem`/`ethers` or the `coinbase/x402` SDK for EIP-3009/EIP-712. Custody via the real `CredentialStore` (service/account) — no hot key on the extension, OS keychain on desktop, secrets-manager-backed `FileCredentialStore` on server.
5. **Disabled by default behind an in-track config gate** (Track 22 absent), default OFF all platforms, extension default especially conservative. Opt-in `/x402` setup on ext/desktop (webfront command registry); server is config-only (no slash command).
6. **Self-contained spend tracking** (Track 18 absent): port claudy's `tracker.ts` (in-memory, session-scoped, `resetX402SessionPayments` on session switch) with a `formatX402Cost()`-style summary surfaced via existing status/log surfaces; expose a one-line fold-in hook for future Track 18.

## Implementation Plan (file-level, ordered — each phase leaves a consistent, working system)

**Phase 0 — in-track foundations (replaces the absent Track 22/18/20 deps).**
- `core/payments/x402/config.ts`: typed x402 config + an `isX402Enabled(platformId)` gate backed by existing config storage; default OFF everywhere. (Stand-in for Track 22.)
- `core/payments/x402/tracker.ts`: port claudy's session ledger + `formatX402Cost()`. (Stand-in for Track 18; future fold-in hook documented.)
- `src/server/config/server-config.ts`: add `X402ConfigSchema` (enabled, allowlist `[{domain, maxPerRequestUSD}]`, `maxPerDayUSD`, network) as `server.x402`, mirroring `ExecConfigSchema:36-39`. (Stand-in for Track 20.)
- `src/tools/BaseTool.ts`: extend `ToolContext` with optional `payments?: PaymentCapability`. `src/tools/ToolRegistry.ts`: populate it in the `execute()` context build (`:497-506`).
- *State after Phase 0:* no behavior change; plumbing present, gate OFF.

**Phase 1 — detect + limits + the resource-fetch tool, dry-run only (no signing, no funds).**
- `core/payments/x402/detect.ts`: parse `402` + `x-payment-required` → `PaymentRequirement` (port claudy `parsePaymentRequirement`).
- `core/payments/x402/limits.ts`: per-request/session caps (port `validatePaymentRequirement`).
- New `ResourceFetchTool` (agent-initiated Node `fetch`, pattern from `NavigationTool:682`): on 402 it parses + validates and **logs the intended payment only** (dry-run), returns the 402 to the agent. Behind the Phase-0 gate, default OFF.
- *State after Phase 1:* with the gate ON, the agent can see "would have paid $X" decisions; nothing is signed or spent.

**Phase 2 — vetted signer + custody (desktop-first).**
- `core/payments/x402/signer.ts` using a vetted EIP-3009/EIP-712 lib; `PaymentKeyStore` over `CredentialStore` with per-platform impls: desktop = `KeytarCredentialStore`; server = `FileCredentialStore` (treat decrypt-fail/empty as "no key ⇒ deny"); **extension = no signer (detect+surface/delegate)**.
- Wire the tracker so signed payments record into the session ledger.
- *State after Phase 2:* desktop can sign + settle within caps (testnet first); ext/server still gated by Phase 3 approval.

**Phase 3 — approval integration, per platform (the corrected safety core).**
- ext/desktop: above-threshold payment → `ApprovalGate.check()` (`ToolRegistry.ts:447`; gate exists here). Extension with no key ⇒ surface/delegate only.
- server: **default-deny**; proceed only if `server.x402` allowlist matches payee domain AND amount ≤ per-request and per-day caps; enforce additionally via a `preExecuteCheck` guard (`ToolRegistry.ts:407-423`, the only server-present choke). Deny + allow both emit audit logs. `NetworkInterceptTool` surfaces navigation 402s (never pays).
- `/x402` setup/status/enable/disable/limits command via `commandRegistry.register` (webfront → ext/desktop only); server documented as config-only.
- *State after Phase 3 (TRACK GOAL MET):* an agent-initiated resource fetch that hits a 402 will — when enabled, funded, within caps, and platform-permitted — pay in USDC and return the resource; on extension it surfaces for human approval; on server it pays only if explicitly allowlisted and otherwise denies safely; navigation 402s are observed, never paid.

**Phase 4 — production hardening (only if validated).**
- Key-custody review, regulatory/legal review, mainnet enablement. **No real funds before this phase.**

## Dependencies

- **In-track (Phase 0)**: config gate (Track 22 absent), spend tracker (Track 18 absent), server `x402` Zod schema (Track 20 absent). These ship in this track.
- **Track 14** (ext/desktop only): `ApprovalGate.check()` for above-threshold confirmation where the gate is actually constructed. Server explicitly does **not** use it.
- **Existing, verified**: `CredentialStore` + 3 platform impls; `IPlatformAdapter.platformId`; `ToolRegistry`/`ToolContext`; `commandRegistry` (webfront); `getServerConfig()`; `NetworkInterceptTool` (observe-only).
- A vetted EIP-3009/EIP-712 library (viem / ethers / coinbase x402 SDK).

## Risks

- **Crypto-key custody is the dominant risk** — vetted lib only, platform-appropriate storage, never logged; **no hot key in the extension**. Non-negotiable.
- **Server `FileCredentialStore` fails OPEN to `{}` on decrypt error and hard-depends on `VITE_VAULT_SECRET`** — the capability must treat absent/empty key as **deny**, never as "skip the check".
- **Auto-pay on navigation would be catastrophic** — forbidden by design; the payable `fetch` is unreachable from `NavigationTool`/CDP by construction (separate tool, gated `ToolContext` handle).
- **Headless over-spend** — without the explicit server allowlist + per-day cap + `preExecuteCheck` deny-default, an unattended/compromised agent could drain funds. The default-deny is mandatory, not advisory; it must not rely on `ApprovalGate` (absent server-side) or any timeout (fails open).
- **Self-contained slices drift from future Tracks 18/20/22** — keep the fold-in hooks small and documented so later tracks can absorb them.
- **ResourceFetchTool is new server egress (SSRF).** A literal-host guard now blocks loopback/RFC1918/link-local/metadata/no-dot hosts (`src/tools/ResourceFetchTool.ts`). It does NOT resolve DNS, so a hostname resolving to a private IP (DNS rebinding) is not caught — resolve-then-check / pinned egress is a **Phase-4 follow-up**.
- **`/x402` webfront↔agent cross-context.** The command runs in the webfront renderer and reads/writes config via `getConfigStorage()`; the capability reads it agent-side. On the extension these are different JS contexts, so a UI `enable`/`set-limit` may not be observed by the service-worker capability (it fails into a clear message, never silently). Routing `/x402` mutations through the UI→agent service channel is a **Phase-3 follow-up**; key custody is already explicitly NOT done over chat.
- Pre-production protocol / regulatory surface — Phase 4 gated on explicit product + legal review; no real funds before then.

## Validation Notes (verified vs claudy + browserx `src/`, 2026-05-16)

- **claudy (all six files read in full):** `services/x402/{paymentFetch,client,config,tracker,types,index}.ts`, `commands/x402/{x402,index}.ts`. Defaults verified `enabled:false / base / $0.10 req / $5.00 session`. Crypto verified broken (`createHash('sha3-256')` as keccak256; hardcoded `v=27`) ⇒ "vetted lib only" is a code-grounded hard requirement.
- **browserx HTTP seams:** no central client; web tools are Chrome/CDP-driven and cannot observe HTTP status (`WebScrapingTool`/`DataExtractionTool`/`WebSearchTool`/`NavigationTool`); only `NetworkInterceptTool.logResponse:556-570` observes status/headers (passively, cannot retry). Lone real Node `fetch` = dead `NavigationTool.checkUrlAccessibility:680-693` (proves the fetch pattern).
- **Approval/gate (flagged error resolved):** `ApprovalGate` → core `ApprovalManager` (`ApprovalGate.ts:23`); server core-manager `balanced` hangs (`ApprovalManager.ts:183-184`), `high_speed` auto-approves (`:145-176`) — fail-OPEN; `setApprovalGate` only in `service-worker.ts:118` / `DesktopAgentBootstrap.ts:258`, **never server**; `ToolRegistry.ts:426` gate block skipped when `approvalGate` undefined; `preExecuteCheck` (`:407-423`) is the only platform-uniform server choke. Matches `14_plan_review/design.md` → "Correction 4".
- **Dependency tracks:** Track 22/18/20 **not in `src/`** (feature flags only a test-only `SessionServices.ts:23-26` recorder; no `CostTracker`; no managed layer — only `server-config.ts` Zod). Track 03 `commandRegistry` is webfront-only. Track 14 gate ext/desktop-only.
- **Custody:** `CredentialStore` (`src/core/storage/CredentialStore.ts`, service/account) with `ChromeCredentialStore` / `KeytarCredentialStore` / `FileCredentialStore(dataDir)` (`0o600`, AES-256-GCM, `VITE_VAULT_SECRET` required, fails-open-to-empty on decrypt error).
- **Injection point:** `ToolContext` (`BaseTool.ts:166-173`) has no services handle today; `ToolRegistry.execute` builds it at `:497-506` — the uniform place to thread the `payments` capability.

### Corrections vs the prior draft
1. **Resolved the flagged ⚠️ error in full (not deferred):** server fail-closed is now an explicit default-deny allowlist + `preExecuteCheck` guard; removed every "ApprovalGate times out → deny" claim. Truth recorded: the gate is *absent* server-side and the core manager fails *open*.
2. **Self-contained:** Tracks 22/18/20 verified non-existent in `src/` ⇒ ship minimal in-track slices (config gate, tracker, server Zod schema) instead of depending on unstarted tracks. Effort M→L.
3. **Correct seam:** a new agent-initiated `ResourceFetchTool` + `core/payments/x402/` reached via a `ToolContext.payments` handle — not a global interceptor and not bolted onto the Chrome-driven web tools (which cannot see a 402).
4. **Crypto:** claudy's EIP-712 verified broken in code ⇒ vetted-library requirement is now fact-based, not cautionary.
5. **Command/cost reality:** `/x402` is webfront (ext/desktop) only; server is config-driven; spend tracking is self-contained with a documented future Track-18 fold-in hook.
6. Fixed factual nits: claudy session default is **$5.00** (not $1); header names are lowercase `x-payment-required` / `x-payment`.
